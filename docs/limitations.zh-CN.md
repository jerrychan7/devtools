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
| 模拟媒体特性 | 部分支持 | 媒体特性和媒体类型[通过改写页面的样式表实现](#emulated-media) |
| 模拟安全区 | 部分支持 | [在页面的样式表里替换](#safe-area-insets) `env(safe-area-inset-*)` |
| 色觉缺陷模拟 | 完整支持 | 和 Chrome 一样在 `<html>` 上加 SVG 滤镜：会覆盖页面自己在 `<html>` 上的 `filter`，内嵌的面板也会被滤镜，`getComputedStyle` 能看到 |
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
- **devtools-anywhere**：不打包这些面板。`debugger;` 不会暂停；外壳模式下改为输出一条带堆栈的警告。[远程调试](usage.zh-CN.md#远程调试)时，断点仍要靠浏览器自带的调试器（`chrome://inspect`、Safari Web Inspector）：页面里运行的仍是同一个页面内 agent。
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
- **devtools-anywhere**：只有探针运行之后添加的；没有源码位置。
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
- **CSSOM 改动之后**：页面通过 CSSOM 改过样式表后（`replace()`、`replaceSync()` 除外），原文改为从 CSSOM 序列化，格式与 Chrome 首次见到已被改过的样式表时一致：每条规则（含 `@import`）的文本后跟一个换行。Chrome 对已知原文的样式表是把规则文本拼进原文，且会滞后。原文里找到的规则与 CSSOM 配不上时、DevTools 打开前就构造的样式表，也改为序列化。
- **看不到的修改**：通过 `style.color = …` 这类属性赋值或改媒体列表文本所做的修改看不到（不发 `CSS.styleSheetChanged`；Styles 可能仍显示旧原文）。
- **开销**：CSS 启用期间，元素行内样式的 `style.cssText = …` 写入约有 40% 额外开销，因为经过钩子；逐属性赋值（`el.style.left = …`）不受影响。
- **编辑 `@supports`、`@container`、`@scope` 的条件**：Chrome 保持原规则对象。这里整条替换该规则，因为 CSSOM 无法修改它们的条件：页面持有的该规则及其内部规则对象会脱离。
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
- **devtools-anywhere**：不覆盖 `@import` 和 `adoptedStyleSheets` 的样式表。

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
- **分组（`cssId`）**：与 Chrome 相同，`cssId` 按赢得动画属性的规则生成，两条规则里的相同声明分两组，`:hover` 的过渡和移出时的反向过渡也分两组。`@import` 样式表的规则和我们的 CSS 匹配漏掉的规则看不到，`::before`、`::after`、`::marker` 以外伪元素的动画仍按计算样式近似。
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
- **devtools-anywhere**：`prefers-color-scheme`、`prefers-reduced-motion`、`prefers-reduced-data`、`prefers-reduced-transparency`、`prefers-contrast`、`forced-colors`、`color-gamut` 和媒体类型，通过改写页面的样式表实现。跨域样式表、内联样式和 `matchMedia()` 不受影响；`light-dark()` 和强制颜色选的配色不会变。

<a id="safe-area-insets"></a>

### 模拟安全区

- **devtools-anywhere**：在页面的样式表里替换 `env(safe-area-inset-*)`：跨域样式表和内联样式不受影响；Styles 里显示的是替换后的值。

<a id="layout-overlays"></a>

### 布局叠加层

- **Chrome**：按布局引擎的结果绘制叠加层。
- **devtools-anywhere**：Grid、Flex、容器查询、scroll-snap、隔离、铰链、刘海和 frame 叠加层，按计算样式近似绘制：grid 没有线编号；隔离模式的拖拽调整大小不跨 iframe。还能补的部分见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)。

<a id="accessibility"></a>

## 无障碍树

Elements 面板的 Accessibility 窗格，以及 `Accessibility.getPartialAXTree`、`getFullAXTree`、`queryAXTree`、`getRootAXNode`、`getChildAXNodes`、`getAXNodeAndAncestors`：在页面里由 DOM、ARIA 属性和计算样式算出，与 Chrome 对照过。由 `accessibility.js`（约 29 KB）计算，首次使用时从 bundle 旁边加载：自托管时要放在同一目录。

- **Chrome**：在浏览器里计算，含 InlineTextBox、列表标记和 UA shadow 树里的节点。
- **devtools-anywhere**：没有 InlineTextBox、列表标记和 UA shadow 树里的节点；input 的默认名称（如 "Submit"）是英文。
- **事件**：不发 `loadComplete`、`nodesUpdated` 事件（待做：见[路线图](roadmap.zh-CN.md#其他能在页面里补上的功能)）。

<a id="application-issues-console"></a>

## Application、问题面板和 Console

<a id="application-panel"></a>

### Application 面板

- **IndexedDB 和 Cache Storage**：Chrome 的视图跟随整个源（包括 worker、其他窗口）的写入。这里视图只在本窗口写入时刷新（worker 和其他窗口的看不到）；存储桶是页面的默认桶。
- **Service Worker**：能列出、更新、注销。看不到是否在运行，所以在变成 redundant 之前都显示为运行中；调试、启动、停止 worker 返回错误。

<a id="issues-panel"></a>

### 问题面板

- **devtools-anywhere**：CSP 违规、弃用、怪异模式和表单问题。CSP 和弃用只有顶层文档的；没有干预。
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
