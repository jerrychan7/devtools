# 路线图

[English](roadmap.md) | 简体中文

已经讨论过、还没做的事，以及没做的原因。只记录方向和已知的取舍，不承诺时间。做完的条目移到 CHANGELOG。

## Android 上通过 ADB 无线调试拿到真正的 CDP

**动机**：页面内的 CDP 有些事情做不到，比如截图（现在是 snapDOM 按 DOM 重新绘制，标注 `approximate`）、真实的网络耗时、性能面板、断点。Android 上的 Chrome 本身有完整的 CDP，打开 Android 系统的「无线调试」（Wireless debugging，Android 11 起）后，电脑就能不插线连上手机里的 Chrome。

**设想**：remote-server 一侧借助 `adb`（配对、连接、`adb forward tcp:<端口> localabstract:chrome_devtools_remote`）连上手机里 Chrome 的真 CDP。页面里的探针仍然负责早期日志这类真 CDP 没有的东西，两边合起来给前端用，或者在能用真 CDP 时直接切换过去。

**还没定的问题**：

- 两个 CDP 来源怎么合并，按方法分流、整体切换，还是前端开两个连接；
- 配对流程（配对码、mDNS 发现）放在 CLI 还是界面里；
- 用户的电脑上没有 `adb` 时怎么办，比如附带一个，或者用纯 JS 实现 ADB 协议；
- 怎么测试：CI 上没有真机，模拟器能否代替。

**状态**：只是方向，没有讨论具体方案。

## 其他能在页面里补上的功能

都能用页面里的标准 API 实现，结果能和 Chrome 对齐。

| 项目 | 现状 | 页面内的做法 |
|---|---|---|
| 外壳模式下对图片和脚本屏蔽 URL、附加请求头、离线 | 屏蔽 URL、附加请求头、禁用缓存、离线只对探针拦截的 fetch、XHR 生效；文档本身的请求和其他子资源不受影响 | 外壳模式开启 Service Worker 时，对它经手的同域请求（图片、脚本、样式表等）同样生效 |
| 常驻叠加层的剩余差距 | Grid、Flex、容器查询、scroll-snap 和隔离叠加层是近似绘制：没有 grid 线编号和区域名，对齐后的 grid 偏移、从右到左布局没有处理；Flex 不显示剩余空间分布和间距；容器查询不标出被查询的后代；合并的沙箱 iframe 里的节点没有常驻叠加层 | 在同一层里按计算样式和盒子画出来 |
| 无障碍事件 | 不发 `Accessibility.loadComplete` 和 `nodesUpdated`：树在每条命令里现算，窗格不会自己刷新 | 对文档用 `MutationObserver`，发出属性变了的节点 |
| 跨域 `<embed>` 文档作为子目标（没做） | 找不到跨域 `<embed>` 的窗口：它没有 `contentWindow`，而跨域时读不了子窗口的 `frameElement`。因此其中的文档不会链接（握手被拒、也不被 ping），DOM 里也不当作跨域 frame；Chrome 会像 iframe 一样给它建子目标 | 用排除法认出它的窗口：页面的子窗口里，不属于其他 owner（iframe、frame、object 的 `contentWindow`，同域 embed）的那些，按文档顺序对应剩下的 embed。没做：页面的子窗口按 frame 插入的顺序排列，不是文档顺序，对应不可靠 |

价值有限的：性能监视器（`Performance.getMetrics`，只有 DOM 节点数和 Chrome 的 `performance.memory`）；事件监听器的源码位置（只能在添加时记录调用栈，影响性能）。不做：问题面板里的低对比度，Chrome 自己已经去掉了 `Audits.checkContrast` 和低文本对比度问题。

## 没有效果的命令

已定：页面做不到的命令返回服务器错误（-32000），信息是「Not supported in the page: <原因>」（`cdp-agent/domains/stubs.ts`）：Autofill 的地址、后台服务记录、需要 worker 本身的 Service Worker 命令（调试、启动、停止 worker，`skipWaiting`，投递推送消息和同步事件）、页面加载时强制更新（关闭时返回成功）、自动深色模式、开启焦点模拟（关闭时返回成功）、重置双指缩放、绕过 Service Worker、跟踪兴趣组和共享存储、远程目标地址、安全隔离状态（COOP、COEP、CSP 是响应头）、浏览器的功能开关、网络限速（设了延迟、吞吐量或丢包就算；都不设或只设离线时返回成功），以及启用只有浏览器才有事件的域：`Autofill`、`Database`（WebSQL）、`HeapProfiler`、`Preload`、`Profiler`。前端不记录服务器错误，这些命令失败时它的各个模型照常启动；Frames 视图不显示隔离状态一节，跳出跟踪视图显示为未启用，与之前编造的回答效果相同。读取类命令同样返回失败而不编造数据，`CSS.getEnvironmentVariables` 则读取页面解析出的 env() 值。只能做一部分的，按核心效果判断：核心效果做不到就算做不到（如焦点模拟保不住 `:focus` 样式），否则算还没做（如 UA 覆盖改不了文档自身的请求，但 JS 和之后的请求能读到）。能在页面里做但还没做的命令仍返回成功，列在上面的表里；页面以后能给出事件的域（`Accessibility`、`Log`；`Animation`、`Audits`、`ServiceWorker` 已实现）启用时也返回成功；`Inspector.enable` 管的是连接本身，也返回成功。

## 从旧版本线发布补丁

DEV.md「给旧版本打补丁」一节记下的两处缺口：CI 不在 `release/**` 分支上运行；发布时会无条件移动 npm 的 `latest`、`chrome-<里程碑>` 以及 GitHub 的 Latest release。方案是在 `scripts/release.ts` 里按 semver 判断该打哪些标签。等第一次真要给旧版本打补丁时再做。

## 搁置的问题

- **外壳模式下分隔条拖动**：Chrome 会把鼠标事件留在按下时所在的 frame，拖快了分隔条会跟丢。在 headless 下复现不了，之前的改动已全部撤回。
- **触屏体验**：要优化的地方很多，但都很零碎，优先级低。
- **`src` 跨源的沙箱 iframe**（同站或跨站）：拒绝连接，只显示为元素。Chrome 把同站的留在页面的 target 里，跨站的作为子 target。维持现状：沙箱文档的源是 `null`，信任它只能信任 `src`，而帧内导航会让 `src` 无从验证；这类场景少，收益抵不上多出来的信任范围。
- **并入的沙箱 iframe：起初 about:blank 的执行上下文、导航的 `loaderId`**：执行上下文没有（Chrome 只对 iframe 导航前就已连上的客户端报出，我们的客户端很少这么早连上）；`frameNavigated` 的 `loaderId` 不变：页面分不清 iframe 是在它开始观察前就已 load 完，还是还没 load，换新 id 又会和文档请求的 `loaderId` 对不上。
