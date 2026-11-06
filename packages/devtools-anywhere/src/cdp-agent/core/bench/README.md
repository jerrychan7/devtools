# JavaScript lexer benchmarks

[简体中文](README.zh-CN.md)

Measures the JavaScript lexer, `../lexer.ts` and the queries over its tokens in `../lexer-queries.ts`, and checks that a change to it keeps the result of every public entry point the same. Neither script is part of `pnpm test`: run them by hand when the lexer changes, and put their numbers in the commit message.

Both run on Node 24 or later, from this directory or with its path:

```sh
# Time, code units read and memory, for the working tree and any older revisions
node --expose-gc lexer.bench.ts --rev HEAD~1 --rev 76f3026

# Every entry point of the working tree against a revision's
node lexer-compare.bench.ts --rev HEAD~1
```

`--rev` takes any git revision. The lexer's files at that revision, `lexer.ts` and every other `lexer*.ts` of `core/` but the tests (found with `git ls-tree`), are read with `git show`, written under their own names to `cache.ignore/<rev>/` (ignored by git), with `.ts` added to their imports of each other, and imported from there; so an older lexer is measured and compared without checking it out, before the queries moved to `lexer-queries.ts` as after. The queries come from `lexer-queries.ts` when the revision has it, else from `lexer.ts`. `lexer.bench.ts` also takes `--entry <name>` and `--material <name>` (both repeatable) to measure less, and `--runs <n>`.

## Materials

`materials.ts` locates them; none is in git:

| Name | Size | Where it comes from |
| --- | --- | --- |
| repl | 96 code units | A console input written in `materials.ts`: destructuring, a template, a regular expression, `typeof` |
| acorn.js | 246,615 code units | `dist/acorn.js` of acorn 8.19.0, a devDependency, from `node_modules` |
| anywhere_app | 7,356,685 code units | `packages/devtools-frontend/dist/bundle/anywhere_app-*.js`, the DevTools front end's largest bundle, from the build output (`pnpm --filter @devtools-anywhere/devtools-frontend run build:frontend`). A git worktree without it uses the main checkout's. The reference results ran on `anywhere_app-BWStrK_m.js`, SHA-256 `4d6737bd…78e57b`; the report prints the file name and hash it ran on |

Without the front end's build, anywhere_app is left out with a warning.

## What `lexer.bench.ts` reports

For each material, each entry point and each lexer (the working tree's and each `--rev`), and a read-only floor:

- **Entry points**: `tokenize` (the token list, what worlds.ts and repl.ts use), `debuggerStatementSites` (service-worker.ts, on every script it serves), `topLevelLexicalNames` (lexical-names.ts), `returnOutsideFunction` (runtime.ts), and `repl`: one `tokenize` whose tokens `topLevelLexicalDeclarations`, `topLevelVarNames` and `lastExpressionStatement` reuse, as repl.ts does.
- **median ms, min ms**: one call, over enough samples to read about 50 MB of text (at least 10). The lexers take turns sample by sample, so that a busy machine slows them alike, and a collection runs before each sample of a text over 1 MB. On a busy machine the minimum is the steadier number.
- **reads/unit**: code units read with `charCodeAt` on the source per code unit of the text, counted by a copy of the lexer's files with each such call wrapped in a counter they share (on `globalThis`). Reads made by `startsWith`, `indexOf`, `slice` and `source[i]` are not counted. 1.00 would be every code unit read once.
- **MB alloc**: how much memory (the JS heap and the buffers of typed arrays, which live outside it) grows over one call before any full collection, its result and its garbage (the most of three calls). Young garbage collected during the call is not in it, so it shows above all what lives long enough to be promoted.
- **MB kept**: what the result keeps once garbage is collected.
- **read-only floor**: a loop that reads every code unit once with `charCodeAt` and does nothing else, which no lexer can beat.

Without `--expose-gc` the memory columns are empty.

## What `lexer-compare.bench.ts` checks

That `tokenize` (every token's kind, start, end, depth, parent and newline), `debuggerStatementSites`, `debuggerStatements`, `topLevelLexicalNames`, `topLevelLexicalDeclarations`, `topLevelVarNames`, `lastExpressionStatement`, `returnOutsideFunction` and `repl` (the queries on reused tokens) give exactly what they give at `--rev`, for a script and for a module, on:

- each material;
- real code: es-module-lexer's test samples when `es-module-lexer.ignore/` is checked out at the repository root, acorn's `dist/`, puppeteer-core's `lib/esm` (up to 400 files), and `lexer.ts` itself;
- every string literal of `lexer.test.ts` (found with the lexer at `--rev`);
- every UTF-16 code unit, after each of 16 prefixes (`a /`, `x = /`, `)`, `` `${ ``, `/*`, `<!-`, `\n--`, `class `, `debugger`, `\u{`, …) and before an `x` (`tokenize`, `debuggerStatementSites` and `topLevelLexicalNames`, as a script);
- 200,000 random fragments per seed (`--seed`, by default 1 and 987654321; `--fragments` to change the count), up to 40 pieces each: strings with escapes and line continuations, templates and `${`, regular expressions and `/` in every position that makes it a division or not, line and block comments, `<!--` and `-->`, `#!`, line terminators (CR, LF, CR LF, U+2028, U+2029), Unicode spaces, every bracket, the keywords the lexer and the queries look at (an escaped `debugger` too), names, numbers, non-ASCII, surrogates, and random code units.

It stops at the first difference and prints the text and where the results part.

On every text it also checks the working tree against itself: `debuggerStatementSites` must give what the rules it applies give on the working tree's own `tokenize`, so the streamed debugger mode and the token list cannot part.

One difference with older revisions is known and not counted as one. Up to 42c0468 (and at aff93c5), the debugger mode kept no tokens, so it took a `-->` anywhere in a script for an HTML-like comment (`x-->0; debugger` hid the `debugger`); since the fix, `-->` is a comment only where `tokenize` takes it for one, at the start of the source or after a line break, with only spaces and comments before it. Against such a revision, `debuggerStatementSites` and `debuggerStatements` may differ on a script that contains `-->`, provided the working tree's agree with its token list; the script reports how many did.

## Reference results

Apple M2, 16 GB, macOS 26, Node 24.21.0, `node --expose-gc lexer.bench.ts --rev 76f3026 --rev 66f4dcf --rev 6c48668 --rev 181329e --rev 42c0468 --material acorn.js --material anywhere_app` at aff93c5, on a machine shared with other work. One step per revision:

| Revision | Step |
| --- | --- |
| 76f3026 | Before any optimisation: a Token object per token |
| 66f4dcf | Tokens in typed arrays, one per field |
| 6c48668 | `charCodeAt(i) \| 0` instead of a bounds check |
| 181329e | A table for the classes of ASCII code units |
| 42c0468 | A debugger mode instead of a token callback; `startsWith('debugger')` |
| aff93c5 | The code unit read ahead kept for the main loop: each code unit read about once |

Each commit's message has the same entry points measured against the commit before it, which tells a step's own gain better than this table: six lexers in one process take turns, and steps of a few percent move within the spread.

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

`node lexer-compare.bench.ts --rev 76f3026` at aff93c5: every entry point gives the same results on 1,448,944 texts.

### Since aff93c5

Same machine, `node --expose-gc lexer.bench.ts --rev 55110e2 --rev 5cefe1a --material acorn.js --material anywhere_app` at e9dfe07, again on a machine shared with other work (the read-only floor of anywhere_app moved from 10 to 12-15 ms between runs):

| Revision | Step |
| --- | --- |
| 55110e2 | The queries moved to `lexer-queries.ts` (as aff93c5, plus the `-->` fix) |
| 5cefe1a | Keywords matched in place (no `slice` per word); `returnOutsideFunction` counts the function bodies per depth |
| e9dfe07 | Token arrays first sized for a token every 8 code units, grown to the density read so far |

The keyword step shows on acorn.js (`returnOutsideFunction` 2.47 to 2.21 ms); on anywhere_app the `tokenize` the queries run on hides it. The arrays step shows in `tokenize`'s memory: its peak (the arrays and their copy, or old and new arrays during a grow), replayed from the token positions, went from 65.1 to 44.9 MB on anywhere_app, and what the result keeps from 28.3 to 31.1 MB (arrays within 1/8 of the count are no longer copied). Its reads/unit on acorn.js rise from 1.14 to 1.24: a word at least as long as the keyword is now read with `charCodeAt` as far as it matches it, where `slice` read it uncounted. The MB alloc column of the other entry points, whose tokens die with the call, moves with what the collector promotes and says little.

#### acorn.js: 246,615 code units (acorn 8.19.0 dist/acorn.js from node_modules)

| Entry | Lexer | median ms | min ms | reads/unit | MB alloc | MB kept |
| --- | --- | --: | --: | --: | --: | --: |
| tokenize | 55110e2 | 1.66 | 1.56 | 1.00 | 2.28 | 0.73 |
| | 5cefe1a | 1.67 | 1.56 | 1.00 | 2.28 | 0.74 |
| | e9dfe07 | 1.69 | 1.59 | 1.00 | 1.55 | 0.76 |
| debuggerStatementSites | 55110e2 | 1.57 | 1.46 | 1.00 | 0.48 | 0.06 |
| | 5cefe1a | 1.69 | 1.57 | 1.00 | 0.48 | 0.06 |
| | e9dfe07 | 1.69 | 1.57 | 1.00 | 0.49 | 0.05 |
| topLevelLexicalNames | 55110e2 | 1.71 | 1.60 | 1.00 | 2.29 | 0.05 |
| | 5cefe1a | 1.73 | 1.61 | 1.00 | 2.28 | 0.05 |
| | e9dfe07 | 1.74 | 1.64 | 1.00 | 1.55 | 0.05 |
| returnOutsideFunction | 55110e2 | 2.59 | 2.47 | 1.14 | 2.89 | 0.08 |
| | 5cefe1a | 2.30 | 2.21 | 1.24 | 2.31 | 0.06 |
| | e9dfe07 | 2.35 | 2.24 | 1.24 | 1.60 | 0.05 |
| repl | 55110e2 | 1.75 | 1.71 | 1.00 | 2.27 | 0.06 |
| | 5cefe1a | 1.75 | 1.70 | 1.00 | 2.33 | 0.06 |
| | e9dfe07 | 1.78 | 1.74 | 1.00 | 1.55 | 0.05 |
| read-only floor | | 0.290 | 0.290 | 1.00 | | |

#### anywhere_app: 7,356,685 code units (anywhere_app-BWStrK_m.js, SHA-256 4d6737bd…78e57b)

| Entry | Lexer | median ms | min ms | reads/unit | MB alloc | MB kept |
| --- | --- | --: | --: | --: | --: | --: |
| tokenize | 55110e2 | 69.9 | 64.9 | 1.00 | 73.41 | 28.34 |
| | 5cefe1a | 70.1 | 65.7 | 1.00 | 73.40 | 28.34 |
| | e9dfe07 | 72.3 | 67.4 | 1.00 | 53.19 | 31.07 |
| debuggerStatementSites | 55110e2 | 63.0 | 61.5 | 1.00 | 11.72 | 0.00 |
| | 5cefe1a | 62.8 | 62.2 | 1.00 | 11.70 | 0.00 |
| | e9dfe07 | 63.5 | 61.9 | 1.00 | 11.71 | 0.00 |
| topLevelLexicalNames | 55110e2 | 80.3 | 76.9 | 1.00 | 28.95 | 0.04 |
| | 5cefe1a | 80.0 | 75.1 | 1.01 | 73.62 | 0.04 |
| | e9dfe07 | 78.8 | 74.6 | 1.01 | 35.46 | 0.04 |
| returnOutsideFunction | 55110e2 | 92.5 | 88.0 | 1.07 | 32.85 | 0.00 |
| | 5cefe1a | 91.1 | 86.1 | 1.08 | 28.63 | 0.00 |
| | e9dfe07 | 96.9 | 88.0 | 1.08 | 35.63 | 0.00 |
| repl | 55110e2 | 90.6 | 87.8 | 1.01 | 29.77 | 0.31 |
| | 5cefe1a | 87.2 | 81.8 | 1.02 | 29.04 | 0.30 |
| | e9dfe07 | 89.7 | 84.6 | 1.02 | 35.98 | 0.30 |
| read-only floor | | 14.9 | 12.0 | 1.00 | | |

`node lexer-compare.bench.ts --rev 55110e2` at e9dfe07: every entry point gives the same results on 1,448,976 texts. The count grows with the string literals of `lexer.test.ts`, which the script reads from the working tree: 1,448,962 at 55110e2, 1,448,968 at 5cefe1a (6 more test strings), 1,448,976 at e9dfe07 (8 more).
