# 使用指南

[English](usage.md) | 简体中文

devtools-anywhere 的接入参考。快速上手见 [README](../README.zh-CN.md)，工作原理见[设计文档](design.zh-CN.md)。

## 选择接入方式

| 场景 | 接入方式 |
|---|---|
| 任意页面，自己部署，要外壳模式 | [script 标签](#script-标签) |
| 任意页面，不想部署 | 从 CDN 引入的 [script 标签](#script-标签) |
| Vite 项目，开发时用 | [Vite 插件](#vite) |
| 在电脑上调试手机里的页面 | [远程调试](#远程调试) |
| DevTools 嵌在页面自己的布局里 | [页面自己放置的组件](#页面自己放置的组件) |

## script 标签

```bash
npm i devtools-anywhere @devtools-anywhere/devtools-frontend
```

部署这两个包的 `dist/`，把探针放在 `<head>` 里第一个，同步加载：

```html
<script src="/devtools-anywhere/dist/probe.iife.js"
  data-devtools-frontend-url="/devtools-frontend/dist/anywhere_app.html"></script>
```

用 jsDelivr 或 unpkg 时，固定一个确切版本：探针会从同一个 CDN 加载同版本的前端。

```html
<script src="https://cdn.jsdelivr.net/npm/devtools-anywhere@0.2.0/dist/probe.iife.js"></script>
```

| | 自己部署 | CDN（jsDelivr、unpkg） |
|---|---|---|
| `data-devtools-frontend-url` | 必填 | 可选：默认用 CDN 上同版本的前端 |
| 外壳模式 | ✅ 默认开启 | ✅ 默认开启，但没有 [Service Worker](#service-worker) |
| 界面语言 | 全部（`@devtools-anywhere/devtools-frontend-locales` 放在前端目录下） | 英文和中文 |

- 页面加载完成后，探针在 `<html>` 下挂载一个 `<devtools-anywhere>`，不管页面里有没有；第二个探针只会警告。
- 缓存：前端 `bundle/` 下的文件以内容命名，可以永久缓存；`anywhere_app.html` 用 `Cache-Control: no-cache` 提供。

### 属性

| 属性 | Vite 选项 | 默认值 | 作用 |
|---|---|---|---|
| `data-devtools-frontend-url` | `devtoolsFrontendUrl` | 来自 jsDelivr、unpkg 的 script 标签：CDN 上同版本的前端。其他 script 标签：无。Vite：已安装的前端 | 前端的 `anywhere_app.html`。没有前端就不挂载面板 |
| `data-no-panel` | — | 关 | 不管有没有前端，都不挂载面板、不进外壳模式：用于只做[远程调试](#远程调试)的页面 |
| `data-bundle` | — | 探针同目录 | `devtools-anywhere.iife.js` 的地址 |
| `data-open-immediately` | `openImmediately` | 关 | 页面加载后直接打开 DevTools |
| `data-default-shell-mode` | `defaultShellMode` | `on` | `off`：不用外壳模式，面板盖在页面上 |
| `data-shell-mode-locked` | `shellModeLocked` | 关 | 始终按 `data-default-shell-mode` 执行，忽略用户的选择（选择仍会保留），并隐藏 DevTools 里的开关 |
| `data-no-toggler` | `noToggler` | 关 | 隐藏 F12 按钮 |
| `data-service-worker` | `serviceWorker`（开 / 关） | 关 | 启用 [Service Worker](#service-worker)。作为属性时可以写它的地址（留空：bundle 同目录） |
| `data-remote` | `remote` | 关 | 连接[远程调试](#远程调试)服务端：它的地址（留空：探针所在的服务端） |
| `data-id-in-query` | `idInQuery` | 关 | 配合开启了 `idInQuery` 的服务端 |

## Vite

```bash
npm i -D @devtools-anywhere/vite-plugin
```

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default { plugins: [devtoolsAnywhere()] }
```

- 只在 `vite serve` 时生效。探针作为每个页面的第一个脚本注入；bundle、Service Worker 和前端都在 `/@devtools-anywhere/` 下提供。
- 选项：和[属性](#属性)一一对应，另加 `devtoolsFrontendPath`（本地另一份前端构建，`…/anywhere_app.html`，托管它所在的目录）。
- `serviceWorker: true`：插件还会返回 `Service-Worker-Allowed` 头。
- 装了 `@devtools-anywhere/devtools-frontend-locales` 就提供全部界面语言。

## 页面自己放置的组件

```html
<devtools-anywhere devtools-frontend-url="/devtools-frontend/dist/anywhere_app.html" style="height: 400px"></devtools-anywhere>
```

- 页面布局中的一个块，尺寸由页面 CSS 决定。连接到文档后就加载 DevTools，`hidden` 时保持加载。
- 没有 F12 按钮、停靠位置、调整大小和外壳模式；在外壳里的页面中照常工作。
- 只有一个属性 `devtools-frontend-url`（默认用探针的），其他属性一律忽略。
- DevTools 的 iframe 可以用 `devtools-anywhere::part(iframe)` 改样式。

## 面板

| 控件 | 作用 |
|---|---|
| F12 按钮 | 打开面板 |
| 面板内侧边缘正中的抓手 | 调整停靠面板的大小（外壳模式下也有，旁边还有 DevTools 自己的分隔条） |
| ⋮ → 停靠位置 | 底部（默认）、右侧、左侧，或取消停靠：拖横条移动、拖右下角调整大小的浮动窗口 |
| 锁形按钮（⚙ 左边） | 开关外壳模式；开启前有对话框说明，开启期间顶部有提示条 |
| 刷新按钮 | 重新加载页面 |
| × | 关闭面板 |

- 停靠位置和尺寸记在 `localStorage` 里，尺寸按视口百分比记录（`dvh`/`dvw`），换屏幕或横竖屏后依然合适。
- 外壳模式下页面会让出空间；否则面板盖在页面上。
- 可以用 `devtools-anywhere::part(toggler)` 修改 F12 按钮的样式，外壳模式下同样有效：此时按钮在页面 iframe 里（只有页面没有探针时，例如其他源的页面，外壳才显示自己的按钮）。
- 在 DOM 里移动组件会重新加载 DevTools。

### 切换按钮

任何元素都可以开关面板：

```html
<button data-devtools-anywhere-toggle>DevTools</button>
```

| `data-devtools-anywhere-toggle` | 点击时 |
|---|---|
| 空 | 开关探针的面板；`aria-expanded` 跟随面板状态 |
| 页面放置的组件的 id | 在那个组件上触发 `devtools-toggle-request`；没有 `aria-expanded` |

- 在 document 上监听点击，之后加入的按钮也有效。不阻止默认行为。
- 探针加载完 `devtools-anywhere.iife.js` 后才生效。
- 外壳里的页面上，所有切换按钮都控制外壳的面板。
- 位于 shadow root 里、或与外壳不同源的页面里的切换按钮无效。
- 指向不存在的组件时会警告，每个值只警告一次。
- 组件不触发开关事件：切换按钮上的 `aria-expanded` 就是状态。

## 外壳模式

顶层页面换成一个外壳：页面运行在 DevTools 旁边的 iframe 里，和 Chrome 一样。

| | 外壳模式 | 非外壳模式 |
|---|---|---|
| 刷新、跳转时的 DevTools | 保持打开，日志保留 | 随页面重新打开 |
| 设备模式 | ✅ | 换成投屏 |
| 布局 | 页面在 DevTools 旁边缩小 | 面板盖在页面上 |

bundle、前端（以及 Service Worker）在探针信任的位置时，顶层页面默认开启外壳模式。信任的位置是：与探针同源；探针来自 jsDelivr 或 unpkg 时，则只限探针所在的包和同版本的前端包。以下情况关闭：

| 情况 | |
|---|---|
| `data-default-shell-mode="off"` | 用户手动开启时除外 |
| 用户点锁形按钮关闭 | 设置了 `data-shell-mode-locked` 时除外 |
| 页面禁止被嵌入（`X-Frame-Options`、CSP `frame-ancestors`） | 本次会话内一直关闭 |
| 页面反复把外壳跳转走 | 本次会话内一直关闭 |

注意：

- 在 iframe 里，`100vh`、`position: fixed`、`window.top` 和视口的表现可能不同。
- 页面的 HTML 会请求两次；表单 POST 返回的页面会用 GET 再请求一次。

### Service Worker

`data-service-worker` / `serviceWorker`，外壳模式下：

- 给页面 iframe 里没有探针的同源页面注入探针。
- 为同源请求（文档、样式表、脚本、图片等）补上请求头和响应头。
- 需要安全上下文（HTTPS 或 localhost）、覆盖这些页面的作用域（`Service-Worker-Allowed: /`），且站点没有自己的 Service Worker。

## 远程调试

```bash
npx -p @devtools-anywhere/remote-server devtools-anywhere-remote
```

1. 把它打印出的 `<script>` 加进页面：

   ```html
   <script src="http://192.168.1.2:8080/probe.iife.js" data-remote></script>
   ```

2. 在电脑上打开它打印出的目标列表（地址里带令牌），点「inspect」。

服务端自己提供探针、bundle 和前端，前端运行在电脑上：上面的同源要求不适用。

### 命令行选项

| 选项 | 默认值 | 作用 |
|---|---|---|
| `--port`、`-p` | `8080` | 端口 |
| `--host` | 所有网卡 | 监听的网卡 |
| `--public-url` | 局域网地址 | 打印给页面的地址，例如在代理后面时 |
| `--base-path` | `/` | 挂在某个路径下 |
| `--token <t>` / `--no-token` | 随机 | 目标列表和 DevTools 需要的令牌；页面不需要 |
| `--cert`、`--key` | — | HTTPS；HTTPS 页面需要 |
| `--id-in-query` | 关 | 目标放在查询参数里，用于按完整路径转发 WebSocket 升级的主机 |
| `--devtools-frontend-path` | 自带的前端 | 本地另一份前端构建 |
| `--devtools-frontend-url` | — | 托管在别处的前端（CDN；用 HTTPS 时服务端也要 HTTPS）。WebSocket 地址和令牌放在 URL 片段里，不会发给 CDN |

### 行为

- 页面加载完成后连接；早期输出照常捕获。
- 页面刷新或在同一标签页内跳转时，DevTools 保持连接。断线的页面会自动重连，期间仍留在列表里。
- 多个 DevTools 窗口可以同时调试一个页面，各自一个会话。
- 目标列表可以筛选，并显示每个页面连着几个 DevTools。
- 同时有前端时（写了 `data-devtools-frontend-url`，或探针来自 jsDelivr、unpkg），页面还有自己的面板；不要面板时加 `data-no-panel`。
- 断点仍要靠浏览器自带的调试器（`chrome://inspect`、Safari Web Inspector）：页面里运行的仍是同一个页面内 agent。

探针来自别处时，用带值的 `data-remote` 指定服务端，按链接的规则解析：

| `data-remote` | 服务端 |
|---|---|
| `http://host:8080/devtools/` | 在 `/devtools/` 下 |
| `http://host:8080/devtools` | 在 `/` 下 |

外壳模式下：

- 连接的是外壳里的页面，不是外壳本身。
- 外壳里的所有页面由外壳的探针决定，页面自己的 `data-remote` 无效，所以页面脚本没法把之后的页面指向别的服务端。
- 配合 `data-service-worker`，被它注入的页面也会连接。
- 外壳模式要求前端在探针信任的位置：探针来自服务端、前端在别处时用不了。

### Node.js 与接口

| API / 地址 | 说明 |
|---|---|
| `startRemoteServer(options)` | 命令行用的服务端 |
| `createRemoteHandler(options)` | 请求和升级处理函数，挂到自己的服务里（Express、Koa 等）；不属于它的请求返回 `false` |
| `<base>target/<id>` | 页面的 WebSocket |
| `<base>client/<id>` | DevTools 的 WebSocket |
| `<base>?target=<id>`、`<base>?client=<id>` | 同上，`idInQuery` 时的形式（两种都始终接受） |
| `/json/list` | 目标列表，格式同 Chrome（需要令牌） |
| `anywhere_app.html?ws=<host:port/path>` | 单独打开的前端连接某个目标，同 Chrome 的 `devtools_app.html?ws=`（HTTPS 用 `wss=`；也可写在 `#?ws=`） |

## 能力边界

拿不到的数据要么精确补上，要么不显示：不把近似值当成事实。

| 功能 | 状态 | 说明 |
|---|---|---|
| 断点、Profiler、内存、性能 | ❌ 不打包这些面板 | 没有 JS API。`debugger;` 不会暂停；外壳模式下改为输出一条带堆栈的警告 |
| 网络时序 | ❌ | 没有 JS API |
| 源代码 | ⚠️ | 文档、外链脚本和样式表、图片、字体；不列内联脚本；代码段可用 |
| 浏览器默认样式 | ❌ | 浏览器不向页面公开 |
| 事件监听器 | ⚠️ | 只有探针运行之后添加的；没有源码位置 |
| WebSocket | ⚠️ | 连接和帧；没有握手头 |
| 跨源样式表 | ⚠️ | 需要 CORS；只读 |
| 强制 `:hover`、`:focus` 等 | ⚠️ | 不覆盖 `@import` 和 `adoptedStyleSheets` 的样式表 |
| 投屏（非外壳模式下的设备按钮） | ⚠️ | 由 [snapDOM](https://github.com/zumerlab/snapdom) 从 DOM 重绘：canvas、视频、跨源图片可能缺失；每秒最多约 2 帧。输入以 `isTrusted: false` 的事件回放 |
| 截图 | ⚠️ | 见[下文](#截图) |
| 设备模式 | ⚠️ | 仅外壳模式。只改尺寸，不改像素比、UA 和触摸；它的截图由 snapDOM 生成，按页面自身的像素比 |
| 全屏的页面 | ⚠️ | 有元素全屏时用不了 DevTools，外壳模式下也一样。按 Esc 退出全屏即可 |
| 前端与页面同源 | ⚠️ | DevTools 的设置会和页面共用 `localStorage`：前端放在别的源 |
| 浏览器 | ⚠️ | 页面这边：现代浏览器都行。DevTools 界面：只在 Chrome 上验证过；新版前端可能需要兼容补丁 |

snapDOM（gzip 后约 90 KB）只在投屏和截图时加载。

### 截图

`Page.captureScreenshot`，供通过 CDP 操作页面的工具和 agent 使用：

- 和投屏一样由 snapDOM 绘制，并标注 `approximate: true`（Chrome 不返回这个字段）。
- `clip` 用页面坐标；图片按设备像素计算（`devicePixelRatio` × `clip.scale`）。
- 没有 `clip` 时，`captureBeyondViewport` 截整个页面。
- 超出画布上限（每边 32767 像素，Safari 为 16384，面积 16384 × 16384）时缩小，snapDOM 会在控制台警告。
- 不支持编码 WebP 的浏览器（Safari）退回 PNG。

## 包

| 包 | 内容 |
|---|---|
| `devtools-anywhere` | `probe.iife.js`、`devtools-anywhere.iife.js`（组件）、`devtools-anywhere-service-worker.js`、`snapdom.js`；组件、事件和各属性的 TypeScript 类型。没有可以 import 的模块 |
| `@devtools-anywhere/devtools-frontend` | 前端，英文和中文界面 |
| `@devtools-anywhere/devtools-frontend-locales` | 其余 80 种界面语言；和前端放在同一目录。缺少的语言退回英文 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |
| `@devtools-anywhere/remote-server` | 远程调试服务端和命令行（`devtools-anywhere-remote`） |
