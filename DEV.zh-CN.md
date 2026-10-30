# 开发指南

[English](DEV.md) | 简体中文

介绍如何搭建开发环境、在实时重新构建下开发各个包，以及改动如何合入或发布。项目做什么、怎么设计的，见 [README](README.zh-CN.md)。

## 1. 第一次开发：环境配置

### 依赖

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | 22.18 及以上 | 构建脚本是 TypeScript，由 Node 直接运行（类型擦除）。`.nvmrc` 固定了版本：`nvm use` |
| pnpm | 与 `packageManager` 一致 | `corepack enable` 会安装对应版本 |
| Google Chrome | 较新版本 | 测试（Puppeteer）要用。如果不在 macOS 的默认位置，请设置 `CHROME_PATH` |
| Git | 任意 | |

开启了 `engine-strict`：Node 版本过低时 `pnpm install` 会直接拒绝。

### 安装并自检

```bash
git clone https://github.com/jerrychan7/devtools.git
cd devtools
pnpm install     # 同时启用 pre-commit 钩子（husky）
pnpm test        # 构建所有包，然后在真实 Chrome 上跑全部测试
```

如果钩子没有生效（`git config core.hooksPath` 没有输出），运行 `pnpm run prepare`。设置 `HUSKY=0` 可以关闭钩子，比如在脚本里。

需要 DevTools 前端的测试在前端构建出来之前会跳过（见下一步）。

### 构建 DevTools 前端（只需一次）

前端用 Chromium 的工具链从官方 [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) 源码构建。大约需要 6 GB 磁盘（源码检出 4.7 GB，depot_tools 0.8 GB），第一次需要较快的网络。

```bash
# depot_tools：Chromium 的 fetch/gclient/gn/autoninja
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git depot_tools.ignore
export PATH="$PWD/depot_tools.ignore:$PATH"

# 检出源码（以 .ignore 结尾的目录不会进 git）
mkdir devtools-frontend.ignore && cd devtools-frontend.ignore
fetch --nohooks devtools-frontend
gclient sync
cd ..

# 构建 packages/devtools-frontend/REVISION 里钉住的版本
pnpm --filter @devtools-anywhere/devtools-frontend build:frontend
```

产物在 `packages/devtools-frontend/dist/`（英文和中文）和 `packages/devtools-frontend-locales/dist/`（其他语言）。如果想放在别处，用 `DEVTOOLS_FRONTEND_SRC`（指向 `devtools-frontend` 检出目录）和 `DEPOT_TOOLS` 指定。

第一次运行 `gclient sync` 如果报加锁错误（`Error locking …/gsutil`），重跑一次即可。

## 2. 日常开发

### 实时重新构建

开两个终端分别运行：

```bash
pnpm dev          # 先完整构建一次，之后改动哪个包就重新构建哪个
pnpm playground   # http://localhost:8788/playground/
```

`pnpm dev` 以 watch 模式运行 `devtools-anywhere`、`vite-plugin` 和 `remote-server` 的 esbuild。没有热更新：刷新页面即可加载新的构建。类型声明只在 `pnpm build` 时生成。

playground 的服务器以仓库根目录为根，所以仓库里任何页面都能打开，比如 `/tests/e2e/pages/real-frontend.html`。所有请求都支持 `?delay=<毫秒>`，`/api/echo` 会把请求原样以 JSON 返回，`/ws/echo` 是一个把每条消息原样发回的 WebSocket。

调试远程模式时，再运行 `pnpm remote`（在 http://localhost:8790/ 启动远程服务器，只监听本机、不要 token），然后打开 `/playground/remote.html`：它会出现在服务器的目标列表里，从那里打开 DevTools 调试它。

### 目录结构

```
packages/
  devtools-frontend/  钉住的 devtools-frontend 版本、补丁和构建脚本
  devtools-anywhere/  总包：<devtools-anywhere>、iframe、连接层、外壳模式
    src/cdp-agent/    页面内的 CDP agent；不引用本目录之外的任何东西（tsconfig.cdp-agent.json），
                      包内其他代码只通过 index.ts 和 probe/ 使用它
      probe/          早期捕获：零依赖，有体积上限，单独的构建入口
      core/           跨域共享的状态：远程对象、节点 id、DOM 变化监听、样式表
      domains/        每个域一个目录：runtime/、network/、dom/、css/、overlay/、storage/……
                      一致性测试放在所属域的目录里
    test-support/     一致性测试的 harness、夹具页面和资源
  vite-plugin/    零配置注入
  remote-server/  远程调试：页面与另一处 DevTools 之间的中继、目标列表、命令行工具
  relay-core/     内部包、不发布：外壳模式与 remote-server 共用的中继逻辑（刷新、`enable` 重放、未答命令），
                  打包进两者
tests/            跨包的测试
  e2e/            探针 → CDP → 前端的完整流程
  support/        启动 Chrome 和静态服务器
playground/       开发调试用的页面和服务器
experiments/      验证记录
```

### 改哪里

| 改动 | 位置 | 怎么验证 |
|---|---|---|
| 早期捕获（console、异常、请求） | `packages/devtools-anywhere/src/cdp-agent/probe/` | 保持精简：它在页面代码之前同步执行。留意 `probe.iife.js` 的体积（min+gzip） |
| CDP 域 | `packages/devtools-anywhere/src/cdp-agent/domains/` | playground，并加一致性测试 |
| 组件、连接、外壳模式、Service Worker | `packages/devtools-anywhere/src/` | playground、端到端测试 |
| Vite 集成 | `packages/vite-plugin/src/` | `tests/e2e/vite.test.ts`（示例应用在 `tests/e2e/vite-app/`） |
| 远程调试 | `packages/remote-server/src/`（中继、服务端）、`packages/devtools-anywhere/src/remote.ts`（页面端） | `tests/e2e/remote.test.ts`；`node packages/remote-server/dist/cli.js` |
| DevTools 前端 | `packages/devtools-frontend/` | 见下文 |

### 约束与注意事项

- 所有 `postMessage` 都必须校验 `event.origin` 和 `event.source`，否则任意页面都能向 CDP 运行时发送命令。
- 判断"是否处于外壳内"要通过 postMessage 握手完成，不要直接读取 `window.parent` 上的属性，否则跨域时会抛出 SecurityError。
- 握手的两端都要有缓冲：devtools 尚未加载完成时，消息不能丢弃。
- 前端资源应当支持自托管，不依赖 unpkg、jsdelivr 等第三方 CDN。
- 使用 Service Worker 注入时：
  - 只处理 `destination === 'iframe'` 的导航请求，其他请求一律放行。
  - 关闭 f12 时调用 `unregister()`。
  - 用 `TransformStream` 流式插入探针，避免破坏 SSR 的流式输出。
  - 注意作用域：Service Worker 脚本需要放在站点根路径，或者由服务器返回 `Service-Worker-Allowed` 头。

### 约定放在哪里

两处代码必须一致的东西，只在它的所有者那里写一次，其他地方引用：

| 约定 | 定义在 | 使用方 |
|---|---|---|
| 中继消息（hello、pagehide、detach、ping）、hello 的参数、页面被顶替时的关闭码 | `packages/relay-core/src/protocol.ts` | `remote.ts`、`connection.ts`、remote-server 的 `relay.ts` |
| 前端 ↔ `<devtools-anywhere>`：请求、停靠位置、hash 参数、我们自己脚本的文件名 | `packages/devtools-anywhere/src/embedder.ts` | 元素、构建脚本；`anywhere_app` 通过前端构建时复制的副本使用 |
| 壳模式下页面与 Service Worker 之间的消息 | `packages/devtools-anywhere/src/shell-messages.ts`，以及 agent 的 `probe/messages.ts` | `element.ts`、`probe.ts`、`service-worker.ts`、探针 |
| `window.DevtoolsAnywhere`，bundle 暴露的 API（含 `RemoteOptions`） | `packages/devtools-anywhere/src/api.ts` | `iife.ts`、`probe.ts`、`tests/globals.d.ts` |
| 探针脚本的 `data-*` 属性 | `packages/devtools-anywhere/src/probe-script.ts`（`ProbeScriptAttributes`，以 `@public` 导出） | `probe.ts`、Vite 插件、remote-server |

`pnpm lint` 和 pre-commit 钩子会检查带我们前缀（`DevtoolsAnywhere.`、`devtools-anywhere:`、`devtools-anywhere-`、`__devtoolsAnywhere`）的字面量只出现在一个源码文件里（`scripts/check-contracts.ts`；不检查注释和测试）。受类型检查约束的名字（比如 `keyof ProbeScriptAttributes`）可以在使用处直接写出。oxlint 还禁止 `devtools-anywhere/src` 的其余代码引用 CDP agent 的 `core/` 或 `domains/`：一律经由 `cdp-agent/index.ts` 和 `cdp-agent/probe/`。

### 测试

```bash
pnpm test                                     # 构建并运行全部测试
node --test packages/devtools-anywhere/src/cdp-agent/domains/css/css.conformance.test.ts
                                              # 只跑一个文件（需先构建，或 pnpm dev 正在运行）
pnpm typecheck                                # 先构建，再检查所有包、构建脚本、测试和 playground 的类型
```

测试放在被测代码旁边，命名为 `<名称>.test.ts`；只有跨包的测试放在 `tests/` 下。
- `*.conformance.test.ts`（在 CDP agent 各个域的旁边）：同一个页面分别通过真实 Chrome 的 CDP 和我们的实现来检查，对比两边的输出。实现或修改 CDP 方法时请在这里加测试：以真实 Chrome 的行为为准，而不是协议文档。它们和页面一样加载构建产物。
- `tests/e2e/`：连接层、外壳模式、零配置接入、Vite 插件和真实前端。测试打开的页面在 `pages/`（脚本与样式在 `pages/assets/`），替身前端在 `frontends/`。

### 修改前端

`packages/devtools-frontend` 按钉住的版本构建官方 [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)，只保留入口能加载到的文件。为了尽量少改上游：

- **自有入口** `anywhere_app` 代替 `devtools_app`：只引入能对接页面内 CDP agent的面板（元素、控制台、源代码、网络、应用）和投屏，其余面板既不显示也不加载。唯一的补丁就是在构建配置里注册这个入口（4 个 `BUILD.gn`/`.gni` 文件，共 7 行）。
- **通过官方宿主接口接入**：Chrome 通过原生的 `InspectorFrontendHost` 与 DevTools 通信。入口保留托管模式的 stub，只替换 `sendMessageToBackend` 和 `isHostedMode`，让 CDP 消息经 `postMessage` 与嵌入它的窗口往来；嵌入方通过 `#?embedded=<origin>` 告知自己的 origin。连接相关代码一行都不改。
- **小屏**：沿用上游自带的响应式布局（元素面板窄屏时上下分栏、标签页溢出折叠）。
- **少请求**：上游每个模块各打成一个包，打开 DevTools 要发约 150 个请求，在 HTTP/1.1 或网络不稳时很慢。`scripts/bundle.ts` 用 rollup 把它们重新打包（含摇树）到 `dist/bundle/`：每个懒加载的模块（主要是面板）各成一个 chunk，用到时才加载；入口 chunk 包含入口引入的模块、多个面板共用的模块和体积很小的模块；每个 worker 打成单个文件，SVG 图标内联成 data: URL。打开 DevTools 约 10 个请求。打包出的文件都以内容 hash 命名，可以永久缓存；只有指明入口的 `anywhere_app.html` 需要每次重新验证。由于模块不再是独立文件，端到端测试通过入口导出的 `modules` 访问它们。

`packages/devtools-frontend/` 里有：

- `REVISION`：钉住的上游提交。
- `src/anywhere_app/`：我们自己的入口，每次构建前复制到 `front_end/entrypoints/`。
- `patches/*.patch`：对上游文件的修改，一个补丁对应一处改动。各补丁改的是不同的文件，打的先后顺序无关紧要。数量和改动都尽量少。
- `locales/<语言>.json`：`anywhere_app` 自己的界面文字（其 `UIStrings` 的键）的翻译。上游的翻译里没有这些文字，构建时合并进对应语言的文件；其他语言显示英文。
- `scripts/build.ts`：构建脚本；`scripts/bundle.ts`：构建最后一步的打包。

```bash
cd packages/devtools-frontend
node scripts/build.ts --no-sync     # 修改 src/ 后重新构建（增量，不动检出目录）
node scripts/build.ts --no-sync --reset   # 同时丢弃检出目录里不属于任何补丁的修改
node scripts/build.ts --no-sync --copy-only   # 只重新复制到 dist/（修改了复制逻辑时）
```

构建会让检出目录始终等于 `REVISION` 加上全部补丁：缺失、改动过或已删除的补丁，都会从干净的文件重新打一遍。如果某个文件既不同于 `REVISION`，也不同于打完补丁后的样子，说明里面有还没写进补丁的修改，构建会停下并列出它，而不是把修改丢掉；加 `--reset` 才会丢弃。改动了 `packages/devtools-frontend/` 的提交，pre-commit 钩子也会因同样的修改而拦下（`scripts/check-checkout.ts`），避免在检出目录里改了却漏写进补丁；入口的改动需要配套改上游文件时（比如在 `KnownContextValues.ts` 登记 `jslog` 上下文值），写成单独的补丁。

要修改补丁，先在检出目录里改上游文件，再对 `HEAD` 求该补丁所涉及文件的 diff，重新生成补丁：

```bash
cd devtools-frontend.ignore/devtools-frontend
git diff HEAD -- front_end/panels/console/ConsolePanel.ts > ../../packages/devtools-frontend/patches/console-reveal-makes-room.patch
```

升级到上游最新版：

```bash
pnpm --filter @devtools-anywhere/devtools-frontend update
```

它会构建上游 `main` 的最新提交，成功后写入 `REVISION`。如果某个补丁打不上，构建会停下；在检出目录里执行 `git apply --3way <补丁>` 会留下冲突标记：解决冲突、重新生成补丁，再运行 `node scripts/build.ts --no-sync --latest`（构建检出目录的 `HEAD` 并写入 `REVISION`）。之后跑 `pnpm test`：新版前端可能会调用 CDP agent 尚未应答的方法（在浏览器控制台里找 "wasn't found"）。

## 3. 开发完成

### 提交之前

```bash
pnpm lint        # oxlint，然后运行 scripts/check-contracts.ts、check-file-size.ts 和 check-dir-size.ts
pnpm fmt         # oxfmt：直接改写文件（Markdown 不格式化）
pnpm typecheck
pnpm test        # 前端需已构建，真实前端测试才会运行
```

pre-commit 钩子（husky + lint-staged）只处理暂存的文件：先用 oxfmt 格式化并把结果加入这次提交，再用 oxlint 检查，有错误就中止提交；还会运行 `scripts/check-contracts.ts`（见「约定放在哪里」），以及两道针对本次新增或改动内容的规模守卫：`scripts/check-file-size.ts` 对超过 1100 行的源码文件（`.ts`、`.js` 及其变体）发出警告，超过 1500 行拒绝提交；`scripts/check-dir-size.ts` 对本次有新增文件的目录，直属文件超过 20 个时警告，超过 30 个拒绝提交。出现警告后，下一次提交就应拆分该文件，或把目录按关注点分进子目录。两者都跳过 devtools-frontend 检出的上游文件（`packages/devtools-frontend/src`、`patches`）和 `experiments/`。`pnpm lint` 会对所有已跟踪文件运行这两道守卫（`--all`），绕过钩子的提交也能在那里查出来。`git commit --no-verify` 可以跳过一次钩子。lint 规则：oxlint 的 correctness 规则，禁止 `any`，禁止非空断言（`!`）。代码风格：2 空格缩进、加分号、单引号、行宽 120。`packages/devtools-frontend/src` 沿用 Chromium 的风格，不做 lint 和格式化。

构建时用 API Extractor 把各包的类型声明按入口合并成单个文件（`dist/index.d.ts`），并把包的 API 写进 `packages/<包>/etc/`：`*.public.api.md` 是公开 API（对外的承诺），`*.api.md` 是全部导出（含内部）（`scripts/api-extract.ts`，配置见 `api-extractor.base.json`；API Extractor 会丢掉 `declare global` 块，脚本会把它们补进合并后的文件）。`devtools-anywhere` 没有运行时入口：它的 `dist/index.d.ts` 只有类型，脚本都构建成 IIFE。报告有变化时与引起它的改动一起提交：公开 API 的变化靠它在评审中看到。CI 中（`CI=true`）报告与 API 不一致会让构建失败。入口的每个导出都要有发布标签：`@public` 只给 README 写明的用法（remote-server 的 `startRemoteServer` / `createRemoteHandler`、Vite 插件），其余一律 `@internal`，只供本仓库各包之间使用（一起构建、一起发布），随时可改；拿不准就标 `@internal`，入口用不到的就不导出。文档注释按 TSDoc 写：`@devtools-anywhere/...` 这类包名放进反引号，代码示例放进围栏代码块。

行为、用法或限制有变化时，同时更新 `README.md` 和 `README.zh-CN.md`（以及本指南的两种语言版本）。

新增或升级会进入产物的依赖、移植其它项目的代码（包括把 DevTools 前端换到新的 `REVISION`）时，运行 `pnpm licenses:update` 重新生成根目录和各包的 `THIRD_PARTY_LICENSES.md`（新增的库先加进 `scripts/third-party-licenses.ts` 的清单）。

### 提交

- 每个提交只做一步。
- 提交信息格式：`type(scope): 概要`，空一行后用英文写正文，说明改了什么、为什么改。type 有 `feat`、`fix`、`docs`、`test`、`build`、`refactor`、`chore`；scope 用包名或模块名，例如 `cdp-agent`、`network`、`devtools-frontend`、`service-worker`、`readme`。

### 提 PR

```bash
git switch -c my-change
# … 提交 …
git push -u origin my-change
gh pr create --fill
```

在 PR 里写明验证过什么，尤其是哪些在浏览器里手动确认过、哪些没有（Safari、真机）。

### 发布到 npm

各个包还没有发布过，下面是预定的流程。所有包使用同一个版本号，一起发布。发布需要 [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) 组织的成员权限。

1. 构建钉住版本的前端（它的 `dist/` 不进 git，`pnpm build` 也不会构建它）：
   ```bash
   pnpm --filter @devtools-anywhere/devtools-frontend build:frontend
   ```
2. 运行 `pnpm typecheck` 和 `pnpm test`。
3. 把所有 `packages/*/package.json` 的 `version` 改成同一个版本并提交（`build: release x.y.z`）。
4. 发布到公共 registry（pnpm 会把 `workspace:*` 替换成实际版本）：
   ```bash
   pnpm -r publish --access public --registry https://registry.npmjs.org
   ```
   如果默认 registry 是镜像，必须显式传 `--registry`。
5. 打 tag 并推送：`git tag vx.y.z && git push origin main vx.y.z`。
