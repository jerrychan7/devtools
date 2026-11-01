# 设计

[English](design.md) | 简体中文

devtools-anywhere 的工作原理和设计取舍。使用方法见 [README](../README.zh-CN.md)，参与开发见[开发指南](../DEV.zh-CN.md)。

## 选型

| 部分 | 选择 | 理由 |
|---|---|---|
| CDP 实现 | 在本项目中自行实现，参考 [chobitsu](https://github.com/liriliri/chobitsu) | 在页面内调试只能通过 JS API 采集数据，所以只能用 JS/TS 实现。自行实现可以让探针和各个 CDP 域共用同一套 hook（不再需要回放技巧），修掉 chobitsu 的已知问题，并通过 [`devtools-protocol`](https://github.com/ChromeDevTools/devtools-protocol) 的类型跟进最新协议 |
| 前端 | 官方 devtools-frontend，从源码构建，加一个很小的补丁集 | 构建时钉住官方的某个版本，补丁以 `.patch` 文件维护，升级时逐个重放，不维护长期 fork 分支。补丁只负责注册我们自己的入口（`anywhere_app`），其余定制都不改上游代码（见[修改前端](../DEV.zh-CN.md#修改前端)） |
| 隔离 | iframe | 隔离 devtools 自身的 DOM、日志和请求，避免它们出现在被调试页面中，也避免与页面的全局环境互相干扰 |

本项目不依赖 Chii 和 chobitsu。遇到边界情况时会阅读它们的源码作为参考，但不复制代码；以真实 Chrome 的 CDP 输出和协议定义为准。

## 架构

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

### 1. 探针

压缩后约 6.2 KB（min+gzip，包含外壳模式、自动挂载和远程调试）的同步脚本，必须是 `<head>` 中第一个执行的脚本。

- 立即 hook `console`、`window.onerror`、`unhandledrejection`、`fetch`、`XHR` 和 `WebSocket`，把事件连同时间戳写入缓冲。WebSocket 帧按原样保存，二进制负载到 CDP agent 才转成 base64。CDP 会话挂载之前，每类记录（控制台消息、请求、WebSocket、每个 WebSocket 的帧）各保留最近 1 万条，作为从不加载 CDP agent 的页面的兜底；CDP 会话挂载后改由它设定上限，控制台消息与 V8 一样保留最近 1000 条。
- 无法 hook 的请求（文档、样式表、脚本、图片、字体等）通过 Resource Timing 记录；带 `buffered` 的 `PerformanceObserver` 还能拿到探针运行之前的请求。这些记录有 URL、类型、时序、大小，以及浏览器公开时的状态码和 MIME 类型，但没有请求头和响应头；响应体在需要时从 HTTP 缓存重新读取。外壳模式下启用了 Service Worker 时，它会为同源请求补上请求头和响应头。之所以仍以 hook 为主：hook 从最开始就生效、带调用栈、无需部署；Service Worker 要安装后才能接管页面，会和网站自己的 Service Worker 冲突，而且要代理请求才能看到响应。
- CDP 运行时和前端延迟加载。运行时的 Runtime、Network 域直接读取探针的缓冲并订阅新事件，因此每个 API 只被 hook 一次。

页面外没有任何途径能观察页面内的输出，只有比业务代码更早执行的脚本才能捕获最早的输出。完整的 CDP 运行时体积太大，不适合同步加载，所以只把最小的捕获逻辑放在最前面。

这个方案已经验证可行，见 [experiments/early-capture/RESULTS.md](../experiments/early-capture/RESULTS.md)：用约 1.4 KB 的探针加延迟加载的 chobitsu，所有早期的 console 调用、异常和请求都进入了 devtools，对象可以展开，时间戳和调用栈都是原始的。

### 2. 外壳模式（原地改写）

不托管独立的 `devtools.html`，也不跳转到 blob URL，因为 blob 会导致刷新失效、地址无法分享。做法是：

1. 使用零配置探针（`data-devtools-frontend-url`，或 Vite 插件）时，顶层页面首次加载就默认进入外壳模式：探针在页面脚本运行前自己把前端地址和 bundle 地址写入 `sessionStorage`，不需要再刷新一次。除非设置了 `data-open-immediately`，devtools 一开始是隐藏的。其他情况下，点击 DevTools 工具栏上的锁形按钮“Keep DevTools open across reloads”，写入这些地址后刷新页面。
2. 探针作为第一个脚本，在顶层窗口检测到配置后，先写入一个不闭合的 `<plaintext>`，让页面剩余的内容变成纯文本（页面脚本都不会执行），再用 `document.open()` / `document.write()` 把文档替换成外壳。外壳中有指向 `location.href` 的用户页面 iframe，以及 `<devtools-anywhere>`，它凭所在的文档认出自己是外壳的元素。（Chrome 在 `window.stop()` 之后会忽略 `document.open()`，所以改用 `<plaintext>`。）
3. 在 iframe 中，探针照常捕获，并加载 bundle，把页面的 CDP 会话连接到外壳。外壳在页面和前端之间转发消息。
4. 页面刷新或跳转后，新页面会发出 hello；外壳通知前端页面已导航，并把前端发过的所有 `enable` 命令重新发给新页面，新页面就会回放它自己最早的输出。地址栏和标题跟随页面变化，包括加载、前进后退和同文档导航（有 Navigation API 时也包括 `pushState`），因此刷新或复制链接打开的都是当前显示的页面。
5. DevTools 铺满外壳，由它来排布页面和自己，和 Chrome 一样：页面 iframe 放在前端的页面区域上，叠在上层。停靠位置和尺寸由 DevTools 自己管理（用它的分隔条；DevTools 面板边缘正中、靠页面一侧还有一个抓手，像面板的一个小标签，触屏上更大）。取消停靠时，DevTools 是页面上方的浮动窗口。工具栏上的设备按钮是设备模式，和 Chrome 一样，取代了投屏：页面 iframe 按设备尺寸设置并缩放到适合窗口，工具栏的菜单可以截图。取消停靠时，设备模式的工具栏画在前端的一个页面（`device_mode_emulation_frame.html`，Chrome 也是这么做的）里，显示在浮动窗口下方。
6. 点工具栏上的 × 只隐藏 devtools，仍留在外壳模式；在重新显示 devtools 之前，页面按自己的尺寸铺满外壳。再点一次锁形按钮会清除配置，并在普通模式下重新加载页面；这个选择会记在 `localStorage` 里，之后优先于页面的 `data-default-shell-mode`，除非页面设置了 `data-shell-mode-locked`。

只有与探针脚本同源的地址才会被采信，否则清除配置、页面照常加载。因此外壳模式要求探针、bundle 和前端都由页面所在的源提供。

页面放进 iframe 后，`viewport`、`100vh`、`position: fixed`、`window.top` 等的行为可能和直接打开时不同；页面的 HTML 会被请求两次（顶层窗口一次，iframe 一次），表单 POST 返回的页面会被用 GET 再请求一次。用 `data-default-shell-mode="off"`（Vite 插件的 `defaultShellMode: 'off'`）可以关闭外壳模式，改为把 devtools 直接嵌在页面中。拒绝被嵌入（`X-Frame-Options`、CSP `frame-ancestors`）或反复把外壳跳走的页面，在本会话剩下的时间里会单独显示。

### 3. 注入方式

| 方式 | 适用场景 |
|---|---|
| 页面手动引入 `<script>`（必须放在 `<head>` 第一个） | 任意页面 |
| `@devtools-anywhere/vite-plugin`：只在开发模式（`vite serve`）下注入 | 使用 Vite 的项目（之后可能补充 webpack 插件） |
| `devtools-anywhere-service-worker.js`：外壳模式下，给页面 iframe 中加载的、没有引入探针的同源页面注入探针 | 安全上下文（HTTPS 或 localhost）、作用域覆盖这些页面（`Service-Worker-Allowed: /`），并且站点没有自己的 Service Worker |

所有方式共用同一份探针。

## 拆包

[README](../README.zh-CN.md#发布形式) 里列出的包为什么这样拆：

- 页面内的 CDP agent 和探针不单独成包：探针和各个域共用同一套 hook 和缓冲，而且只有 `devtools-anywhere` 使用它们。它们放在 `devtools-anywhere` 中（`src/cdp-agent/`），不会出现版本不匹配；探针仍单独构建成一个很小的文件 `probe.iife.js`。
- 前端单独成包，因为它体积大（约 16 MB），更新节奏跟随 Chrome 版本。其他语言（约 42 MB）再拆成一个包，需要的人才装。
- 所有包使用同一个版本号、一起发布，版本号相同的包一定能配合使用。
