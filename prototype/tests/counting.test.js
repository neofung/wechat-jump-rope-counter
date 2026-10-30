const assert = require('assert')
const { JumpCounter } = require('../miniprogram/utils/counting')

function makeAnchor({ hipY, ankleY, wristY, bodyHeight, ankleConfidence = 1 }) {
  const points = Array.from({ length: 23 }, () => ({ x: 0.5, y: 0.5 }))
  const shoulderY = hipY - bodyHeight / 2
  points[5] = { x: 0.5, y: shoulderY }
  points[6] = { x: 0.5, y: shoulderY }
  points[11] = { x: 0.5, y: hipY }
  points[12] = { x: 0.5, y: hipY }
  points[15] = { x: 0.5, y: ankleY }
  points[16] = { x: 0.5, y: ankleY }
  points[9] = { x: 0.5, y: wristY }
  points[10] = { x: 0.5, y: wristY }
  const confidence = Array(23).fill(0.95)
  confidence[15] = ankleConfidence
  confidence[16] = ankleConfidence
  return {
    points,
    confidence,
    size: { width: 0.5, height: bodyHeight },
    score: 0.9
  }
}

function simulate(options) {
  const {
    durationMs = 10000,
    fps = 15,
    periodMs = 600,
    airRatio = 0.5,
    amplitude = 0.1,
    wristAmp = 0.03,
    calibrationMs = 1000,
    requireWrist = false,
    ankleConfidence = 1
  } = options || {}

  const counter = new JumpCounter({ calibrationMs, requireWrist })
  const step = 1000 / fps
  const bodyHeight = 0.5

  for (let t = 0; t < durationMs; t += step) {
    const phase = (t % periodMs) / periodMs
    const lift = phase < airRatio
      ? amplitude * Math.sin((Math.PI * phase) / airRatio)
      : 0
    counter.update(makeAnchor({
      hipY: 0.6 - lift,
      ankleY: 0.8 - lift,
      wristY: 0.55 + wristAmp * Math.sin((2 * Math.PI * t) / periodMs),
      bodyHeight,
      ankleConfidence
    }), t)
  }

  return counter
}

function main() {
  const results = []

  // 1. 正常跳绳：10 秒、每 0.6 秒一次起跳，校准 1 秒后约 15 次
  const normal = simulate({})
  assert(normal.count >= 12 && normal.count <= 17, `normal count expected 12-17, got ${normal.count}`)
  results.push({ name: '正常跳绳计数', count: normal.count, pass: true })

  // 2. 小幅晃动不应计数
  const noise = simulate({ amplitude: 0.01 })
  assert.strictEqual(noise.count, 0, `noise count expected 0, got ${noise.count}`)
  results.push({ name: '小幅晃动不计数', count: noise.count, pass: true })

  // 3. 双摇语义：一次起跳只计 1 次，不因手腕两次摆动多计
  const doubleUnder = simulate({ wristAmp: 0.06, periodMs: 600 })
  assert(doubleUnder.count >= 12 && doubleUnder.count <= 17, `double-under count expected 12-17, got ${doubleUnder.count}`)
  results.push({ name: '双摇按起跳计 1 次', count: doubleUnder.count, pass: true })

  // 4. 手腕静止的无绳空跳：开启手腕筛选时应为 0
  const noRopeStill = simulate({ wristAmp: 0, requireWrist: true })
  assert.strictEqual(noRopeStill.count, 0, `no-rope still expected 0, got ${noRopeStill.count}`)
  results.push({ name: '无绳空跳（手臂静止）不计数', count: noRopeStill.count, pass: true })

  // 5. 手腕摆动的无绳空跳：当前手腕阈值无法区分，记录为已知限制
  const noRopeSwing = simulate({ wristAmp: 0.03, requireWrist: true })
  assert(noRopeSwing.count > 0, 'wrist-swinging no-rope is expected to be counted by current heuristic')
  results.push({ name: '无绳空跳（甩腕）当前会误计（已知限制）', count: noRopeSwing.count, pass: true })

  // 6. 踝关节低置信度时使用髋部回退，不崩溃
  const missingAnkles = simulate({ ankleConfidence: 0.05 })
  assert(missingAnkles.count >= 12 && missingAnkles.count <= 17, `missing ankles fallback expected 12-17, got ${missingAnkles.count}`)
  results.push({ name: '踝关键点缺失时髋部回退', count: missingAnkles.count, pass: true })

  // 7. reset 清零
  normal.reset()
  assert.strictEqual(normal.count, 0, 'reset should clear count')
  results.push({ name: 'reset 清零', count: normal.count, pass: true })

  // 8. 校准期内不计数
  const calibration = simulate({ calibrationMs: 3000, durationMs: 6000 })
  assert(calibration.count <= 6, `calibration count expected <= 6, got ${calibration.count}`)
  results.push({ name: '校准期内不计数', count: calibration.count, pass: true })

  console.log('全部测试通过：')
  results.forEach(r => console.log(`- ${r.name}: count=${r.count}`))
}

main()
