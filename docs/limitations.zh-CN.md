# 能力边界

[English](limitations.md) | 简体中文

devtools-anywhere 做不到的事，以及有意与 Chrome 不同的行为。接入方法见[使用指南](usage.zh-CN.md)；能在页面里做但还没做的见[路线图](roadmap.zh-CN.md)。

拿不到的数据要么精确补上，要么不显示：不把近似值当成事实。每一条写明 Chrome 怎么做、devtools-anywhere 怎么做，以及已知的原因。「与 Chrome 相同」标出这一条保留了 Chrome 的哪些行为。

<a id="overview"></a>

## 支持情况总览

下表的「支持情况」：「完整支持」与 Chrome 一样可用；「部分支持」可用，与 Chrome 的差异见链接的小节；「不支持」在页面里做不到。

| 功能 | 支持情况 | 概括 |
|---|---|---|
| 断点、Profiler、内存、性能 | 不支持：不打包这些面板 | [没有 JS API](#breakpoints-and-profiling)；`debugger;` 不会暂停 |
| 网络时序 | 不支持 | [没有 JS API](#network-timing) |
| 源代码 | 部分支持 | 文档、外链脚本和样式表、图片、字体和代码段，[但不列内联脚本](#sources) |
| 浏览器默认样式 | 部分支持 | Styles 里的「user agent stylesheet」规则来自 [Chromium 的 `html.css` 副本](#browser-default-styles) |
| 事件监听器 | 部分支持 | [只有探针运行之后添加的](#event-listeners)，没有源码位置 |
| WebSocket | 部分支持 | 连接和帧，[没有握手头](#websocket) |
| 同源 iframe | 部分支持 | 导航要到 load 事件才发现，[之前的日志和请求会缺失](#same-origin-iframes) |
| 沙箱 iframe（没有 `allow-same-origin`） | 部分支持 | 和 Chrome 一样[并入](usage.zh-CN.md#沙箱-iframe)父页面的 target，[有少数差异](#sandboxed-iframes)，否则[只显示为元素](#sandboxed-iframes-not-merged) |
| 跨域 iframe | 部分支持 | [需要 iframe 页面也加载探针](#cross-origin-iframes)、双方都配了[源名单](usage.zh-CN.md#跨域-iframe)才能调试，否则只显示为元素 |
| 隔离世界 | 部分支持 | Animations 面板所用的 `Page.createIsolatedWorld` 和 `Runtime.addBinding` [在页面自己的 JavaScript 世界里模拟](#isolated-worlds) |
| 跨源样式表 | 部分支持 | [需要 CORS，只读](#cross-origin-style-sheets) |
| 样式表原文 | 部分支持 | 返回原文，range 与 Chrome 一致，[CSSOM 改动后改为序列化，所有客户端共享](#style-sheet-text) |
| `@namespace` | 部分支持 | 选择器[靠临时采用一张我们自己的表来匹配](#namespace) |
| 强制 `:hover`、`:focus` 等 | 部分支持 | [不覆盖 `@import` 和 `adoptedStyleSheets` 的样式表](#forced-pseudo-classes) |
| Animations 面板 | 部分支持 | 列出、暂停、拖动进度、改时间，[调速设在每个动画上，另有其他差异](#animations) |
| 投屏（非外壳模式下的设备按钮） | 部分支持 | [由 snapDOM 从 DOM 重绘](#screencast)，每秒最多约 2 帧 |
| 截图 | 部分支持 | `Page.captureScreenshot` [由 snapDOM 绘制](#screenshots)，标注 `approximate: true` |
| 设备模式 | 部分支持 | [仅外壳模式，只改尺寸](#device-mode) |
| 全屏的页面 | 部分支持 | [有元素全屏时用不了 DevTools](#fullscreen-pages)；按 Esc 退出全屏即可 |
| Rendering 面板的模拟 | 部分支持 | [「模拟页面处于焦点」、自动深色模式、双指缩放重置做不到](#rendering-emulation)，返回错误 |
| 模拟媒体特性 | 部分支持 | 媒体特性和媒体类型[通过改写页面的样式表、`<source>` 元素、图片的 `sizes` 和 `matchMedia()` 收到的查询实现](#emulated-media) |
| 强制颜色 | 部分支持 | [系统调色板和画布色通过自有样式表实现，表单控件只改颜色](#forced-colors) |
| 模拟安全区 | 部分支持 | [在页面的样式表和 style 属性里，通过自定义属性读取](#safe-area-insets) `env(safe-area-inset-*)` |
| 色觉缺陷模拟 | 完整支持 | 和 Chrome 相同的 SVG 滤镜，作为顶层（top layer）里一个透明遮罩的 backdrop-filter：页面自己在 `<html>` 上的 `filter` 保留，`getComputedStyle` 看不到；页面之后打开的 dialog、popover、全屏元素会立即被压回遮罩之下，内嵌面板保持在遮罩之上（页面先打开 modal dialog 时，面板显示在遮罩之上但随页面一起 inert，鼠标点不到；不开滤镜时面板本来就被 modal 盖住）。滤不到：浏览器自己的弹层（`<select>` 下拉、日期选择器、customizable select 的 `::picker`）和 closed 声明式 shadow root 里的顶层元素（页面和我们都拿不到）。与 Chrome 的差异：同源 iframe 和页面一起滤一次，而不是各滤各的；模糊在视口边缘不向外淡出（约 4px：backdrop-filter 会重复边缘像素，把遮罩外扩到视口之外也不变） |
| 布局叠加层 | 部分支持 | Grid、Flex、容器查询、scroll-snap、隔离、铰链、刘海和 frame 叠加层，[按计算样式近似绘制](#layout-overlays) |
| 网络条件 | 部分支持 | [只对探针拦截的 `fetch()`、XHR 生效](#network-conditions)，不支持限速 |
| 无障碍树 | 部分支持 | Accessibility 窗格和 `Accessibility` 命令，由 `accessibility.js` [在页面里算出](#accessibility) |
| Application 面板 | 部分支持 | IndexedDB、Cache Storage 和 Service Worker，[有缺口](#application-panel) |
| 问题面板 | 部分支持 | CSP 违规、弃用、怪异模式和表单问题，[没有 Cookie、CORS、混合内容](#issues-panel) |
| Console 违规提示 | 部分支持 | [由 `long-animation-frame` 条目得出](#console-violations)的 `[Violation]` 消息 |
| 跨域 iframe 里的 `DOM.scrollIntoViewIfNeeded` | 完整支持 | 会继续滚动父页面，[在应答之后异步进行](#cross-origin-iframes) |
| 前端与页面同源 | 部分支持 | [DevTools 的设置会和页面共用 `localStorage`](#frontend-origin)，前端要放在别的源 |
| 浏览器 | 部分支持 | 页面这边现代浏览器都行，[DevTools 界面只在 Chrome 上验证过](#browsers) |

<a id="panels-without-a-js-api"></a>

## 没有 JavaScript API 的面板和数据

<a id="breakpoints-and-profiling"></a>

### 断点、Profiler、内存、性能

- **Chrome**：在断点和 `debugger;` 处暂停，分析 CPU 和内存，录制性能。
- **devtools-anywhere**：不打包这些面板。`debugger;` 不会暂停；外壳模式下改为输出一条带堆栈的警告。（由 Service Worker 改写页面的同源脚本。它按脚本内容的哈希记住每个脚本里 `debugger` 语句的位置：再次加载的脚本不必重新解析，改过的脚本下次加载就会按新内容改写，无需强制刷新。只记完整的 `200` 响应，最多 256 个 URL，最久未用的先淘汰。这些信息存在 Cache API 的 `devtools-anywhere-service-worker-rewrites` 里：每个脚本存 URL 的 SHA-256（不存 URL 本身，查询串不会落盘）、内容的 SHA-256、charset 和 `debugger` 语句的字节偏移，从不存脚本文本；以 `Cache-Control: no-store` 返回的脚本只记在内存里。退出外壳模式、外壳之外的页面注销遗留的 worker、或新版本的 worker 激活时，这份缓存会被删除；别的构建写下的记录会被忽略。）[远程调试](usage.zh-CN.md#远程调试)时，断点仍要靠浏览器自带的调试器（`chrome://inspect`、Safari Web Inspector）：页面里运行的仍是同一个页面内 agent。
- **原因**：没有 JS API。

<a id="network-timing"></a>

### 网络时序

- **Chrome**：显示每个请求的时序。
- **devtools-anywhere**：没有。
- **原因**：没有 JS API。

<a id="sources-and-event-listeners"></a>

## 源代码和事件监听器

<a id="sources"></a>

### 源代码

- **Chrome**：列出所有脚本，包括内联脚本。
- **devtools-anywhere**：文档、外链脚本和样式表、图片、字体；不列内联脚本。代码段可用。

<a id="event-listeners"></a>

### 事件监听器

- **Chrome**：列出所有监听器，带源码位置。
- **devtools-anywhere**：只有探针运行之后添加的；没有源码位置。被 `signal` 移除的监听器不会列出，但探针保留它的记录（连同监听函数），直到页面以相同参数调用 `removeEventListener()` 移除它、同一目标上下一次添加监听器，或该目标被回收。
- **原因**：监听器靠探针装的钩子看到。源码位置需要每次添加时捕获堆栈，会拖慢页面（见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)）。

<a id="css"></a>

## CSS 和样式表

<a id="browser-default-styles"></a>

### 浏览器默认样式

- **Chrome**：显示它所有默认样式表里的「user agent stylesheet」规则。
- **devtools-anywhere**：Styles 里的「user agent stylesheet」规则来自 Chromium 的 `html.css` 副本（`chromium-html.css`，首次使用时从 bundle 旁边加载）。含 Blink 内部选择器的规则不显示，`@supports blink-feature()` 按特性关闭处理，只用 `html.css`（不含 Chrome 的其他默认样式表）。bundle 内联（没有 URL）时不显示；站点删掉 `chromium-html.css` 时也不显示（见[包](usage.zh-CN.md#包)）。
- **Chrome**：Computed 窗格跟随每次样式变化。
- **devtools-anywhere**：Computed 窗格在 DOM 变动和 DevTools 自己修改样式时刷新，不是每次样式变化都刷新；合并的沙箱 iframe 里的节点不刷新。

<a id="cross-origin-style-sheets"></a>

### 跨源样式表

- **Chrome**：拿得到每张样式表的原文，也能编辑。
- **devtools-anywhere**：需要 CORS；只读。没有 CORS 时 `CSS.getStyleSheetText` 报错，也不显示规则。

<a id="style-sheet-text"></a>

### 样式表原文

返回样式表的原文，range 与 Chrome 一致，编辑按原样写入原文。不同之处：

- **`<style>` 的位置**：原文从 0:0 起算，不是它在 HTML 里的位置。
- **CSSOM 改动之后**：页面通过 CSSOM 改过样式表的规则后（`replace()`、`replaceSync()` 除外，样式表自己的媒体列表 `sheet.media` 也除外），原文改为从 CSSOM 序列化，格式与 Chrome 首次见到已被改过的样式表时一致：每条规则（含 `@import`）的文本后跟一个换行。Chrome 对已知原文的样式表是把规则文本拼进原文，且会滞后。原文里找到的规则与 CSSOM 配不上时、DevTools 打开前就构造的样式表，也改为序列化。
- **启用 CSS 前就被改过**：样式表在启用 CSS 前是否被页面改过，要到第一次用到原文时（`CSS.getMatchedStylesForNode`、`CSS.getStyleSheetText`、编辑）或页面空闲时检查才发现，而不是在登记时：`CSS.styleSheetAdded` 的 header 按写下的原文计算；发现改过后补发 `CSS.styleSheetChanged`，之后按序列化文本提供（header 的 `length`、`endLine`、`endColumn` 仍是先前发出的值，前端也不会重新获取）。Chrome 在 header 里直接给出最终文本，不发 `CSS.styleSheetChanged`；对脚本插入的 `<style>`，这个文本是把改过的规则文本拼在 `<style>` 原文之前。
- **按属性名赋值**：`rule.style.color = …` 这类赋值发生时 CSS 域得不到通知（Chrome 里这些名字是每个 style 对象自有的属性；agent 为它们放在原型上的访问器只通知模拟，见[跟踪页面的写入](#following-writes)），改为事后检测：页面通过 `rule.style` 取得过的规则，在下次使用原文之前与取得时的文本比对。因此修改要到下次使用原文时才被发现，`CSS.styleSheetChanged` 也随之延后。看不到的情况：CSS 启用之前就取得并保存的 style，之后通过它所做的修改；同时盯着的规则超过 2048 条时，相关样式表整表重新序列化并不再盯着这些规则，此后通过早先保存的 style 所做的修改。
- **header 的 `isMutable`**：与 Chrome 一样，样式表的规则经 CSSOM 被页面或编辑改过后即为 mutable，构造样式表始终是。这里不算、Chrome 却算的情况：CSS 未启用时（启用之前或关闭期间）页面所做的修改；按属性名赋了属性不接受的值（`rule.style.color = 'nope'`），因为比对的文本没变；同时盯着的规则超过 2048 条之后，通过从中取得的 style 所做的写入。
- **媒体列表**：`mediaText`、`appendMedium()`、`deleteMedium()` 的修改能看到，包括规则的媒体列表（`rule.media`）和样式表自己的媒体列表（`sheet.media`）。在任何会话或模拟开始监视 CSSOM 之前就取得的媒体列表，之后对它的修改看不到（不知道它属于哪条规则或样式表）。
- **开销**：CSS 启用期间或模拟改写页面期间，元素行内样式的 `style.cssText = …` 经过 agent 的一层代理和一层钩子，逐属性赋值（`el.style.left = …`）经过 agent 的访问器（见[跟踪页面的写入](#following-writes)）：这些写入明显比没有 agent 时慢，按名字写属性慢到数倍。两者都不在时，代理和访问器被摘掉，这些写入的开销与没有 agent 时相同。CSS 启用期间或模拟改写页面期间，页面读取规则的 `rule.style` 或样式表的 `sheet.media` 要经过钩子（`rule.media` 也是）；关闭 CSS 之后原生 getter 被还原，这类读取的开销回到原先的水平。
- **编辑 `@supports`、`@container`、`@scope` 的条件**：Chrome 保持原规则对象。这里整条替换该规则，因为 CSSOM 无法修改它们的条件：页面持有的该规则及其内部规则对象会脱离。
- **整体替换原文**（`CSS.setStyleSheetText`）：Chrome 先清空样式表的全部规则再重新解析，页面持有的每个规则对象都会脱离（`parentStyleSheet` 变为 `null`），文本未变的也一样。这里只删除并插入文本有变化的顶层规则，其余规则以原对象留在表中：大样式表里编辑代价低，页面的引用也仍然有效。
- **重新获取**：`<link>` 和 `@import` 的文件会再取一次（能用 HTTP 缓存时走缓存）。
- **多个客户端**：一个客户端编辑样式表（`CSS.setStyleSheetText`、`CSS.setStyleTexts`、`CSS.addRule` 等）后，Chrome 不通知其他客户端，它们保留旧原文。这里所有客户端（包括之后才启用 CSS 的）都看到最新原文及其 range，其他客户端收到 `CSS.styleSheetChanged`。其他客户端或页面改过该表后再撤销编辑，原文改为序列化文本。
- **编辑时的命名空间前缀**：`CSS.setRuleSelector` 和 `CSS.addRule` 接受带本表 `@namespace` 所声明前缀的选择器（如 `h|p`）。Chrome 会拒绝，因为它是在一张没有命名空间的空表里校验文本的。

<a id="namespace"></a>

### `@namespace`

- **Chrome**：原生匹配声明了命名空间的样式表的选择器。
- **devtools-anywhere**：声明了命名空间的样式表，其选择器（前缀、默认命名空间，含 `:host()`、`::slotted()`、`@scope` 内）靠临时采用一张我们自己的表来匹配，每次请求要遍历一遍文档，并重算按最后一段复合选择器可能被这些规则命中的元素（6 万个元素、其中 2 万个可能命中时约 15 ms）。没有前奏的 `@scope` 内仍按未声明命名空间匹配；根选择器带命名空间前缀的 `@scope`，算不出远近，按最远处理。

<a id="forced-pseudo-classes"></a>

### 强制 `:hover`、`:focus` 等

- **Chrome**：在所有样式表里强制状态。
- **devtools-anywhere**：不覆盖 `@import` 和 `adoptedStyleSheets` 的样式表。被强制的元素带有属性 `data-devtools-anywhere-force`，客户端看不到它，但指名它的查询能找到：`DOM.querySelector`、`DOM.querySelectorAll`，以及用选择器（如 `[data-devtools-anywhere-force]`）或 XPath 表达式（如 `//*[@data-devtools-anywhere-force]`）的 `DOM.performSearch`。devtools-anywhere 的样式表隐藏在文档或 shadow root 里时，页面在探针取得访问器之后才包装的 `adoptedStyleSheets` 访问器 wrapper，对该树的读取和赋值不再被调用；在探针之前包装的仍会被调用（见[页面的 wrapper](#emulated-media)）。

<a id="animations"></a>

## Animations 面板

来自 `getAnimations()` 的 CSS 动画、过渡和 Web Animations，以及用 `animate()` 或 `new Animation()` 创建的动画（无 target、不在文档中、立即结束的）：列出、暂停、拖动进度、改时间。与 Chrome 不同之处：

- **调速**：Chrome 设在时间线上。这里设在每个动画上，所以页面读到的 `playbackRate` 是乘过的（页面自己设的速率会保留，但恰好等于取负速率的值会被当作 `reverse()`）。
- **调速期间开始的动画**：开始时间与 Chrome 有偏差，因为 Chrome 是把文档时间线放慢。
- **pending 的动画**：一直 pending 的动画（时间线不活动）在 `disable` 后保留面板设的速率。
- **已结束的动画**：`getAnimations()` 之外已结束的动画若不是通过 `play()` 重新开始，则看不到。
- **文档范围**：只覆盖页面自己和同源 frame 的文档。
- **shadow 树**：shadow 树里的动画也会列出（包括声明式的、宿主后插入的、iframe 里的），但拿不到 closed 声明式 shadow root 里的（页面拿不到它的引用），也拿不到 UA shadow 树里的（如 `input::placeholder` 的）。
- **`::backdrop`**：Chrome 指向伪元素本身。这里 `::backdrop` 的动画指向它的 `<dialog>`，即 Elements 面板能显示的节点（还没有 `::backdrop` 节点：见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)）。
- **分组（`cssId`）**：与 Chrome 相同，`cssId` 按赢得动画属性的规则生成，两条规则里的相同声明分两组，`:hover` 的过渡和移出时的反向过渡也分两组。伪元素也一样，包括 Elements 面板不显示的 `::backdrop`、`::scroll-marker`、`::scroll-marker-group`、`::scroll-button()`、`::column`、`::view-transition-group()` 等（按名字、`*` 和 `view-transition-class` 匹配）。也与 Chrome 相同，`@import` 进来的样式表和构造样式表（没有 `ownerNode`）里的规则不参与 `cssId`。与 Chrome 不同的是：我们的 CSS 匹配漏掉的规则看不到；伪元素后的伪类只判定滚动按钮的 `:disabled`/`:enabled`、`:target-current`（按滚动位置近似）和视图过渡图像的 `:only-child`；视图过渡的 class 只有在 DevTools 之后开始的过渡才在开始时取，否则取当时元素的；shadow 树里的元素不算 class，`auto`、`match-element` 名字不按 class 匹配。
- **`seekAnimations`**：`currentTimes` 按协议的毫秒处理；Chrome 156 当成秒。
- **开始前被取消**：动画在开始前被取消或暂停时，只报告创建和取消。若取消前已跑过一帧动画更新（先出帧、后在定时器里取消），Chrome 还会先报告一次开始，这里少报这一次。
- **被垃圾回收的动画**：页面丢弃且已被垃圾回收的动画，按 id 查不到；Chrome 会保留到 `disable`。
- **还在解析的文档**：文档还在流式解析时，其声明式 shadow root 里的动画和样式表可能晚到，解析结束时补齐。
- **滚动驱动动画**（`scroll()`、`view()`、`ScrollTimeline`、`ViewTimeline`）：与 Chrome 相同，会报告 `viewOrScrollTimeline`（根滚动容器报为 `document`），时间单位为每像素 16µs。正在运行的滚动驱动动画 seek 无效；暂停的按换算后的时间 seek，截到终点。调速不作用于它们（面板选中滚动分组时调速按钮被禁用）。页面自己滚动时 scrubber 会跟随（通过[隔离世界](#isolated-worlds)），拖动 scrubber 也能改滚动位置。

<a id="isolated-worlds"></a>

## 隔离世界

- **Chrome**：`Page.createIsolatedWorld` 建一个有自己 JavaScript realm 的世界，与页面只共享 DOM。
- **devtools-anywhere**：支持 Animations 面板所用的 `Page.createIsolatedWorld` 和 `Runtime.addBinding`（`Runtime.bindingCalled`），在页面自己的 JavaScript 世界里模拟。
- **原因**：只有独立的 realm 才能避免[世界与页面共享的部分](#isolated-worlds-shared-javascript)里的差异。

<a id="isolated-worlds-global"></a>

### 世界的全局对象

- 世界里的代码有自己的全局对象：页面 window 的一个视图（是 `Window`，`window`、`self`、`globalThis` 和顶层 `this` 都指向它），在上面设的属性（包括 binding）和不加声明直接赋值的名字都只留在世界里。
- 与 Chrome 相同：哪里都不存在的名字会抛 ReferenceError，也不在 `window` 里（`in` 为 false），对它用 `typeof` 得到 'undefined'。为此会改写世界的代码：`typeof 名字`（包括加括号的）改为调用一个查询函数。因此世界里用 `eval` 执行的代码不改写，其中对这类名字用 `typeof` 会抛错；世界定义的函数 `toString()` 会露出改写后的代码；异常栈的列号会偏移。

<a id="isolated-worlds-nodes"></a>

### 被调用函数的节点

- **Chrome**：世界有自己的节点包装对象，世界的属性和页面的互不可见。
- **devtools-anywhere**：在世界里 `DOM.resolveNode` 后再 `Runtime.callFunctionOn` 时，`this` 就是页面的真节点。
  - 世界在它上面保留的属性，调用前放回节点，调用的同步部分结束后收回，返回的 Promise 结束后再收回一次（`await` 之后写的属性在此之前留在节点上）。
  - 同步部分结束后，节点上新增、改动或删除的属性，不论怎么写的（`Object.assign`、计算属性名、`Object.defineProperty`），都归世界；例外是调用派发的事件（调用期间监视 `dispatchEvent`，以及 HTML 和 SVG 元素的 `click`、`focus`、`blur`）里页面监听器写的属性，它们留给页面，与世界同名时也一样，此时世界保留事件之前它自己的值。
  - 调用期间这几个被监视的方法是代理：name、length 和 `toString()` 与原生的一致，页面在此期间换掉的方法也会保留，但页面读到的函数与之前不是同一个（`===` 不成立）。
  - 调用期间以其他方式运行的页面代码写的属性，会被当成世界的收走：经其他方法派发的事件（`requestSubmit()`、`select()` 等）、自定义元素的回调、世界用到的页面 getter 和 setter。
  - `await` 之后，只收回世界代码赋值或删除过的属性名（`.name =`、`['name'] =`、`delete x.name`）和作为字符串参数传入的名字；此时用 `Object.assign`、计算属性名等其他写法写的属性会留在页面的节点上。
  - 调用期间页面能在节点上看到世界的属性，世界也能看到页面的：它触发的监听器读到的是世界的值；事件之后、调用结束之前，世界读到的是监听器写的同名属性。Chrome 里二者互不可见。

<a id="isolated-worlds-shared-javascript"></a>

### 世界与页面共享的部分

除此之外世界与页面共享 JavaScript：

- 能读到页面的全局变量（页面默认上下文的 binding 也看得到）和对内置对象的改动。
- `document.defaultView`，以及宽松模式下直接调用的普通函数里的 `this`，是页面的 window 而不是世界的全局对象。
- 世界顶层的 `new.target` 是 undefined；Chrome 报 SyntaxError。
- 在其他对象上设的属性页面也看得到。
- `Runtime.evaluate` 的 `var` 和函数声明不会保留（待做：见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)）。

<a id="isolated-worlds-csp-and-frames"></a>

### CSP 和 frame

- **CSP**：Chrome 的世界不受页面 CSP 限制。这里页面 CSP 禁止 `eval` 时，世界照常创建和宣告，但在里面执行代码会像在页面默认上下文里一样失败，返回 EvalError。
- **frame**：只支持同源 frame 的世界。合并的沙箱 iframe 的 frame 会被拒绝（"No frame for given id found"）；转发给它的做法待做（见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)）。
- **与 Chrome 相同**：世界属于页面，各会话拿到同一个 id；frame 每加载一个文档，世界都以新 id 重新出现；多个会话添加同一个 binding 时，每次调用每个会话都会收到；`Runtime.removeBinding` 后函数仍在，只是调用不再上报。

<a id="iframes"></a>

## iframe

<a id="same-origin-iframes"></a>

### 同源 iframe

- **Chrome**：iframe 的导航一开始就发现。
- **devtools-anywhere**：iframe 的导航要到 load 事件才发现，比 Chrome 晚：在此之前的日志和请求拿不到，srcdoc 和空 iframe 除外；在此之前 iframe 脚本附加的 closed shadow root 也拿不到。

<a id="sandboxed-iframes"></a>

### 沙箱 iframe（没有 `allow-same-origin`）

[并入](usage.zh-CN.md#沙箱-iframe)父页面的 target 后和 Chrome 一样：它的 DOM、样式、执行上下文、console、请求和脚本都显示在父页面里，能高亮、检查和输入。并入后与 Chrome 不同之处：

- 跨沙箱边界移动或复制节点会报错。
- `DOM.performSearch` 的结果父页面在前、沙箱在后。
- 沙箱文档重新加载时，新的 `contentDocument` 直接带着子节点数，不发 `childNodeCountUpdated` 和 `scrollableFlagUpdated`。
- Chrome 为沙箱 iframe 起初的 about:blank 报的执行上下文没有。
- 向沙箱取文档、节点或坐标的请求 1 秒内没有应答，就按沙箱未应答处理（不嫁接它的文档，落在它上面的坐标命中 `<iframe>` 本身）。
- 从 Console 在沙箱里执行的代码，之后抛出的未捕获异常（比如在定时器里）不带异常对象（`exception` 为 null），也没有位置和堆栈。原因：沙箱文档把探针脚本当作跨源脚本，屏蔽了它的错误详情。沙箱页自己脚本的异常不受影响。
- 沙箱脚本的源码由父页面按 URL 重新获取，只能拿到父页面能取到的。
- 检查模式下悬停高亮被 iframe 边界裁剪，`highlightNode` 画的沙箱节点高亮不随滚动更新。
- 沙箱文档导航后 `frameNavigated` 的 `loaderId` 不变。
- 沙箱 frame 导航到没有探针的页面后，父页面仍留着旧文档。
- 在它里面建隔离世界会被拒绝：见 [CSP 和 frame](#isolated-worlds-csp-and-frames)。

<a id="sandboxed-iframes-not-merged"></a>

未并入（没有开启，或沙箱文档没加载探针）：

- **Chrome**：iframe 的文档、执行上下文和子 frame 都在页面的 target 里。
- **devtools-anywhere**：和 Chrome 一样列在 frame 树里，但只显示为元素，没有它自己的执行上下文和子 frame，请求只有它的文档本身。URL 取 iframe 上次 load 时的 `src`（或 `srcdoc`），不是它的脚本导航去的地址；MIME 类型固定为 text/html；名称取 iframe 的 `name` 属性，不是脚本设的名称。导航要到 load 事件才发现。
- **原因**：它的源是不透明的，页面拿不到它的文档。

<a id="cross-origin-iframes"></a>

### 跨域 iframe

- **Chrome**：跨站（cross-site）的 iframe 在进程外，作为子 target 调试。
- **devtools-anywhere**：需要 iframe 页面也加载探针，并且双方都配了[源名单](usage.zh-CN.md#跨域-iframe)，否则只显示为元素。要等 iframe 的探针运行后才连上：它的文档本身的请求报在它自己的会话里，而不是父页面的；导航后按 URL 设置的断点不会重新设上。导航后没有重新连接的页面，最多 10 秒后断开。
- **原因**：页面拿不到跨域 iframe 的文档。
- **与 Chrome 相同**：跨域 iframe 里的 `DOM.scrollIntoViewIfNeeded` 会继续滚动父页面。
- **`DOM.scrollIntoViewIfNeeded`**：父页面在应答之后异步滚动。

<a id="network"></a>

## 网络

<a id="websocket"></a>

### WebSocket

- **Chrome**：显示连接、帧和握手头。
- **devtools-anywhere**：连接和帧；没有握手头。

<a id="network-conditions"></a>

### 网络条件

- **Chrome**：作用于页面的所有请求。
- **devtools-anywhere**：屏蔽 URL、附加请求头、禁用缓存、离线和 UA 覆盖只对探针拦截的 `fetch()`、XHR 生效，文档本身的请求和其他子资源不受影响（外壳模式下的子资源见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)）。XHR 禁用缓存只对同源请求有效；跨源请求附加请求头会触发 CORS 预检；UA 只覆盖页面和已发现的同源 iframe。
- **限速**：不支持，返回错误（见路线图的[没有效果的命令](roadmap.zh-CN.md#没有效果的命令)）。
- **Reporting API**：只有页面能看到的报告。

<a id="emulation"></a>

## 投屏、设备模式和模拟

<a id="screencast"></a>

### 投屏（非外壳模式下的设备按钮）

- **Chrome**：传输渲染好的页面画面。
- **devtools-anywhere**：由 [snapDOM](https://github.com/zumerlab/snapdom) 从 DOM 重绘：canvas、视频、跨源图片可能缺失；每秒最多约 2 帧。输入以 `isTrusted: false` 的事件回放。

<a id="screenshots"></a>

### 截图

`Page.captureScreenshot`，供通过 CDP 操作页面的工具和 agent 使用：

- 和投屏一样由 snapDOM 绘制，并标注 `approximate: true`（Chrome 不返回这个字段）。
- 图片按设备像素计算（`devicePixelRatio` × `clip.scale`）。
- 超出画布上限（每边 32767 像素，Safari 为 16384，面积 16384 × 16384）时缩小，snapDOM 会在控制台警告。
- 不支持编码 WebP 的浏览器（Safari）退回 PNG。

<a id="device-mode"></a>

### 设备模式

- **Chrome**：任何时候都能用设备模式，含像素比、UA 和触摸。
- **devtools-anywhere**：仅外壳模式。只改尺寸，不改像素比、UA 和触摸；它的截图由 snapDOM 生成，按页面自身的像素比。外壳模式下任何客户端（包括远程连入的 agent）都能用 `Emulation.setDeviceMetricsOverride`；其他模式下返回错误。
- **与 Chrome 相同**：以最后一次设置为准；远程客户端的设置在页面重新加载后仍然有效；参数按 Chrome 的规则检查，报错也与 Chrome 相同。
- **"Invalid parameters"**：data 不带 Chrome 的 "at position N"（这是 Chrome 内部编码里的字节偏移）。
- **未知的 `devicePosture`**：type 不认识时照常接受，而 Chrome 会不再应答。

<a id="fullscreen-pages"></a>

### 全屏的页面

- **Chrome**：DevTools 在页面之外，不受页面全屏影响。
- **devtools-anywhere**：有元素全屏时用不了 DevTools，外壳模式下也一样。按 Esc 退出全屏即可。

<a id="rendering-emulation"></a>

### Rendering 面板的模拟

- **「模拟页面处于焦点」**：做不到，开启时返回错误。原因：在页面里使用 DevTools 时，焦点真的会离开页面元素，`:focus` 样式随之消失。
- **自动深色模式、双指缩放重置**：同样做不到，返回错误。
- 页面做不到的命令一律返回错误「Not supported in the page: <原因>」；能做但还没做的见[路线图](roadmap.zh-CN.md)。

<a id="emulated-media"></a>

### 模拟媒体特性

- **Chrome**：对整个页面模拟媒体特性。
- **devtools-anywhere**：`prefers-color-scheme`、`prefers-reduced-motion`、`prefers-reduced-transparency`、`prefers-contrast`、`forced-colors`、`color-gamut` 和媒体类型，通过改写页面的样式表和 `matchMedia()` 得到的查询、`<source>` 的 `media` 和图片的 `sizes` 实现（与 Chrome 一样，页面里的图片在创建时、以及其 `<source>` 改变时，浏览器会重新选择资源）。跨域样式表的规则不改写（它的 media 会改写），探针运行之前、同源 iframe 加载完成之前页面做的查询也不改写；`matchMedia()` 得到的查询的变化事件在下一帧发出，且不可信（`isTrusted` 为 false）；`light-dark()` 选的配色只通过模拟改写的 `color-scheme` 值跟随模拟的配色（见下面的「颜色方案」）：该值没有被改写的地方（带 `var()` 的值、跨域样式表的规则），配色不变。强制颜色还会绘制页面，见[强制颜色](#forced-colors)。页面自己的脚本读到的是改写后的值（`mediaText`、媒体列表的 `item()` 和各项、`media` 和 `sizes` 属性、`style`），页面自己的 MutationObserver 也会看到这些写入；`appendMedium()` 和 `deleteMedium()` 与 Chrome 一样按页面写入的各项操作，操作后列表仍是改写后的；只有 devtools-anywhere 的客户端看到的是页面写入的原值。`prefers-reduced-data` 不模拟：Chrome 157 不模拟它，其媒体查询交给浏览器处理。
- **错误**：经过被挂钩的 `matchMedia()`、其 `matches` getter 和 `Function.prototype.toString` 抛出的错误，栈里比 Chrome 多一帧探针的 bundle（`at Object.apply`），Chrome 的错误没有这一帧。经过顶层窗口的 `addEventListener` 和 `removeEventListener` 抛出的，多两帧（这一帧，以及探针原有的监听器包装），`change` 监听器在读取其 options 时抛出的实测多三帧；在探针挂钩过的同源 iframe 里，这两个函数是浏览器原函数的代理（名字、`length` 和 `[native code]` 都不变），多一帧，上述 `change` 监听器多三帧；经过 `addListener`、`removeListener` 和 `onchange` 的多三帧。顶层窗口的 `addEventListener` 和 `removeEventListener` 就是那个包装，所以它们的 `toString()` 显示的是其源码，而不是 `[native code]`；它们的 `name` 为空、`length` 为 3，而浏览器的有名字、`length` 为 2。CSS 启用期间或模拟改写页面期间被挂钩的 CSSOM 方法和访问器，名字和 `length` 不变，但 `toString()` 显示时没有名字，为 `function () { [native code] }`。agent 用来跟踪页面写入的那些函数从 agent 加载起就被代理（同源 iframe 里则从它的 realm 首次被挂钩起，见[跟踪页面的写入](#following-writes)）：在页面存续期间它们一直这样显示。经其中之一抛出的错误（规则解析失败、写计算样式）栈里多一帧 bundle（`at Object.apply`）；CSS 启用期间或模拟改写页面期间，其中同时又被挂钩的那些则多两帧：插入和删除规则的方法、`replace()`、`replaceSync()`、`setProperty()`、`removeProperty()` 和 `cssText` setter。
- **未挂钩的 realm**：同源 iframe 在 agent 发现它之前（即其导航的 load 事件之前，见[同源 iframe](#same-origin-iframes)），以及只有探针、没有 agent 的页面（它从不挂钩 iframe）：在那里，`Function.prototype.toString` 把顶层窗口被挂钩的函数显示为 `function () { [native code] }`。
- **探针不知道的监听器**：通过未挂钩的 realm 的原生 `addEventListener` 添加的监听器，探针不知道。该列表上没有探针知道的监听器时，它收不到合成的变化事件，浏览器对原查询自己的变化事件反而会送到它那里（不是模拟后的）；该列表上有探针知道的监听器时，它与其他监听器一样收到合成的事件；在探针知道的第一个监听器之前加入的，还会收到浏览器对原查询自己的事件，因为拦下这些事件的探针监听器是随那第一个已知监听器加入的，排在它之后运行。
- **时机**：通过 CSSOM 插入或改动的规则，以及样式表自己的媒体列表（`sheet.media`），在造成改动的那次调用里改写；`replace()` 在其 promise 完成后改写，`replaceSync()` 在调用里改写。设置的 `style` 属性或新增的 `<style>` 在所在任务的脚本之后（微任务里）改写。按属性名写在规则样式上的属性（`rule.style.color = …`）也在那次调用里改写，靠的是 agent 为这些名字放置的访问器（见[跟踪页面的写入](#following-writes)）；没有这些访问器的 realm 里，要等到下一次同步页面的样式表（样式表或模拟有变化之后）时，或 CSS 域读取该样式表时才改写，可能在页面已读取该样式之后。
- **守卫**：页面每次改动模拟改写过的属性（`style`、`media` 或 `sizes`）时都把它改回原文（守卫），每次改写都会被它的写入应答。模拟等待后再改写：在模拟写入的同一回合里应答的改回，每次都让等待加倍，最多 64 帧（60 Hz 下约一秒）。回合在其计时器运行时结束，或在开始之后一秒结束：清除了全部计时器编号的页面（比如循环调用 clearTimeout）会让这个计时器不再运行，回合于是在一秒后结束。其余的改回在各自独立的任务里、3 秒之内计数：不超过 3 次的立即改写；超过之后，每次写入都等待，并同样逐次加倍。守卫的 observer 看到模拟的写入后排定的定时器里的改回，算作同一回合里的应答，无论守卫的 observer 和模拟的 observer 谁先创建。页面因其他原因（如以另一种写法写入的媒体列表）频繁写入这类值时，也会如此。守卫存在期间，元素显示的是页面写入的原文，而 Chrome 显示模拟后的值：每次改写都应答的守卫，只要它还在运行，模拟就一直不在该元素上生效（例如 `env(safe-area-inset-top)` 的 padding 在每一帧里都按真实的安全区计算），守卫停止后模拟才生效。页面本身照常运行。
- **颜色方案**：同时含 light 和 dark 的 `color-scheme` 值（样式表、style 属性、CSSOM 或 `<meta name="color-scheme">` 里的）按模拟的 `prefers-color-scheme` 取值，与 Chrome 一样改写为该配色（写在原处的 `only` 保留，`only light dark` 成为 `only dark`），因此随它取值的 `light-dark()`、CanvasText 和表单控件与 Chrome 的渲染一致。根元素不另外强制配色；只含一种配色、`normal`，或 Chrome 不认识的值保持原样。`getComputedStyle().colorScheme`、`style.colorScheme` 和 `<meta name="color-scheme">` 的 `content` 读到的是改写后的值（深色偏好下 `light dark` 为 `dark`），Chrome 读到的是页面自己的值；Styles 窗格、样式表文本和 DOM 显示的仍是页面自己的值，但页面通过 CSSOM 改过的样式表除外（见「模拟媒体特性」的「复制与查询」）。带函数的值（如 `color-scheme: var(--scheme)`）不改写，页面因此跟随浏览器自己的偏好。
- **多个客户端**：页面上有多个客户端时，之后才链接的沙箱 iframe（已并入页面）按客户端逐个接收每个客户端最后一次的媒体模拟调用，客户端的先后按它们首次出现的顺序，而不是调用的先后；它的媒体类型可能与页面不同。
- **复制与查询**：页面在改写期间复制的元素（`cloneNode()`，或页面脚本复制的 `outerHTML`），会把改写后的值当成自己的，模拟结束后仍保留。页面写入的值恰好与模拟写入的文本相同时，被当作模拟的写入。选择器查询（`DOM.querySelector`、Elements 按选择器搜索）按改写后的值匹配。页面通过 CSSOM 改过的样式表，按规则序列化后提供，其中含改写后的值。
- **导入和自定义元素**：`@import` 在它的样式表加载完之后改写：其所属 `<style>` 或 `<link>` 的 `load` 事件到来时，这个事件在导入都加载完时才派发（实测了 `<style>` 里的 `@import`、用 `insertRule()` 加进去的 `@import`，以及 `<link>` 文件里的 `@import`）。对模拟写入的属性作出反应而改动它的自定义元素，模拟会跟随它改写。
- **样式表文本**：媒体模拟改写 `<style>` 里的 `@media` 规则期间，该样式表的文本首次被检查时，客户端可能收到它的 `CSS.styleSheetChanged`，因为其规则已与原文不符；Chrome 对此不发。
- **页面的 wrapper**：下面列出的调用，agent 用的是探针在页面代码之前取得的浏览器原生函数（探针是页面的第一个脚本），探针运行之后页面才包装上去的 wrapper 不会被调用：
  - 模拟的改写：它读写的元素的属性方法、`matches`、`querySelector` 和 `querySelectorAll`、元素的 `style` getter，它读写的样式表、规则、声明块和媒体列表的方法与访问器（`cssRules`、`media`、`cssText`、`mediaText`、`setProperty`、`removeProperty` 等），以及文档和 shadow root 的 `adoptedStyleSheets`；
  - 模拟的等待和回合：它的 `setTimeout`、`queueMicrotask`、`requestAnimationFrame` 和 `performance.now`（包括色觉缺陷遮罩的帧），以及 shadow root 和样式表监视用的 `queueMicrotask`；
  - 模拟及其跟随的 frame 和 shadow root 的 MutationObserver，以及模拟给页面文档添加的 `load` 监听器；
  - 强制颜色的扫描：它的 `getComputedStyle` 和 `getPropertyValue`、`querySelectorAll`，以及它给元素打标记用的属性；
  - 色觉缺陷遮罩的 `attachShadow`、`setAttribute`、popover 调用和监听器；
  - DOM 域对属性的读取和编辑（属性方法和 `attributes`，包括这些编辑的撤销与重做）、它的 `querySelector`、`querySelectorAll` 和 `matches`，以及 CSS 域按文本读写 `style` 属性、读写强制状态标记属性。

  除此之外，agent 的其它调用都可能被页面的 wrapper 看到。例如：其它域的 `getComputedStyle`、MutationObserver、定时器和 `performance.now`；DOM 树的读取和编辑（`parentNode`、`insertBefore`、`innerHTML`、`cloneNode` 等）；CSS 域直接读元素的 `style` 或通过它写入（`CSS.setEffectivePropertyValueForNode` 的 `el.style.setProperty`），以及它填充自己的样式表（`replaceSync`）；模拟为了给客户端显示页面写的原文而读取被改写的声明块或媒体列表的文本（`cssText`、`mediaText`），为了读出浏览器怎样解析一个声明块而创建元素（`document.createElement`，以及该元素的 `style`），以及在规则写入时的文本里查找该规则（声明块的 `parentRule`，规则的 `parentRule` 和 `parentStyleSheet`，样式表的 `href`，`<style>` 的 `textContent`，与该文本配对的各规则的 `cssRules`、`selectorText`、`keyText`、`parentRule` 和 `parentStyleSheet`，以及其 `@namespace` 规则的 `cssText`、嵌套在其间的声明的 `getPropertyValue()`（它们的 `style` 经浏览器自己的 getter 读取），为单独解析选择器而创建的 `CSSStyleSheet`，以及重新抓取样式表文件时响应的 `text()`；请求本身用的是探针取得的 `fetch`）；agent 用来跟踪页面写入的函数（见[跟踪页面的写入](#following-writes)），它们盖在 agent 加载时页面已有的函数之上（style 的那些在 CSS 启用或模拟开始改写页面时）并调用后者，以及为列出 style 的属性名而创建的元素（`document.createElement` 及其 `style`）；devtools-anywhere 注入样式表时用的各文档所在 window 的 `CSSStyleSheet` 构造函数；色觉缺陷遮罩的元素，经页面的 DOM 创建和放置（`createElement`、`append`、`remove`）；强制颜色扫描为 `forced-color-adjust: preserve-parent-color` 从元素向上的查找（`parentElement`、`assignedSlot`、`parentNode`、shadow root 的 `host`）。若探针不在页面代码之前（旧版探针，或页面代码先于探针运行），用的是 agent 加载时页面已有的函数，wrapper 会看到所有调用。
- **内存**：模拟运行期间，页面移除的同源 iframe 的 realm 上的钩子（CSSOM 的和 `adoptedStyleSheets` 的）保留到模拟结束，与 CSS 启用时相同：该 iframe 及其文档要到模拟结束后才被回收。页面移除的 shadow 宿主在模拟运行期间即可回收。`change` 监听器被 signal 移除的 MediaQueryList 与 Chrome 一样可被回收。在没有 `AbortSignal.any` 的浏览器（Chrome 116 之前）里，探针靠该 signal 自己的 `abort` 事件得知中止：若页面的监听器拦下了这个事件（`stopImmediatePropagation()`），探针的监听器会留在该列表上，使它不被回收。

<a id="forced-colors"></a>

### 强制颜色

- **Chrome**：按系统调色板绘制页面：每个不保留颜色的元素（`forced-color-adjust: none` 之外的元素）的文字、边框、链接和背景，表单控件由系统主题绘制，没有 `url()` 图片的背景里的渐变被去掉。
- **devtools-anywhere**：调色板是 agent 所知的页面每个框架和 shadow root 里的自有样式表（见下文「框架」），规则带 `!important`。保留颜色的元素、有背景的元素和失去渐变的元素，带有属性 `data-devtools-anywhere-forced-colors`，其中的记号（`kept`、`canvas`、`canvas-<percent>`、`no-image`）说明是哪一种；客户端看不到这个属性，模拟结束时标记和样式表都会去掉。与 Chrome 一样，背景变为画布色，所以不透明的背景会盖住它覆盖的内容；半透明的背景保留不透明度，按 5% 的步长取整，低于 2.5% 的则保留页面的颜色。
- **调色板**：与 Chrome 一样，按页面的 `prefers-color-scheme` 取深色调色板（黑底白字）或浅色调色板（白底黑字）：与强制颜色一同模拟的那个，否则取浏览器自己的；两者任一变化时调色板跟着变。Chrome 还按元素使用的 `color-scheme` 取选中文字的颜色（`Highlight`）：在 `color-scheme: dark` 下，深色调色板里是 `rgba(26, 235, 255, 0.8)`，浅色里是 `rgba(55, 0, 110, 0.8)`。这里选中文字总是 Chrome 在浅色 `color-scheme` 下给的颜色，即 `rgba(0, 230, 255, 0.8)` 和 `rgba(5, 0, 73, 0.8)`。
- **优先级**：Chrome 的强制颜色替换页面的颜色，无论特异性如何，包括 `!important` 声明和内联的 `!important` 声明。这里调色板的规则也带 `!important`，但特异性低，所以特异性更高的 `!important` 声明，以及内联的 `!important` 声明，保留自己的颜色。
- **表单控件**：Chrome 由系统主题绘制它们，边框、宽度和强调色（复选框、单选框和滑块的勾选与填充）都来自系统。这里只改颜色：边框保留浏览器的宽度和样式，强调色是浏览器自己的。
- **时机**：元素被加入页面时标记，模拟开始时已在页面里的元素在开始时标记。之后对它的渐变、背景或 `forced-color-adjust` 的改变（改 class、悬停样式，或父元素的 `forced-color-adjust` 被子元素继承），不会被看到；把元素移到另一个父元素下，或改分配到另一个 slot（改它的 `slot` 属性，或改宿主 shadow 树里的 slot），也不会被看到：它保留原来的标记，所以 `forced-color-adjust: preserve-parent-color` 的元素保留的是标记时所在的父元素或 slot 给它的结果。页面自己的 MutationObserver 若以添加元素来应答这些标记（比如每看到一次属性变化就添加一个），不会像在 Chrome 下那样保持静止，因为 Chrome 不写入任何这类页面能应答的东西。若它在标记的同一回合里应答（在观察者回调里、在微任务里，或在回合结束之前运行的任务里：回合由模拟在标记之后排入的一个零延迟定时器结束，不看任务是谁排入的；实测零延迟定时器、`MessageChannel` 消息和 `scheduler.postTask()` 回调都在它之前运行），该文档的扫描会把这些元素延后若干帧再标记：第一个延后的批次等 2 帧，之后每开一个新批次加倍，最多 64 帧（60 Hz 下约一秒）。批次等待期间到来的应答并入同一批，不延长等待。页面在标记的回合之外自己添加元素时，等待重新从 2 帧开始。这样的页面两秒内只添加几个元素（微任务和上述三种任务实测都是 6 个），元素在被标记之前显示自己的背景和渐变。强制颜色结束时这些等待被丢弃：下一次模拟从 2 帧重新开始。若它更晚才应答（在帧回调里，或带延迟的定时器里），这个应答与页面自己的添加无法区分，会立即标记：页面按它自己的节奏继续添加（60 Hz 下两秒内实测：帧回调应答 120 个，即每帧一个；50 ms 定时器应答 37 个）。页面自己添加的元素在加入的那一帧标记，除非它碰巧落在某次标记的同一回合里，比如分多个微任务或多个零延迟定时器加入的一批元素里靠后的部分：这些元素晚两帧标记（实测：一次调用加入 2000 个、连续 20 帧每帧 100 个、每帧一个持续三秒，都在加入的那一帧标记；分 20 个微任务或 20 个零延迟定时器加入 2000 个，2 帧之内标记完；这些方式接连进行时也在 2 帧之内）。等待按文档分别记：一个应答标记的 iframe 不会拖住页面的元素，页面也不会拖住 iframe 的。后台标签页里没有帧，等待靠定时器进行，而 Chrome 在后台会放慢定时器。
- **伪元素**：`::before` 和 `::after` 的文字、边框和阴影取调色板的颜色，阴影去掉，背景透明：它覆盖的内容会透出来，而 Chrome 会把它的画布色盖在上面。它们上面的渐变不会被去掉。
- **衬底**：文字画在绘制过的边框或半透明背景之上时，Chrome 在文字后面画一块衬底，改变了文字下面的像素；这里不改变它们。
- **计算值**：对大多数元素，`getComputedStyle()` 把 `text-decoration-color` 和 `column-rule-color` 报成调色板的颜色，而 Chrome 保留页面的颜色；`color-scheme` 报成页面的值，而 Chrome 计算为 `light dark`。根元素和 `<body>` 的 `background-color` 读到的是画布色（深色调色板为 `rgb(0, 0, 0)`，浅色为 `rgb(255, 255, 255)`），而 Chrome 保留页面的值、把画布色画在它后面；其他元素的背景读数与 Chrome 一致，即按页面给的不透明度取画布色（深色调色板下，不透明的为 `rgb(0, 0, 0)`，50% 的为 `rgba(0, 0, 0, 0.5)`），只有半透明背景不透明度的取整和低于 2.5% 的背景（见上）不同。透明背景保留页面的值 `rgba(0, 0, 0, 0)`，而在浅色调色板下 Chrome 读作 `rgba(255, 255, 255, 0)`。
- **保留颜色的元素**：`forced-color-adjust: none` 的元素若从父元素取颜色（自己没有设 `color`，或 `background-color: inherit`），得到的是父元素强制之后的颜色（调色板的颜色），而 Chrome 给它页面给父元素的颜色。`forced-color-adjust: preserve-parent-color` 沿扁平树读取（取元素被分配到的 slot），闭合的 shadow root 除外：其 slot 不向页面暴露（`assignedSlot` 为 null），被分配进去的元素按其 DOM 父元素的子元素处理。
- **查询**：指名该标记的查询能找到被标记的元素，尽管客户端看不到这个属性：`DOM.querySelector`、`DOM.querySelectorAll`，以及用选择器（如 `[data-devtools-anywhere-forced-colors]`）或 XPath 表达式（如 `//*[@data-devtools-anywhere-forced-colors]`）的 `DOM.performSearch`。按文本的搜索不会匹配它。
- **页面自己看到的**：页面的脚本和 MutationObserver 能看到这些标记，它的 `outerHTML` 也含有这些标记；只有 devtools-anywhere 的客户端看到的是页面写入的原样。
- **框架**：调色板覆盖同源 iframe，以及 devtools-anywhere 知道的 shadow root（其中闭合的，只包括探针记录下的）；跨域 iframe 的文档够不着。

<a id="safe-area-insets"></a>

### 模拟安全区

- **devtools-anywhere**：页面的样式表和元素的 `style` 属性里，每个 `env(safe-area-inset-*)` 和 `env(safe-area-max-inset-*)` 都通过模拟在 `:root` 上设置的自定义属性读取（`--da-sai-top`、`--da-sai-max-top` 等），写成 `var(--da-sai-top, env(safe-area-inset-top, 7px))`。没有设置的边保留真实的安全区，改变数值只改变这些属性。跨域样式表的规则不受影响。
- **页面的脚本**：它读到的是改写后的文本，通过 `element.style`、`getAttribute('style')`、规则的 `style` 和 `cssText`：Chrome 给出 `env(safe-area-inset-top, 7px)` 的地方，这里是 `var(--da-sai-top, env(safe-area-inset-top, 7px))`。`getComputedStyle()` 会列出 `--da-sai-*` 属性，并在 `:root` 上读到它们，Chrome 上没有这些属性。计算值与 Chrome 一致，覆盖的情况包括：回退值、简写、自定义属性、max 安全区、切换和结束模拟、shadow 树和同源 iframe。模拟改写或恢复 `style` 属性时，页面自己观察该属性的 MutationObserver 会收到 Chrome 的模拟不会产生的记录：属性按文本写入时一条；逐条声明写入并放回声明顺序时有多条（见下面的「声明的顺序」；对两个这样的属性实测为 10 条和 15 条，每设置或清除一次安全区各一轮）；按页面自己的写入重做该块时（见「简写后面跟着长写」），块起始的文本一条，之后设置的每个属性各一条（`el.style.padding = …; el.style.paddingBottom = …` 为 3 条）。这些记录的旧值（`attributeOldValue`）显示的是改写后的文本（`var(--da-sai-top, env(safe-area-inset-top))`）。没有模拟在改写页面时，页面的观察器收到的记录与 Chrome 相同，没有多出的。浏览器写成不带值的各边，有没有模拟读起来都一样。
- **交给客户端的值**：Styles 面板、`CSS.getMatchedStylesForNode`、`CSS.getInlineStylesForNode` 和 `CSS.getStyleSheetText` 显示页面写的 `env()` 文本，与 Chrome 一致，包括 `@media`、`@supports` 等规则里嵌套的规则，以及 `@keyframes`、`@font-face` 规则里的；`CSS.getComputedStyleForNode` 不列出 `--da-sai-*` 属性。页面通过 CSSOM 改过的样式表，或含有比较尚不认识的规则种类的样式表，会整张序列化（见[样式表原文](#style-sheet-text)）。
- **部分修改**：带 `env()` 的简写，页面只改了其中一边（如 `el.style.paddingLeft = …`）时，其余各边在模拟运行期间保持，模拟结束后读到真实的安全区，与 Chrome 一致；页面自己的声明按它写的样子保留。这种简写的文本是浏览器自己的，其各边写成空的长写属性，与 Chrome 的写法相同。在不能凭页面的写入得知其块的 `style` 属性里，或页面在模拟安全区期间写入的这类规则里（见下一条），同一块里页面没改的其他声明，模拟结束后仍保留 `var()` 文本（页面的脚本读到的是它，Chrome 保留 `env()`），它们的值同样是真实的安全区，顺序也与 Chrome 相同。这样的块里有不带值的自定义属性（`--x: ;`）时也是这样。对读出不带值的各边、按自身文本改写的规则（不能凭页面写入得知的，见下一条），Styles 面板列出的不带值的长写可能比 Chrome 少（`CSS.getMatchedStylesForNode`）。知道页面写入时的内容的块（见下一条），模拟结束后读起来与 Chrome 相同；不知道时与这样的 `style` 属性一样。
- **简写后面跟着长写**：一个块若声明了带 `env()` 或 `var()` 的简写、后面又跟着同组的某个长写（`padding: max(env(safe-area-inset-top), 8px) 16px; padding-bottom: 0`），浏览器会把它写成不带值的长写（`padding-top: ; padding-right: ; padding-left: ; padding-bottom: 0px;`），也不以任何别的方式给出简写的文本：`env()` 不在模拟读到的文本里。这样的块按页面写入它时的内容改写，模拟结束时再按它恢复；这些内容由 agent 在页面写入时记下（见下面的[跟踪页面的写入](#following-writes)）：
  - 页面从未通过 CSSOM 写过的规则：该规则在这些文本里的那一段：传给 `insertRule()` 或 `addRule()` 的文本，传给 `replace()` 或 `replaceSync()` 的文本，它所在 `<style>` 的文本，或它的 `<link>`、`@import` 的文件；但只在 agent 从加载起就跟踪写入时才采用（`ALWAYS`，见[跟踪页面的写入](#following-writes)末尾）。现在不是这样：这些文本都不采用，也不为此重新抓取文件，这样的规则不被模拟（见下文）。采用时，文件用探针加载时取得的 `fetch()` 重新抓取（页面之后包上去的 wrapper 不会被调用），多半来自 HTTP 缓存，带同源请求的凭据，`<link crossorigin="use-credentials">` 的则对别的源也带凭据；这次请求不上报给客户端（Network 域），页面的 Service Worker 能看到它，是一次 `fetch()`（mode 为 `cors`，cache 为 `force-cache`，没有 destination），而样式表自己加载时是 `style` 请求；
  - 通过 CSSOM 写过的块，规则的或元素的：它被设成的文本（`style.cssText = …`、`el.style = …`），或第一次被记下的写入之前它读出的文本，以及之后依次设置或移除的每个属性（`setProperty()`、`removeProperty()`、按名字写属性）。改写时把同样的写入重做一遍，其中每个 `env()` 换成改写后的；恢复时按页面原来的写法重做一遍：同样的写入，浏览器得出同样的块，其中没有任何猜测。块只凭 CSS 启用期间或模拟改写页面期间页面所写的内容得知，并且从一次整段文本的写入（`cssText`）开始，规则则从这期间的第一次写入开始：脚本在模拟安全区期间逐个属性设置的元素样式（`el.style.padding = …; el.style.paddingBottom = …`，框架就是这样做的）这样被模拟；在此之前这样设置的不被模拟（见下文）。

  此时这种块的计算值、顺序（`style[i]`）以及模拟结束后的文本都与 Chrome 相同。一致性测试对照的是：规则里的 `padding`、`margin`、`inset`、`border-width`、`scroll-padding` 和 `padding-inline`，在从左到右、从右到左和竖排的元素上；元素样式里的 `padding` 和 `margin`。在 Styles 面板里编辑这样的规则，撤销（`DOM.undo`）时回到页面写的那个块，前提是这个块这样得知。不得知时（比如页面在监视期间从未写过的 `<style>` 规则），撤销把规则设回编辑前读出的文本，其中简写的各边没有值：简写丢失（`padding: env(safe-area-inset-top) 2px; padding-bottom: 0` 变成 `padding-bottom: 0px`），Chrome 的撤销则保留它。

  记下的内容只在确知它就是该块时才使用：
  - 一个块的写入记录，遇到写入时得不到内容的写入就作废（只是这一份记录：之后用带 `env()` 的文本设 `cssText`，或对元素而言之后一次可能调用 `env()` 的写入，会开始新的记录）：值或名字是对象；通过 Typed OM 的写入（`attributeStyleMap`、`styleMap`）；记下的写入超过 64 次（同一属性紧接着再设一次会顶替前一次写入，所以要轮流设置几个属性才会达到，比如脚本做的动画）；
  - 元素的块只有在 agent 知道该 style 属于哪个元素（这个 style 是在 agent 跟踪的 realm 里以 `el.style` 读出的）、并且从开始记录的那次写入之前起就观察着该元素的 `style` 属性时，才有记录。行内样式的每一次改动都是这个属性的一次改动，不论由谁做出：不是 agent 看到的写入所造成的改动会使记录作废，不管此后块读起来是什么。通过别的 realm 的函数（`frame.contentWindow.CSSStyleDeclaration.prototype.setProperty.call(el.style, …)`）、页面在 agent 加载之前取走的函数、`setAttribute('style', …)` 或 Typed OM 所做的写入都是如此；
  - 规则的块被改动时没有任何迹象。它的记录保留每次写入之后块读出的文本，下一次写入之前或使用记录时块读出的文本与之不同，记录就作废；
  - 元素的记录只在它的 `style` 属性读起来就是浏览器对该块的序列化时使用：之后被设置过的属性（`setAttribute('style', …)`）本身就是那个块，按一般的文本改写；
  - 每次使用之前，把记录里的写入在 agent 自己的一个块上重做一遍，它必须与页面的块读起来相同，文本和顺序都相同；不同则记录作废；
  - 样式表或插入规则的文本现在不当作规则的块（`ALWAYS` 为 false）：没人监视期间的写入看不到。`ALWAYS` 为 true 时，只在 agent 加载以来页面没有写过该规则的块、且该规则所在列表里的规则（插入的除外）仍是文本里的那些时才采用：文本里的某条规则被删除过的规则列表（`deleteRule()`、`removeRule()`），以及页面追加或删除过关键帧的 `@keyframes` 规则，此后不再为其中的规则给出文本；`replace()` 尚未完成的样式表也不给出；`<style>` 或文件的文本只在顶层窗口里采用；客户端设置过文本的样式表（`CSS.setStyleSheetText`）按那个文本，客户端添加的规则（`CSS.addRule`）按它自己的文本。

  不能这样确知页面写了什么时，这种简写里的 `env()` 不被模拟（top 安全区为 20 时，上面的 padding 计算为 `8px 16px 0px`，Chrome 给出 `20px 16px 0px`），也不会按某个文本去设置该块：它的各边保持原样，块里的其他声明照常模拟，该块按一般的块改写（它留下的差异见下面的「声明的顺序」）。属于这种情况的有：
  - 写入未被跟踪时写下的块：CSS 未启用、模拟也未改写页面期间，agent 加载之前，或同源 iframe 里它的 realm 被挂钩之前；每条记录都在监视结束时作废，监视之前的一律不采用。页面从未通过 CSSOM 写过的规则也是这样，以及监视期间第一次写入时已经含有空值长写的规则，因为它的文本不采用（上一列表）；
  - 页面按文本写下 `style` 属性、之后又通过元素的 style 做了不含 `env()` 的写入（对 `<div style="padding: env(…) 2px; padding-left: 0">` 执行 `el.style.color = …`）：属性于是成了浏览器的文本，这个块没有记录。保持页面所写文本的属性会被模拟，因为它的文本里有 `env()`；
  - 记录已作废、列表不再给出其规则（比如交错地删除和插入规则：`deleteRule(1); insertRule('.c {}', 0); deleteRule(1)` 之后，样式表文本里的规则已不在文本所说的位置；插入的规则也不模拟，因为它们的文本不采用：模拟结束后样式表读起来与 Chrome 相同）、文件无法重新抓取或文件里已找不到该规则，以及规则读起来与它在样式表文本里的那一段不同；
  - agent 不知道属于哪个元素的行内样式（通过别的 realm 的 `style` getter 取得的，或在 agent 加载之前取得的），以及以 agent 看不到的方式写过的行内样式（见上一个列表）。

  一个块仍可能被设成已不属于它的文本，只剩这一种途径，而且只限于规则的块：agent 看不到的写入，并且这些写入之后块读起来与 agent 看到的最后一次写入之后一样（简写设成另一个 `env()`、后面再设同一个长写，两次都以 agent 看不到的方式）。agent 看不到的写入有：通过别的 realm 的函数所做的（iframe 的 `CSSStyleDeclaration.prototype.setProperty`，包括在同一个任务里创建并使用的 iframe），通过页面在 agent 加载之前从原型上取走的函数所做的（保存下来的 `setProperty`），以及按名字写入、而该名字的访问器已被页面从原型上去掉的。此时该规则按记下的内容模拟，模拟结束时被设成记下的内容：浏览器没有给脚本任何办法把这样的规则与没被写过的规则区分开。元素的块不会被这样设置：任何 agent 没看到的写入都会使它的记录作废。
- **跟踪页面的写入**：<a id="following-writes"></a>为了知道一个块写入时的内容（上一条），agent 在 CSSOM 的原型上放置代理。分两组，存在的时间不同（见本条末尾的 `ALWAYS`）：
  - 从 agent 加载起，在顶层窗口；同源 iframe 则在它的 realm 首次被挂钩时（CSS 启用期间或模拟改写页面期间，对 agent 当时知道的框架；页面在同一个任务里创建并使用的框架，在挂钩之前就被使用了，经它的函数所做的写入看不到），一直留到页面结束：`insertRule()` 和 `deleteRule()`（样式表的、分组规则的和样式规则的）、`addRule()`、`removeRule()`、`replace()`、`replaceSync()`、`@keyframes` 规则的 `appendRule()` 和 `deleteRule()`，以及 `StylePropertyMap` 的 `set()`、`append()`、`delete()`、`clear()` 和 `styleMap`、`attributeStyleMap` 两个 getter；
  - 只在 CSS 启用期间或模拟改写页面期间存在，之后再摘掉：声明块的 `cssText` 和 `cssFloat` setter、`setProperty()` 和 `removeProperty()`；`CSSStyleDeclaration.prototype` 上为浏览器给 style 的每个名字、按它接受的每种写法（`paddingTop`、`padding-top`、`webkitTransform`、`WebkitTransform`：Chrome 157 里共 1551 个）放的访问器，读时经过 `getPropertyValue()`，写时经过 `setProperty()`；以及 `HTMLElement.prototype`、`SVGElement.prototype` 和 `MathMLElement.prototype` 的 `style` getter，agent 借此知道行内样式属于哪个元素。按名字写属性（`el.style.padding = …`）在 Chrome 里不经过任何函数，这些名字是每个 style 对象自己的属性：所以要有访问器。一致性测试对每个名字用 20 个值与浏览器自己的读写做比较。

  函数的代理保留名字和长度，但打印为 `function () { [native code] }`，没有 Chrome 在那里打印的函数名（`function setProperty() { [native code] }`）；它们给错误多出的栈帧见[模拟媒体](#emulated-media)的「错误」。页面能看出的差异，第一组任何时候都有，第二组只在它存在期间：
  - 这些名字属于原型，不再是每个 style 自己的：`Object.hasOwn(el.style, 'padding')` 为 false，`Object.getOwnPropertyDescriptor(el.style, 'padding')` 为 undefined，Chrome 里是数据属性，所以 `Object.keys(el.style)`、`Object.getOwnPropertyNames(el.style)` 和 `Reflect.ownKeys(el.style)` 列出的键（与 Chrome 相同）与描述符对不上；`'padding' in CSSStyleDeclaration.prototype` 为 true，原型自己有 1561 个名字，Chrome 的只有 10 个。对元素的 style、规则的 style 或 computed style 做 `for … in`，列出的名字与 Chrome 相同、顺序相同（访问器不可枚举），`in`、`JSON.stringify(el.style)` 和 `Object.assign(el.style, …)` 的结果与 Chrome 相同。复制 style 自有属性（`{ ...el.style }`、`Object.entries(el.style)`、`Object.values(el.style)`）得不到这些名字，Chrome 里都有；
  - `Object.defineProperty(el.style, 'color', { value: 'teal' })` 在 style 对象上建了一个属性，此后它遮住该 CSS 属性（`el.style.color` 读出 `teal`，`getPropertyValue('color')` 读出原来的值），Chrome 里则设置该 CSS 属性。`Object.prototype` 上与 style 名字同名的属性不会代替 CSS 属性被读到，Chrome 里会；
  - style 的 `Proxy`（`new Proxy(el.style, {})`）按名字读写 style 的属性与 Chrome 相同，经过也传递 receiver 的 trap 也一样。每次这样的读写都要把访问器从原型上摘下再放回，比 Chrome 慢得多，并使页面写入的所有记录作废，因为这次写入看不到；写入之后 `Object.hasOwn(proxy, 'color')` 为 false，Chrome 里为 true。页面冻结过的原型上访问器摘不下来：读出 undefined，写入不生效；
  - 访问器的函数和 `style` getter 是 agent 自己的：名字是 `get padding`、`set padding` 和 `get style`，`toString()` 打印它们的源码；
  - 按名字写入出错时（写 computed style，或写 Symbol），错误说的是 `Failed to execute 'setProperty' on 'CSSStyleDeclaration'`，Chrome 说的是 `Failed to set a named property 'color' on 'CSSStyleDeclaration'`，并且多一帧 bundle 的栈（访问器的）；
  - 没有模拟改写页面时，页面的 MutationObserver 收到的记录与 Chrome 相同，没有多余的：agent 用自己的观察器观察那些块有记录的元素的 `style` 属性；
  - 开销：元素样式的写入（按名字、经 `setProperty()` 或 `cssText`）、`el.style` 和按名字读属性（computed style 的也算）、`insertRule()` 和 `deleteRule()` 都比没有 agent 时慢，按名字写入最明显；有记录的块每次写入还要检查有没有看不到的写入，开销更大；
  - 内存：记下的内容由它所属的样式表、规则或 style 弱持有，随之一起回收；存放它们的表不会缩小，所以一次性创建大量带 `env()` 规则的页面，在规则消失后仍会留下一部分内存。

  agent 里有一个常量（`written-blocks.ts` 的 `ALWAYS`），决定第二组存在多久。它现在是 `false`：如上所述，只在 CSS 启用期间或模拟改写页面期间存在。两者都不在时，页面与没有 agent 的页面相比，上面这些差异里只有第一组，按名字读写的开销与没有 agent 时相同；这期间写下的内容一律不采信（监视开始或结束时每条记录都作废），样式表、`<style>`、文件或插入规则的文本都不当作块：只有第二组存在期间写下的块才被模拟。为 `true` 时，第二组从 agent 加载起就在顶层窗口存在，上述差异和开销任何时候都有，这些文本按上一条所说采用。
- **未闭合的值**：没有闭合函数、块、字符串或 `url()` 的值（`--x: f(a`），浏览器按原样序列化，后面接一个分号和其余声明；这个文本重新解析时，它们会被并进这个值里。未闭合的值自身里的 `env()` 会被模拟（`--x: calc(env(safe-area-inset-top)` 被 `padding-top: var(--x)` 读取时得到安全区，与 Chrome 相同）。页面之后通过 CSSOM 在该块里声明的内容（`el.style.setProperty('padding-top', 'env(safe-area-inset-top)')`），在该块有页面写入的记录时会被模拟（见「简写后面跟着长写」），因为重做的是写入而不是文本。没有记录时（记录已作废），该块按它的文本逐条声明地写，而在那个文本里，未闭合的值之后设置的声明是这个值的一部分：其中的 `env()` 不被模拟。之前已改写的声明照常模拟，不会丢失任何声明，模拟结束后该块读起来与 Chrome 模拟下相同。Styles 面板对这样的 `style` 属性的解析可能与 Chrome 不同：Chrome 把 `--x` 显示为 `f(a; color: blue`，并在其后列出 `color`；这里的值多一个分号，且不列出 `color`。
- **声明的顺序**：被改写的块在模拟运行期间和结束之后都保持声明的顺序（`style[i]`）。若块里靠后的位置声明了某属性对应的逻辑或物理属性（`padding-inline-start` 在 `padding-top` 之前、`inline-size` 在 `height` 之前），浏览器在设置该属性时会把它移到块尾，它在那里会压过对应的那个属性。所以改写会把从被移动的属性起的各个属性按块原来的顺序放回：逐个移除，再带着当前的值重新添加；值待定的简写（带 `var()` 或 `env()`）整条添加。这个顺序是块自己的，不是块文本的，文本并不总能说明它：浏览器把 `padding: 1px; padding-inline-start: 3px; padding-left: 2px` 写成 `padding: 1px 1px 1px 2px; padding-inline-start: 3px`。当要写入的文本声明的名字与规则自己的文本声明的名字相同时（改写留下的就是这样），规则这样逐条声明地写；声明了其他名字的文本整块设置（`cssText`）。凭页面写入时的内容得知的块（「简写后面跟着长写」）不按文本写：把页面的写入重做一遍，得到的就是页面做出的那个块，顺序不变。`style` 属性按文本写回，用页面自己的文本；只有当它的文本就是浏览器为该元素的 style 序列化出的文本（最后一次是 CSSOM 写的）时例外：知道页面的写入时按这些写入重做，否则像规则一样逐条声明地写，其中带未闭合值的也一样。在逐条声明写入的块里还剩一处差异：没有值可供重新添加的属性留在原处，排在放回的属性之前。这类属性是 `all`，以及值待定的简写中、另一边之后又被单独设置时的各边（`padding: var(--x); padding-left: 2px`，浏览器把它写成空的长写），后者出现在不能凭页面写入时的内容得知的块里：「简写后面跟着长写」所列情况下的规则，或最后一次由 CSSOM 写入的 `style` 属性。这样的块若读作 `padding-inline-start: env(safe-area-inset-left); padding: var(--x); padding-left: 2px`（`margin`、`border-width`、`inset` 同理），`padding-inline-start` 于是排在 `padding-bottom` 之后，而 Chrome 把它排在最前：从开始模拟安全区起一直如此，模拟结束后也是，直到该块被重新写入或页面重新加载；不会丢失任何声明。计算值与 Chrome 相同，除非被移动的属性与它越过的某个属性设置的是同一边：在从右到左的元素上 `padding-inline-start` 是右内边距，在竖排的元素（`writing-mode: vertical-rl`）上是上内边距，它会压过简写给出的值（`--x: 3px`、left 安全区为 6 时实测：该内边距在模拟期间为 6px、结束后为 0px，Chrome 为 3px；从左到右的元素与 Chrome 相同）。放回顺序要对从被移动的属性起的每个属性做一次移除和一次设置，所以在规则会移动属性的大样式表上设置和清除安全区，比不发生移动时明显更慢；两者都远慢于 Chrome 自己的模拟。`CSS.getMatchedStylesForNode` 里，被改写规则的声明之后那些不带文本的长写条目，是把页面的文本重新解析得到的，`!important` 的排在最后，与页面通过 CSSOM 给出的顺序无关。
- **页面自己写的、与模拟相同的 `var()`**（`var(--da-sai-top, env(safe-area-inset-top))`）与模拟写的无法区分：客户端看到的是 `env(safe-area-inset-top)`，在 Styles 面板里编辑该样式会写入这个 `env()`。
- **安全区**：必须是 int32 范围内的整数，与 Chrome 一致；其他值会以「Invalid parameters」失败。

<a id="layout-overlays"></a>

### 布局叠加层

- **Chrome**：按布局引擎的结果绘制叠加层。
- **devtools-anywhere**：Grid、Flex、容器查询、scroll-snap、隔离、铰链、刘海和 frame 叠加层，按计算样式近似绘制：grid 没有线编号；隔离模式的拖拽调整大小不跨 iframe。还能补的部分见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)。

<a id="accessibility"></a>

## 无障碍树

Elements 面板的 Accessibility 窗格，以及 `Accessibility.getPartialAXTree`、`getFullAXTree`、`queryAXTree`、`getRootAXNode`、`getChildAXNodes`、`getAXNodeAndAncestors`：在页面里由 DOM、ARIA 属性和计算样式算出，与 Chrome 对照过。由 `accessibility.js`（约 80 KB）计算，首次使用时从 bundle 旁边加载：自托管时要放在同一目录。

- **Chrome**：在浏览器里计算，含 InlineTextBox、列表标记和 UA shadow 树里的节点。
- **devtools-anywhere**：没有 InlineTextBox。UA shadow 树里的节点（select 的弹出层和 slot、文本框的占位符和内部编辑区、input 按钮的文字、meter 的数值条（两层 generic 包装及其中的数值部分）、取色框的色块、details 的 slot）和列表标记及其文字，在没有 DOM 节点的情况下重建：它们没有 `backendDOMNodeId`，id 为负数，在会话内保持不变；列表标记例外，与 Chrome 一样用其 `::marker` 的 backend id。input 的默认名称（如 "Submit"，image input 的也是）是英文，Chrome 的则用浏览器语言。MathML 不逐节点重建：`math` 元素的内容显示为 generic 节点和其原文，Chrome 则给出 MathMLIdentifier 等 MathML 角色和渲染后的文字（斜体标识符 "x" 为 "𝑥"）。role 为 none 或 presentation 的 meter 没有节点，Chrome 则保留其数值条的 generic 包装。没有 summary 的 details 不生成 Chrome 的默认 summary：它的文字是浏览器语言的「详细信息」，页面拿不到。video 和 audio 没有 Chrome 在媒体无法播放时给的名称（浏览器语言的「无法播放媒体。」），也没有其媒体控件 shadow 树里那些被忽略的节点：它们随浏览器版本和媒体状态而变。body 与 Chrome 一样在有 click、mousedown 或 mouseup 处理函数时保留在树里，但只认经 `on*` 属性或特性设置的：用 `addEventListener` 添加的监听器页面里看不到，这样的 body 在 Chrome 保留时这里仍被忽略。
- **暂不处理**：日期、时间、月份、星期类输入框没有内部节点，Chrome 则有以浏览器语言命名的 spinbutton（「年」「月」……）和选择器按钮；file 输入框也没有内部按钮。`role="none"` 或 `"presentation"` 与焦点、或与要求特定子元素的父元素冲突时，树可能与 Chrome 不同：规范对这些情形没有定论，Chrome 的结果只能逐个实测。多个元素用 `aria-owns` 拥有同一元素时，按文档顺序第一个生效；Chrome 按创建无障碍对象的顺序决定，动态插入节点的页面上可能不同。这些已与 Chrome 做整棵树对照，不一致处保留现状。
- **事件**：与 Chrome 一样，在域启用期间，对客户端经 `getChildAXNodes` 或 `getAXNodeAndAncestors` 拿到过、节点又变了的发 `nodesUpdated`，同一帧的合成一个事件。变化由 MutationObserver 观察 DOM、属性和文本得知：class 或 `style` 属性引起的样式变化能看到；经 CSSOM 的修改、`:hover` 等状态、媒体查询、动画或图片加载引起的，要等下一次 DOM 变化才发出（命令总是读当前的树）。Chrome 还会发出变化节点的父节点，即使其节点没变；这里只发确实不同的节点。不发 `loadComplete`：它在文档加载完成时发出，早于 agent 运行，enable 时也不发。

<a id="application-issues-console"></a>

## Application、问题面板和 Console

<a id="application-panel"></a>

### Application 面板

- **IndexedDB 和 Cache Storage**：Chrome 的视图在整个源的每次写入发生时更新。这里，本窗口的写入立即显示。worker、Service Worker 和其他标签页的写入靠比较快照发现：页面可见时约三秒内显示，或在窗口获得焦点、变为可见时显示。快照只看数据库名称和版本、缓存名称和每个缓存里的请求 URL，不看数据库里的内容：别处写入的 IndexedDB 内容要刷新才能看到。页面自己写入后 300 毫秒内，别处对同一缓存或列表的写入可能不会单独产生事件。Chrome 会随写入重复发送存储桶事件；这里在跟踪期间每个桶只报告一次。对不存在的缓存调用 `requestEntries` 时列为空但不创建它，而 Chrome 会创建。
- **存储桶**：浏览器有 `navigator.storageBuckets` 时，具名存储桶可以列出、读取和写入；否则只有默认桶。持久性（durability）总是报 "relaxed"，与 Chrome 一致。在本窗口之外打开的桶，配额用的是它的估算值，可能是浏览器定的上限，而 Chrome 报 0。跟踪开始前页面取到的桶的 IndexedDB 或 caches，经由它们的写入要等下一次比较才显示。清除站点数据只清默认桶。IndexedDB 命令指向不存在的桶时返回错误，而 Chrome 不应答。别处恰好在快照读取的那一刻删除某个缓存或桶时，快照可能把它重新创建：这个 API 没有「仅在存在时才打开」的方式。
- **Service Worker**：能列出、更新、注销。看不到是否在运行，所以在变成 redundant 之前都显示为运行中。其他标签页改动的注册在页面获得焦点、变为可见或 controller 变化时显示，不是即时的。受控客户端只列当前页，不含其他标签页。Sync 通过 Background Sync 触发真实的 `sync` 事件，但离线时和要求 `lastChance` 时返回错误，同一 tag 仍在等待时浏览器会合并成一次事件。`skipWaiting` 只对收到 `{type: 'SKIP_WAITING'}` 消息时会调用 `self.skipWaiting()` 的 worker 有效，并在 worker 激活后才返回，而 Chrome 立即返回并能激活任意等待中的 worker；其他 worker 约三秒后报错。调试、启动、停止 worker，周期性同步和推送消息返回错误。

<a id="issues-panel"></a>

### 问题面板

- **devtools-anywhere**：CSP 违规、弃用、怪异模式和表单问题。CSP 和弃用只有顶层文档的；没有干预。
- **弃用 API 的调用位置**：给的是页面 URL，Chrome 指向调用它的脚本及行列。原因：页面的 `ReportingObserver` 收到的报告里源文件、行、列都是空的（Chrome 159 中为 null），且报告在调用之后才到，观察者回调的调用栈也看不到调用方。
- **低对比度**：没有；Chrome 也已没有这项检查。
- **Cookie、CORS、混合内容**：没有。原因：只有浏览器知道。

<a id="console-violations"></a>

### Console 违规提示

- **devtools-anywhere**：由 `long-animation-frame` 条目得出慢 handler 和强制重排的 `[Violation]` 消息，没有行号；浏览器需要支持 long-animation-frame，否则 `Log.startViolationsReport` 返回错误。

<a id="hosting-and-browsers"></a>

## 部署、外壳模式和浏览器

<a id="shell-mode"></a>

### 外壳模式

- **Chrome**：DevTools 在页面之外；页面就是顶层文档。
- **devtools-anywhere**：[外壳模式](usage.zh-CN.md#外壳模式)下页面运行在 iframe 里。在 iframe 里，`100vh`、`position: fixed`、`window.top` 和视口的表现可能不同。页面的 HTML 会请求两次；表单 POST 返回的页面会用 GET 再请求一次。

<a id="frontend-origin"></a>

### 前端与页面同源

- **devtools-anywhere**：DevTools 的设置会和页面共用 `localStorage`：前端放在别的源。

<a id="browsers"></a>

### 浏览器

- **devtools-anywhere**：页面这边：现代浏览器都行。DevTools 界面：只在 Chrome 上验证过；新版前端可能需要兼容补丁。
