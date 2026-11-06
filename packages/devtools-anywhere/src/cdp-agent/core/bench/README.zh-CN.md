# JavaScript 词法器基准

[English](README.md)

测量 JavaScript 词法器（`../lexer.ts`，以及 token 查询所在的 `../lexer-queries.ts`），并核对改动后每个公开入口的结果是否不变。两个脚本都不在 `pnpm test` 里：词法器有改动时手动运行，把数据写进提交信息。

两者都需要 Node 24 及以上，在本目录下运行，或带上路径：

```sh
# 工作区和任意旧版本的耗时、读取码元数和内存
node --expose-gc lexer.bench.ts --rev HEAD~1 --rev 76f3026

# 工作区每个入口的结果与某个版本对拍
node lexer-compare.bench.ts --rev HEAD~1
```

`--rev` 接受任意 git 版本。该版本词法器的各个文件（`core/` 下的 `lexer.ts` 和其他 `lexer*.ts`，不含测试，用 `git ls-tree` 找出）用 `git show` 读出，按原文件名写到 `cache.ignore/<rev>/`（被 git 忽略），互相之间的 import 补上 `.ts` 后再导入。所以不用检出就能测量和对拍旧版本，查询拆到 `lexer-queries.ts` 之前和之后的版本都行。该版本有 `lexer-queries.ts` 时查询从它导入，否则从 `lexer.ts` 导入。`lexer.bench.ts` 还接受 `--entry <名称>` 和 `--material <名称>`（都可重复）来只测一部分，以及 `--runs <n>`。

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
- **reads/unit**：每码元用 `charCodeAt` 读取源码的次数，由把词法器各文件里每次这种调用都包上同一个计数器（放在 `globalThis` 上）的副本统计。`startsWith`、`indexOf`、`slice` 和 `source[i]` 的读取不计入。1.00 表示每个码元恰好读一次。
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

每份文本还会让工作区和自己核对：`debuggerStatementSites` 的结果必须等于按同样规则从工作区自己的 `tokenize` 推导出的结果，流式的 debugger 模式和 token 列表不能分叉。

与旧版本有一处已知差异，不算作不同。直到 42c0468（以及 aff93c5），debugger 模式不保存 token，于是把脚本里任何位置的 `-->` 都当成 HTML 注释（`x-->0; debugger` 里的 `debugger` 被漏掉）；修复后，`-->` 只在 `tokenize` 也认作注释的地方才是注释：源码开头，或换行之后、前面只有空白和注释。与这类版本对拍时，含 `-->` 的脚本上 `debuggerStatementSites` 和 `debuggerStatements` 可以不同，前提是工作区的结果与它自己的 token 列表一致；脚本会报告这样的结果有多少。

## 参考结果

Apple M2，16 GB，macOS 26，Node 24.21.0，在 aff93c5 运行 `node --expose-gc lexer.bench.ts --rev 76f3026 --rev 66f4dcf --rev 6c48668 --rev 181329e --rev 42c0468 --material acorn.js --material anywhere_app`，机器同时有别的负载。每个版本对应一步：

| 版本 | 这一步 |
| --- | --- |
| 76f3026 | 优化前：每个 token 一个对象 |
| 66f4dcf | token 存进类型化数组，每个字段一个 |
| 6c48668 | 用 `charCodeAt(i) \| 0` 代替边界判断 |
| 181329e | ASCII 码元分类查表 |
| 42c0468 | 用 debugger 模式代替 token 回调；`startsWith('debugger')` |
| aff93c5 | 主循环复用预读的码元：每个码元约读一次 |

每笔提交的信息里还有它和前一笔的对比，更能说明单步的收益：这张表是六个词法器在同一进程里轮流跑，几个百分点的差别落在波动范围内。

### acorn.js: 246,615 code units (acorn 8.19.0 dist/acorn.js from node_modules)

| Entry | Lexer | median ms | min ms | reads/unit | MB alloc | MB kept |
| --- | --- | --: | --: | --: | --: | --: |
| tokenize | 76f3026 | 2.23 | 2.03 | 1.53 | 5.01 | 3.68 |
| | 66f4dcf | 1.97 | 1.90 | 1.53 | 2.28 | 0.72 |
| | 6c48668 | 1.85 | 1.73 | 1.53 | 2.28 | 0.72 |
| | 181329e | 1.78 | 1.68 | 1.53 | 2.28 | 0.72 |
| | 42c0468 | 1.75 | 1.69 | 1.53 | 2.27 | 0.70 |
| | aff93c5 | 1.63 | 1.56 | 1.00 | 2.28 | 0.73 |
| debuggerStatementSites | 76f3026 | 1.92 | 1.84 | 1.53 | 3.84 | 0.01 |
| | 66f4dcf | 1.96 | 1.90 | 1.53 | 0.44 | 0.06 |
| | 6c48668 | 1.79 | 1.72 | 1.53 | 0.44 | 0.02 |
| | 181329e | 1.66 | 1.61 | 1.53 | 0.51 | 0.05 |
| | 42c0468 | 1.74 | 1.68 | 1.53 | 0.49 | 0.06 |
| | aff93c5 | 1.55 | 1.48 | 1.00 | 0.48 | 0.06 |
| topLevelLexicalNames | 76f3026 | 2.40 | 2.20 | 1.53 | 4.93 | 0.05 |
| | 66f4dcf | 2.07 | 1.92 | 1.53 | 2.30 | 0.05 |
| | 6c48668 | 1.93 | 1.78 | 1.53 | 2.29 | 0.06 |
| | 181329e | 1.87 | 1.73 | 1.53 | 2.29 | 0.05 |
| | 42c0468 | 1.86 | 1.72 | 1.53 | 2.29 | 0.05 |
| | aff93c5 | 1.74 | 1.61 | 1.00 | 2.29 | 0.06 |
| returnOutsideFunction | 76f3026 | 3.09 | 2.86 | 1.66 | 5.61 | 0.07 |
| | 66f4dcf | 2.97 | 2.80 | 1.66 | 2.88 | 0.07 |
| | 6c48668 | 2.79 | 2.64 | 1.66 | 2.88 | 0.07 |
| | 181329e | 2.72 | 2.58 | 1.66 | 2.90 | 0.07 |
| | 42c0468 | 2.71 | 2.58 | 1.66 | 2.88 | 0.07 |
| | aff93c5 | 2.62 | 2.47 | 1.14 | 2.90 | 0.06 |
| repl | 76f3026 | 2.40 | 2.32 | 1.53 | 5.24 | 0.08 |
| | 66f4dcf | 2.07 | 2.04 | 1.53 | 2.25 | 0.06 |
| | 6c48668 | 1.90 | 1.86 | 1.53 | 2.32 | 0.06 |
| | 181329e | 1.87 | 1.83 | 1.53 | 2.32 | 0.06 |
| | 42c0468 | 1.86 | 1.82 | 1.53 | 2.32 | 0.06 |
| | aff93c5 | 1.74 | 1.71 | 1.00 | 2.33 | 0.07 |
| read-only floor | | 0.362 | 0.362 | 1.00 | | |

### anywhere_app: 7,356,685 code units (anywhere_app-BWStrK_m.js, SHA-256 4d6737bd…78e57b)

| Entry | Lexer | median ms | min ms | reads/unit | MB alloc | MB kept |
| --- | --- | --: | --: | --: | --: | --: |
| tokenize | 76f3026 | 195.4 | 166.2 | 1.56 | 152.36 | 151.66 |
| | 66f4dcf | 87.5 | 81.2 | 1.56 | 73.40 | 28.34 |
| | 6c48668 | 80.8 | 78.9 | 1.56 | 73.41 | 28.34 |
| | 181329e | 75.9 | 73.5 | 1.56 | 73.39 | 28.34 |
| | 42c0468 | 76.7 | 71.4 | 1.56 | 73.39 | 28.34 |
| | aff93c5 | 73.8 | 72.0 | 1.00 | 73.40 | 28.34 |
| debuggerStatementSites | 76f3026 | 79.5 | 74.3 | 1.56 | 14.17 | 0.00 |
| | 66f4dcf | 76.9 | 73.9 | 1.56 | 12.18 | 0.00 |
| | 6c48668 | 70.5 | 68.0 | 1.56 | 12.19 | 0.00 |
| | 181329e | 66.0 | 63.9 | 1.56 | 12.20 | 0.00 |
| | 42c0468 | 66.1 | 64.2 | 1.56 | 11.73 | 0.00 |
| | aff93c5 | 65.1 | 61.6 | 1.00 | 11.75 | 0.00 |
| topLevelLexicalNames | 76f3026 | 167.1 | 160.2 | 1.56 | 152.60 | 0.02 |
| | 66f4dcf | 86.1 | 85.3 | 1.56 | 74.13 | 0.02 |
| | 6c48668 | 76.9 | 75.7 | 1.56 | 74.09 | 0.04 |
| | 181329e | 73.9 | 72.8 | 1.56 | 74.08 | 0.04 |
| | 42c0468 | 78.3 | 77.1 | 1.56 | 74.13 | 0.02 |
| | aff93c5 | 75.6 | 74.5 | 1.00 | 74.15 | 0.02 |
| returnOutsideFunction | 76f3026 | 173.0 | 167.6 | 1.62 | 156.57 | 0.00 |
| | 66f4dcf | 97.8 | 97.0 | 1.62 | 78.07 | 0.00 |
| | 6c48668 | 93.2 | 91.8 | 1.62 | 78.09 | 0.00 |
| | 181329e | 89.8 | 88.9 | 1.62 | 78.17 | 0.00 |
| | 42c0468 | 89.9 | 88.9 | 1.62 | 78.10 | 0.00 |
| | aff93c5 | 87.1 | 85.5 | 1.07 | 78.16 | 0.00 |
| repl | 76f3026 | 192.1 | 172.3 | 1.57 | 153.49 | 0.33 |
| | 66f4dcf | 103.2 | 96.9 | 1.57 | 74.98 | 0.31 |
| | 6c48668 | 93.9 | 89.0 | 1.57 | 74.93 | 0.32 |
| | 181329e | 91.1 | 83.8 | 1.57 | 74.94 | 0.31 |
| | 42c0468 | 97.5 | 89.5 | 1.57 | 74.97 | 0.31 |
| | aff93c5 | 93.8 | 86.0 | 1.01 | 75.01 | 0.31 |
| read-only floor | | 11.0 | 10.2 | 1.00 | | |

在 aff93c5 运行 `node lexer-compare.bench.ts --rev 76f3026`：每个入口在 1,448,944 份文本上结果都相同。
