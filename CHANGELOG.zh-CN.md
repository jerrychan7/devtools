# 变更日志

所有包使用同一个版本号，一起发布（见 DEV.zh-CN.md 的「发布到 npm」）。每个版本开头先写明它的 DevTools 前端来自哪个版本的 Chrome；版本规则也在 DEV.zh-CN.md 里。改动合入时记在 `Unreleased` 下，发布时挪到对应的版本号下。英文版见 [CHANGELOG.md](CHANGELOG.md)，两份内容保持一致。

## Unreleased

- 无障碍树不再使用 dom-accessibility-api：角色、label 文字和描述改由项目自己的代码计算，并用从该库的测试和 web-platform-tests 导入的用例与 Chrome 对照。更多节点的角色与 Chrome 一致（`role` 首个 token 无效时回退到下一个，`del`、`em`、`time`、`abbr`、`canvas` 等元素给出 Chrome 自己的角色），名称、描述、value 和 properties 也按 Chrome 的规则计算：导入的约 1800 条用例全部与 Chrome 一致，包括布局表格、图像热区和生成内容里的 CSS 计数器。`accessibility.js` 从约 29 KB 增至约 40 KB。
- `devtools-anywhere` 不再有运行时依赖：snapDOM 本来就已打进 `dist/snapdom.js`，改为开发依赖；dom-accessibility-api 已去掉。

## 0.4.0

基于 Chrome 158（158.0.8127.37）。

- DevTools 前端改为来自 Chrome 158（原为 Chrome 156），面板和界面随之更新；Styles 里显示的浏览器默认样式也改为 Chrome 158 的。
- Elements 的 Accessibility 窗格显示无障碍树；`Accessibility.getPartialAXTree`、`getFullAXTree`、`queryAXTree`、`getRootAXNode`、`getChildAXNodes`、`getAXNodeAndAncestors` 的应答与 Chrome 一致，供读取页面结构的工具和 agent 使用。树由 `accessibility.js` 在页面里计算，首次使用时从 bundle 旁边加载；其中打包了 dom-accessibility-api（MIT）。
- Animations 面板列出页面的 CSS 动画、过渡和 Web Animations，能暂停、拖动进度、改时间和调速。能找到 shadow 树（包括声明式的和宿主后插入的）和同源 iframe 里的动画；伪元素动画指向的节点与 Chrome 一致（`::backdrop` 例外，指向其 dialog，因我们的 DOM 没有它的节点）；分别开始的两个 CSS 动画分成两组。和 Chrome 一样报告 `getAnimations()` 漏掉的动画：无 target、不在文档里、立即结束或在第一帧前就取消的（探针挂钩 `animate()`、`new Animation()`、`play()`、`pause()` 和 `cancel()`）。调速会跟随页面自己设的速率，disable 时还给页面；拖动进度条时每个动画各自 seek 到自己的时间，已结束的先播放、停在结尾，与 Chrome 一致。前端删除最后一个动画分组时不再抛错。滚动驱动动画连同其滚动或视图时间线一起列出，以像素为单位；拖动 scrubber 会滚动页面，页面自己滚动时 scrubber 也会跟随，靠的是在页面里模拟的隔离世界（`Page.createIsolatedWorld`）和 binding（`Runtime.addBinding`）。任何伪元素的动画（`::backdrop`、`::scroll-marker`、`::column`、view transition 的，后面带伪类的也算）都按赢得其属性的规则分组，与 Chrome 一致；在元素上开始的 view transition 也能看到。挂钩不让页面察觉：`startViewTransition` 由 CSS 域挂在原型上，页面的 options 只读一次，作为新的字典传入，其中 `update` 被包装；`reverse()`、`finish()`、`updatePlaybackRate()` 和设新时间、新速率也能看到；面板的控制调用浏览器自己的函数而不是页面的（改时间除外：它经由效果的 `updateTiming()`，页面的 wrapper 能看到）；探针自己的错误不再经过页面包装过的 `console.error`。
- 模拟也作用于页面的 HTML 和 CSSOM：在媒体模拟下，`<picture>` 的 `<source>` 和图片的 `sizes` 与 Chrome 一样选出对应的资源；页面元素的 `style` 属性获得安全区的模拟值；页面通过 `insertRule()` 或 `replaceSync()` 插入的规则在同一任务里就生效，嵌套在样式规则里的也一样。对模拟改写过的媒体列表调用 `appendMedium()` 和 `deleteMedium()`，与 Chrome 一样按页面写入的各项查找。页面属性的值按页面写入的原样显示给客户端，agent 自己的写入不向客户端发出 DOM 域事件。对模拟改写过的属性或样式的编辑，撤销（`DOM.undo`）时回到页面写入的原文，模拟结束后不会留下改写后的文本。按文本的 DOM 搜索不再匹配 agent 加在节点上、不显示给客户端的属性（强制伪类状态的标记和强制颜色的标记；按选择器或 XPath 点名这种属性的搜索仍能找到节点，见能力边界）；撤销属性编辑也不再把该标记恢复成编辑时的状态。
- Rendering 面板和设备模式里的模拟媒体特性（`prefers-color-scheme`、减少动画、对比度、强制颜色等）和媒体类型、色觉缺陷模拟生效：通过改写页面的样式表、`<source>` 元素和图片 `sizes` 里的媒体查询，以及 `matchMedia()` 得到的查询（变化事件在下一帧发出），再加上和 Chrome 相同的 SVG 滤镜实现。色觉缺陷滤镜是顶层里一个遮罩的 backdrop-filter，不动页面自己在 `<html>` 上的 `filter` 和计算样式，并保持在页面之后打开的 dialog、popover 之上。用 String 对象（或能转换成该名字的对象）作类型添加的 `change` 监听器，同样收到模拟的事件；监听器的选项只读一次，与浏览器一致。`change` 监听器已被浏览器移除的 MediaQueryList（用 `once` 添加的，或其 signal 已中止的，即使页面停止了该 signal 的 `abort` 事件；Chrome 116 之前这一情形除外，见能力边界）可以被回收，与没有探针时一样。
- 安全区（`Emulation.setSafeAreaInsetsOverride`）通过模拟在 `:root` 上设置的自定义属性读取，改变数值不再改写页面的样式表：Styles 面板和样式表文本显示页面写的 `env()`，与 Chrome 一致；页面只改了简写的一边时，其余各边在模拟运行期间保持模拟的安全区，模拟结束后读到真实的安全区。简写后面跟着一个长写属性时，浏览器读简写为空，此时按文本比较：页面对它的编辑保留页面自己的值，不再被改回原来的 `env()`；不需要改写的改动保留浏览器写下的文本。页面读过、又被安全区模拟改写的样式表不再被报告为页面的改动（`CSS.styleSheetChanged`），模拟结束后也不再以序列化的文本提供（媒体模拟改写了 `@media` 规则的 `<style>` 仍可能被报告，见能力边界）。用 CSS 转义写的名字按 Chrome 的读法识别（`e\nv(…)` 即 `env()`）；页面覆盖在改写过的文本上的文本，若字符串里有注释记号（`content: "/*"`），也完整保留。页面覆盖在改写过的文本上的文本，模拟结束后按页面写入的原样恢复：style 属性逐字节一致（包括其中的注释、空声明和末尾的分号），值里函数或字符串未闭合的自定义属性在改写前后保持原值，页面之后通过 CSSOM 在它后面设置的声明也一样。`!important` 声明排在普通声明之前的规则，模拟安全区时保持两者的顺序；逻辑属性声明在对应的物理属性之前（`padding-inline-start` 在 `padding-top` 之前）或反过来的规则，以及 CSSOM 写过的这类 `style` 属性，也保持声明的顺序和层叠得出的值，即使后面的长写已被浏览器并进简写的文本里（`padding: 1px; padding-inline-start: …; padding-left: 2px`）；没有值可供重新添加的属性例外（`all`，以及值待定的简写中、另一边之后又被单独设置的各边，后者出现在不能凭页面写入时的内容得知的块里），它们留在原处，见能力边界；模拟没有改动的声明保留浏览器序列化的文本。一个块若声明了带 `env()` 的简写、后面又跟着同组的长写（`padding: max(env(safe-area-inset-top), 8px) 16px; padding-bottom: 0`），浏览器序列化时不带简写的文本，这样的块按 CSS 启用期间或模拟改写页面期间页面通过 CSSOM 写入它时的内容模拟：它被设成的文本和之后设置的各个属性，所以框架在模拟安全区期间逐个属性设置的元素样式（`el.style.padding = …; el.style.paddingBottom = …`）也被模拟。这样的块保持声明的顺序，模拟结束后读起来与页面写的一样；在 Styles 面板里对这样的规则的编辑，撤销（`DOM.undo`）时回到页面写的那个块。为了跟踪这些写入，agent 从加载起就代理 CSSOM 中规则列表和 style map 的函数，并且只在 CSS 启用期间或模拟改写页面期间代理 style 的 setter 及其 `setProperty()`、`removeProperty()`，在 `CSSStyleDeclaration.prototype` 上为 style 的属性名放置访问器。页面能察觉到：被代理的函数 `toString()` 显示时没有名字，经它们抛出的错误栈里多一到两帧 bundle，style 的属性名属于原型、不再是它自有的属性，写 style 的开销增加，后两项只在这些代理存在期间（清单见能力边界的「跟踪页面的写入」）。不能确知页面写了什么时，这种简写里的 `env()` 不被模拟：块里读出来不带值的各边保持原样，块的其余部分按它自己的文本改写（见能力边界）。安全区必须是 int32 范围内的整数，与 Chrome 一致，其他值以「Invalid parameters」失败。
- 模拟不再冻结这样的页面：页面脚本每次改动模拟改写过的属性时都把它改回原文，模拟的改写因此等待；页面持续改回时，无论在同一任务还是在各自独立的任务里，等待都更久。页面修改样式表自己的媒体列表（`sheet.media`）时，与修改规则的媒体列表一样在同一任务里生效。页面的 wrapper 若在探针取得这些原生函数之后才包装它们，便不再看到 agent 对元素、文档和 window 的这些调用：元素的属性方法和 `attributes`、`matches`、`querySelector(All)`、CSSOM 的 `insertRule()`、`deleteRule()`、`replaceSync()`，以及模拟改写时读写的样式表、规则、媒体列表和声明块的访问器与方法（`getPropertyValue()`、`setProperty()`、`removeProperty()` 等）、`adoptedStyleSheets`、`setTimeout`、`queueMicrotask`、`requestAnimationFrame`、`performance.now`、`getComputedStyle`、`MutationObserver`、`addEventListener` 和 `removeEventListener`。也就是模拟对属性和 CSSOM 的写入和强制颜色的扫描（色觉缺陷遮罩的元素仍通过页面的 DOM 函数创建和放置）、devtools-anywhere 隐藏的样式表、对改写过的元素的复制品的属性读写（`cloneNode()` 调用本身仍会被看到）、DOM 与 CSS 编辑及其撤销的属性写入，以及模拟自己的帧、定时器和观察器，都不再被这些 wrapper 看到。agent 的其它调用仍可能被看到：哪些调用不经过页面的 wrapper，见 docs/limitations.zh-CN.md。清除了全部计时器编号的页面不再让模拟的改写长久等待：其写入所在的回合在开始之后一秒结束。
- 页面脚本把模拟会改写的值改回另一种写法（例如模拟写入 `color-scheme: dark`，页面改回 `color-scheme:dark`），或改动同一属性里的其他声明（例如 `el.style.transform = …`）时，模拟不再反复写回该属性：样式属性只在它声明的值改变时才被改写，改变了值的改回和其他改回一样等待。页面观察器看到模拟写入后排定的定时器改回，无论页面的观察器和模拟的观察器谁先创建，都算作对该次写入的回应。
- 页面自己把模拟改写过的属性写回它先前的值（例如再次设置 `color-scheme`）时，与 Chrome 一样在同一任务里生效，不再推迟一帧。
- 模拟的 `prefers-color-scheme` 也作用于 `color-scheme`，与 Chrome 一致：同时含 light 和 dark 的值（样式表、style 属性、CSSOM 或 `<meta name="color-scheme">` 里的）取模拟的配色，因此 `light-dark()`、CanvasText 和表单控件按模拟的配色渲染。根元素不另外强制配色。Styles 窗格、样式表文本和 DOM 显示的仍是页面写入的原样，但页面通过 CSSOM 改过的样式表除外（见能力边界）。
- 模拟的媒体特性和媒体类型按客户端保存，与 Chrome 一致。一次调用撤销它的客户端之前设置的特性，因此省略 `features` 与 `features: []` 相同。另一个客户端设置的特性保留，除非本客户端之前设置过同名的特性：这时调用撤销该名称，即使之后是另一个客户端设置的。页面的媒体类型取最后一次调用的 `media`，无论哪个客户端调用；省略 `media` 即 `media: ''`，不设置媒体类型。客户端结束等于一次空调用：撤销它的特性，并清除媒体类型，无论是哪个客户端设置的。
- 对模拟的特性，Chrome 不认识的值使该特性恢复真实值，并取消同一特性之前的值；特性值里的转义与 NUL 按 CSS 的规则读取，`setEmulatedMedia` 给出的特性名按原样比较，与 Chrome 一致。
- 强制颜色用 Chrome 的调色板绘制页面，按模拟的或浏览器自己的 `prefers-color-scheme` 取深色或浅色调色板：文字、链接、按钮、输入框、mark 和选区用系统调色板的颜色，每个背景下是画布色（不透明的背景盖住它覆盖的内容，半透明的保留不透明度），页面的框架和 shadow root 里一并生效。保留颜色的元素（`forced-color-adjust: none`）不改，没有 `url()` 图片的背景去掉渐变。表单控件只改颜色；页面用 `!important` 设置且特异性更高的颜色，以及内联的 `!important` 颜色，保留自己的颜色；页面若在同一任务里、微任务里或零延迟的定时器里以添加元素来应答这些标记，新元素要过若干帧才绘制；在帧回调或更晚的定时器里应答的页面则按它自己的节奏继续添加，见[限制](docs/limitations.zh-CN.md#forced-colors)。
- Event Listeners 窗格（`DOMDebugger.getEventListeners`）不再列出已经运行过、并对后面的监听器停止了事件（`stopImmediatePropagation()`）的 `once` 监听器，也不再列出已被其 signal 移除、而页面的监听器停止了该 signal 的 `abort` 事件的监听器；运行过的 `once` 监听器不再被它的 signal 一直引用到中止为止；页面在自己的 `abort` 监听器里重新添加的监听器会被列出；用页面长期持有的 signal 添加监听器的元素，页面丢弃后可被回收，因为探针不再为记录事件监听器而在页面的 signal 上放 `abort` 监听器（没有 `AbortSignal.any` 的浏览器，即 Chrome 116 之前，MediaQueryList 的 `change` 监听器例外，见能力边界；带 signal 注册的 WebMCP 工具仍和以前一样加一个）。
- Styles 显示浏览器的「user agent stylesheet」规则，来自随包附带的 Chromium `html.css` 副本 `chromium-html.css`；Computed 窗格会自动刷新。
- 样式表按原文提供（`<style>` 的文本、重新取回的文件、或 `replace()`、`replaceSync()` 收到的文本），选择器、声明、注释掉的属性和 at 规则条件的 range 与 Chrome 一致；编辑（`setStyleTexts`、`setRuleSelector`、新增的 `setMediaText`、`addRule`、`setStyleSheetText`）按原样改写原文，不动 `<style>` 的文本和 id。页面通过 CSSOM 改样式表时发 `CSS.styleSheetChanged`（样式表自己的媒体列表 `sheet.media` 除外，与 Chrome 一致），此后原文改为序列化文本。没有 CORS 的跨源样式表，`getStyleSheetText` 报错。匹配样式包含元素动画的 `@keyframes`（取元素所在树作用域里生效的那些）；`setKeyframeKey`、`setSupportsText`、`setContainerQueryText`、`setContainerQueryConditionText`、`setScopeText` 按原样改写关键帧选择器和条件。以下与 Chrome（157）一致：页面通过样式规则内嵌的 `insertRule()`、`deleteRule()`，规则的媒体列表，`@counter-style` 和 `@font-feature-values` 规则，以及按属性名写入（`rule.style.color = …`，事后发现）所做的修改都能看到，而什么都没改的写入（不存在的属性名、`important` 以外的优先级）不算；样式表的规则经 CSSOM 或编辑改过后，header 的 `isMutable` 为真；注释掉的声明只有能解析时才报告；style 属性和被设了文本的样式按 Chrome 的文本和 range 读取，属性删掉后即忘掉原文；自定义属性保留 `{}` 值和 `\2d-x` 这类转义名，CSSOM 丢弃的嵌套规则之后的声明照样计入。`setStyleTexts` 拒绝改完不再是该规则样式的文本（「Style text is not valid」），所有 range 都按第一次编辑前的文本解读，某一项失败时撤销已做的编辑且不进撤销历史；`setRuleSelector` 和 `setMediaText` 在新文本解析失败时保留原规则。页面在启用 CSS 之前改过的样式表，一旦发现就发 `CSS.styleSheetChanged`；跨源样式表的副本迟到时不再覆盖更新的文本，也不再重复通知；规则按选择器的区别特征与原文配对。其余差异见[能力边界](docs/limitations.zh-CN.md#style-sheet-text)。
- 大样式表更快：CSS 的分词和大纲在 WebAssembly 里完成（内置在 bundle 中，没有新文件），页面的 CSSOM 修改和 `setStyleSheetText` 只更新涉及的规则，样式表在页面空闲时就核对原文并配对。2.6 MB 的样式表上（无头 Chrome，一台机器），`CSS.enable` 约 23 ms，空闲片刻后的第一次 `getMatchedStylesForNode` 约 200 ms。
- 网络：屏蔽 URL、附加请求头、禁用缓存、离线和 UA 覆盖对页面的 `fetch()`、XHR 生效；列出页面能看到的 Reporting API 报告。
- Application 面板的 IndexedDB 和 Cache Storage 视图在页面写入时刷新；Service workers 视图列出页面的注册，能更新和注销；需要 worker 本身的命令返回错误「Not supported in the page」。
- Layout 窗格的 Grid、Flex、容器查询、scroll-snap 叠加层，隔离模式，设备模式的铰链和刘海，以及 frame 高亮，都在页面里画出。
- 问题面板显示 CSP 违规、弃用、怪异模式和表单问题；Console 显示慢 handler 和强制重排的 `[Violation]` 消息。
- 已链接的跨域 iframe 里的 `DOM.scrollIntoViewIfNeeded` 会和 Chrome 一样继续滚动外层页面。
- 壳模式：Service Worker 按脚本内容的哈希记住每个同源脚本里 `debugger` 语句的位置，再次加载时不再重新解析（7 MB 的 bundle，在 Node 中实测：命中时约 5 ms，原先约 80 ms），改过的脚本会重新改写；同一行 `x-->0` 之后的 `debugger` 现在也能找到。Console 里同一行 `}` 之后的表达式重新给出结果值；名为 `catch`、`if` 等的方法不再干扰顶层 `return` 的判断。
- 内存：页面移除的 `<devtools-anywhere>`（页面放置的或全局的）连同其面板和 frontend iframe 可以被垃圾回收；移除的带 shadow root 的元素也能被回收，不必等页面增删 iframe，agent 的框架登记不再拉住它们。
- 打开面板时不再在页面控制台打出 `console.assert` 错误：控制台消息、未捕获错误和请求发起方的调用栈，每一帧都带上 Sources 面板按其 URL 列出的脚本的 id，Console 里的链接和 Sources 里的标记都落到这个脚本上。
- 在 Chrome 158 下，点击跨域或沙箱 iframe 里的元素重新会让它获得焦点，按键和文字能进入 iframe 里的输入框：从该版本起，跨域 iframe 的页面只有在其 frame 有焦点时才能让元素获得焦点，现在按下时先把焦点交给该 frame，和 Chrome 一样。
- 在浏览器自带 WebMCP API 的情况下（Chrome 158），调用表单工具时传入表单没有的参数，报的是 Chrome 的文字 `Input contains a parameter "…" but there is no such parameter for the tool`，不再是浏览器的 `Failed to parse tool input arguments.`。

### 接口变化

公开 API（以 `packages/*/etc/*.public.api.md` 为准）与 0.3.0 相比没有变化。

- `devtools-anywhere` 的 `dist/` 新增两个首次使用时才加载的文件：`accessibility.js`（导出为 `./accessibility.js`，附带 source map `accessibility.js.map`）和 `chromium-html.css`；自托管时和 bundle 放在一起。`chromium-html.css` 采用 LGPL（2.0 或更高版本），是包里唯一不属于 MIT 或 BSD 的文件；许可全文随附为 `chromium-html.LICENSE.txt`，两个文件都删掉只会少掉 user agent stylesheet 规则。新增依赖 `dom-accessibility-api`。
- 探针 minify 后从 18948 字节增到 27489 字节（原始字节，不是 gzip；保存 agent 调用的页面函数之前为 25409 字节），主要是 Animations 面板用的挂钩、`matchMedia()` 的挂钩，为其和色觉缺陷遮罩保存的浏览器原生函数，以及 agent 调用的函数（属于探针的内部接口，不是公开 API）。
- 壳模式下 Service Worker 把 `debugger` 改写记录存在 Cache API 的 `devtools-anywhere-service-worker-rewrites` 里；新 worker 激活时、退出壳模式时，以及不在壳模式的页面注销遗留的壳 worker 时删除。
- 跨域 iframe 里的探针和父页面之间的消息新增内部事件 `DevtoolsAnywhere.scrollParent`：两边请使用同一版本的探针。

## 0.3.0

基于 Chrome 156（156.0.8078.80）。

- 支持同源 iframe，与 Chrome 一致：Elements 能展开；每个 iframe 在 Page 的 frame 树里有自己的 frame，在 Console 的上下文菜单里有自己的执行上下文，带着它的 console 消息和错误；Styles 显示它自己的样式表和媒体条件；Network 的请求标出所属 frame；高亮、检查模式和 Input 都能进入 iframe。shadow tree 里的 iframe 以及同源 `<object>`、`<embed>` 的文档同样是 frame；`Page.getResourceTree` 列出每个 frame 自己的资源。iframe 在 load 事件之前的日志和请求拿不到（srcdoc 和空 iframe 除外），导航要加载完成后才报出。
- 支持跨域 iframe：iframe 页面也加载探针，并且双方互相信任时（父页面配 `data-frame-origins`，iframe 页面配 `data-parent-origins`；Vite 选项为 `frameOrigins`、`parentOrigins`），它们作为子 target 接入，和 Chrome 的进程外 iframe 一样，通过 `Target.setAutoAttach` 和按 `sessionId` 转发的消息工作，直接嵌入、外壳模式、远程调试都支持。Elements 把它们的文档显示在 `<iframe>` 下（`DOM.getFrameOwner`），Console 里有它们的执行上下文；落在它们上面的输入会转进去，滚轮滚到底会传回父页面。每个接入它们的客户端各有自己的会话，与 Chrome 一致（比如页面上的 DevTools 和远程连入的 agent 同时调试）。导航后 target 保留，iframe 里再嵌的跨域 iframe 逐级接入。
- 支持没有 `allow-same-origin` 的沙箱 iframe（`src` 与页面同源、`about:blank` 或 `srcdoc`）：沙箱文档加载探针，父页面的 `data-frame-origins` 写 `sandboxed`、沙箱文档的 `data-parent-origins` 写父页面的源时，它并入父页面的 target，和 Chrome 一样留在那里，不开子 target。Elements 把它的文档显示在 `<iframe>` 下，Console 里有它的执行上下文和消息，Network 有它的请求，Sources 有它的脚本，Styles 有它的样式表；高亮、检查模式和 Input 都能进入它。默认关闭；`src` 跨源的仍然拒绝，同站的也一样。其余差异见[能力边界](docs/limitations.zh-CN.md#sandboxed-iframes)。
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
