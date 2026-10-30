/**
 * 跳绳计数状态机（可在小程序与 Node 测试中复用）
 *
 * 输入：VisionKit body anchor（23 点 2D 关键点，归一化坐标）
 * 输出：计数与调试信号
 *
 * 关键点索引（官方 23 点图）：
 * 0 颈/胸中心，5/6 肩，7/8 肘，9/10 腕，11/12 髋，
 * 13/14 膝，15/16 踝，17/18 手，19-22 脚部
 */

const DEFAULTS = {
  heightRatio: 0.06,      // 起跳阈值（相对躯干高度）
  wristRatio: 0.02,       // 手腕活动阈值（相对躯干高度），用于无绳筛选（实验项）
  refractoryMs: 220,      // 两次计数最小间隔
  minConfidence: 0.3,     // 关键点最低置信度
  smoothAlpha: 0.5,       // 关键点平滑系数
  requiredFrames: 2,      // 状态切换所需连续帧数
  calibrationMs: 1000,    // 开始计数前的静止校准时长
  requireWrist: false,    // 是否要求手腕有明显活动（无绳筛选，默认关闭待验证）
  wristWindowMs: 600,     // 手腕活动统计窗口
  baselineBeta: 0.02      // 着地时基线缓慢更新系数
}

function avg(values) {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

function smooth(prev, next, alpha) {
  return prev * (1 - alpha) + next * alpha
}

class JumpCounter {
  constructor(options) {
    this.options = Object.assign({}, DEFAULTS, options || {})
    this.reset()
  }

  reset() {
    this.count = 0
    this.startedAt = null
    this.calibrating = true
    this.airborne = false
    this.candidateFrames = 0
    this.groundedFrames = 0
    this.lastCountAt = -Infinity
    this.smoothedHipY = null
    this.smoothedAnkleY = null
    this.baselineHipY = null
    this.baselineAnkleY = null
    this.bodyHeight = null
    this.wristSamples = []
    this.lastResult = this._result()
  }

  update(anchor, timestamp) {
    const opt = this.options
    if (this.startedAt == null) this.startedAt = timestamp
    if (!anchor || !anchor.points) return this.lastResult

    const points = anchor.points
    const confidence = anchor.confidence || []

    const valid = index => {
      const point = points[index]
      if (!point || !isFinite(point.x) || !isFinite(point.y)) return false
      if (confidence.length && typeof confidence[index] === 'number' && confidence[index] < opt.minConfidence) {
        return false
      }
      return true
    }

    const ankleIndices = [15, 16].filter(valid)
    const hipIndices = [11, 12].filter(valid)
    const shoulderIndices = [5, 6].filter(valid)
    const wristIndices = [9, 10].filter(valid)

    if (!hipIndices.length) return this.lastResult

    const hipY = avg(hipIndices.map(i => points[i].y))
    const ankleY = ankleIndices.length ? avg(ankleIndices.map(i => points[i].y)) : null
    const shoulderY = shoulderIndices.length ? avg(shoulderIndices.map(i => points[i].y)) : null

    let bodyHeight = null
    if (shoulderY != null && Math.abs(hipY - shoulderY) > 0.02) {
      bodyHeight = Math.abs(hipY - shoulderY) * 2
    } else if (anchor.size && anchor.size.height > 0) {
      bodyHeight = anchor.size.height
    } else if (this.bodyHeight) {
      bodyHeight = this.bodyHeight
    } else {
      return this.lastResult
    }
    this.bodyHeight = bodyHeight

    this.smoothedHipY = this.smoothedHipY == null
      ? hipY
      : smooth(this.smoothedHipY, hipY, opt.smoothAlpha)
    if (ankleY != null) {
      this.smoothedAnkleY = this.smoothedAnkleY == null
        ? ankleY
        : smooth(this.smoothedAnkleY, ankleY, opt.smoothAlpha)
    }

    let wristRange = 0
    if (wristIndices.length) {
      const wristY = avg(wristIndices.map(i => points[i].y))
      this.wristSamples.push({ t: timestamp, y: wristY })
      const cutoff = timestamp - opt.wristWindowMs
      while (this.wristSamples.length && this.wristSamples[0].t < cutoff) {
        this.wristSamples.shift()
      }
      if (this.wristSamples.length > 1) {
        let min = Infinity
        let max = -Infinity
        for (let i = 0; i < this.wristSamples.length; i++) {
          min = Math.min(min, this.wristSamples[i].y)
          max = Math.max(max, this.wristSamples[i].y)
        }
        wristRange = (max - min) / bodyHeight
      }
    }

    if (this.baselineHipY == null) {
      this.baselineHipY = this.smoothedHipY
      if (this.smoothedAnkleY != null) this.baselineAnkleY = this.smoothedAnkleY
    }

    const elapsed = timestamp - this.startedAt
    if (elapsed < opt.calibrationMs) {
      this.baselineHipY = smooth(this.baselineHipY, this.smoothedHipY, 0.2)
      if (this.smoothedAnkleY != null && this.baselineAnkleY != null) {
        this.baselineAnkleY = smooth(this.baselineAnkleY, this.smoothedAnkleY, 0.2)
      }
      this.lastResult = this._result({
        hipSignal: 0,
        ankleSignal: 0,
        wristRange
      })
      return this.lastResult
    }

    this.calibrating = false
    const hipSignal = (this.baselineHipY - this.smoothedHipY) / bodyHeight
    let ankleSignal = 0
    if (this.smoothedAnkleY != null && this.baselineAnkleY != null) {
      ankleSignal = (this.baselineAnkleY - this.smoothedAnkleY) / bodyHeight
    }

    let isJump = hipSignal > opt.heightRatio && (ankleSignal > opt.heightRatio * 0.4 || !ankleIndices.length)
    if (!isJump && !ankleIndices.length) {
      isJump = hipSignal > opt.heightRatio * 1.2
    }
    if (opt.requireWrist && wristRange < opt.wristRatio) {
      isJump = false
    }

    if (!this.airborne) {
      if (isJump) {
        this.candidateFrames++
        if (this.candidateFrames >= opt.requiredFrames) {
          this.airborne = true
          this.candidateFrames = 0
          if (timestamp - this.lastCountAt >= opt.refractoryMs) {
            this.count++
            this.lastCountAt = timestamp
          }
        }
      } else {
        this.candidateFrames = 0
        this.baselineHipY = smooth(this.baselineHipY, this.smoothedHipY, opt.baselineBeta)
        if (this.smoothedAnkleY != null && this.baselineAnkleY != null) {
          this.baselineAnkleY = smooth(this.baselineAnkleY, this.smoothedAnkleY, opt.baselineBeta)
        }
      }
    } else if (!isJump) {
      this.groundedFrames++
      if (this.groundedFrames >= opt.requiredFrames) {
        this.airborne = false
        this.groundedFrames = 0
      }
    } else {
      this.groundedFrames = 0
    }

    this.lastResult = this._result({
      hipSignal,
      ankleSignal,
      wristRange
    })
    return this.lastResult
  }

  _result(extra) {
    extra = extra || {}
    return {
      count: this.count,
      airborne: this.airborne,
      calibrating: this.calibrating,
      candidateFrames: this.candidateFrames,
      hipSignal: extra.hipSignal || 0,
      ankleSignal: extra.ankleSignal || 0,
      wristRange: extra.wristRange || 0,
      bodyHeight: this.bodyHeight || 0
    }
  }
}

module.exports = {
  JumpCounter,
  DEFAULTS
}
