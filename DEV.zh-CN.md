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

`pnpm dev` 以 watch 模式运行 `cdp-server`、`devtools-anywhere` 和 `vite-plugin` 的 esbuild。改动 `cdp-server` 时，打包了它的 `devtools-anywhere` 产物也会跟着重新构建。没有热更新：刷新页面即可加载新的构建。类型声明只在 `pnpm build` 时生成。

playground 的服务器以仓库根目录为根，所以仓库里任何页面都能打开，比如 `/tests/e2e/real-frontend.html`。所有请求都支持 `?delay=<毫秒>`，`/api/echo` 会把请求原样以 JSON 返回。

### 目录结构

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

### 改哪里

| 改动 | 位置 | 怎么验证 |
|---|---|---|
| 早期捕获（console、异常、请求） | `packages/cdp-server/src/probe/` | 保持精简：它在页面代码之前同步执行。留意 `probe.iife.js` 的体积（min+gzip） |
| CDP 域 | `packages/cdp-server/src/domains/` | playground，并加一致性测试 |
| 组件、连接、外壳模式、Service Worker | `packages/devtools-anywhere/src/` | playground、端到端测试 |
| Vite 集成 | `packages/vite-plugin/src/` | `tests/e2e/vite.test.ts`（示例应用在 `tests/e2e/vite-app/`） |
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
  - 注意作用域：SW 脚本需要放在站点根路径，或者由服务器返回 `Service-Worker-Allowed` 头。

### 测试

```bash
pnpm test                                     # 构建并运行全部测试
node --test tests/conformance/css.test.ts     # 只跑一个文件（需先构建，或 pnpm dev 正在运行）
pnpm typecheck                                # 先构建，再检查所有包、构建脚本、测试和 playground 的类型
```

- `tests/conformance/`：同一个页面分别通过真实 Chrome 的 CDP 和我们的实现来检查，对比两边的输出。实现或修改 CDP 方法时请在这里加测试：以真实 Chrome 的行为为准，而不是协议文档。
- `tests/e2e/`：连接层、外壳模式、零配置接入、Vite 插件和真实前端。

### 修改前端

`packages/devtools-frontend` 按钉住的版本构建官方 [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)，只保留入口能加载到的文件。为了尽量少改上游：

- **自有入口** `anywhere_app` 代替 `devtools_app`：只引入能对接页面内 CDP 服务端的面板（元素、控制台、源代码、网络、应用），其余面板既不显示也不加载。唯一的补丁就是在构建配置里注册这个入口（4 个 `BUILD.gn`/`.gni` 文件，共 7 行）。
- **通过官方宿主接口接入**：Chrome 通过原生的 `InspectorFrontendHost` 与 DevTools 通信。入口保留托管模式的 stub，只替换 `sendMessageToBackend` 和 `isHostedMode`，让 CDP 消息经 `postMessage` 与嵌入它的窗口往来；嵌入方通过 `#?embedded=<origin>` 告知自己的 origin。连接相关代码一行都不改。
- **小屏**：沿用上游自带的响应式布局（元素面板窄屏时上下分栏、标签页溢出折叠）。

`packages/devtools-frontend/` 里有：

- `REVISION`：钉住的上游提交。
- `src/anywhere_app/`：我们自己的入口，每次构建前复制到 `front_end/entrypoints/`。
- `patches/*.patch`：对上游文件的修改，按顺序打上。数量和改动都尽量少。
- `scripts/build.ts`：构建脚本。

```bash
cd packages/devtools-frontend
node scripts/build.ts --no-sync     # 修改 src/ 后重新构建（增量，不动检出目录）
node scripts/build.ts --no-sync --copy-only   # 只重新复制到 dist/（修改了复制逻辑时）
```

要修改补丁，先在检出目录里改上游文件，再用检出目录的 diff 重新生成补丁：

```bash
cd devtools-frontend.ignore/devtools-frontend
git diff > ../../packages/devtools-frontend/patches/0001-register-anywhere_app-entrypoint.patch
```

升级到上游最新版：

```bash
pnpm --filter @devtools-anywhere/devtools-frontend update
```

它会构建上游 `main` 的最新提交，成功后写入 `REVISION`。如果某个补丁打不上，`git apply --3way` 会在检出目录里留下冲突标记：解决冲突、重新生成补丁，再运行 `node scripts/build.ts --no-sync`。之后跑 `pnpm test`：新版前端可能会调用 CDP 服务端尚未应答的方法（在浏览器控制台里找 "wasn't found"）。

## 3. 开发完成

### 提交之前

```bash
pnpm lint        # oxlint
pnpm fmt         # oxfmt：直接改写文件（Markdown 不格式化）
pnpm typecheck
pnpm test        # 前端需已构建，真实前端测试才会运行
```

pre-commit 钩子（husky + lint-staged）只处理暂存的文件：先用 oxfmt 格式化并把结果加入这次提交，再用 oxlint 检查，有错误就中止提交。`git commit --no-verify` 可以跳过一次。lint 规则：oxlint 的 correctness 规则，禁止 `any`，禁止非空断言（`!`）。代码风格：2 空格缩进、加分号、单引号、行宽 120。`packages/devtools-frontend/src` 沿用 Chromium 的风格，不做 lint 和格式化。

行为、用法或限制有变化时，同时更新 `README.md` 和 `README.zh-CN.md`（以及本指南的两种语言版本）。

### 提交

- 每个提交只做一步。
- 提交信息格式：`type(scope): 概要`，空一行后用英文写正文，说明改了什么、为什么改。type 有 `feat`、`fix`、`docs`、`test`、`build`、`refactor`、`chore`；scope 用包名或模块名，例如 `cdp-server`、`network`、`devtools-frontend`、`sw`、`readme`。

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
