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

- 页面内的 CDP 实现只能基于 JS API，因此以下能力**无法提供**：断点调试、Profiler、Memory、真实的网络时序。这些面板不打包进前端，而不是展示给用户后再让他发现不能用。页面脚本里的 `debugger;` 语句同样无法暂停。真正的断点要靠浏览器自带的调试器：后续计划加入类似 Chii 的远程调试模式，页面连接到服务端，DevTools 经由服务端接入。源代码面板的“网页”标签页能列出页面的文档、外链脚本和样式表、图片和字体（内联脚本不列出，因为拿不到它们在文档中的位置）；代码段可以用。
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

压缩后约 4.2 KB（min+gzip，包含外壳模式和自动挂载）的同步脚本，必须是 `<head>` 中第一个执行的脚本。

- 立即 hook `console`、`window.onerror`、`unhandledrejection`、`fetch`、`XHR` 和 `WebSocket`，把事件连同时间戳写入缓冲。WebSocket 帧按原样保存，二进制负载到 CDP 服务端才转成 base64。
- 无法 hook 的请求（文档、样式表、脚本、图片、字体等）通过 Resource Timing 记录；带 `buffered` 的 `PerformanceObserver` 还能拿到探针运行之前的请求。这些记录有 URL、类型、时序、大小，以及浏览器公开时的状态码和 MIME 类型，但没有请求头和响应头；响应体在需要时从 HTTP 缓存重新读取。外壳模式下启用了 Service Worker 时，它会为同源请求补上请求头和响应头。之所以仍以 hook 为主：hook 从最开始就生效、带调用栈、无需部署；Service Worker 要安装后才能接管页面，会和网站自己的 Service Worker 冲突，而且要代理请求才能看到响应。
- CDP 运行时和前端延迟加载。运行时的 Runtime、Network 域直接读取探针的缓冲并订阅新事件，因此每个 API 只被 hook 一次。

页面外没有任何途径能观察页面内的输出，只有比业务代码更早执行的脚本才能捕获最早的输出。完整的 CDP 运行时体积太大，不适合同步加载，所以只把最小的捕获逻辑放在最前面。

这个方案已经验证可行，见 [experiments/early-capture/RESULTS.md](experiments/early-capture/RESULTS.md)：用约 1.4 KB 的探针加延迟加载的 chobitsu，所有早期的 console 调用、异常和请求都进入了 devtools，对象可以展开，时间戳和调用栈都是原始的。

#### 2. 外壳模式（原地改写）

不托管独立的 `devtools.html`，也不跳转到 blob URL，因为 blob 会导致刷新失效、地址无法分享。做法是：

1. 点击 DevTools 工具栏上的锁形按钮“Keep DevTools open across reloads”（`element.enterShell()`），把前端地址和 bundle 地址写入 `sessionStorage`，然后刷新页面。
2. 探针作为第一个脚本，在顶层窗口检测到配置后，先写入一个不闭合的 `<plaintext>`，让页面剩余的内容变成纯文本（页面脚本都不会执行），再用 `document.open()` / `document.write()` 把文档替换成外壳。外壳中有指向 `location.href` 的用户页面 iframe，以及 `<devtools-anywhere shell>`。（Chrome 在 `window.stop()` 之后会忽略 `document.open()`，所以改用 `<plaintext>`。）
3. 在 iframe 中，探针照常捕获，并加载 bundle，把页面的 CDP 服务端连接到外壳。外壳在页面和前端之间转发消息。
4. 页面刷新或跳转后，新页面会发出 hello；外壳通知前端页面已导航，并把前端发过的所有 `enable` 命令重新发给新页面，新页面就会回放它自己最早的输出。地址栏和标题跟随页面变化。
5. 再点一次锁形按钮，或点工具栏上的 ×（`element.exitShell()`），会清除配置，并在普通模式下重新加载页面。

只有与探针脚本同源的地址才会被采信，否则清除配置、页面照常加载。因此外壳模式要求探针、bundle 和前端都由页面所在的源提供。

外壳模式是**可选**的：页面放进 iframe 后，`viewport`、`100vh`、`position: fixed`、`window.top`、`X-Frame-Options` 等的行为可能和直接打开时不同。默认模式是把 devtools 直接嵌在页面中。

#### 3. 注入方式

| 方式 | 适用场景 |
|---|---|
| 页面手动引入 `<script>`（必须放在 `<head>` 第一个） | 任意页面 |
| `@devtools-anywhere/vite-plugin`：只在开发模式（`vite serve`）下注入 | 使用 Vite 的项目（之后可能补充 webpack 插件） |
| `devtools-anywhere-sw.js`：外壳模式下，给页面 iframe 中加载的、没有引入探针的同源页面注入探针 | 安全上下文（HTTPS 或 localhost）、作用域覆盖这些页面（`Service-Worker-Allowed: /`），并且站点没有自己的 SW |

所有方式共用同一份探针。

### 发布形式

发布一个总包，以及 npm 组织 [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) 下的几个子包：

| 包 | 内容 |
|---|---|
| `devtools-anywhere` | 总包：`<devtools-anywhere>` 组件、`probe.iife.js`（探针加自动挂载）、`devtools-anywhere.iife.js`、`devtools-anywhere-sw.js` 和 `snapdom.js`（投屏的绘制器，按需加载） |
| `@devtools-anywhere/cdp-server` | 页面内的 CDP 服务端。探针通过子路径 `@devtools-anywhere/cdp-server/probe` 导出，单独构建成一个很小的文件，供 `<script>` 引入和插件注入使用 |
| `@devtools-anywhere/devtools-frontend` | 构建好的前端静态资源，界面带英文和中文，可以自托管，也可以从 CDN 引用 |
| `@devtools-anywhere/devtools-frontend-locales` | 可选：其余 80 种界面语言，文件路径与前端包一致。两个包放在同一目录下提供即可（装了它的话 Vite 插件会自动这样做）；缺少的语言会退回英文 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |

- 探针不单独成包：Runtime 和 Network 域直接读取它的缓冲，两者必须严格匹配。放在 cdp-server 中可以共用类型，也不会出现版本不匹配。
- 前端单独成包，因为它体积大（约 16 MB），更新节奏跟随 Chrome 版本。其他语言（约 42 MB）再拆成一个包，需要的人才装。
- 所有包使用同一个版本号、一起发布，版本号相同的包一定能配合使用。

## 用法（预览）

各个包尚未发布，下面的路径指本仓库构建出的文件。`data-frontend` 指向 `@devtools-anywhere/devtools-frontend` 构建产物里的 `anywhere_app.html`。

### 一行 script

```html
<head>
  <!-- 第一个同步脚本：从最开始捕获输出。 -->
  <script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-frontend="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
  ...
</head>
```

页面加载完成后，探针会从同目录（或 `data-bundle` 指定的地址）加载 `devtools-anywhere.iife.js`，并挂载 `<devtools-anywhere>`。可选属性：`data-open` 立即打开 devtools；`data-sw` 在外壳模式下启用 Service Worker。

### Vite

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default {
  plugins: [devtoolsAnywhere()],
}
```

只影响 `vite serve`：探针作为第一个脚本注入每个页面，bundle、Service Worker 和前端都在 `/@devtools-anywhere/` 下提供。前端默认来自 `@devtools-anywhere/devtools-frontend`。选项：`frontendDir`（使用别的前端构建）、`frontendEntry`（默认 `anywhere_app.html`）、`frontendUrl`、`open`、`serviceWorker`。

### 组件

点击右下角的 F12 悬浮按钮打开面板；拖动面板的横条调整大小。DevTools 设置按钮左边，锁形按钮开关外壳模式（开启前有对话框说明，开启后顶部有提示条），刷新按钮重新加载页面；工具栏上的 × 关闭面板。DevTools 主菜单（⋮）里有“停靠位置”：底部（默认）、右侧、左侧，或取消停靠，变成页面上方的浮动窗口，拖动横条移动、拖动右下角调整大小。外壳模式下页面会让出空间，和 Chrome 一样；普通模式下面板盖在页面上。停靠位置和尺寸会记在 localStorage 里；尺寸记的是占视口的百分比（`dvh`/`dvw`），换屏幕或横竖屏切换后依然合适。属性：`frontend`、`open`、`dock`、`height`、`width`、`no-launcher`、`sw`；方法：`show()`、`hide()`、`toggle()`、`enterShell()`、`exitShell()`。组件要固定挂在一个位置，在 DOM 中移动它会导致 iframe 重新加载。

## 开发

环境配置、目录结构与实现约束、实时重新构建、测试、构建前端和发布，见[开发指南](DEV.zh-CN.md)。

## 参考

- [chobitsu](https://github.com/liriliri/chobitsu)：CDP 实现的参考
- [Chii](https://github.com/liriliri/chii)：嵌入模式 `src/target/DevtoolsFrame.ts`
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
- [Puppeteer](https://github.com/puppeteer/puppeteer)：一致性测试中作为标准答案
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## 许可证

[MIT](LICENSE)
