# 变更日志

所有包使用同一个版本号，一起发布（见 DEV.zh-CN.md 的「发布到 npm」）。每个版本开头先写明它的 DevTools 前端来自哪个版本的 Chrome；版本规则也在 DEV.zh-CN.md 里。改动合入时记在 `Unreleased` 下，发布时挪到对应的版本号下。英文版见 [CHANGELOG.md](CHANGELOG.md)，两份内容保持一致。

## Unreleased

- Elements 的 Accessibility 窗格显示无障碍树；`Accessibility.getPartialAXTree`、`getFullAXTree`、`queryAXTree`、`getRootAXNode`、`getChildAXNodes`、`getAXNodeAndAncestors` 的应答与 Chrome 一致，供读取页面结构的工具和 agent 使用。树由 `accessibility.js` 在页面里计算，首次使用时从 bundle 旁边加载；其中打包了 dom-accessibility-api（MIT）。
- Animations 面板列出页面的 CSS 动画、过渡和 Web Animations，能暂停、拖动进度、改时间和调速。能找到 shadow 树（包括声明式的和宿主后插入的）和同源 iframe 里的动画；伪元素动画指向的节点与 Chrome 一致（`::backdrop` 例外，指向其 dialog，因我们的 DOM 没有它的节点）；分别开始的两个 CSS 动画分成两组。和 Chrome 一样报告 `getAnimations()` 漏掉的动画：无 target、不在文档里、立即结束或在第一帧前就取消的（探针挂钩 `animate()`、`new Animation()`、`play()` 和 `cancel()`）。调速会跟随页面自己设的速率，disable 时还给页面；拖动进度条时每个动画各自 seek 到自己的时间，已结束的先播放、停在结尾，与 Chrome 一致。前端删除最后一个动画分组时不再抛错。滚动驱动动画连同其滚动或视图时间线一起列出，以像素为单位，拖动 scrubber 会滚动页面。
- Rendering 面板和设备模式里的模拟媒体特性（`prefers-color-scheme`、减少动画、对比度、强制颜色等）和媒体类型、安全区、色觉缺陷模拟生效：通过改写页面的样式表，以及和 Chrome 相同的 SVG 滤镜实现。
- Styles 显示浏览器的「user agent stylesheet」规则，来自随包附带的 Chromium `html.css` 副本 `chromium-html.css`；Computed 窗格会自动刷新。
- 网络：屏蔽 URL、附加请求头、禁用缓存、离线和 UA 覆盖对页面的 `fetch()`、XHR 生效；列出页面能看到的 Reporting API 报告。
- Application 面板的 IndexedDB 和 Cache Storage 视图在页面写入时刷新；Service workers 视图列出页面的注册，能更新和注销；需要 worker 本身的命令返回错误「Not supported in the page」。
- Layout 窗格的 Grid、Flex、容器查询、scroll-snap 叠加层，隔离模式，设备模式的铰链和刘海，以及 frame 高亮，都在页面里画出。
- 问题面板显示 CSP 违规、弃用、怪异模式和表单问题；Console 显示慢 handler 和强制重排的 `[Violation]` 消息。
- 已链接的跨域 iframe 里的 `DOM.scrollIntoViewIfNeeded` 会和 Chrome 一样继续滚动外层页面。

### 接口变化

公开 API（以 `packages/*/etc/*.public.api.md` 为准）与 0.3.0 相比没有变化。

- `devtools-anywhere` 的 `dist/` 新增两个首次使用时才加载的文件：`accessibility.js`（导出为 `./accessibility.js`）和 `chromium-html.css`；自托管时和 bundle 放在一起。`chromium-html.css` 采用 LGPL（2.0 或更高版本），是包里唯一不属于 MIT 或 BSD 的文件；许可全文随附为 `chromium-html.LICENSE.txt`，两个文件都删掉只会少掉 user agent stylesheet 规则。新增依赖 `dom-accessibility-api`。
- 探针 minify 后从 18948 字节增到 19899 字节（其中 514 字节是 Animations 面板用的挂钩，属于探针的内部接口，不是公开 API）。
- 跨域 iframe 里的探针和父页面之间的消息新增内部事件 `DevtoolsAnywhere.scrollParent`：两边请使用同一版本的探针。

## 0.3.0

基于 Chrome 156（156.0.8078.80）。

- 支持同源 iframe，与 Chrome 一致：Elements 能展开；每个 iframe 在 Page 的 frame 树里有自己的 frame，在 Console 的上下文菜单里有自己的执行上下文，带着它的 console 消息和错误；Styles 显示它自己的样式表和媒体条件；Network 的请求标出所属 frame；高亮、检查模式和 Input 都能进入 iframe。shadow tree 里的 iframe 以及同源 `<object>`、`<embed>` 的文档同样是 frame；`Page.getResourceTree` 列出每个 frame 自己的资源。iframe 在 load 事件之前的日志和请求拿不到（srcdoc 和空 iframe 除外），导航要加载完成后才报出。
- 支持跨域 iframe：iframe 页面也加载探针，并且双方互相信任时（父页面配 `data-frame-origins`，iframe 页面配 `data-parent-origins`；Vite 选项为 `frameOrigins`、`parentOrigins`），它们作为子 target 接入，和 Chrome 的进程外 iframe 一样，通过 `Target.setAutoAttach` 和按 `sessionId` 转发的消息工作，直接嵌入、外壳模式、远程调试都支持。Elements 把它们的文档显示在 `<iframe>` 下（`DOM.getFrameOwner`），Console 里有它们的执行上下文；落在它们上面的输入会转进去，滚轮滚到底会传回父页面。每个接入它们的客户端各有自己的会话，与 Chrome 一致（比如页面上的 DevTools 和远程连入的 agent 同时调试）。导航后 target 保留，iframe 里再嵌的跨域 iframe 逐级接入。
- 支持没有 `allow-same-origin` 的沙箱 iframe（`src` 与页面同源、`about:blank` 或 `srcdoc`）：沙箱文档加载探针，父页面的 `data-frame-origins` 写 `sandboxed`、沙箱文档的 `data-parent-origins` 写父页面的源时，它并入父页面的 target，和 Chrome 一样留在那里，不开子 target。Elements 把它的文档显示在 `<iframe>` 下，Console 里有它的执行上下文和消息，Network 有它的请求，Sources 有它的脚本，Styles 有它的样式表；高亮、检查模式和 Input 都能进入它。默认关闭；`src` 跨源的仍然拒绝，同站的也一样。其余差异见使用说明的限制。
- `DOM.getNodeForLocation` 按文档坐标而不是视口坐标计算；`DOM.scrollIntoViewIfNeeded` 对不在视口内的元素滚到居中，与 Chrome 一致。`Input.dispatchMouseEvent` 悬停时按 Chrome 的顺序发出 `pointerout`、`pointerover`、`mouseout`、`mouseover`。
- `history.pushState`、`replaceState`、hash 变化以及 Navigation API 拦截的导航会发出 `Page.navigatedWithinDocument`，顶层页面和 frame 都是。
- 探针运行之前页面发出的请求，改为从 Resource Timing 补报（没有调用栈、请求头和请求体），Chrome 同样会报这些请求。
- `DOM.requestChildNodes` 不再重复发送客户端已有的子节点，与 Chrome 一致：前端请求两次时，展开的 iframe 会变成空白。
- 外壳模式下重新加载的前端开始一个新会话，与 Chrome 一致。
- 外壳模式下，页面的任何客户端（远程连入的 agent、`createCdpSession`）都能用 `Emulation.setDeviceMetricsOverride` 和 `clearDeviceMetricsOverride`，不再只限外壳自带的前端：以最后一次设置为准，客户端清除或断开时只撤销自己的设置；远程客户端的设置在页面重新加载后仍然有效，按客户端连上的先后重新应用，与 Chrome 一致。参数按 Chrome 的规则校验，报错相同；非外壳模式下这两条命令返回错误并说明原因。
- 页面做不到的命令（自动深色模式、开启焦点模拟、双指缩放、后台服务记录、绕过 Service Worker、自动填充地址、安全隔离状态、浏览器功能开关、网络限速、启用性能分析器等只有浏览器才有事件的域等）改为返回错误「Not supported in the page: <原因>」，不再假装成功或编造数据；`CSS.getEnvironmentVariables` 返回页面解析出的 env() 值；能在页面里实现、只是还没做的仍返回成功，并记进路线图。
- 直接嵌入的前端重新加载后，改为按命令 id 重新从 1 开始来判断，不再看 iframe 的 load 事件：load 晚于新前端的第一批命令，会把它刚启用的东西又关掉。
- `CSS.createStyleSheet` 遇到不存在的 `frameId` 时报错「Frame not found」，与 Chrome 一致。
- 并入的沙箱 iframe 与 Chrome 对齐：每个新文档分配新的 id，重新加载时销毁旧的执行上下文且 id 不复用，同一文档重新链接时沿用原来的；DOM 的撤销和重做把页面和并入的 frame 放在同一个历史里，按编辑先后，frame 里的 CSS 编辑也在内；向 frame 取文档、节点或坐标 1 秒内没有应答，按未应答处理；`Page.navigate` 接受沙箱 iframe 的 `frameId`，并入与否都行；`Page.disable` 之后不再发出 frame 排队的事件。

### 接口变化

公开 API（以 `packages/*/etc/*.public.api.md` 为准）只有新增，没有删除、改名或改动。

- 探针脚本属性（`devtools-anywhere`）：新增 `data-frame-origins`（本页 DevTools 可以调试的跨域 iframe 的源，空格分隔；写 `sandboxed` 调试它的沙箱 iframe）和 `data-parent-origins`（可以在 iframe 里调试本页的父页面的源）。
- Vite 插件选项（`@devtools-anywhere/vite-plugin`）：新增 `frameOrigins` 和 `parentOrigins`（数组），写进上面两个属性。
- CDP：页面做不到的命令改为报错 -32000「Not supported in the page: <原因>」，不再返回成功却没有效果（见上文）；`CSS.createStyleSheet` 遇到不存在的 `frameId` 时报错。CDP 应答和事件的其他变化都是向 Chrome 对齐的行为修正，见上文。
- 探针、外壳和远程服务之间的消息新增内部方法 `DevtoolsAnywhere.attach` 和 `DevtoolsAnywhere.metrics`：探针和 `@devtools-anywhere/remote-server` 请使用同一版本。

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
