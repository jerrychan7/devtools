# devtools-anywhere

[English](README.md) | 简体中文

在任意网页里用上真正的 Chrome DevTools，手机浏览器也可以。

<figure>
<p align="center">
  <img src="docs/images/desktop.webp" alt="桌面：设备模式下以横屏 iPhone SE 尺寸显示的页面，元素面板停靠在右侧" width="62%">
  <img src="docs/images/mobile.webp" alt="手机：页面下方的元素面板" width="22%">
</p>
<figcaption><p align="center"><sub>截图：在 <a href="https://github.com/jerrychan7/WebMC">WebMC</a>（基于 WebGL 的网页版 Minecraft）中使用 devtools-anywhere。左：电脑上的设备模式；右：手机上。</sub></p></figcaption>
</figure>

## 为什么

| | devtools-anywhere | eruda / vConsole | Chii |
|---|---|---|---|
| 界面 | 最新的 Chrome DevTools | 自己实现的面板 | 旧版 Chrome DevTools（约 122） |
| 页面最早的日志和报错 | ✅ 从第一行脚本开始 | ❌ 初始化前的会丢 | ✅ |
| 接入 | 一行 `<script>` 或 Vite 插件 | 一行 `<script>` | 比较繁琐 |

## 快速上手

**Vite 项目**，只在 `vite serve` 时生效：

```bash
npm i -D @devtools-anywhere/vite-plugin
```

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default { plugins: [devtoolsAnywhere()] }
```

**任意页面**，用 CDN，放在 `<head>` 里第一个：

```html
<script src="https://cdn.jsdelivr.net/npm/devtools-anywhere@0.2.0/dist/probe.iife.js"></script>
```

打开页面，点 **F12** 按钮。

**在电脑上调试手机里的页面**：

```bash
npx -p @devtools-anywhere/remote-server devtools-anywhere-remote
```

把打印出的 `<script>` 加进页面，在电脑上打开打印出的目标列表，点「inspect」。

自托管、全部选项和组件的用法见[使用指南](docs/usage.zh-CN.md)。

## 常用选项

| `<script>` 属性 | Vite 选项 | 作用 |
|---|---|---|
| `data-open-immediately` | `openImmediately` | 页面加载后直接打开 DevTools |
| `data-default-shell-mode="off"` | `defaultShellMode: 'off'` | 不用外壳模式，面板盖在页面上 |
| `data-no-toggler` | `noToggler` | 隐藏 F12 按钮 |
| `data-remote` | `remote` | 连接到远程调试服务端 |

外壳模式（默认开启）把页面放进 iframe，刷新时 DevTools 不会关闭，也能用设备模式，见[外壳模式](docs/usage.zh-CN.md#外壳模式)。

## 能用什么

| 面板 | 支持情况 |
|---|---|
| 元素、样式 | ✅ 不显示浏览器默认样式 |
| 控制台 | ✅ 包括页面最早的输出 |
| 网络 | ✅ 没有真实的时序；WebSocket 握手头看不到 |
| 源代码 | ⚠️ 能看文件、用代码段，不能下断点 |
| 应用 | ✅ |
| 设备模式 | ⚠️ 仅外壳模式，只改尺寸，不改像素比、UA 和触摸 |
| 投屏、截图 | ⚠️ 从 DOM 重绘，不是屏幕像素 |
| 性能、内存、Profiler | ❌ 页面脚本拿不到这些数据 |

页面这边只用标准 Web API，现代浏览器都能用；DevTools 界面只在 Chrome 上验证过。完整的限制见[使用指南](docs/usage.zh-CN.md#能力边界)。

## 包

| 包 | 用途 |
|---|---|
| `devtools-anywhere` | 探针和页面里的组件 |
| `@devtools-anywhere/devtools-frontend` | DevTools 前端（英文、中文界面） |
| `@devtools-anywhere/devtools-frontend-locales` | 可选：另外 80 种界面语言 |
| `@devtools-anywhere/vite-plugin` | Vite 插件 |
| `@devtools-anywhere/remote-server` | 远程调试服务端和命令行 |

## 文档

- [使用指南](docs/usage.zh-CN.md)：所有接入方式、选项、限制
- [设计](docs/design.zh-CN.md)：工作原理和取舍
- [开发指南](DEV.zh-CN.md)：搭建环境、测试、发布

## 许可证

[MIT](LICENSE)。发布包中的第三方代码（Chrome DevTools 前端、snapDOM、es-module-lexer）及其许可证见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
