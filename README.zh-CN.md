# devtools-anywhere

[English](README.md) | 简体中文

在任意网页里使用真正的 Chrome DevTools，尤其适合没有开发者工具的移动端浏览器。

## 为什么

现有的页面内调试工具各有短板：

| 工具 | 短板 |
|---|---|
| eruda / vConsole | 只能捕获初始化之后的输出。它们体积较大，通常异步加载，页面最开始的日志和报错会丢失 |
| mobile-devtools | 自己实现的 UI，不是 Chrome DevTools；通过框架适配器初始化，晚于应用代码启动（根据其 README 判断，未验证） |
| Chii | 能做到早期捕获，但接入和配置比较繁琐，前端停留在旧版 Chrome DevTools（约 122） |

本项目的目标：

1. **不丢最早的输出**：从页面第一行脚本开始，console、报错、网络请求都能看到。
2. **接入零配置**：一行 `<script>` 或一个构建插件就能用。
3. **刷新不丢 devtools**：页面刷新或跳转时，devtools 保持打开，日志可以持续保留。
4. **持续跟进新版 Chrome DevTools**：基于官方 devtools-frontend 维护一组补丁，定期升级，不长期停留在旧版本。

## 用法（预览）

各个包已发布到 npm（`npm i devtools-anywhere @devtools-anywhere/devtools-frontend`），下面的路径指它们的 `dist/` 目录，本仓库构建出的文件也一样。`data-devtools-frontend-url` 指向 `@devtools-anywhere/devtools-frontend` 构建产物里的 `anywhere_app.html`。产物里 `bundle/` 下的文件以内容命名，可以永久缓存；`anywhere_app.html` 本身要带重新验证提供（`Cache-Control: no-cache`），更新才能到达浏览器。

### 一行 script

```html
<head>
  <!-- 第一个同步脚本：从最开始捕获输出。 -->
  <script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-devtools-frontend-url="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
  ...
</head>
```

也可以直接用 CDN：jsDelivr 和 unpkg 会提供所有 npm 包，不用自己部署。请固定到确切的版本号，两个包用同一个版本。这种方式只有英文和中文界面，因为其他语言在单独的包里，必须和前端放在同一目录下提供。外壳模式也用不了，因为它要求探针、bundle 和前端都与页面同源（见[外壳模式](docs/design.zh-CN.md#2-外壳模式原地改写)）：用 `data-default-shell-mode="off"` 把 devtools 直接嵌在页面里。

```html
<!-- jsDelivr -->
<script src="https://cdn.jsdelivr.net/npm/devtools-anywhere@0.1.0/dist/probe.iife.js" data-devtools-frontend-url="https://cdn.jsdelivr.net/npm/@devtools-anywhere/devtools-frontend@0.1.0/dist/anywhere_app.html" data-default-shell-mode="off"></script>
<!-- unpkg -->
<script src="https://unpkg.com/devtools-anywhere@0.1.0/dist/probe.iife.js" data-devtools-frontend-url="https://unpkg.com/@devtools-anywhere/devtools-frontend@0.1.0/dist/anywhere_app.html" data-default-shell-mode="off"></script>
```

页面加载完成后，探针会从同目录（或 `data-bundle` 指定的地址）加载 `devtools-anywhere.iife.js`，并在 `<html>` 下、与 `<body>` 同级挂载它自己的 `<devtools-anywhere>`，不管页面里有没有 `<devtools-anywhere>`；每个页面只有一个这样的全局元素，再出现的只在控制台警告。可选属性：`data-open-immediately` 立即打开 devtools；`data-default-shell-mode="off"` 不进入外壳模式（顶层页面默认 `on`，即进入）；`data-shell-mode-locked` 锁定外壳模式，始终按 `data-default-shell-mode` 执行，忽略用户的选择（已存的选择保留）并隐藏 DevTools 里的开关，但页面禁止被嵌入 iframe 时仍会退回普通模式；`data-no-toggler` 隐藏 F12 按钮，外壳模式下同样生效；`data-service-worker` 在外壳模式下启用 Service Worker，它给页面 iframe 中没有引入探针的同源页面注入探针，并为同源的文档、样式表、脚本、图片等请求补上请求头和响应头；默认关闭，使用条件见[注入方式](docs/design.zh-CN.md#3-注入方式)。

### Vite

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default {
  plugins: [devtoolsAnywhere()],
}
```

只影响 `vite serve`：探针作为第一个脚本注入每个页面，bundle、Service Worker 和前端都在 `/@devtools-anywhere/` 下提供。前端默认来自 `@devtools-anywhere/devtools-frontend`。选项：`devtoolsFrontendPath`（本地另一份前端构建的入口文件路径，如 `…/anywhere_app.html`，托管它所在的目录）、`devtoolsFrontendUrl`（托管在别处的前端，设置后不再托管本地文件）、`openImmediately`、`defaultShellMode`（`'on'` 或 `'off'`）、`shellModeLocked`、`noToggler`（隐藏 F12 按钮）、`serviceWorker`（使用条件见[注入方式](docs/design.zh-CN.md#3-注入方式)，`Service-Worker-Allowed` 头由插件返回），与探针的属性一一对应；`remote`（[远程调试](#远程调试)服务端的地址，页面同时连接到它，组件照常挂载），以及配合它的 `idInQuery`（`data-id-in-query`，对应服务端的 `idInQuery`）。

### 远程调试

要在电脑上的 Chrome 里调试手机上的页面，先在电脑上启动远程调试服务端：

```bash
npx -p @devtools-anywhere/remote-server devtools-anywhere-remote --port 8080
```

它会打印目标列表的地址（带 token）和给页面用的 script 标签，标签里用的是电脑的局域网地址（`--public-url` 可以改成别的地址，例如经过代理时）。从服务端加载探针，带上 `data-remote`，放在页面 `<head>` 的第一个脚本位置：

```html
<script src="http://192.168.1.2:8080/probe.iife.js" data-remote></script>
```

页面加载完成后连接到服务端（早期输出照常捕获），并出现在目标列表中；列表可以筛选，也会显示连着几个 DevTools。点“inspect”会在新标签页里打开它的 DevTools。页面在同一个标签页里刷新或跳转时，DevTools 保持连接；连接断开后页面会自动重连，期间它仍留在列表中。一个页面可以同时被多个 DevTools 调试，和 Chrome 一样各有独立的会话：页面为每个会话运行一个 CDP 会话。探针从别处加载时，`data-remote` 也可以写服务端地址（`data-remote="http://host:8080/"`）。它像链接一样相对探针的地址解析，所以挂在路径下的服务端要带结尾斜杠：`/devtools/` 指 `/devtools/` 下的服务端，`/devtools` 指的却是 `/` 下的。再加上 `data-devtools-frontend-url` 时，页面同时还有自己的 DevTools 面板，两边可以同时调试，各自有独立的会话。外壳模式与不带 `data-remote` 时一样（它要求探针、bundle 和前端同源，所以探针从服务端加载、前端在别处时不会进入）：连接服务端的是外壳里的页面，外壳本身不连。再加上 `data-service-worker` 时，页面 iframe 跳转到的没有引入探针的同源页面也会连接：Service Worker 给它们注入探针，它们连接同一个服务端。外壳里的页面（自带探针或由 Service Worker 注入）连不连远程由外壳的探针决定：外壳的探针没有配服务端时都不连，页面自己的 `data-remote` 不起作用。这个服务端地址由外壳保存在内存里，不和其余外壳配置一起写进 `sessionStorage`，外壳里的页面加载完成后再由外壳告诉它，所以页面脚本无法让之后的页面连到别处。

- 服务端同时提供探针、bundle 和 DevTools 前端；前端运行在电脑上，不受“前端要和页面不同源”的限制。
- 调试一个页面就意味着能在其中执行任意脚本：目标列表和 DevTools 连接都需要 token（`--token <值>`，默认随机生成；`--no-token` 关闭）。页面连接不需要 token。
- HTTPS 页面只能连接 HTTPS 服务端：使用 `--cert` 和 `--key`。其他选项：`--host`、`--base-path`、`--id-in-query`（即下文的 `idInQuery`）、`--devtools-frontend-path`，以及 `--devtools-frontend-url`（打开托管在别处的前端，如 CDN；HTTPS 的前端要求服务端也用 HTTPS；它的链接把 `ws=`/`wss=` 和 token 放在 URL 片段里，所以不会发给 CDN）。在 Node.js 中也可以调用 `startRemoteServer(options)`；`createRemoteHandler(options)` 提供请求和 upgrade 两个处理函数，可以挂在自己的服务（Express、Koa 等）的某个 base path 下，不属于它的请求返回 false。页面连接 `<base>target/<id>`，DevTools 连接 `<base>client/<id>`；宿主只能按精确路径分发 WebSocket upgrade 时，用 `idInQuery: true`，两者都连到 base path 本身（`<base>?target=<id>`、`<base>?client=<id>`）：目标列表和打印的 script 标签改用这种形式，标签上带 `data-id-in-query`，宿主只需为 upgrade 注册 base path（带结尾斜杠）。两种形式始终都接受。单独打开的前端可以用 `anywhere_app.html?ws=<host:port/path>`（HTTPS 用 `wss=`；也可以从片段 `#?ws=` 读取）连接任一目标，参数是去掉协议的 WebSocket 地址，和 Chrome 的 `devtools_app.html?ws=` 一样。
- `/json/list`（带 token）按 Chrome 的格式列出目标。

### 组件

点击右下角的 F12 悬浮按钮打开面板；拖动面板的横条调整大小（外壳模式下用 DevTools 自己的分隔条，见[外壳模式](docs/design.zh-CN.md#2-外壳模式原地改写)）。DevTools 设置按钮左边，锁形按钮开关外壳模式（开启前有对话框说明，开启后顶部有提示条），刷新按钮重新加载页面；工具栏上的 × 关闭面板。DevTools 主菜单（⋮）里有“停靠位置”：底部（默认）、右侧、左侧，或取消停靠，变成页面上方的浮动窗口，拖动横条移动、拖动右下角调整大小。外壳模式下页面会让出空间，和 Chrome 一样；普通模式下面板盖在页面上。停靠位置和尺寸会记在 localStorage 里；尺寸记的是占视口的百分比（`dvh`/`dvw`），换屏幕或横竖屏切换后依然合适。唯一的属性 `devtools-frontend-url` 是可选的，不写时沿用探针的 `data-devtools-frontend-url`。其余状态都由库维护：探针的参数决定组件的配置，打开和关闭由用户操作；组件没有自己的方法。页面可以用 `devtools-anywhere::part(toggler)` 修改 F12 按钮的样式，外壳模式下同样有效：此时按钮在页面 iframe 里，由页面 `<html>` 下一个只承载按钮的 `<devtools-anywhere>` 显示，点击开关外壳的 DevTools（只有 iframe 里的页面没有探针时，例如其他源的页面，外壳才显示自己的按钮）。探针挂载的组件不把它的 iframe 暴露为部件。组件要固定挂在一个位置，在 DOM 中移动它会导致 iframe 重新加载。

页面也可以自己放置 `<devtools-anywhere>`，作为显示 DevTools 的一个区域：它是页面文档流里的块级盒子（`display: block`），尺寸由页面的 CSS 决定，一连接就加载 DevTools。页面用 CSS 或 `hidden` 控制它的显示和隐藏；隐藏时 DevTools 不会卸载。它没有 F12 按钮，不能停靠或拖拽调整大小，也不会进入外壳模式（DevTools 里没有入口）；在外壳里的页面中照常工作。它只有 `devtools-frontend-url` 一个属性，其他属性一律忽略。里面的 DevTools iframe 可以用 `devtools-anywhere::part(iframe)` 设置样式。

页面上任意元素都能开关面板：加上 `data-devtools-anywhere-toggle`，留空则指向探针挂载的组件。值为页面自己放置的某个组件的 id 时，点击只会在该组件上派发 `devtools-toggle-request` 事件，由页面自行处理；这类切换器不设置 `aria-expanded`。点击在 document 上统一捕获，后加入的切换器同样生效；不阻止默认行为，切换器的 `aria-expanded` 跟随面板状态。找不到目标时只打一条警告（同一个值只警告一次）。面板是否打开只能从切换器的 `aria-expanded` 得知，组件本身不派发事件。

```html
<button data-devtools-anywhere-toggle>DevTools</button>
```

切换器在探针加载 `devtools-anywhere.iife.js`（由它注册组件）后才生效，放在 shadow root 里不起作用。外壳模式下，外壳里那个页面的切换器一律控制外壳的面板，忽略属性值。与外壳不同源的页面（如跨源 iframe）里的切换器不起作用。

## 能力边界

- 页面内的 CDP 实现只能基于 JS API，因此以下能力**无法提供**：断点调试、Profiler、Memory、真实的网络时序。这些面板不打包进前端，而不是展示给用户后再让他发现不能用。页面脚本里的 `debugger;` 语句同样无法暂停；在外壳模式下，同源脚本中执行到的每个 `debugger;` 会改为在控制台输出一条带堆栈的警告。真正的断点要靠浏览器自带的调试器（Android 用 `chrome://inspect`，iOS 用 Safari 的 Web Inspector）；[远程调试](#远程调试)改变不了这一点，因为页面里运行的仍是同一个页面内 CDP agent。源代码面板的“网页”标签页能列出页面的文档、外链脚本和样式表、图片和字体（内联脚本不列出，因为拿不到它们在文档中的位置）；代码段可以用。
- 页面脚本缺少相应 API 的地方，要么精确补上，要么不做；不会把近似结果当作事实展示：
  - 不显示浏览器默认样式（user-agent styles）：浏览器不开放它的默认样式表，内置一份副本又可能和浏览器实际使用的不一致。
  - 事件监听器由探针从它执行的那一刻起记录（探针必须是第一个脚本）；拿不到处理函数的源码位置。
  - 能显示 WebSocket 连接和帧，但没有握手阶段的请求头和响应头，页面拿不到它们。
  - 投屏（工具栏上的设备按钮，默认关闭）显示的是 [snapDOM](https://github.com/zumerlab/snapdom) 根据 DOM 重新绘制的视口，不是屏幕上的真实像素：canvas、视频和跨域图片可能缺失，每秒最多更新约两次。snapDOM（gzip 后约 90 KB）只在开始投屏或截图时加载。
  - 截图（`Page.captureScreenshot`，供通过 CDP 操作页面的工具和 agent 使用）同样由 snapDOM 绘制，投屏缺失的内容截图里也会缺失。返回结果里会多一个 Chrome 没有的字段 `approximate: true` 来说明这一点。其余参数的行为和 Chrome 一致：`clip` 按页面坐标计算，图片按设备像素输出（`devicePixelRatio` 乘以 `clip.scale`），不带 `clip` 时设置 `captureBeyondViewport` 会截取整个页面。超出浏览器画布上限（单边 32767 像素，Safari 上 16384；面积 16384 × 16384）的图片会等比缩小，snapDOM 会在页面的控制台里给出警告。不支持编码 WebP 的浏览器（Safari）在请求 WebP 时返回 PNG。
  - 设备模式（只在外壳模式下提供，因为它要求页面在一个可以调整尺寸的 iframe 里）设置的是页面的尺寸，也就是页面看到的视口：媒体查询、`vw`/`vh` 和 `innerWidth` 都会随之变化。它不改变 `devicePixelRatio`、UA 和触摸输入，这些是页面改不了的：工具栏里没有设备像素比和设备类型，选择设备预设时只套用尺寸。它菜单里的截图同样由 snapDOM 绘制，按页面自己的像素比输出。
  - 投屏上的输入以 DOM 事件重放，这些事件不是可信事件（`isTrusted` 为 false）：聚焦、点击、滚动和文本编辑都会执行，但检查 `isTrusted` 的页面会忽略它们。
  - 跨域样式表通过重新下载的副本读取，需要对方返回 CORS 头；这些规则是只读的。
  - 强制伪类（样式面板里的 `:hover`、`:focus` 等）通过伴随样式表模拟，层叠顺序保持不变；`@import` 引入的样式表和 `adoptedStyleSheets` 不在覆盖范围内。
- 页面让某个元素全屏（Fullscreen API）期间，devtools 和它的 F12 按钮都无法使用：浏览器不让全屏元素以外的任何内容接收输入，外壳模式下也一样。退出全屏（Esc）后即可恢复。
- 前端要部署在和页面不同的源上。如果同源，devtools 自己的设置会写进页面的 `localStorage`，并出现在 Application 面板里。
- 被调试页面一侧只用标准 Web API，可以运行在任何现代浏览器中。devtools 界面由 Google 针对 Chrome 开发和测试，Firefox 和 Safari 尚未验证；新版前端可能需要额外的兼容补丁。

## 发布形式

发布一个总包，以及 npm 组织 [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) 下的几个子包：

| 包 | 内容 |
|---|---|
| `devtools-anywhere` | 总包：`probe.iife.js`（探针加自动挂载）、`devtools-anywhere.iife.js`（`<devtools-anywhere>` 组件，由探针加载）、`devtools-anywhere-service-worker.js`、`snapdom.js`（投屏和截图的绘制器，按需加载），以及组件、事件、探针脚本和切换器属性的 TypeScript 类型。没有可以 import 的模块，运行时只有这些脚本 |
| `@devtools-anywhere/devtools-frontend` | 构建好的前端静态资源，界面带英文和中文，可以自托管，也可以从 CDN 引用 |
| `@devtools-anywhere/devtools-frontend-locales` | 可选：其余 80 种界面语言，文件路径与前端包一致。两个包放在同一目录下提供即可（装了它的话 Vite 插件会自动这样做）；缺少的语言会退回英文 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |
| `@devtools-anywhere/remote-server` | 远程调试服务端（Node.js）及其命令行工具 `devtools-anywhere-remote` |

## 设计

工作原理和设计取舍（探针、外壳模式、注入方式、选型、拆包理由）见 [docs/design.zh-CN.md](docs/design.zh-CN.md)。

## 开发

环境配置、目录结构与实现约束、实时重新构建、测试、构建前端和发布，见[开发指南](DEV.zh-CN.md)。

## 参考

- [chobitsu](https://github.com/liriliri/chobitsu)：CDP 实现的参考
- [Chii](https://github.com/liriliri/chii)：嵌入模式 `src/target/DevtoolsFrame.ts`，以及它的远程调试服务端
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
- [Puppeteer](https://github.com/puppeteer/puppeteer)：一致性测试中作为标准答案
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## 许可证

devtools-anywhere 以 [MIT](LICENSE) 许可发布。每个发布包都带有自己的 `LICENSE`；产物中含第三方代码的包另附 `THIRD_PARTY_LICENSES.md`。

发布包中的第三方代码及其版权声明、完整许可文本见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)：

- `@devtools-anywhere/devtools-frontend` 与 `@devtools-anywhere/devtools-frontend-locales` 由 Chrome DevTools frontend 构建（BSD-3-Clause，The Chromium Authors），包含它打包的各个库。
- `devtools-anywhere` 打包了 [snapDOM](https://github.com/zumerlab/snapdom)（MIT）。
- `packages/devtools-anywhere/src/cdp-agent/core/lexer.ts` 中的模块词法分析器移植自 [es-module-lexer](https://github.com/guybedford/es-module-lexer)（MIT，Guy Bedford）。
