# 变更日志

所有包使用同一个版本号，一起发布（见 DEV.zh-CN.md 的「发布到 npm」）。每个版本开头先写明它的 DevTools 前端来自哪个版本的 Chrome；版本规则也在 DEV.zh-CN.md 里。改动合入时记在 `Unreleased` 下，发布时挪到对应的版本号下。英文版见 [CHANGELOG.md](CHANGELOG.md)，两份内容保持一致。

## Unreleased

- 外壳模式下新增设备模式，和 Chrome 一样：由 DevTools 排布页面和自己，工具栏上的设备按钮按设备尺寸设置页面（缩放到适合窗口），它的菜单可以截图，停靠和取消停靠时都能用。它只设置页面的尺寸，不改变像素比、UA 和触摸输入。触屏上，页面和 DevTools 的分界处有一条拖动条用来调整大小。非外壳模式下，这个按钮仍然是投屏。
- 新增 `Page.captureScreenshot` 和 `Page.getLayoutMetrics`：可以截取视口、指定区域或整个页面，由 snapDOM 绘制，并标注 `approximate: true`，供通过 CDP 操作页面的工具和 agent 使用。

## 0.1.0

基于 Chrome 156（156.0.8078.80）。

首次发布。
