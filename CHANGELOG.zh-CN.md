# 变更日志

所有包使用同一个版本号，一起发布（见 DEV.zh-CN.md 的「发布到 npm」）。每个版本开头先写明它的 DevTools 前端来自哪个版本的 Chrome；版本规则也在 DEV.zh-CN.md 里。改动合入时记在 `Unreleased` 下，发布时挪到对应的版本号下。英文版见 [CHANGELOG.md](CHANGELOG.md)，两份内容保持一致。

## Unreleased

- 探针来自 jsDelivr 或 unpkg 时，不用再写其他属性：它会从同一个 CDN 加载同版本的前端，外壳模式也能用（没有 Service Worker）。来自这类 CDN 时，外壳配置只信任探针所在的包和同版本的前端包，不再信任整个 CDN。新增 `data-no-panel`，不挂载面板：从这类 CDN 引入、只做远程调试（`data-remote`）的页面需要加上它，否则现在也会出现面板。
- 停靠的面板改用内侧边缘正中、靠页面一侧的抓手调整大小，取代原来贯穿整条边的横条：它不遮挡 DevTools，也只占页面上它看得见的那一小块，外壳模式内外样式一致。浮动窗口仍保留用来移动的横条。
- 外壳模式下新增设备模式，和 Chrome 一样：由 DevTools 排布页面和自己，工具栏上的设备按钮按设备尺寸设置页面（缩放到适合窗口），它的菜单可以截图，停靠和取消停靠时都能用。它只设置页面的尺寸，不改变像素比、UA 和触摸输入。DevTools 面板边缘正中、靠页面一侧有一个抓手，用来调整大小，不遮挡 DevTools，触屏上更大。非外壳模式下，这个按钮仍然是投屏。
- 新增 `Page.captureScreenshot` 和 `Page.getLayoutMetrics`：可以截取视口、指定区域或整个页面，由 snapDOM 绘制，并标注 `approximate: true`，供通过 CDP 操作页面的工具和 agent 使用。

## 0.1.0

基于 Chrome 156（156.0.8078.80）。

首次发布。
