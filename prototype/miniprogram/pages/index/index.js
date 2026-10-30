const { JumpCounter } = require('../../utils/counting')

const KEYPOINT_EDGES = [
  [1, 2], [2, 0], [0, 4], [4, 3],
  [0, 5], [0, 6],
  [5, 7], [7, 9], [9, 17],
  [6, 8], [8, 10], [10, 18],
  [0, 11], [0, 12], [11, 12],
  [11, 13], [13, 15], [15, 19], [15, 21],
  [12, 14], [14, 16], [16, 20], [16, 22]
]

const FOCUS_POINTS = {
  5: '#ffd166',
  6: '#ffd166',
  9: '#ffb020',
  10: '#ffb020',
  11: '#4aa3ff',
  12: '#4aa3ff',
  13: '#58d6ff',
  14: '#58d6ff',
  15: '#3ddc84',
  16: '#3ddc84'
}

Page({
  data: {
    running: false,
    cameraReady: false,
    count: 0,
    fps: 0,
    processedFps: 0,
    statusText: '待开始',
    calibrating: true,
    airborne: false,
    hipSignal: '0.000',
    ankleSignal: '0.000',
    wristRange: '0.000',
    bodyHeight: '0.000',
    anchorScore: '0.00',
    showIndices: false,
    mirrorKeypoints: true,
    heightRatioPct: 6,
    targetFps: 15,
    requireWrist: false,
    error: ''
  },

  onLoad() {
    this.counter = new JumpCounter({ heightRatio: 0.06, calibrationMs: 1000 })
    this.session = null
    this.visionReady = false
    this.cameraListener = null
    this.pending = false
    this.pendingTimer = null
    this.lastDetectAt = 0
    this.lastUiAt = 0
    this.lastRenderedCount = -1
    this.frameCount = 0
    this.processedCount = 0
    this.lastFpsAt = Date.now()
    this.logs = []
    this.lastAnchor = null
    this.hasStarted = false
  },

  onReady() {
    this.initCanvas()
    this.initVision()
  },

  onHide() {
    this.stopFrameListener()
    if (this.data.running) {
      this.setData({ running: false, statusText: '已暂停' })
    }
  },

  onUnload() {
    this.stopFrameListener()
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    if (this.session) {
      try { this.session.destroy() } catch (e) { /* ignore */ }
      this.session = null
    }
  },

  initCanvas() {
    wx.createSelectorQuery()
      .select('#debugCanvas')
      .fields({ node: true, size: true })
      .exec(res => {
        if (!res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = info.pixelRatio || 1
        canvas.width = res[0].width * dpr
        canvas.height = res[0].height * dpr
        ctx.scale(dpr, dpr)
        this.canvas = canvas
        this.ctx = ctx
        this.canvasW = res[0].width
        this.canvasH = res[0].height
        this.drawDebug(null)
      })
  },

  initVision() {
    if (!wx.createVKSession) {
      this.setData({ error: '当前环境不支持 wx.createVKSession（需基础库 2.28.0+）' })
      return
    }
    let session
    try {
      session = wx.createVKSession({
        track: { body: { mode: 2 } },
        version: 'v1'
      })
    } catch (e) {
      this.setData({ error: '创建 VKSession 失败：' + (e && e.message ? e.message : String(e)) })
      return
    }
    this.session = session

    session.on('updateAnchors', anchors => {
      this.pending = false
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer)
        this.pendingTimer = null
      }
      const anchor = anchors && anchors[0]
      this.lastAnchor = anchor || null
      if (anchor && this.data.running) this.processAnchor(anchor)
      this.drawDebug(anchor)
    })

    session.on('removeAnchors', () => {
      this.pending = false
      this.lastAnchor = null
      this.drawDebug(null)
    })

    session.start(err => {
      if (err) {
        this.setData({ error: 'VisionKit 启动失败：' + JSON.stringify(err) })
        return
      }
      this.visionReady = true
    })
  },

  onCameraReady() {
    this.setData({ cameraReady: true })
  },

  onCameraError(e) {
    this.stopFrameListener()
    this.setData({
      running: false,
      error: '摄像头错误：' + JSON.stringify(e.detail || {})
    })
  },

  openSettings() {
    wx.openSetting({})
  },

  toggleRunning() {
    if (this.data.running) {
      this.stopFrameListener()
      this.setData({ running: false, statusText: '已暂停' })
      return
    }
    if (!this.data.cameraReady) {
      wx.showToast({ title: '摄像头未就绪', icon: 'none' })
      return
    }
    if (!this.visionReady) {
      wx.showToast({ title: '识别引擎未就绪', icon: 'none' })
      return
    }
    if (!this.hasStarted) {
      this.counter.reset()
      this.logs = []
      this.hasStarted = true
    }
    this.startFrameListener()
    this.setData({ running: true, statusText: '识别中' })
  },

  startFrameListener() {
    if (this.cameraListener) return
    try {
      const ctx = wx.createCameraContext()
      this.cameraListener = ctx.onCameraFrame(frame => this.onFrame(frame))
      this.cameraListener.start()
    } catch (e) {
      this.cameraListener = null
      this.setData({ error: '抽帧失败：' + (e && e.message ? e.message : String(e)) })
    }
  },

  stopFrameListener() {
    if (!this.cameraListener) return
    try { this.cameraListener.stop() } catch (e) { /* ignore */ }
    this.cameraListener = null
    this.pending = false
  },

  onFrame(frame) {
    this.frameCount++
    const now = Date.now()
    if (now - this.lastFpsAt >= 1000) {
      this.setData({
        fps: this.frameCount,
        processedFps: this.processedCount
      })
      this.frameCount = 0
      this.processedCount = 0
      this.lastFpsAt = now
    }

    if (!this.data.running || !this.visionReady || this.pending) return
    const interval = 1000 / this.data.targetFps
    if (now - this.lastDetectAt < interval) return

    this.lastDetectAt = now
    this.pending = true
    this.processedCount++

    try {
      this.session.detectBody({
        frameBuffer: frame.data,
        width: frame.width,
        height: frame.height,
        scoreThreshold: 0.3,
        sourceType: 0
      })
    } catch (e) {
      this.pending = false
      this.setData({ error: 'detectBody 失败：' + (e && e.message ? e.message : String(e)) })
      return
    }

    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = setTimeout(() => {
      this.pending = false
      this.pendingTimer = null
    }, 400)
  },

  processAnchor(anchor) {
    const now = Date.now()
    const result = this.counter.update(anchor, now)
    const confidence = anchor.confidence || []

    this.logs.push({
      t: this.counter.startedAt == null ? 0 : Math.round(now - this.counter.startedAt),
      c: result.count,
      air: result.airborne ? 1 : 0,
      cal: result.calibrating ? 1 : 0,
      hip: Number(result.hipSignal.toFixed(4)),
      ank: Number(result.ankleSignal.toFixed(4)),
      wr: Number(result.wristRange.toFixed(4)),
      h: Number(result.bodyHeight.toFixed(4)),
      s: Number((anchor.score || 0).toFixed(3)),
      a15: Number((confidence[15] || 0).toFixed(3)),
      a16: Number((confidence[16] || 0).toFixed(3))
    })
    if (this.logs.length > 3000) this.logs.shift()

    const statusText = result.calibrating
      ? '保持静止校准…'
      : (result.airborne ? '腾空' : '着地')

    if (now - this.lastUiAt >= 200) {
      this.lastUiAt = now
      this.lastRenderedCount = result.count
      this.setData({
        count: result.count,
        airborne: result.airborne,
        calibrating: result.calibrating,
        statusText,
        hipSignal: result.hipSignal.toFixed(3),
        ankleSignal: result.ankleSignal.toFixed(3),
        wristRange: result.wristRange.toFixed(3),
        bodyHeight: result.bodyHeight.toFixed(3),
        anchorScore: Number(anchor.score || 0).toFixed(2)
      })
    } else if (result.count !== this.lastRenderedCount) {
      this.lastRenderedCount = result.count
      this.setData({ count: result.count })
      wx.vibrateShort({ type: 'light' })
    }
  },

  drawDebug(anchor) {
    const ctx = this.ctx
    if (!ctx) return
    const w = this.canvasW
    const h = this.canvasH
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0b0f14'
    ctx.fillRect(0, 0, w, h)

    if (!anchor || !anchor.points) {
      ctx.fillStyle = '#7d8ea3'
      ctx.font = '13px sans-serif'
      ctx.fillText('等待人体进入画面…', 16, 26)
      return
    }

    const points = anchor.points
    const confidence = anchor.confidence || []
    const mirror = this.data.mirrorKeypoints
    const pad = 16

    const map = p => ({
      x: pad + (mirror ? 1 - p.x : p.x) * (w - pad * 2),
      y: pad + p.y * (h - pad * 2)
    })
    const visible = i => {
      const p = points[i]
      if (!p) return false
      if (confidence.length && typeof confidence[i] === 'number' && confidence[i] < 0.2) return false
      return true
    }

    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(74, 163, 255, 0.55)'
    KEYPOINT_EDGES.forEach(edge => {
      const a = edge[0]
      const b = edge[1]
      if (!visible(a) || !visible(b)) return
      const pa = map(points[a])
      const pb = map(points[b])
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.stroke()
    })

    for (let i = 0; i < points.length; i++) {
      if (!visible(i)) continue
      const p = map(points[i])
      ctx.beginPath()
      ctx.fillStyle = FOCUS_POINTS[i] || '#9fb3c8'
      ctx.arc(p.x, p.y, FOCUS_POINTS[i] ? 4 : 2.5, 0, Math.PI * 2)
      ctx.fill()

      if (this.data.showIndices) {
        ctx.fillStyle = '#d7e2ee'
        ctx.font = '10px sans-serif'
        ctx.fillText(String(i), p.x + 5, p.y - 4)
      }
    }
  },

  toggleIndices() {
    this.setData({ showIndices: !this.data.showIndices })
    this.drawDebug(this.lastAnchor)
  },

  toggleMirror() {
    this.setData({ mirrorKeypoints: !this.data.mirrorKeypoints })
    this.drawDebug(this.lastAnchor)
  },

  resetCounter() {
    this.counter.reset()
    this.logs = []
    this.lastRenderedCount = -1
    this.setData({
      count: 0,
      airborne: false,
      calibrating: true,
      statusText: '待开始',
      hipSignal: '0.000',
      ankleSignal: '0.000',
      wristRange: '0.000',
      bodyHeight: '0.000',
      anchorScore: '0.00'
    })
    this.drawDebug(this.lastAnchor)
  },

  onHeightRatioChange(e) {
    const pct = Number(e.detail.value)
    this.counter.options.heightRatio = pct / 100
    this.setData({ heightRatioPct: pct })
  },

  onFpsChange(e) {
    this.setData({ targetFps: Number(e.detail.value) })
  },

  onRequireWristChange(e) {
    this.counter.options.requireWrist = !!e.detail.value
    this.setData({ requireWrist: !!e.detail.value })
  },

  exportLog() {
    if (!this.logs.length) {
      wx.showToast({ title: '暂无采样日志', icon: 'none' })
      return
    }
    const payload = {
      project: 'PRJ-001',
      version: 1,
      capturedAt: new Date().toISOString(),
      config: {
        heightRatio: this.counter.options.heightRatio,
        targetFps: this.data.targetFps,
        requireWrist: this.counter.options.requireWrist,
        calibrationMs: this.counter.options.calibrationMs
      },
      summary: {
        count: this.counter.count,
        samples: this.logs.length
      },
      samples: this.logs
    }
    wx.setClipboardData({
      data: JSON.stringify(payload),
      success: () => wx.showToast({ title: '日志已复制', icon: 'success' }),
      fail: () => wx.showModal({
        title: '复制失败',
        content: '日志可能过大，请减少采样后重试。',
        showCancel: false
      })
    })
  }
})
