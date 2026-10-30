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

## 设计

### 选型

| 部分 | 选择 | 理由 |
|---|---|---|
| CDP 实现 | 在本项目中自行实现，参考 [chobitsu](https://github.com/liriliri/chobitsu) | 在页面内调试只能通过 JS API 采集数据，所以只能用 JS/TS 实现。自行实现可以让探针和各个 CDP 域共用同一套 hook（不再需要回放技巧），修掉 chobitsu 的已知问题，并通过 [`devtools-protocol`](https://github.com/ChromeDevTools/devtools-protocol) 的类型跟进最新协议 |
| 前端 | 官方 devtools-frontend，从源码构建，加一个很小的补丁集 | 构建时钉住官方的某个版本，补丁以 `.patch` 文件维护，升级时逐个重放，不维护长期 fork 分支。补丁只负责注册我们自己的入口（`anywhere_app`），其余定制都不改上游代码（见[修改前端](DEV.zh-CN.md#修改前端)） |
| 隔离 | iframe | 隔离 devtools 自身的 DOM、日志和请求，避免它们出现在被调试页面中，也避免与页面的全局环境互相干扰 |

本项目不依赖 Chii 和 chobitsu。遇到边界情况时会阅读它们的源码作为参考，但不复制代码；以真实 Chrome 的 CDP 输出和协议定义为准。

### 能力边界

- 页面内的 CDP 实现只能基于 JS API，因此以下能力**无法提供**：断点调试、Profiler、Memory、真实的网络时序。这些面板不打包进前端，而不是展示给用户后再让他发现不能用。页面脚本里的 `debugger;` 语句同样无法暂停；在 shell 模式下，同源脚本中执行到的每个 `debugger;` 会改为在控制台输出一条带堆栈的警告。真正的断点要靠浏览器自带的调试器（Android 用 `chrome://inspect`，iOS 用 Safari 的 Web Inspector）；[远程调试](#远程调试)改变不了这一点，因为页面里运行的仍是同一个页面内 CDP agent。源代码面板的“网页”标签页能列出页面的文档、外链脚本和样式表、图片和字体（内联脚本不列出，因为拿不到它们在文档中的位置）；代码段可以用。
- 页面脚本缺少相应 API 的地方，要么精确补上，要么不做；不会把近似结果当作事实展示：
  - 不显示浏览器默认样式（user-agent styles）：浏览器不开放它的默认样式表，内置一份副本又可能和浏览器实际使用的不一致。
  - 事件监听器由探针从它执行的那一刻起记录（探针必须是第一个脚本）；拿不到处理函数的源码位置。
  - 能显示 WebSocket 连接和帧，但没有握手阶段的请求头和响应头，页面拿不到它们。
  - 投屏（工具栏上的设备按钮，默认关闭）显示的是 [snapDOM](https://github.com/zumerlab/snapdom) 根据 DOM 重新绘制的视口，不是屏幕上的真实像素：canvas、视频和跨域图片可能缺失，每秒最多更新约两次。snapDOM（gzip 后约 90 KB）只在开始投屏时加载。
  - 投屏上的输入以 DOM 事件重放，这些事件不是可信事件（`isTrusted` 为 false）：聚焦、点击、滚动和文本编辑都会执行，但检查 `isTrusted` 的页面会忽略它们。
  - 跨域样式表通过重新下载的副本读取，需要对方返回 CORS 头；这些规则是只读的。
  - 强制伪类（样式面板里的 `:hover`、`:focus` 等）通过伴随样式表模拟，层叠顺序保持不变；`@import` 引入的样式表和 `adoptedStyleSheets` 不在覆盖范围内。
- 前端要部署在和页面不同的源上。如果同源，devtools 自己的设置会写进页面的 `localStorage`，并出现在 Application 面板里。
- 被调试页面一侧只用标准 Web API，可以运行在任何现代浏览器中。devtools 界面由 Google 针对 Chrome 开发和测试，Firefox 和 Safari 尚未验证；新版前端可能需要额外的兼容补丁。

### 架构

```
┌──────────── 顶层窗口（外壳）─────────────┐
│  ┌──────────────────────────────────┐  │
│  │ 用户页面 iframe                   │  │
│  │  探针（<head> 首个同步脚本）       │  │
│  │   └─ 缓冲 → CDP 运行时（延迟加载） │  │
│  └──────────────┬───────────────────┘  │
│        postMessage（校验 origin）       │
│  ┌──────────────┴───────────────────┐  │
│  │ devtools iframe                   │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

#### 1. 探针

压缩后约 6.2 KB（min+gzip，包含外壳模式、自动挂载和远程调试）的同步脚本，必须是 `<head>` 中第一个执行的脚本。

- 立即 hook `console`、`window.onerror`、`unhandledrejection`、`fetch`、`XHR` 和 `WebSocket`，把事件连同时间戳写入缓冲。WebSocket 帧按原样保存，二进制负载到 CDP agent 才转成 base64。CDP 会话挂载之前，每类记录（控制台消息、请求、WebSocket、每个 WebSocket 的帧）各保留最近 1 万条，作为从不加载 CDP agent 的页面的兜底；CDP 会话挂载后改由它设定上限，控制台消息与 V8 一样保留最近 1000 条。
- 无法 hook 的请求（文档、样式表、脚本、图片、字体等）通过 Resource Timing 记录；带 `buffered` 的 `PerformanceObserver` 还能拿到探针运行之前的请求。这些记录有 URL、类型、时序、大小，以及浏览器公开时的状态码和 MIME 类型，但没有请求头和响应头；响应体在需要时从 HTTP 缓存重新读取。外壳模式下启用了 Service Worker 时，它会为同源请求补上请求头和响应头。之所以仍以 hook 为主：hook 从最开始就生效、带调用栈、无需部署；Service Worker 要安装后才能接管页面，会和网站自己的 Service Worker 冲突，而且要代理请求才能看到响应。
- CDP 运行时和前端延迟加载。运行时的 Runtime、Network 域直接读取探针的缓冲并订阅新事件，因此每个 API 只被 hook 一次。

页面外没有任何途径能观察页面内的输出，只有比业务代码更早执行的脚本才能捕获最早的输出。完整的 CDP 运行时体积太大，不适合同步加载，所以只把最小的捕获逻辑放在最前面。

这个方案已经验证可行，见 [experiments/early-capture/RESULTS.md](experiments/early-capture/RESULTS.md)：用约 1.4 KB 的探针加延迟加载的 chobitsu，所有早期的 console 调用、异常和请求都进入了 devtools，对象可以展开，时间戳和调用栈都是原始的。

#### 2. 外壳模式（原地改写）

不托管独立的 `devtools.html`，也不跳转到 blob URL，因为 blob 会导致刷新失效、地址无法分享。做法是：

1. 使用零配置探针（`data-devtools-frontend-url`，或 Vite 插件）时，顶层页面首次加载就默认进入外壳模式：探针在页面脚本运行前自己把前端地址和 bundle 地址写入 `sessionStorage`，不需要再刷新一次。除非设置了 `data-open-immediately`，devtools 一开始是隐藏的。其他情况下，点击 DevTools 工具栏上的锁形按钮“Keep DevTools open across reloads”，写入这些地址后刷新页面。
2. 探针作为第一个脚本，在顶层窗口检测到配置后，先写入一个不闭合的 `<plaintext>`，让页面剩余的内容变成纯文本（页面脚本都不会执行），再用 `document.open()` / `document.write()` 把文档替换成外壳。外壳中有指向 `location.href` 的用户页面 iframe，以及 `<devtools-anywhere>`，它凭所在的文档认出自己是外壳的元素。（Chrome 在 `window.stop()` 之后会忽略 `document.open()`，所以改用 `<plaintext>`。）
3. 在 iframe 中，探针照常捕获，并加载 bundle，把页面的 CDP 会话连接到外壳。外壳在页面和前端之间转发消息。
4. 页面刷新或跳转后，新页面会发出 hello；外壳通知前端页面已导航，并把前端发过的所有 `enable` 命令重新发给新页面，新页面就会回放它自己最早的输出。地址栏和标题跟随页面变化，包括加载、前进后退和同文档导航（有 Navigation API 时也包括 `pushState`），因此刷新或复制链接打开的都是当前显示的页面。
5. 点工具栏上的 × 只隐藏 devtools，仍留在外壳模式。再点一次锁形按钮会清除配置，并在普通模式下重新加载页面；这个选择会记在 `localStorage` 里，之后优先于页面的 `data-default-shell-mode`，除非页面设置了 `data-shell-mode-locked`。

只有与探针脚本同源的地址才会被采信，否则清除配置、页面照常加载。因此外壳模式要求探针、bundle 和前端都由页面所在的源提供。

页面放进 iframe 后，`viewport`、`100vh`、`position: fixed`、`window.top` 等的行为可能和直接打开时不同；页面的 HTML 会被请求两次（顶层窗口一次，iframe 一次），表单 POST 返回的页面会被用 GET 再请求一次。用 `data-default-shell-mode="off"`（Vite 插件的 `defaultShellMode: 'off'`）可以关闭外壳模式，改为把 devtools 直接嵌在页面中。拒绝被嵌入（`X-Frame-Options`、CSP `frame-ancestors`）或反复把外壳跳走的页面，在本会话剩下的时间里会单独显示。

#### 3. 注入方式

| 方式 | 适用场景 |
|---|---|
| 页面手动引入 `<script>`（必须放在 `<head>` 第一个） | 任意页面 |
| `@devtools-anywhere/vite-plugin`：只在开发模式（`vite serve`）下注入 | 使用 Vite 的项目（之后可能补充 webpack 插件） |
| `devtools-anywhere-service-worker.js`：外壳模式下，给页面 iframe 中加载的、没有引入探针的同源页面注入探针 | 安全上下文（HTTPS 或 localhost）、作用域覆盖这些页面（`Service-Worker-Allowed: /`），并且站点没有自己的 Service Worker |

所有方式共用同一份探针。

### 发布形式

发布一个总包，以及 npm 组织 [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) 下的几个子包：

| 包 | 内容 |
|---|---|
| `devtools-anywhere` | 总包：`probe.iife.js`（探针加自动挂载）、`devtools-anywhere.iife.js`（`<devtools-anywhere>` 组件，由探针加载）、`devtools-anywhere-service-worker.js`、`snapdom.js`（投屏的绘制器，按需加载），以及组件、事件、探针脚本和切换器属性的 TypeScript 类型。没有可以 import 的模块，运行时只有这些脚本 |
| `@devtools-anywhere/devtools-frontend` | 构建好的前端静态资源，界面带英文和中文，可以自托管，也可以从 CDN 引用 |
| `@devtools-anywhere/devtools-frontend-locales` | 可选：其余 80 种界面语言，文件路径与前端包一致。两个包放在同一目录下提供即可（装了它的话 Vite 插件会自动这样做）；缺少的语言会退回英文 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |
| `@devtools-anywhere/remote-server` | 远程调试服务端（Node.js）及其命令行工具 `devtools-anywhere-remote` |

- 页面内的 CDP agent 和探针不单独成包：探针和各个域共用同一套 hook 和缓冲，而且只有 `devtools-anywhere` 使用它们。它们放在 `devtools-anywhere` 中（`src/cdp-agent/`），不会出现版本不匹配；探针仍单独构建成一个很小的文件 `probe.iife.js`。
- 前端单独成包，因为它体积大（约 16 MB），更新节奏跟随 Chrome 版本。其他语言（约 42 MB）再拆成一个包，需要的人才装。
- 所有包使用同一个版本号、一起发布，版本号相同的包一定能配合使用。

## 用法（预览）

各个包尚未发布，下面的路径指本仓库构建出的文件。`data-devtools-frontend-url` 指向 `@devtools-anywhere/devtools-frontend` 构建产物里的 `anywhere_app.html`。产物里 `bundle/` 下的文件以内容命名，可以永久缓存；`anywhere_app.html` 本身要带重新验证提供（`Cache-Control: no-cache`），更新才能到达浏览器。

### 一行 script

```html
<head>
  <!-- 第一个同步脚本：从最开始捕获输出。 -->
  <script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-devtools-frontend-url="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
  ...
</head>
```

页面加载完成后，探针会从同目录（或 `data-bundle` 指定的地址）加载 `devtools-anywhere.iife.js`，并在 `<html>` 下、与 `<body>` 同级挂载它自己的 `<devtools-anywhere>`，不管页面里有没有 `<devtools-anywhere>`；每个页面只有一个这样的全局元素，再出现的只在控制台警告。可选属性：`data-open-immediately` 立即打开 devtools；`data-default-shell-mode="off"` 不进入外壳模式（顶层页面默认 `on`，即进入）；`data-shell-mode-locked` 锁定外壳模式，始终按 `data-default-shell-mode` 执行，忽略用户的选择（已存的选择保留）并隐藏 DevTools 里的开关，但页面禁止被嵌入 iframe 时仍会退回普通模式；`data-no-toggler` 隐藏 F12 按钮，外壳模式下同样生效；`data-service-worker` 在外壳模式下启用 Service Worker，它给页面 iframe 中没有引入探针的同源页面注入探针，并为同源的文档、样式表、脚本、图片等请求补上请求头和响应头；默认关闭，使用条件见[注入方式](#3-注入方式)。

### Vite

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default {
  plugins: [devtoolsAnywhere()],
}
```

只影响 `vite serve`：探针作为第一个脚本注入每个页面，bundle、Service Worker 和前端都在 `/@devtools-anywhere/` 下提供。前端默认来自 `@devtools-anywhere/devtools-frontend`。选项：`devtoolsFrontendPath`（本地另一份前端构建的入口文件路径，如 `…/anywhere_app.html`，托管它所在的目录）、`devtoolsFrontendUrl`（托管在别处的前端，设置后不再托管本地文件）、`openImmediately`、`defaultShellMode`（`'on'` 或 `'off'`）、`shellModeLocked`、`noToggler`（隐藏 F12 按钮）、`serviceWorker`（使用条件见[注入方式](#3-注入方式)，`Service-Worker-Allowed` 头由插件返回），与探针的属性一一对应；`remote`（[远程调试](#远程调试)服务端的地址，页面同时连接到它，组件照常挂载），以及配合它的 `idInQuery`（`data-id-in-query`，对应服务端的 `idInQuery`）。

### 远程调试

要在电脑上的 Chrome 里调试手机上的页面，先在电脑上启动远程调试服务端：

```bash
npx devtools-anywhere-remote --port 8080
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

点击右下角的 F12 悬浮按钮打开面板；拖动面板的横条调整大小。DevTools 设置按钮左边，锁形按钮开关外壳模式（开启前有对话框说明，开启后顶部有提示条），刷新按钮重新加载页面；工具栏上的 × 关闭面板。DevTools 主菜单（⋮）里有“停靠位置”：底部（默认）、右侧、左侧，或取消停靠，变成页面上方的浮动窗口，拖动横条移动、拖动右下角调整大小。外壳模式下页面会让出空间，和 Chrome 一样；普通模式下面板盖在页面上。停靠位置和尺寸会记在 localStorage 里；尺寸记的是占视口的百分比（`dvh`/`dvw`），换屏幕或横竖屏切换后依然合适。唯一的属性 `devtools-frontend-url` 是可选的，不写时沿用探针的 `data-devtools-frontend-url`。其余状态都由库维护：探针的参数决定组件的配置，打开和关闭由用户操作；组件没有自己的方法。页面可以用 `devtools-anywhere::part(toggler)` 修改 F12 按钮的样式，外壳模式下同样有效：此时按钮在页面 iframe 里，由页面 `<html>` 下一个只承载按钮的 `<devtools-anywhere>` 显示，点击开关外壳的 DevTools（只有 iframe 里的页面没有探针时，例如其他源的页面，外壳才显示自己的按钮）。探针挂载的组件不把它的 iframe 暴露为部件。组件要固定挂在一个位置，在 DOM 中移动它会导致 iframe 重新加载。

页面也可以自己放置 `<devtools-anywhere>`，作为显示 DevTools 的一个区域：它是页面文档流里的块级盒子（`display: block`），尺寸由页面的 CSS 决定，一连接就加载 DevTools。页面用 CSS 或 `hidden` 控制它的显示和隐藏；隐藏时 DevTools 不会卸载。它没有 F12 按钮，不能停靠或拖拽调整大小，也不会进入外壳模式（DevTools 里没有入口）；在外壳里的页面中照常工作。它只有 `devtools-frontend-url` 一个属性，其他属性一律忽略。里面的 DevTools iframe 可以用 `devtools-anywhere::part(iframe)` 设置样式。

页面上任意元素都能开关面板：加上 `data-devtools-anywhere-toggle`，留空则指向探针挂载的组件。值为页面自己放置的某个组件的 id 时，点击只会在该组件上派发 `devtools-toggle-request` 事件，由页面自行处理；这类切换器不设置 `aria-expanded`。点击在 document 上统一捕获，后加入的切换器同样生效；不阻止默认行为，切换器的 `aria-expanded` 跟随面板状态。找不到目标时只打一条警告（同一个值只警告一次）。面板是否打开只能从切换器的 `aria-expanded` 得知，组件本身不派发事件。

```html
<button data-devtools-anywhere-toggle>DevTools</button>
```

切换器在探针加载 `devtools-anywhere.iife.js`（由它注册组件）后才生效，放在 shadow root 里不起作用。外壳模式下，外壳里那个页面的切换器一律控制外壳的面板，忽略属性值。与外壳不同源的页面（如跨源 iframe）里的切换器不起作用。

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
