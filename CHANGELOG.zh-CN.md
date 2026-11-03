# 变更日志

所有包使用同一个版本号，一起发布（见 DEV.zh-CN.md 的「发布到 npm」）。每个版本开头先写明它的 DevTools 前端来自哪个版本的 Chrome；版本规则也在 DEV.zh-CN.md 里。改动合入时记在 `Unreleased` 下，发布时挪到对应的版本号下。英文版见 [CHANGELOG.md](CHANGELOG.md)，两份内容保持一致。

## Unreleased

- 支持同源 iframe，与 Chrome 一致：Elements 能展开；每个 iframe 在 Page 的 frame 树里有自己的 frame，在 Console 的上下文菜单里有自己的执行上下文，带着它的 console 消息和错误；Styles 显示它自己的样式表和媒体条件；Network 的请求标出所属 frame；高亮、检查模式和 Input 都能进入 iframe。shadow tree 里的 iframe 以及同源 `<object>`、`<embed>` 的文档同样是 frame；`Page.getResourceTree` 列出每个 frame 自己的资源。iframe 在 load 事件之前的日志和请求拿不到（srcdoc 和空 iframe 除外），导航要加载完成后才报出。
- 支持跨域 iframe：iframe 页面也加载探针，并且双方互相信任时（父页面配 `data-frame-origins`，iframe 页面配 `data-parent-origins`；Vite 选项为 `frameOrigins`、`parentOrigins`），它们作为子 target 接入，和 Chrome 的进程外 iframe 一样，通过 `Target.setAutoAttach` 和按 `sessionId` 转发的消息工作，直接嵌入、外壳模式、远程调试都支持。Elements 把它们的文档显示在 `<iframe>` 下（`DOM.getFrameOwner`），Console 里有它们的执行上下文；落在它们上面的输入会转进去，滚轮滚到底会传回父页面。每个接入它们的客户端各有自己的会话，与 Chrome 一致（比如页面上的 DevTools 和远程连入的 agent 同时调试）。导航后 target 保留，iframe 里再嵌的跨域 iframe 逐级接入。
- `DOM.getNodeForLocation` 按文档坐标而不是视口坐标计算；`DOM.scrollIntoViewIfNeeded` 对不在视口内的元素滚到居中，与 Chrome 一致。`Input.dispatchMouseEvent` 悬停时按 Chrome 的顺序发出 `pointerout`、`pointerover`、`mouseout`、`mouseover`。
- `history.pushState`、`replaceState`、hash 变化以及 Navigation API 拦截的导航会发出 `Page.navigatedWithinDocument`，顶层页面和 frame 都是。
- 探针运行之前页面发出的请求，改为从 Resource Timing 补报（没有调用栈、请求头和请求体），Chrome 同样会报这些请求。
- `DOM.requestChildNodes` 不再重复发送客户端已有的子节点，与 Chrome 一致：前端请求两次时，展开的 iframe 会变成空白。
- 外壳模式下重新加载的前端开始一个新会话，与 Chrome 一致。
- 外壳模式下，页面的任何客户端（远程连入的 agent、`createCdpSession`）都能用 `Emulation.setDeviceMetricsOverride` 和 `clearDeviceMetricsOverride`，不再只限外壳自带的前端：以最后一次设置为准，客户端清除或断开时只撤销自己的设置；远程客户端的设置在页面重新加载后仍然有效，按客户端连上的先后重新应用，与 Chrome 一致。参数按 Chrome 的规则校验，报错相同；非外壳模式下这两条命令返回错误并说明原因。
- 页面做不到的命令（自动深色模式、开启焦点模拟、双指缩放、后台服务记录、绕过 Service Worker、自动填充地址等）改为返回错误「Not supported in the page: <原因>」，不再假装成功；能在页面里实现、只是还没做的仍返回成功，并记进路线图。
- 直接嵌入的前端重新加载后，改为按命令 id 重新从 1 开始来判断，不再看 iframe 的 load 事件：load 晚于新前端的第一批命令，会把它刚启用的东西又关掉。
- `CSS.createStyleSheet` 遇到不存在的 `frameId` 时报错「Frame not found」，与 Chrome 一致。

## 0.2.0

基于 Chrome 156（156.0.8078.80）。

- 探针来自 jsDelivr 或 unpkg 时，不用再写其他属性：它会从同一个 CDN 加载同版本的前端，外壳模式也能用（没有 Service Worker）。来自这类 CDN 时，外壳配置只信任探针所在的包和同版本的前端包，不再信任整个 CDN。新增 `data-no-panel`，不挂载面板：从这类 CDN 引入、只做远程调试（`data-remote`）的页面需要加上它，否则现在也会出现面板。
- 停靠的面板改用内侧边缘正中、靠页面一侧的抓手调整大小，取代原来贯穿整条边的横条：它不遮挡 DevTools，也只占页面上它看得见的那一小块，外壳模式内外样式一致。浮动窗口仍保留用来移动的横条。
- 外壳模式下新增设备模式，和 Chrome 一样：由 DevTools 排布页面和自己，工具栏上的设备按钮按设备尺寸设置页面（缩放到适合窗口），它的菜单可以截图，停靠和取消停靠时都能用。它只设置页面的尺寸，不改变像素比、UA 和触摸输入。DevTools 面板边缘正中、靠页面一侧有一个抓手，用来调整大小，不遮挡 DevTools，触屏上更大。非外壳模式下，这个按钮仍然是投屏。
- `console.table` 传入对象时，和 Chrome 一样按字段分列显示，不再只有一列「Value」；以数组给出列名时只显示这些列。
- 新增 `Page.captureScreenshot` 和 `Page.getLayoutMetrics`：可以截取视口、指定区域或整个页面，由 snapDOM 绘制，并标注 `approximate: true`，供通过 CDP 操作页面的工具和 agent 使用。

## 0.1.0

基于 Chrome 156（156.0.8078.80）。

首次发布。
