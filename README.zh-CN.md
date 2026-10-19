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
| 前端 | 原型阶段：Chii 已构建好的 `front_end`；正式阶段：官方 devtools-frontend 加本项目的补丁集 | Chii 的版本可以直接使用，适合快速验证。正式版本钉住官方的某个版本，补丁以 `.patch` 文件维护，升级时逐个重放，不维护长期 fork 分支 |
| 隔离 | iframe | 隔离 devtools 自身的 DOM、日志和请求，避免它们出现在被调试页面中，也避免与页面的全局环境互相干扰 |

本项目不依赖 Chii 和 chobitsu，只把它们作为参考。

### 能力边界

- 页面内的 CDP 实现只能基于 JS API，因此以下能力**无法提供**：断点调试、Profiler、Memory、真实的网络时序。这些面板应该隐藏，而不是展示给用户后再让他发现不能用。
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

压缩后约 1–2 KB（min+gzip）的同步脚本，必须是 `<head>` 中第一个执行的脚本。

- 立即 hook `console`、`window.onerror`、`unhandledrejection`、`fetch` 和 `XHR`，把事件连同时间戳写入缓冲。
- CDP 运行时和前端延迟加载。运行时的 Runtime、Network 域直接读取探针的缓冲并订阅新事件，因此每个 API 只被 hook 一次。

页面外没有任何途径能观察页面内的输出，只有比业务代码更早执行的脚本才能捕获最早的输出。完整的 CDP 运行时体积太大，不适合同步加载，所以只把最小的捕获逻辑放在最前面。

这个方案已经验证可行，见 [experiments/early-capture/RESULTS.md](experiments/early-capture/RESULTS.md)：用约 1.4 KB 的探针加延迟加载的 chobitsu，所有早期的 console 调用、异常和请求都进入了 devtools，对象可以展开，时间戳和调用栈都是原始的。

#### 2. 外壳模式（原地改写）

不托管独立的 `devtools.html`，也不跳转到 blob URL，因为 blob 会导致刷新失效、地址无法分享。做法是：

1. 开启 f12 时，在 `sessionStorage` 中写入标记，然后刷新页面。
2. 探针执行时检测到标记，并且自身不在 iframe 中：调用 `window.stop()` 停止加载原页面，再用 `document.open()` / `document.write()` 写入外壳。外壳中的用户页面 iframe 指向 `location.href`。
3. 探针在 iframe 中再次执行，识别到自己处于外壳内，开始正常工作。
4. 关闭 f12 时，清除标记并刷新页面。

这样地址栏始终是真实地址，刷新和分享都正常；用户页面刷新时，devtools 保留不动。

外壳模式是**可选**的：页面放进 iframe 后，`viewport`、`100vh`、`position: fixed`、`window.top`、`X-Frame-Options` 等的行为可能和直接打开时不同。默认模式是把 devtools 直接嵌在页面中。

#### 3. 注入方式

| 方式 | 适用场景 |
|---|---|
| 页面手动引入 `<script>`（必须放在 `<head>` 第一个） | 任意页面 |
| Vite / webpack 插件，在开发模式下自动注入、生产构建自动移除 | 使用构建工具的项目 |
| Service Worker 改写外壳内 iframe 的 HTML | 同源、HTTPS、站点没有自己的 SW；可以顺带记录探针执行之前的网络请求 |

所有方式共用同一份探针。

### 发布形式

发布一个总包，以及 npm 组织 [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) 下的几个子包：

| 包 | 内容 |
|---|---|
| `devtools-anywhere` | 总包：依赖下面的子包，提供 `<devtools-anywhere>` 组件和最简单的接入方式 |
| `@devtools-anywhere/cdp-server` | 页面内的 CDP 服务端。探针通过子路径 `@devtools-anywhere/cdp-server/probe` 导出，单独构建成一个很小的文件，供 `<script>` 引入和插件注入使用 |
| `@devtools-anywhere/devtools-frontend` | 构建好的前端静态资源，可以自托管，也可以从 CDN 引用 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |

- 探针不单独成包：Runtime 和 Network 域直接读取它的缓冲，两者必须严格匹配。放在 cdp-server 中可以共用类型，也不会出现版本不匹配。
- 前端单独成包，因为它体积大（约 14 MB），更新节奏跟随 Chrome 版本。
- 所有包使用同一个版本号、一起发布，版本号相同的包一定能配合使用。

### 目录结构（规划）

```
packages/
  cdp-server/     页面内的 CDP 服务端
    src/probe/    早期捕获：零依赖，有体积上限，单独的构建入口
    src/core/     跨域共享的状态：远程对象、节点 id、DOM 变化监听、样式表
    src/domains/  每个域一个目录：runtime、network、dom、css、overlay、storage……
  devtools-frontend/  钉住的 devtools-frontend 版本、补丁和构建脚本
  devtools-anywhere/  总包：<devtools-anywhere>、iframe、连接层、外壳模式
  vite-plugin/    零配置注入
tests/
  conformance/    用 Puppeteer 对比真实 Chrome 的 CDP 输出
  e2e/            探针 → CDP → 前端的完整流程
playground/       开发调试用的页面和服务器
experiments/      验证记录
```

## 约束与注意事项

- 所有 `postMessage` 都必须校验 `event.origin` 和 `event.source`，否则任意页面都能向 CDP 运行时发送命令。
- 判断"是否处于外壳内"要通过 postMessage 握手完成，不要直接读取 `window.parent` 上的属性，否则跨域时会抛出 SecurityError。
- 握手的两端都要有缓冲：devtools 尚未加载完成时，消息不能丢弃。
- 前端资源应当支持自托管，不依赖 unpkg、jsdelivr 等第三方 CDN。
- 使用 Service Worker 注入时：
  - 只处理 `destination === 'iframe'` 的导航请求，其他请求一律放行。
  - 关闭 f12 时调用 `unregister()`。
  - 用 `TransformStream` 流式插入探针，避免破坏 SSR 的流式输出。
  - 注意作用域：SW 脚本需要放在站点根路径，或者由服务器返回 `Service-Worker-Allowed` 头。

## 路线图

1. ✅ **验证早期捕获**：探针、缓冲和回放（[结果](experiments/early-capture/RESULTS.md)）。
2. **项目骨架和 CDP 核心**：workspace、TypeScript、最新的 `devtools-protocol`；跨域共享的核心状态；基于探针的 Runtime 和 Network 域；对比真实 Chrome 的一致性测试。
3. **连接层和默认模式**：完成握手时序、两端缓冲和 origin 校验；`<devtools-anywhere>` 直接嵌在页面中。
4. **外壳模式**：用原地改写实现，验证刷新、跳转后 devtools 仍然保留。
5. **零配置接入**：Vite 插件、单行 `<script>`，最后是可选的 Service Worker 注入。
6. **其余的域**：先做 DOM 和 Overlay，然后是 CSS，最后是各种存储相关的域（DOMStorage、Storage、IndexedDB、CacheStorage）。
7. **前端定制**：基于官方 devtools-frontend 维护补丁集并定期升级；隐藏用不了的面板，适配小屏。

## 参考

- [chobitsu](https://github.com/liriliri/chobitsu)：CDP 实现的参考
- [Chii](https://github.com/liriliri/chii)：嵌入模式 `src/target/DevtoolsFrame.ts`
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
- [Puppeteer](https://github.com/puppeteer/puppeteer)：一致性测试中作为标准答案
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## 许可证

[MIT](LICENSE)
