# CSS 词法器基准测试

[English](README.md)

测量 `../css-lexer.ts` 的性能，并核对修改后每个词元是否保持不变；`outline-wasm.bench.ts` 对 WebAssembly 大纲做同样的事。这些脚本都不在 `pnpm test` 里：修改词法器时手动运行，并把数据写进提交信息。

需要 Node 24 或更高版本，在本目录下运行，或带上路径：

```sh
# 当前工作区与任意历史版本的耗时、读取次数和内存
node --expose-gc lexer.bench.ts --rev cb7f711~1 --rev e1e8d6f

# 当前工作区的词元与某个版本对拍
node lexer-compare.bench.ts --rev cb7f711~1
```

`--rev` 接受任意 git 版本。脚本用 `git show` 取出该版本的词法器，写到 `cache.ignore/` 后再导入，所以不用检出旧版本就能测量和对拍。`cache.ignore/` 被 git 忽略，下载的样式表也存放在这里。

## 测试材料

`materials.ts` 每次运行都生成相同的文本：

| 名称 | 大小 | 内容 |
| --- | --- | --- |
| generated | 2.6 MB | 一条带选择器列表、注释和 `url()` 的规则，加一条 `@media`，重复 2 万次 |
| common | 49 KB | 接近手写的规则：字体、字符串、`calc()`、`:not()`、`@media` |
| mixed | 93 KB | 较难处理的情况，重复 300 次：转义、带转义换行的字符串、坏字符串和坏 URL、CDO 和 CDC、带符号、指数和单位的数字、`-` 后跟名字或转义、非 ASCII 字符、NUL、CR LF 和 FF |
| all.css | 125 KB | [webPixelUIengine](https://github.com/jerrychan7/webPixelUIengine/blob/04ca2e7061845f9cabe7cae8f76ec48a59734f87/release/all.css) 的发布构建：大量自定义属性、`var()` 和 `calc()`。按这个固定提交下载一次，并校验 SHA-256 |

## `lexer.bench.ts` 输出什么

每份材料、每个词法器各一行。词法器包括当前工作区的版本、每个 `--rev` 指定的版本，以及一个只读下限：

- **median ms、min ms**：单次 `tokenize` 的耗时中位数和最小值。先预热 20 次，再跑到累计处理约 20 MB 文本为止，共 20 到 600 次。
- **reads/unit**：平均每个代码单元被 `text.charCodeAt` 读取的次数。统计时用的是词法器的副本，每次调用都套了一层计数器。`indexOf` 和 `startsWith` 的读取不计入，涉及注释内部和 CDO。1.00 表示每个代码单元恰好读一次。
- **B/token kept**：垃圾回收后，结果本身平均每个词元占用的字节数。一次保留 10 份结果，以冲淡堆的波动。
- **B/token alloc**：单次调用在回收前给堆增加的字节数，按词元平均，包括结果和产生的垃圾。取 5 次中的最大值。
- **read-only floor**：只用 `charCodeAt` 把每个代码单元读一遍、什么都不做的循环。任何词法器都不可能比它快。

不加 `--expose-gc` 时，内存两列为空。耗时每次运行会有几个百分点的波动，机器繁忙时更大：比较不同词法器要在同一次运行里进行；差距很小时，先用 `--runs 3` 重复几次再下结论。

## `lexer-compare.bench.ts` 核对什么

核对当前工作区的 `kinds` 和 `starts` 与 `--rev` 版本完全相同，并且 `starts` 的最后一项等于文本长度。覆盖：

- 每份测试材料；
- 每个 UTF-16 代码单元，分别放在 16 种前缀之后（如 `-`、`--`、`\`、`#`、`@`、`1e`、`url(`、`/*`），后面再跟一个 `x`；
- 每个种子 100 万个随机片段：`--seed` 默认取 1 和 987654321，`--fragments` 可以改片段数。每个片段最多 40 块，每块是随机 ASCII、随机 BMP 代码单元、孤立代理项，或 `url(`、`var(--a)`、`-->`、`\fffff `、`1e+`、`-\` 这类片段之一。

遇到第一处不同就停止，并打印出该文本。

## 参考结果

环境：Apple M2，16 GB 内存，macOS 26，Node 24.21.0。在 79284fb 上运行 `node --expose-gc lexer.bench.ts --rev cb7f711~1 --rev e808b7d --rev e1e8d6f`。各版本的含义：

- `cb7f711~1`：未做任何优化的词法器；
- `e808b7d`：加了字符类别表并改用类型化数组；
- `e1e8d6f`：改为直接调用 `charCodeAt`；
- 79284fb：每个代码单元约读一次。

| 材料 | 词法器 | 耗时中位数 ms | 每单元读取次数 | 保留 B/词元 | 分配 B/词元 |
| --- | --- | --: | --: | --: | --: |
| generated | cb7f711~1 | 66.6 | 2.42 | 22.20 | 67.89 |
| | e808b7d | 41.8 | 1.66 | 5.00 | 20.41 |
| | e1e8d6f | 18.2 | 1.66 | 5.00 | 20.42 |
| | 79284fb | 16.2 | 1.07 | 5.00 | 19.38 |
| | 只读下限 | 4.8 | | | |
| common | cb7f711~1 | 1.3 | 2.57 | 18.36 | 65.92 |
| | e808b7d | 0.899 | 1.87 | 4.95 | 19.24 |
| | e1e8d6f | 0.383 | 1.87 | 5.11 | 19.29 |
| | 79284fb | 0.291 | 1.08 | 5.25 | 18.53 |
| | 只读下限 | 0.088 | | | |
| mixed | cb7f711~1 | 2.5 | 2.60 | 24.00 | 79.36 |
| | e808b7d | 1.7 | 1.91 | 4.87 | 25.29 |
| | e1e8d6f | 0.775 | 1.91 | 4.86 | 21.80 |
| | 79284fb | 0.583 | 1.28 | 5.12 | 20.04 |
| | 只读下限 | 0.171 | | | |
| all.css | cb7f711~1 | 2.6 | 2.54 | 20.54 | 71.12 |
| | e808b7d | 2.0 | 1.92 | 4.96 | 27.19 |
| | e1e8d6f | 0.910 | 1.92 | 4.96 | 27.42 |
| | 79284fb | 0.695 | 1.12 | 5.03 | 21.91 |
| | 只读下限 | 0.154 | | | |

在 79284fb 上运行 `node lexer-compare.bench.ts --rev cb7f711~1`：304 万 8580 段文本的词元全部相同。

## WebAssembly 词法器

`../css-lexer-wasm.ts` 对 64 个码元及以上的文本用 WebAssembly 模块（写在 `../wasm-gen/lexer.ts`，由 `../wasm-gen/build.ts` 与大纲拼成一个模块）跑同一个词法器；更短的文本，或页面 CSP 不允许编译 WebAssembly 时，用 TypeScript 词法器。500 多万（5 Mi）码元及以上的文本单独创建一个实例（约 0.02ms），用完即丢，这样共享实例只增不减的内存最多约 35MB。`--wasm` 测量并核对它：

```sh
# 加上 WebAssembly 词法器及其各阶段的行
node --expose-gc lexer.bench.ts --wasm

# 与某个版本对拍词元，文本分别按字节和按 UTF-16 复制进去
node lexer-compare.bench.ts --rev cb7f711~1 --wasm
```

`--wasm` 加的行（不论文本长短都走 WebAssembly）：

- **wasm**：完整流程，与 `tokenize` 相同：复制文本进去、词法分析、把词元复制出来。全 ASCII 的文本用 `TextEncoder.encodeInto` 每码元一个字节复制；其他文本逐码元按 UTF-16 复制。`encodeInto` 每次只处理 16K 个码元，遇到非 ASCII 时最多白做一块，之前已写入的块在原地扩宽成 UTF-16。
- **wasm utf16**：同上，但 ASCII 文本也按 UTF-16 复制。
- **wasm copy in**、**wasm lex**、**wasm lex utf16**、**wasm copy out**：各阶段单独计时。

同一台机器，加入时的提交上 `node --expose-gc lexer.bench.ts --wasm --runs 2` 的第二轮：

| 材料 | 词法器 | 中位数 ms |
| --- | --- | --: |
| generated | TypeScript | 14.0 |
| | wasm | 3.8 |
| | wasm utf16 | 8.5 |
| | 复制进 / 词法 / 词法 utf16 / 复制出 | 0.065 / 3.4 / 3.5 / 0.173 |
| | 只读下限 | 4.8 |
| common | TypeScript | 0.296 |
| | wasm | 0.077 |
| | wasm utf16 | 0.164 |
| | 复制进 / 词法 / 词法 utf16 / 复制出 | 0.001 / 0.069 / 0.071 / 0.005 |
| | 只读下限 | 0.088 |
| mixed | TypeScript | 0.570 |
| | wasm | 0.345 |
| | wasm utf16 | 0.320 |
| | 复制进 / 词法 / 词法 utf16 / 复制出 | 0.194 / 0.136 / 0.137 / 0.008 |
| | 只读下限 | 0.168 |
| all.css | TypeScript | 0.692 |
| | wasm | 0.219 |
| | wasm utf16 | 0.370 |
| | 复制进 / 词法 / 词法 utf16 / 复制出 | 0.003 / 0.207 / 0.210 / 0.009 |
| | 只读下限 | 0.150 |

`mixed` 不是 ASCII，复制进的时间是 UTF-16 复制，加上 `encodeInto` 在第一块就停下的开销；这两行是改为分块编码那笔提交的数据（之前 `encodeInto` 会白跑完整份文本，分别是 0.443 和 0.280）。结果每个词元占 5.0 字节，与 TypeScript 词法器相同，一次调用在 JavaScript 堆上不再分配别的。`node lexer-compare.bench.ts --rev cb7f711~1 --wasm`：304 万 8580 段文本词元相同，两种复制方式都是。

## WebAssembly 大纲

`../css-outline-wasm.ts` 在词法器所在的同一个模块里生成 `../css-outline.ts` 的大纲：`../wasm-gen/outline.ts` 编写大纲部分，`../wasm-gen/build.ts` 把它和 `../wasm-gen/lexer.ts` 拼成一个模块并写出 `../css-wasm-bytes.ts`。词元不离开模块，只把规则表和声明表复制出来。模块只有一个入口，带一个“只做词法”的标识，`tokenize` 传这个标识：只要词法时不进入大纲代码，速度与之前相同。短于 16 个码元的文本（调用开销大于省下的时间，两边都约 1µs）仍用 `../css-outline.ts`；不能编译 WebAssembly 时、模块在某段文本上失败时（内存无法增长，或 `{` 嵌套几千层导致调用栈溢出，此时 css-outline.ts 也可能溢出）同样回退。值里的括号用内存里的栈匹配，嵌套一百万层也没问题。500 多万（5 Mi）码元及以上的文本与词法器一样单独创建实例。

```sh
# 在材料和 2 × 20 万段随机片段上逐字段对拍两份大纲，再报告时间、分配量、每码元的 wasm 内存
# 和模块体积；--chrome 同时在 Chrome 里计时
node --expose-gc outline-wasm.bench.ts [--fragments 200000] [--chrome]
```

片段由 `outline-fragments.ts` 用 45 种片段（括号、at 规则、含或不含声明的注释、`!important`、`--x`、CDO、非 ASCII 和只有 JavaScript 视为空白的字符……）加随机码元拼成，种子为 1 和 987654321；`../css-outline-wasm.test.ts` 在 `pnpm test` 里每个种子跑 2 万段。

同一台机器，Node 24.21.0、Chrome 157，加入时的提交上 `node --expose-gc outline-wasm.bench.ts --fragments 250000 --chrome`（Node 的时间取不带 `--fragments` 的第二次运行）：

| 材料 | TS ms（Node） | wasm ms（Node） | TS ms（Chrome） | wasm ms（Chrome） | TS 分配 MB | wasm 分配 MB | wasm 字节/码元 |
| --- | --: | --: | --: | --: | --: | --: | --: |
| generated | 16.9 | 7.0 | 16.4 | 9.0 | 24.41 | 4.83 | 7.0 |
| common | 0.248 | 0.127 | 0.3 | 0.2 | 0.51 | 0.06 | 7.9 |
| mixed | 0.793 | 0.460 | 0.6 | 0.4 | 0.93 | 0.17 | 7.6 |
| all.css | 0.586 | 0.347 | 0.6 | 0.4 | 1.04 | 0.08 | 7.2 |

50 万零 4 段文本大纲相同。**wasm 字节/码元**是新实例为这段文本增长到的内存（不计词法器的表）除以码元数：大纲的表大多放得进为词元起点预留的空间（只做词法时是每码元 7 字节），每个码元都是一个词元时最多到 14。模块 9190 字节，比只有词法器时多 3651 字节。
