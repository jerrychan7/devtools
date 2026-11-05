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
| `data-frame-origins` | `frameOrigins`（数组） | 无 | 本页 DevTools 可以调试的[跨域 iframe](#跨域-iframe) 的源，空格分隔；写 `sandboxed` 调试它的[沙箱 iframe](#沙箱-iframe) |
| `data-parent-origins` | `parentOrigins`（数组） | 无 | 可以在自己的 iframe 里调试本页的页面的源，空格分隔 |

### 跨域 iframe

页面拿不到跨域 iframe 的文档。如果 iframe 里的页面也加载了探针，并且双方互相信任，就能在父页面的 DevTools 里调试它，和 Chrome 调试进程外 iframe 一样：Elements 里它的文档挂在 `<iframe>` 下，Console 的上下文菜单里有它的执行上下文，请求、样式、高亮和输入也都能用。

```html
<!-- https://app.example.com -->
<script src="…/probe.iife.js" data-frame-origins="https://widget.example.net"></script>
<!-- https://widget.example.net，在上面页面的 iframe 里 -->
<script src="…/probe.iife.js" data-parent-origins="https://app.example.com"></script>
```

- 两边的名单都要配，默认都关闭：父页面的 DevTools 能在 iframe 里执行任意代码。
- 每一项是确切的源，或者 `https://*.example.com`，表示任意层级的子域（不含 `example.com` 本身）；协议和端口要完全一致。单独的 `*` 会被忽略并给出警告。
- 连上以后，iframe 自己的 F12 按钮和面板会隐藏。
- iframe 重新加载、或者导航到同样会连接的页面，连接都会保留；iframe 里再嵌的跨域 iframe 也按同样方式逐级连上。

### 沙箱 iframe

没有 `allow-same-origin` 的沙箱 iframe 是不透明源（`null`）：页面拿不到它的文档，Chrome 也不给它开子 target，而是留在页面自己的 target 里。如果沙箱文档也加载了探针，并且父页面允许，它就像在 Chrome 里一样并入父页面的 target：Elements 里它的文档挂在 `<iframe>` 下，Console 里有它的执行上下文和消息，Network 有它的请求，Sources 有它的脚本，Styles 有它的样式表；高亮、检查模式和输入也都能进入它。

```html
<!-- https://app.example.com -->
<script src="…/probe.iife.js" data-frame-origins="sandboxed"></script>
<!-- 沙箱文档，在上面页面的 <iframe sandbox="allow-scripts" src="/widget.html"> 里 -->
<script src="…/probe.iife.js" data-parent-origins="https://app.example.com"></script>
```

- 默认关闭：父页面的 `data-frame-origins` 写上 `sandboxed` 才开启（可以和源写在一起），沙箱文档的 `data-parent-origins` 写父页面的源。父页面的 DevTools 能在 iframe 里执行任意代码，而沙箱文档可能加载第三方脚本。
- 只对 `src` 与页面同源、`about:blank` 或 `srcdoc` 的生效。`src` 跨源的一律拒绝，同站的也一样（Chrome 把它留在页面的 target 里）：只显示为元素，不列在 frame 树里。
- 校验看的是 iframe 的 `src`，不是它实际装着的文档：沙箱文档的源是 `null`，页面分辨不出它从哪来。iframe 一旦导航到别的源（在框里点了链接，或 `src` 被重定向），那边的文档只要实现了探针的握手，同样会被并入，它回报的内容会出现在页面的 DevTools 里。只对始终停留在自己页面上的 iframe 开启。
- 没有开启，或者沙箱文档没加载探针时，按[能力边界](#能力边界)里说的显示。

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
| 浏览器默认样式 | ⚠️ | Styles 里显示「user agent stylesheet」规则，来自 Chromium 的 `html.css` 副本（`chromium-html.css`，首次使用时从 bundle 旁边加载）。含 Blink 内部选择器的规则不显示，`@supports blink-feature()` 按特性关闭处理，只用 `html.css`（不含 Chrome 的其他默认样式表）；bundle 内联（没有 URL）时不显示。Computed 窗格在 DOM 变动和 DevTools 自己修改样式时刷新，不是每次样式变化都刷新；合并的沙箱 iframe 里的节点不刷新 |
| 事件监听器 | ⚠️ | 只有探针运行之后添加的；没有源码位置 |
| WebSocket | ⚠️ | 连接和帧；没有握手头 |
| 同源 iframe | ⚠️ | iframe 的导航要到 load 事件才发现，比 Chrome 晚：在此之前的日志和请求拿不到，srcdoc 和空 iframe 除外；在此之前 iframe 脚本附加的 closed shadow root 也拿不到。没有隔离 world（`Page.createIsolatedWorld`） |
| 沙箱 iframe（没有 `allow-same-origin`） | ⚠️ | [并入](#沙箱-iframe)父页面的 target 后和 Chrome 一样：它的 DOM、样式、执行上下文、console、请求和脚本都显示在父页面里，能高亮、检查和输入。并入后：跨沙箱边界移动或复制节点会报错；`DOM.performSearch` 的结果父页面在前、沙箱在后；沙箱文档重新加载时，新的 `contentDocument` 直接带着子节点数，不发 `childNodeCountUpdated` 和 `scrollableFlagUpdated`；Chrome 为沙箱 iframe 起初的 about:blank 报的执行上下文没有；向沙箱取文档、节点或坐标的请求 1 秒内没有应答，就按沙箱未应答处理（不嫁接它的文档，落在它上面的坐标命中 `<iframe>` 本身）；从 Console 在沙箱里执行的代码，之后抛出的未捕获异常（比如在定时器里）不带异常对象（`exception` 为 null），也没有位置和堆栈：沙箱文档把探针脚本当作跨源脚本，屏蔽了它的错误详情；沙箱页自己脚本的异常不受影响；沙箱脚本的源码由父页面按 URL 重新获取，只能拿到父页面能取到的；检查模式下悬停高亮被 iframe 边界裁剪，`highlightNode` 画的沙箱节点高亮不随滚动更新；沙箱文档导航后 `frameNavigated` 的 `loaderId` 不变；沙箱 frame 导航到没有探针的页面后，父页面仍留着旧文档。未并入（没有开启，或沙箱文档没加载探针）：和 Chrome 一样列在 frame 树里，但它的不透明文档拿不到：只显示为元素，没有它自己的执行上下文和子 frame，请求只有它的文档本身。URL 取 iframe 上次 load 时的 `src`（或 `srcdoc`），不是它的脚本导航去的地址；MIME 类型固定为 text/html；名称取 iframe 的 `name` 属性，不是脚本设的名称。导航要到 load 事件才发现 |
| 跨域 iframe | ⚠️ | 需要 iframe 页面也加载探针，并且双方都配了[源名单](#跨域-iframe)，否则只显示为元素。要等 iframe 的探针运行后才连上：它的文档本身的请求报在它自己的会话里，而不是父页面的；导航后按 URL 设置的断点不会重新设上。导航后没有重新连接的页面，最多 10 秒后断开 |
| 跨源样式表 | ⚠️ | 需要 CORS；只读。没有 CORS 时 `CSS.getStyleSheetText` 报错（Chrome 拿得到原文），也不显示规则 |
| 样式表原文 | ⚠️ | 返回样式表的原文，range 与 Chrome 一致，编辑按原样写入原文。`<style>` 从 0:0 起算，不是它在 HTML 里的位置。页面通过 CSSOM 改过样式表后（`replace()`、`replaceSync()` 除外），原文改为从 CSSOM 序列化、一条规则一行（Chrome 是把规则直接拼接，且会滞后）；原文里找到的规则与 CSSOM 配不上时、DevTools 打开前就构造的样式表，也是如此。通过 `style.color = …` 这类属性赋值或改媒体列表文本所做的修改看不到（不发 `CSS.styleSheetChanged`；Styles 可能仍显示旧原文）。CSS 启用期间，元素行内样式的 `style.cssText = …` 写入约有 40% 额外开销（经过钩子）；逐属性赋值（`el.style.left = …`）不受影响。编辑 `@supports`、`@container`、`@scope` 的条件会整条替换该规则（CSSOM 无法修改它们的条件）：页面持有的该规则及其内部规则对象会脱离，Chrome 则保持原对象。`<link>` 和 `@import` 的文件会再取一次（能用 HTTP 缓存时走缓存）。另一个客户端用 `CSS.setStyleSheetText` 替换样式表后，本客户端继续返回它原有的原文，与 Chrome 一致；但本客户端随后自己编辑该表时，原文会改为序列化文本，Chrome 则保留旧原文 |
| 强制 `:hover`、`:focus` 等 | ⚠️ | 不覆盖 `@import` 和 `adoptedStyleSheets` 的样式表 |
| 投屏（非外壳模式下的设备按钮） | ⚠️ | 由 [snapDOM](https://github.com/zumerlab/snapdom) 从 DOM 重绘：canvas、视频、跨源图片可能缺失；每秒最多约 2 帧。输入以 `isTrusted: false` 的事件回放 |
| 截图 | ⚠️ | 见[下文](#截图) |
| 设备模式 | ⚠️ | 仅外壳模式。只改尺寸，不改像素比、UA 和触摸；它的截图由 snapDOM 生成，按页面自身的像素比。外壳模式下任何客户端（包括远程连入的 agent）都能用 `Emulation.setDeviceMetricsOverride`，以最后一次设置为准，与 Chrome 一致；其他模式下返回错误。远程客户端的设置在页面重新加载后仍然有效，与 Chrome 一致。参数按 Chrome 的规则检查，报错也与 Chrome 相同，但有两处例外："Invalid parameters" 的 data 不带 Chrome 的 "at position N"（这是 Chrome 内部编码里的字节偏移）；`devicePosture` 的 type 不认识时照常接受，而 Chrome 会不再应答 |
| Rendering 面板的模拟 | ⚠️ | 「模拟页面处于焦点」做不到：在页面里使用 DevTools 时，焦点真的会离开页面元素，`:focus` 样式随之消失，开启时返回错误。自动深色模式、双指缩放重置同样做不到，返回错误。页面做不到的命令一律返回错误「Not supported in the page: <原因>」，能做但还没做的见[路线图](roadmap.zh-CN.md) |
| 全屏的页面 | ⚠️ | 有元素全屏时用不了 DevTools，外壳模式下也一样。按 Esc 退出全屏即可 |
| 无障碍树 | ⚠️ | Elements 面板的 Accessibility 窗格，以及 `Accessibility.getPartialAXTree`、`getFullAXTree`、`queryAXTree`、`getRootAXNode`、`getChildAXNodes`、`getAXNodeAndAncestors`：在页面里由 DOM、ARIA 属性和计算样式算出，与 Chrome 对照过。没有 InlineTextBox、列表标记和 UA shadow 树里的节点；input 的默认名称（如 "Submit"）是英文；不发 `loadComplete`、`nodesUpdated` 事件。由 `accessibility.js`（约 29 KB）计算，首次使用时从 bundle 旁边加载：自托管时要放在同一目录 |
| Animations 面板 | ⚠️ | 来自 `getAnimations()` 的 CSS 动画、过渡和 Web Animations，以及用 `animate()` 或 `new Animation()` 创建的动画（无 target、不在文档中、立即结束的）：列出、暂停、拖动进度、改时间。调速设在每个动画上，而不是像 Chrome 那样设在时间线上，所以页面读到的 `playbackRate` 是乘过的（页面自己设的速率会保留，但恰好等于取负速率的值会被当作 `reverse()`）；`getAnimations()` 之外已结束的动画若不是通过 `play()` 重新开始，则看不到；只覆盖页面自己和同源 frame 的文档。shadow 树里的动画也会列出（包括声明式的、宿主后插入的、iframe 里的），但拿不到 closed 声明式 shadow root 里的（页面拿不到它的引用），也拿不到 UA shadow 树里的（如 `input::placeholder` 的）。`::backdrop` 的动画指向它的 `<dialog>`，即 Elements 面板能显示的节点。`cssId`（面板据此分组）是按页面样式近似算的：两条规则里的相同声明算同一组，`:hover` 的过渡和移出时的反向过渡同组。`seekAnimations` 的 `currentTimes` 按协议的毫秒处理（Chrome 156 当成秒）。调速期间新开始的动画，开始时间与 Chrome 有偏差，因为 Chrome 是把文档时间线放慢。一直 pending 的动画（时间线不活动）在 `disable` 后保留面板设的速率。动画在开始前被取消或暂停时，只报告创建和取消：若取消前已跑过一帧动画更新（先出帧、后在定时器里取消），Chrome 还会先报告一次开始，这里少报这一次。页面丢弃且已被垃圾回收的动画，按 id 查不到（Chrome 会保留到 `disable`）。文档还在流式解析时，其声明式 shadow root 里的动画和样式表可能晚到，解析结束时补齐。滚动驱动动画（`scroll()`、`view()`、`ScrollTimeline`、`ViewTimeline`）会报告 `viewOrScrollTimeline`（根滚动容器报为 `document`），时间单位与 Chrome 相同，为每像素 16µs。正在运行的滚动驱动动画 seek 无效；暂停的按换算后的时间 seek，截到终点。调速不作用于它们（面板选中滚动分组时调速按钮被禁用）。页面自己滚动时面板不跟随（需要用 `Page.createIsolatedWorld` 和 `Runtime.addBinding` 建的隔离世界）；拖动 scrubber 可以改滚动位置 |
| 模拟媒体特性 | ⚠️ | `prefers-color-scheme`、`prefers-reduced-motion`、`prefers-reduced-data`、`prefers-reduced-transparency`、`prefers-contrast`、`forced-colors`、`color-gamut` 和媒体类型，通过改写页面的样式表实现。跨域样式表、内联样式和 `matchMedia()` 不受影响；`light-dark()` 和强制颜色选的配色不会变 |
| 模拟安全区 | ⚠️ | 在页面的样式表里替换 `env(safe-area-inset-*)`：跨域样式表和内联样式不受影响；Styles 里显示的是替换后的值 |
| 色觉缺陷模拟 | ✅ | 和 Chrome 一样在 `<html>` 上加 SVG 滤镜：会覆盖页面自己在 `<html>` 上的 `filter`，内嵌的面板也会被滤镜，`getComputedStyle` 能看到 |
| 布局叠加层 | ⚠️ | Grid、Flex、容器查询、scroll-snap、隔离、铰链、刘海和 frame 叠加层，按计算样式近似绘制：grid 没有线编号；隔离模式的拖拽调整大小不跨 iframe |
| 网络条件 | ⚠️ | 屏蔽 URL、附加请求头、禁用缓存、离线和 UA 覆盖只对探针拦截的 `fetch()`、XHR 生效，文档本身的请求和其他子资源不受影响。XHR 禁用缓存只对同源请求有效；跨源请求附加请求头会触发 CORS 预检；UA 只覆盖页面和已发现的同源 iframe。不支持限速。Reporting API 只有页面能看到的报告 |
| Application 面板 | ⚠️ | IndexedDB 和 Cache Storage 视图只在本窗口写入时刷新（worker 和其他窗口的看不到）；存储桶是页面的默认桶。Service Worker：能列出、更新、注销；看不到是否在运行，所以在变成 redundant 之前都显示为运行中；调试、启动、停止 worker 返回错误 |
| 问题面板 | ⚠️ | CSP 违规、弃用、怪异模式和表单问题。CSP 和弃用只有顶层文档的；没有干预，没有低对比度（Chrome 也已没有这项检查）；Cookie、CORS、混合内容只有浏览器知道 |
| Console 违规提示 | ⚠️ | 由 `long-animation-frame` 条目得出慢 handler 和强制重排的 `[Violation]` 消息，没有行号；浏览器需要支持 long-animation-frame，否则 `Log.startViolationsReport` 返回错误 |
| 跨域 iframe 里的 `DOM.scrollIntoViewIfNeeded` | ✅ | 会继续滚动父页面，在应答之后异步进行 |
| 前端与页面同源 | ⚠️ | DevTools 的设置会和页面共用 `localStorage`：前端放在别的源 |
| 浏览器 | ⚠️ | 页面这边：现代浏览器都行。DevTools 界面：只在 Chrome 上验证过；新版前端可能需要兼容补丁 |

snapDOM（gzip 后约 90 KB）只在投屏和截图时加载；`accessibility.js` 只在用到无障碍树时加载；`chromium-html.css` 只在显示浏览器默认样式时加载。它是 Chromium `html.css` 的副本，也是包里唯一采用 LGPL（2.0 或更高版本）的文件；许可全文放在它旁边的 `chromium-html.LICENSE.txt`，也列在 THIRD_PARTY_LICENSES.md 里。不想分发它的站点可以把这两个文件一起删掉：Styles 里就不再显示 user agent stylesheet 规则，其他功能不受影响。

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
| `devtools-anywhere` | `probe.iife.js`、`devtools-anywhere.iife.js`（组件）、`devtools-anywhere-service-worker.js`、`snapdom.js`、`accessibility.js`、`chromium-html.css`（及 `chromium-html.LICENSE.txt`）；组件、事件和各属性的 TypeScript 类型。没有可以 import 的模块 |
| `@devtools-anywhere/devtools-frontend` | 前端，英文和中文界面 |
| `@devtools-anywhere/devtools-frontend-locales` | 其余 80 种界面语言；和前端放在同一目录。缺少的语言退回英文 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |
| `@devtools-anywhere/remote-server` | 远程调试服务端和命令行（`devtools-anywhere-remote`） |
