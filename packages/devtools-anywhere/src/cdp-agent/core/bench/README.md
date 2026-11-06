# JavaScript lexer benchmarks

[简体中文](README.zh-CN.md)

Measures `../lexer.ts`, and checks that a change to it keeps the result of every public entry point the same. Neither script is part of `pnpm test`: run them by hand when the lexer changes, and put their numbers in the commit message.

Both run on Node 24 or later, from this directory or with its path:

```sh
# Time, code units read and memory, for the working tree and any older revisions
node --expose-gc lexer.bench.ts --rev HEAD~1 --rev 76f3026

# Every entry point of the working tree against a revision's
node lexer-compare.bench.ts --rev HEAD~1
```

`--rev` takes any git revision. The lexer at that revision is read with `git show` and imported from `cache.ignore/` (ignored by git), so an older lexer is measured and compared without checking it out. `lexer.bench.ts` also takes `--entry <name>` and `--material <name>` (both repeatable) to measure less, and `--runs <n>`.

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
- **reads/unit**: code units read with `charCodeAt` on the source per code unit of the text, counted by a copy of the lexer with each such call wrapped in a counter. Reads made by `startsWith`, `indexOf`, `slice` and `source[i]` are not counted. 1.00 would be every code unit read once.
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

## Reference results

See the table at the end, filled in step by step.
