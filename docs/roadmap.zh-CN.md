# 路线图

[English](roadmap.md) | 简体中文

已经讨论过、还没做的事，以及没做的原因。只记录方向和已知的取舍，不承诺时间。做完的条目移到 CHANGELOG。

## 无障碍树（`Accessibility` 域）

**现状**：完全空缺。只有 `Accessibility.enable` 这一个空操作（`cdp-agent/domains/stubs.ts`），让前端启动时不报错。

**影响**：

- Elements 面板侧栏的 Accessibility 窗格（无障碍树、计算出的 role 和 name 及其来源）是空的。
- 通过 CDP 读页面的自动化工具大多靠 `Accessibility.getFullAXTree` / `queryAXTree` 拿页面结构，在这里拿不到。它们仍然可以用 `Runtime.evaluate` 在页面里执行脚本自己算，所以对 agent 来说不算硬阻塞。

**做法**：在页面里根据 DOM、ARIA 属性和隐式 role 算出 CDP 的 `AXNode`，拿真 Chrome 的 `getFullAXTree` 逐个节点对照测试，和现有的 conformance 测试一样。

- 参考：Blink 的 `third_party/blink/renderer/modules/accessibility/`（BSD），以及规范 HTML-AAM（隐式 role）和 accname 1.2（name 计算）。Blink 的实现依赖布局树，只能照规则用 JS 重写，没法逐行移植。
- 可用的现成库：[`dom-accessibility-api`](https://github.com/eps1lon/dom-accessibility-api)（MIT，零依赖，minify 后约 15 KB，能直接在浏览器里运行）实现了 accname、`getRole`、`isInaccessible`。name 和 description 的计算可以用它打底，这是最难对齐的部分。
- 还要自己补的：
  - role 映射的上下文规则：比如 `header` / `footer` 在 `section` 里是 generic，没有 name 的 `section` 不是 region，`th` 的行表头和列表头，以及没有映射的元素应当是 generic；
  - 树结构：被忽略的节点、`aria-owns`、文本节点变成 StaticText；
  - 节点属性：focusable、checked、expanded、level、value 等；
  - name 的来源列表（`sources`），Accessibility 窗格会展示它。

**拆分**：先做 Elements 窗格用到的 `getPartialAXTree`，再做 `getFullAXTree` / `queryAXTree`。

**体积**：这块代码不该进探针。和 snapDOM 一样，用到时才从 bundle 旁边加载。

## Android 上通过 ADB 无线调试拿到真正的 CDP

**动机**：页面内的 CDP 有些事情做不到，比如截图（现在是 snapDOM 按 DOM 重新绘制，标注 `approximate`）、真实的网络耗时、性能面板、断点。Android 上的 Chrome 本身有完整的 CDP，打开 Android 系统的「无线调试」（Wireless debugging，Android 11 起）后，电脑就能不插线连上手机里的 Chrome。

**设想**：remote-server 一侧借助 `adb`（配对、连接、`adb forward tcp:<端口> localabstract:chrome_devtools_remote`）连上手机里 Chrome 的真 CDP。页面里的探针仍然负责早期日志这类真 CDP 没有的东西，两边合起来给前端用，或者在能用真 CDP 时直接切换过去。

**还没定的问题**：

- 两个 CDP 来源怎么合并，按方法分流、整体切换，还是前端开两个连接；
- 配对流程（配对码、mDNS 发现）放在 CLI 还是界面里；
- 用户的电脑上没有 `adb` 时怎么办，比如附带一个，或者用纯 JS 实现 ADB 协议；
- 怎么测试：CI 上没有真机，模拟器能否代替。

**状态**：只是方向，没有讨论具体方案。

## iframe

- **跨域 iframe**：页面拿不到它的文档，只能由 iframe 自己也加载探针，再通过 postMessage 作为子 target 接上来（`Target.setAutoAttach`、`attachedToTarget`、带 `sessionId` 的消息转发）。前端本来就支持子 target，外壳模式的 relay 有类似机制。
- **同源 iframe 还没覆盖到的**：shadow root 里的 iframe，以及 iframe 脚本后来附加的 shadow root；`<object>`、`<embed>` 的文档；iframe 内 hash 变化的 `Page.navigatedWithinDocument`；`Page.getResourceTree` 里 iframe 自己的资源。

## 其他能在页面里补上的功能

都能用页面里的标准 API 实现，结果能和 Chrome 对齐。按性价比排序，前三项工作量小。

| 项目 | 现状 | 页面内的做法 |
|---|---|---|
| Animations 面板（`Animation` 域） | `enable` 是空操作 | `document.getAnimations()` 覆盖 CSS 动画、过渡和 Web Animations API；列出、暂停、调速、拖动进度都能对应上 |
| 色觉缺陷模拟（`setEmulatedVisionDeficiency`） | 空操作 | 在 `<html>` 上加 SVG 滤镜，Chrome 用的也是颜色矩阵 |
| 网络：屏蔽 URL、禁用缓存、附加请求头、离线 | `setBlockedURLs`、`setCacheDisabled`、`setExtraHTTPHeaders`、`emulateNetworkConditions` 是空操作 | 对已经拦截的 fetch、XHR 生效；外壳模式下由 Service Worker 覆盖图片和脚本。限速只能近似，不做 |
| 浏览器默认样式 | Styles 里不显示 | 附带一份 Chromium 的 `html.css`（开源），用到时加载，用来匹配出「user agent stylesheet」规则；每次升级 Chrome 都要同步 |
| Grid / Flex / 容器查询 / scroll-snap 叠加层 | `Overlay.setShow*Overlays` 是空操作 | 在页面里画出来；`getComputedStyle` 返回 grid 解析后的轨道尺寸；和 `highlightNode` 共用叠加层 |
| 模拟 `prefers-color-scheme`、print 等媒体特性 | `setEmulatedMedia` 是空操作 | 通过 CSSOM 改写 `@media` 条件；限制和强制 `:hover` 相同：对 `@import`、跨域样式表和 `matchMedia` 不生效 |
| Application 面板自动刷新（`Storage.track*`） | 空操作，要手动刷新 | 包装 IDB 的写操作和 `caches.put`，发出 `indexedDBContentUpdated` 等事件 |
| Service Workers 视图 | `ServiceWorker.enable` 是空操作 | 用 `navigator.serviceWorker.getRegistrations()` 列出、注销、更新；不能调试 |
| 违规提示与长任务（`Log.startViolationsReport`） | 空操作 | `PerformanceObserver` 监听 `longtask`、`long-animation-frame`，在 Console 输出 |

价值有限的：性能监视器（`Performance.getMetrics`，只有 DOM 节点数和 Chrome 的 `performance.memory`）；事件监听器的源码位置（只能在添加时记录调用栈，影响性能）。

## Emulation 的缺口

- `Emulation.setDeviceMetricsOverride` 没有实现。外壳模式下的设备模式由前端直接布局 iframe，没有走 CDP。通过 CDP 改视口的自动化工具因此改不了尺寸；在外壳模式下可以复用设备模式的 iframe 尺寸逻辑来补上。
- `setEmulatedMedia`、`setUserAgentOverride` 等是空操作：返回成功，但实际没有效果。对 DevTools 前端来说没问题，对自动化脚本却有误导，因为它会以为已经设置好了。要不要改成返回错误，需要权衡前端是否依赖它们成功返回。

## 从旧版本线发布补丁

DEV.md「给旧版本打补丁」一节记下的两处缺口：CI 不在 `release/**` 分支上运行；发布时会无条件移动 npm 的 `latest`、`chrome-<里程碑>` 以及 GitHub 的 Latest release。方案是在 `scripts/release.ts` 里按 semver 判断该打哪些标签。等第一次真要给旧版本打补丁时再做。

## 搁置的问题

- **外壳模式下分隔条拖动**：Chrome 会把鼠标事件留在按下时所在的 frame，拖快了分隔条会跟丢。在 headless 下复现不了，之前的改动已全部撤回。
- **触屏体验**：要优化的地方很多，但都很零碎，优先级低。
