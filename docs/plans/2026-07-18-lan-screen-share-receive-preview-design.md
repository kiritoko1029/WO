# 局域网屏幕共享接收与本地预览设计

## Goal

修复局域网轻量房间中“房主开始共享后，加入者持续停留在正在接收提示”的
问题，并让共享方在主舞台预览自己实际发送的屏幕画面。

## Root Cause

轻量房间的屏幕所有权与媒体轨道是两条独立链路：

```text
screen.acquire -> screen.ownerChanged -> RoomRoute
固定 video transceiver -> RTCRtpReceiver.track -> CallSnapshot
```

加入者收到 `screen.ownerChanged` 后能够显示共享者姓名，但当前处理只更新
`screenOwner`。如果首次协商完成时 screen receiver 尚未被同步到
`remoteScreenTrack`，之后开始共享不会再次同步 receiver，界面便永久停留在
“正在接收”状态。

共享方已经通过固定 screen sender 发送捕获轨道，但调用状态和展示组件没有
投影该 sender track，因此只能显示文字占位。

## Design

保持固定 transceiver 和单屏幕租约设计，不触发重新协商，也不修改
`createScreenController`。

- `createCallController` 在协商完成和远端 `screen.ownerChanged` 到达时同步
  `peer.screenReceiver.track`，使所有权与媒体两条链路最终收敛。
- `CallSnapshot` 增加 `localScreenTrack`。屏幕控制器进入 `sharing` 时，从
  `peer.screenSender.track` 投影本地轨道；停止、租约丢失和清理时清空。
- `RoomRoute` 把本地与远端轨道都传给 `ScreenStage`。
- `ScreenStage` 优先显示有效的远端共享；本地处于 `sharing` 时显示本地轨道。
  本地预览不镜像、静音并使用独立无障碍标签。

## State Rules

| 状态 | 主舞台 |
| --- | --- |
| 远端 owner + 远端 track | 远端共享画面 |
| 本地 `sharing` + 本地 track | 本地共享预览 |
| 远端 owner + 无远端 track | 正在接收提示 |
| 本地 `sharing` + 无本地 track | 本地共享文字占位 |
| 无 owner、无共享 | 等待屏幕共享 |

远端画面不会被预协商但尚未承载媒体的 receiver track提前展示；仍以权威
`screenOwner` 决定可见性。停止共享、租约丢失、信令关闭或 transport 重建
沿用现有清理路径，并同步清除相应轨道投影。

## Risk And Compatibility

GitNexus upstream impact 对 `createCallController`、`ScreenStage` 和 `RoomRoute`
均为 LOW。设计不修改 CRITICAL 的 `createScreenController`，不改变中心服务
协议、LAN 认证帧、屏幕租约或 WebRTC SDP。

中心模式和 Web 模式复用同一 renderer 状态层，因此获得相同的接收恢复与本地
预览行为。

## Verification

- 状态层回归：首次协商未同步 screen track 时，远端所有权事件会补挂 receiver。
- 状态层回归：本地进入 `sharing` 后投影 sender track，停止后清空。
- 组件回归：本地预览使用视频元素；远端共享优先且标签正确。
- 运行桌面端聚焦测试、类型检查和 lint。
- 运行 GitNexus `detect_changes`，只接受桌面调用状态与屏幕展示流程变化。
