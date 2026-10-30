# PRJ-001 端侧识别验证原型

用于验证「微信小程序 + 前置摄像头 + VisionKit Body 关键点 + 起跳计数状态机」的可行性。只做识别与计数验证，不包含产品级 UI、语音、历史记录。

## 目录

```text
prototype/
├── project.config.json          # 微信开发者工具项目配置
├── miniprogram/
│   ├── app.js / app.json / app.wxss
│   ├── sitemap.json
│   ├── pages/index/             # 验证页：前摄、检测、计数、日志
│   └── utils/counting.js        # 起跳计数状态机（可复用于产品）
└── tests/counting.test.js       # 合成关键点序列单元测试
```

## 技术路径

`camera`（前置）→ `CameraContext.onCameraFrame` 取 RGBA 帧 → 限频 → `VKSession.detectBody({ sourceType: 0 })` → `updateAnchors` 23 点关键点 → 置信度过滤/EMA → `JumpCounter` 状态机 → 计数与调试日志。

## 运行

1. 打开微信开发者工具，导入本目录 `prototype/`。
2. 将 `project.config.json` 中的 `appid` 替换为你的小程序 AppID（VisionKit 需要真实 AppID；`touristappid` 仅用于打开项目）。
3. 使用**真机调试**扫码，不要只用模拟器。
4. 允许摄像头权限，确认画面为前置摄像头。
5. 点击「开始」，保持静止约 1 秒完成校准，然后开始跳绳。
6. 用「显示索引」核对 23 点关键点；用「镜像开/关」修正前摄方向。
7. 测试结束后点「复制日志」，粘贴保存为 JSON，用于离线分析。

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| 起跳阈值 | 6% | 髋部上升超过躯干高度的 6% 判为起跳 |
| 处理帧率 | 15fps | 调用 `detectBody` 的频率 |
| 手腕筛选 | 关闭 | 开启后要求腕部有明显活动，用于无绳筛选实验 |
| 镜像关键点 | 开启 | 前摄预览镜像时使用 |
| 校准时长 | 1s | 开始计数前静止校准基线 |

## 单元测试

```bash
node tests/counting.test.js
```

覆盖：正常计数、小幅晃动不计数、双摇计 1 次、无绳（手臂静止）不计数、无绳（甩腕）已知误计、踝关键点缺失回退、reset、校准期不计数。

> 注意：单元测试使用合成关键点序列，只验证计数逻辑，不替代真机视觉验证。

## 已知限制

- 无绳甩腕仍可能被计数，需要后续时序分类器或绳子检测。
- 开发者工具模拟器不支持真机摄像头/VisionKit 能力。
- 前摄镜像方向需在真机上用「举右手」确认。
- 阈值与处理帧率是初始值，需按真机日志调整。
- 未实现语音、结果页、历史与个人最佳。

详细验证步骤见 [recognition-validation.md](../PRJ-001/06-technical-design/recognition-validation.md)；技术方案见 [technical-design.md](../PRJ-001/06-technical-design/technical-design.md)。
