# JavaScript 词法器基准

[English](README.md)

测量 `../lexer.ts`，并核对改动后每个公开入口的结果是否不变。两个脚本都不在 `pnpm test` 里：词法器有改动时手动运行，把数据写进提交信息。

两者都需要 Node 24 及以上，在本目录下运行，或带上路径：

```sh
# 工作区和任意旧版本的耗时、读取码元数和内存
node --expose-gc lexer.bench.ts --rev HEAD~1 --rev 76f3026

# 工作区每个入口的结果与某个版本对拍
node lexer-compare.bench.ts --rev HEAD~1
```

`--rev` 接受任意 git 版本。该版本的词法器用 `git show` 读出，写到 `cache.ignore/`（被 git 忽略）再导入，所以不用检出就能测量和对拍旧版本。`lexer.bench.ts` 还接受 `--entry <名称>` 和 `--material <名称>`（都可重复）来只测一部分，以及 `--runs <n>`。

## 材料

由 `materials.ts` 定位，都不在 git 里：

| 名称 | 大小 | 来源 |
| --- | --- | --- |
| repl | 96 码元 | 写在 `materials.ts` 里的一行控制台输入：解构、模板、正则、`typeof` |
| acorn.js | 246,615 码元 | acorn 8.19.0（开发依赖）的 `dist/acorn.js`，取自 `node_modules` |
| anywhere_app | 7,356,685 码元 | `packages/devtools-frontend/dist/bundle/anywhere_app-*.js`，DevTools 前端最大的 bundle，来自构建产物（`pnpm --filter @devtools-anywhere/devtools-frontend run build:frontend`）。git worktree 里没有时用主检出目录的。参考结果用的是 `anywhere_app-BWStrK_m.js`，SHA-256 `4d6737bd…78e57b`；报告里会打印实际所用的文件名和哈希 |

没有前端构建产物时，跳过 anywhere_app 并给出警告。

## `lexer.bench.ts` 报告什么

对每份材料、每个入口、每个词法器（工作区的和每个 `--rev`），外加只读下限：

- **入口**：`tokenize`（token 列表，worlds.ts 和 repl.ts 用）、`debuggerStatementSites`（service-worker.ts，对每个经手的脚本）、`topLevelLexicalNames`（lexical-names.ts）、`returnOutsideFunction`（runtime.ts），以及 `repl`：像 repl.ts 那样 `tokenize` 一次，`topLevelLexicalDeclarations`、`topLevelVarNames` 和 `lastExpressionStatement` 复用这份 token。
- **median ms、min ms**：一次调用的耗时，样本数够读约 50 MB 文本（至少 10 次）。各词法器逐个样本轮流跑，机器忙时大家一起变慢；超过 1 MB 的文本每个样本前先做一次垃圾回收。机器忙时最小值更稳定。
- **reads/unit**：每码元用 `charCodeAt` 读取源码的次数，由把每次这种调用包上计数器的副本统计。`startsWith`、`indexOf`、`slice` 和 `source[i]` 的读取不计入。1.00 表示每个码元恰好读一次。
- **MB alloc**：一次调用在完整回收前内存（JS 堆，加上类型化数组在堆外的缓冲区）的增长量，含结果和垃圾（三次取最大）。调用期间已回收的新生代垃圾不在其中，所以主要反映活得够久、被晋升的部分。
- **MB kept**：回收垃圾后结果本身占用的内存。
- **read-only floor**：用 `charCodeAt` 把每个码元读一遍、别的什么都不做的循环，任何词法器都不可能更快。

不加 `--expose-gc` 时内存两列为空。

## `lexer-compare.bench.ts` 核对什么

`tokenize`（每个 token 的种类、起点、终点、深度、所在括号和换行标记）、`debuggerStatementSites`、`debuggerStatements`、`topLevelLexicalNames`、`topLevelLexicalDeclarations`、`topLevelVarNames`、`lastExpressionStatement`、`returnOutsideFunction` 和 `repl`（复用 token 的各查询），在脚本和模块两种模式下，都与 `--rev` 的结果逐条相等。覆盖：

- 每份材料；
- 真实代码：仓库根目录有 `es-module-lexer.ignore/` 时它的测试样例、acorn 的 `dist/`、puppeteer-core 的 `lib/esm`（至多 400 个文件），以及 `lexer.ts` 自身；
- `lexer.test.ts` 里的每个字符串字面量（用 `--rev` 的词法器找出）；
- 每个 UTF-16 码元，分别跟在 16 个前缀（`a /`、`x = /`、`)`、`` `${ ``、`/*`、`<!-`、`\n--`、`class `、`debugger`、`\u{` 等）之后、`x` 之前（`tokenize`、`debuggerStatementSites` 和 `topLevelLexicalNames`，脚本模式）；
- 每个种子 200,000 个随机片段（`--seed`，默认 1 和 987654321；`--fragments` 改数量），每个至多 40 段：带转义和续行的字符串、模板和 `${`、处在各种位置（是否为除号）的正则和 `/`、行注释和块注释、`<!--` 和 `-->`、`#!`、行终止符（CR、LF、CR LF、U+2028、U+2029）、Unicode 空白、各种括号、词法器和查询关心的关键字（含转义写法的 `debugger`）、名称、数字、非 ASCII、代理项和随机码元。

遇到第一处不同即停止，打印文本和结果分叉的位置。

## 参考结果

见文末的表，逐步补充。
