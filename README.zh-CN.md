# devtools

[English](README.md) | 简体中文

在手机网页上直接使用 Chrome DevTools 的 web component。

移动端浏览器没有开发者工具，现有方案各有短板：

- **eruda / vConsole**：只能捕获初始化之后的输出。它们体积较大，通常异步加载，页面最开始的日志和报错会丢失。
- **Chii**：能做到早期捕获，但接入和配置比较繁琐，前端停留在旧版 Chrome DevTools（约 122）。

本项目的目标：

1. **不丢最早的输出**：从页面第一行脚本开始，console、报错、网络请求都能看到。
2. **接入零配置**：一行 `<script>` 或一个构建插件就能用。
3. **刷新不丢 devtools**：页面刷新或跳转时，devtools 保持打开，日志可以持续保留。
4. **持续跟进新版 Chrome DevTools**：基于官方 devtools-frontend 维护一组补丁，定期升级，不长期停留在旧版本。

## 设计

### 选型

| 部分 | 选择 | 理由 |
|---|---|---|
| CDP 实现 | 先用 [chobitsu](https://github.com/liriliri/chobitsu)，后续可能自行重写 | 在页面内调试只能通过 JS API 采集数据，用其他语言（如 Rust 编译为 wasm）实现没有收益。自行重写是为了更贴合本项目，比如原生支持探针缓冲回放、跟上新版 CDP |
| 前端 | 原型阶段：Chii 发布在 npm 上的 `front_end`；正式阶段：官方 devtools-frontend 加本项目的补丁集 | Chii 的版本已构建好，可以直接从 CDN 加载，适合快速验证。正式版本钉住官方的某个版本，补丁以 `.patch` 文件维护，升级时逐个重放，不维护长期 fork 分支 |
| 隔离 | iframe | 隔离 devtools 自身的 DOM、日志和请求，避免它们出现在被调试页面中，也避免与页面的全局环境互相干扰 |

不依赖 Chii 本身，只参考它的嵌入模式与握手协议。

### 能力边界

页面内的 CDP 实现只能基于 JS API，因此以下能力**无法提供**：断点调试、Profiler、Memory、真实的网络时序。这些面板应该隐藏，而不是展示给用户后再让他发现不能用。

### 架构

```
┌──────────── 顶层窗口（外壳）─────────────┐
│  ┌──────────────────────────────────┐  │
│  │ 用户页面 iframe                   │  │
│  │  探针（<head> 首个同步脚本）       │  │
│  │   └─ 缓冲 → chobitsu（延迟加载）   │  │
│  └──────────────┬───────────────────┘  │
│        postMessage（校验 origin）       │
│  ┌──────────────┴───────────────────┐  │
│  │ devtools iframe（blob URL）       │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

#### 1. 探针

体积只有几 KB 的同步脚本，必须是 `<head>` 中第一个执行的脚本。

- 立即 hook `console`、`window.onerror`、`unhandledrejection`、`fetch` 和 `XHR`，把事件连同时间戳写入缓冲。
- chobitsu 和前端延迟加载；连接建立后，先把缓冲中的事件回放到 devtools，再切换为实时转发。

之所以单独拆出探针，是因为页面外没有任何途径能观察页面内的输出，只有比业务代码更早执行的脚本才能捕获最早的输出。chobitsu 本身有 450 KB 以上，同步加载会拖慢首屏，所以只把最小的捕获逻辑放在最前面。

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

## 约束与注意事项

- 所有 `postMessage` 都必须校验 `event.origin` 和 `event.source`，否则任意页面都能向 chobitsu 发送 CDP 命令。
- 判断"是否处于外壳内"要通过 postMessage 握手完成，不要直接读取 `window.parent` 上的属性，否则跨域时会抛出 SecurityError。
- 握手的两端都要有缓冲：devtools 尚未加载完成时，消息不能丢弃。
- 前端资源应当支持自托管，不依赖 unpkg、jsdelivr 等第三方 CDN。
- 使用 Service Worker 注入时：
  - 只处理 `destination === 'iframe'` 的导航请求，其他请求一律放行。
  - 关闭 f12 时调用 `unregister()`。
  - 用 `TransformStream` 流式插入探针，避免破坏 SSR 的流式输出。
  - 注意作用域：SW 脚本需要放在站点根路径，或者由服务器返回 `Service-Worker-Allowed` 头。

## 路线图

1. **验证早期捕获**：探针 + 缓冲 + 回放。用一个测试页面在最开头同步打印日志，确认这些日志能完整出现在 Console 面板中。
2. **连接层**：完成握手时序、两端缓冲和 origin 校验，跑通默认模式。
3. **外壳模式**：用原地改写实现，验证刷新、跳转后 devtools 仍然保留。
4. **零配置接入**：Vite 插件、单行 `<script>`，最后是可选的 Service Worker 注入。
5. **组件化与前端定制**：封装成 custom element，提供属性、事件和方法；隐藏用不了的面板，适配小屏；基于官方 devtools-frontend 维护补丁集，并定期升级。
6. **自研 CDP 实现（可选）**：视需要替换 chobitsu。

## 参考

- [Chii](https://github.com/liriliri/chii)：嵌入模式 `src/target/DevtoolsFrame.ts`
- [chobitsu](https://github.com/liriliri/chobitsu)
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## 许可证

[MIT](LICENSE)
