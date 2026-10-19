# 早期捕获验证结果

路线图第 1 步：验证探针加缓冲加回放能否完整地把页面最早的输出送进 devtools，包括可展开的对象和网络请求。

## 运行

```bash
node experiments/early-capture/server.ts 8787
```

打开 `http://localhost:8787/experiments/early-capture/`。依赖本地 `chii.ignore/` 中已构建的 `public/front_end` 和 `node_modules/chobitsu`。

每个页面都把发给 devtools 的 CDP 消息记录在 `window.__bridgeLog` 中，可以在页面里直接检查。

## 方案

| 页面 | 做法 |
|---|---|
| `a.html` | chobitsu 作为 `<head>` 第一个同步脚本（基线） |
| `p.html` | `probe.js` 作为第一个同步脚本；`load` 后再等 1 秒才加载 chobitsu，然后交接并回放 |

两个页面共用同一套测试场景：
- `scenario-early.js`：`<head>` 中的各类 console 调用，参数包括原始值、对象、数组、DOM 节点、Error、group、table；还有早期的 fetch（GET、POST、慢请求、404）和 XHR、`setTimeout` 中抛出的错误、未处理的 rejection。
- `scenario-throw.js`：解析期间同步抛出的错误。
- `late.js`：body 阶段的日志，以及 devtools 连上之后的日志和请求。

## 回放机制（p.html）

- **console 和异常**：chobitsu 没有暴露用来生成对象引用的 `objManager`，因此不直接合成 CDP 消息，而是在 chobitsu 加载完成的同一个 task 内，用缓存的**原始参数**重新调用 chobitsu 包装过的 console 方法。这样参数会成为真正的 RemoteObject，可以展开；回放期间探针吞掉这次调用，不会再输出到原生控制台。桥接层（`embed.js`）随后按顺序把这些消息的时间戳和调用栈改回原始值；回放的异常则以 `console.error(err)` 作为载体，再改写成 `Runtime.exceptionThrown`。
- **网络请求**：探针记录 chobitsu 加载前发出的 fetch/XHR。devtools 发出 `Network.enable` 后，桥接层合成 `requestWillBeSent`、`responseReceived`、`loadingFinished` 等事件，并自行回答这些请求的 `getResponseBody`、`getRequestPostData`。交接时仍未完成的请求由探针继续跟踪，完成后再补发事件。交接之后发出的请求交给 chobitsu 处理，不会重复。

## 结果（2026-10-19，Chrome，内置浏览器，localhost）

| 检查项 | A | P |
|---|---|---|
| 所有早期 console 输出都出现，并且顺序正确 | ✅ | ✅ |
| 对象、数组、DOM 节点、Error 可以展开（协议层 `Runtime.getProperties` 和界面都验证过） | ✅ | ✅ |
| 时间戳为原始调用时间 | ✅ | ✅（由桥接层恢复，约 19ms） |
| warn/error 的调用栈指向原始代码行 | ✅ | ✅（如 `scenario-early.js:11`） |
| 三种早期异常：同步 throw、`setTimeout` 中 throw、unhandled rejection | ✅ | ✅（文本为 `Uncaught` / `Uncaught (in promise)`，带调用栈） |
| 早期 fetch/XHR 出现在 Network 面板，包含状态、耗时、请求体和响应体 | ✅ | ✅（5 个请求，其中 4 秒的慢请求跨越了交接过程） |
| 交接后的日志和请求正常，没有重复 | ✅ | ✅ |
| 首个业务脚本的开始时间 | 67ms | 18ms |
| 首屏前需要同步加载的体积（min+gzip） | 约 121 KB | 约 1.4 KB |

结论：**探针加回放的方案成立，保真度与同步加载 chobitsu 相同，阻塞成本约为后者的百分之一。**本地没有网络延迟，67ms 和 18ms 的差距主要来自 chobitsu 的解析和执行；在移动网络下，还要加上约 121 KB 的下载时间。

## 发现的问题和注意事项

- **chobitsu 的 bug**：它自己发出的 `Runtime.exceptionThrown` 中，`timestamp` 赋值成了 `now` 函数本身而不是调用结果，序列化后字段丢失。方案 A 中的异常因此没有时间戳；P 中回放的异常由桥接层补上了时间戳。
- **交接时序**：`handoff()` 必须和 chobitsu 的执行处于同一个 task（这里放在 script 的 `onload` 中）；否则中间产生的日志会被 chobitsu 和探针各记一次，或者打乱回放顺序。桥接层依赖"chobitsu 输出的前 N 条 `consoleAPICalled` 就是回放的那些"，这个假设依赖上述时序。
- **方法覆盖范围**：探针只包装 chobitsu 也包装的 console 方法（log、warn、error、info、debug、dir、table、group、groupCollapsed、groupEnd、clear）。`console.trace`、`assert`、`count`、`time` 等方法 chobitsu 本身就不支持。
- **fetch 的原生检测**：探针包装 `fetch` 后，`window.fetch` 不再是原生函数。chobitsu 会因此回退到检查 `navigator.serviceWorker` 或原生 `Request` 是否存在，Chrome 中可以通过。在既没有 `serviceWorker`（例如通过局域网 http 访问）、`Request` 又不是原生实现的环境里，chobitsu 会跳过对 fetch 的 hook。需要在真机上验证。
  - 已在本机用局域网 IP（`http://192.168.x.x`，非安全上下文）验证 Chrome：`navigator.serviceWorker` 不存在，但 `Request` 是原生的，chobitsu 仍然 hook 了 fetch，交接后的请求正常上报。
- **网络请求的覆盖范围**：只覆盖 fetch/XHR。`<script>`、`<img>` 等资源加载请求 chobitsu 也不会上报（可以考虑后续用 `PerformanceObserver` 补充）。合成的响应头只有 `responseReceivedExtraInfo` 中的那一份，界面显示正常。
- **console.table**：chobitsu 会在表格下方额外显示一行 `Array(2)`，A 和 P 都一样，属于 chobitsu 的行为。
- **尚未验证**：iOS Safari 和 Android 真机，以及 Safari 的调用栈格式（`parseStack` 已兼容 `fn@url:line:col` 格式，但还没实测）。
