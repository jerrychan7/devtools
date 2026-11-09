# CSS lexer benchmarks

[简体中文](README.zh-CN.md)

Measures `../css-lexer.ts`, and checks that a change to it keeps every token the same; `outline-wasm.bench.ts` does the same for the WebAssembly outline. No script is part of `pnpm test`: run them by hand when the lexer changes, and put their numbers in the commit message.

Both run on Node 24 or later, from this directory or with its path:

```sh
# Time, code units read and memory, for the working tree and any older revisions
node --expose-gc lexer.bench.ts --rev cb7f711~1 --rev e1e8d6f

# The working tree's tokens against a revision's
node lexer-compare.bench.ts --rev cb7f711~1
```

`--rev` takes any git revision. The lexer at that revision is read with `git show` and imported from `cache.ignore/`, so an older lexer is measured and compared without checking it out. `cache.ignore/` (ignored by git) also keeps the downloaded style sheet.

## Materials

`materials.ts` makes the same texts on every run:

| Name | Size | What is in it |
| --- | --- | --- |
| generated | 2.6 MB | A rule with a selector list, a comment and `url()`, and an `@media`, 20,000 times |
| common | 49 KB | Rules as written by hand: fonts, strings, `calc()`, `:not()`, `@media` |
| mixed | 93 KB | The harder cases, 300 times: escapes, strings with escaped newlines, bad strings and URLs, CDO and CDC, signed numbers with exponents and units, `-` before names and escapes, non-ASCII, NUL, CR LF and FF |
| all.css | 125 KB | The release build of [webPixelUIengine](https://github.com/jerrychan7/webPixelUIengine/blob/04ca2e7061845f9cabe7cae8f76ec48a59734f87/release/all.css): thousands of custom properties, `var()` and `calc()`. Downloaded once at that commit and checked against its SHA-256 |

## Data the tests share

The unit tests next to this directory import some of its modules too: `materials.ts` and `outline-fragments.ts` (the WebAssembly outline against the TypeScript one), and `dashed-names.ts`, names of declarations and whether they are a custom property's once escapes are decoded (`css-outline.test.ts` and `css-outline-wasm.test.ts`).

## What `lexer.bench.ts` reports

For each material and each lexer (the working tree's, each `--rev`, and a read-only floor):

- **median ms, min ms**: one `tokenize` call, after 20 warm-up calls, over enough runs to tokenize about 20 MB (20 to 600 runs).
- **reads/unit**: code units read with `text.charCodeAt` per code unit of the text, counted by a copy of the lexer with each call wrapped in a counter. Reads made by `indexOf` and `startsWith` (the inside of comments, CDO) are not counted. 1.00 would be every code unit read once.
- **B/token kept**: bytes per token the result holds once garbage is collected (ten results kept at once, to dilute the heap's noise).
- **B/token alloc**: bytes per token one call adds to the heap before any collection, its result and its garbage, the most of five calls.
- **read-only floor**: a loop that reads every code unit once with `charCodeAt` and does nothing else, which no lexer can beat.

Without `--expose-gc` the memory columns are empty. Times move by a few percent from run to run, and more when the machine is busy: compare lexers in one run, and repeat it (`--runs 3`) before trusting a small difference.

## What `lexer-compare.bench.ts` checks

That the working tree's `kinds` and `starts` equal those of the lexer at `--rev`, and that `starts` ends with the text's length, on:

- each material;
- every UTF-16 code unit, after each of 16 prefixes (`-`, `--`, `\`, `#`, `@`, `1e`, `url(`, `/*`, …) and before an `x`;
- 1,000,000 random fragments per seed (`--seed`, by default 1 and 987654321; `--fragments` to change the count), up to 40 pieces each of random ASCII, random BMP code units, lone surrogates, and pieces such as `url(`, `var(--a)`, `-->`, `\fffff `, `1e+`, `-\`.

It stops at the first difference and prints the text.

## Reference results

Apple M2, 16 GB, macOS 26, Node 24.21.0, `node --expose-gc lexer.bench.ts --rev cb7f711~1 --rev e808b7d --rev e1e8d6f` at 79284fb. `cb7f711~1` is the lexer before any optimisation, `e808b7d` after the character class table and typed arrays, `e1e8d6f` after calling `charCodeAt` directly, and the working tree reads each code unit about once.

| Material | Lexer | median ms | reads/unit | B/token kept | B/token alloc |
| --- | --- | --: | --: | --: | --: |
| generated | cb7f711~1 | 66.6 | 2.42 | 22.20 | 67.89 |
| | e808b7d | 41.8 | 1.66 | 5.00 | 20.41 |
| | e1e8d6f | 18.2 | 1.66 | 5.00 | 20.42 |
| | 79284fb | 16.2 | 1.07 | 5.00 | 19.38 |
| | read-only floor | 4.8 | | | |
| common | cb7f711~1 | 1.3 | 2.57 | 18.36 | 65.92 |
| | e808b7d | 0.899 | 1.87 | 4.95 | 19.24 |
| | e1e8d6f | 0.383 | 1.87 | 5.11 | 19.29 |
| | 79284fb | 0.291 | 1.08 | 5.25 | 18.53 |
| | read-only floor | 0.088 | | | |
| mixed | cb7f711~1 | 2.5 | 2.60 | 24.00 | 79.36 |
| | e808b7d | 1.7 | 1.91 | 4.87 | 25.29 |
| | e1e8d6f | 0.775 | 1.91 | 4.86 | 21.80 |
| | 79284fb | 0.583 | 1.28 | 5.12 | 20.04 |
| | read-only floor | 0.171 | | | |
| all.css | cb7f711~1 | 2.6 | 2.54 | 20.54 | 71.12 |
| | e808b7d | 2.0 | 1.92 | 4.96 | 27.19 |
| | e1e8d6f | 0.910 | 1.92 | 4.96 | 27.42 |
| | 79284fb | 0.695 | 1.12 | 5.03 | 21.91 |
| | read-only floor | 0.154 | | | |

`node lexer-compare.bench.ts --rev cb7f711~1` at 79284fb: same tokens on 3,048,580 texts.

## The WebAssembly lexer

`../css-lexer-wasm.ts` runs the same lexer as a WebAssembly module (written in `../wasm-gen/lexer.ts`, assembled with the outline by `../wasm-gen/build.ts`) for texts of 64 code units or more, and the TypeScript lexer for shorter ones, or where the page's CSP keeps WebAssembly from compiling. A text of 5 Mi code units or more gets an instance of its own (about 0.02 ms to make), dropped after, so that the shared instance's memory, which only grows, stays under about 35 MB. `--wasm` measures and checks it:

```sh
# Adds rows for the WebAssembly lexer and each of its stages
node --expose-gc lexer.bench.ts --wasm

# Checks its tokens against a revision's, with the text copied in as bytes and as UTF-16
node lexer-compare.bench.ts --rev cb7f711~1 --wasm
```

The rows `--wasm` adds, each on any text whatever its length:

- **wasm**: all of it, as `tokenize` does: the text copied in, lexed, and the tokens copied out. An all-ASCII text is copied in with `TextEncoder.encodeInto`, one byte per code unit; any other is copied as UTF-16 code unit by code unit. `encodeInto` takes 16 K code units at a time, so that a text past ASCII stops it after one such chunk, the chunks before widened to UTF-16 in place.
- **wasm utf16**: the same, with the text copied in as UTF-16 even when it is ASCII.
- **wasm copy in**, **wasm lex**, **wasm lex utf16**, **wasm copy out**: each stage alone.

Same machine, `node --expose-gc lexer.bench.ts --wasm --runs 2` at the commit that added it, second run:

| Material | Lexer | median ms |
| --- | --- | --: |
| generated | TypeScript | 14.0 |
| | wasm | 3.8 |
| | wasm utf16 | 8.5 |
| | copy in / lex / lex utf16 / copy out | 0.065 / 3.4 / 3.5 / 0.173 |
| | read-only floor | 4.8 |
| common | TypeScript | 0.296 |
| | wasm | 0.077 |
| | wasm utf16 | 0.164 |
| | copy in / lex / lex utf16 / copy out | 0.001 / 0.069 / 0.071 / 0.005 |
| | read-only floor | 0.088 |
| mixed | TypeScript | 0.570 |
| | wasm | 0.345 |
| | wasm utf16 | 0.320 |
| | copy in / lex / lex utf16 / copy out | 0.194 / 0.136 / 0.137 / 0.008 |
| | read-only floor | 0.168 |
| all.css | TypeScript | 0.692 |
| | wasm | 0.219 |
| | wasm utf16 | 0.370 |
| | copy in / lex / lex utf16 / copy out | 0.003 / 0.207 / 0.210 / 0.009 |
| | read-only floor | 0.150 |

`mixed` is not ASCII, so its copy in is the UTF-16 copy, after `encodeInto` stopped in the first chunk; its rows are those of the commit that encodes in chunks (0.443 and 0.280 before, when `encodeInto` went through the whole text in vain). The result keeps 5.0 bytes per token, as the TypeScript lexer's does, and one call allocates nothing else on the JavaScript heap. `node lexer-compare.bench.ts --rev cb7f711~1 --wasm`: same tokens on 3,048,580 texts, both ways of copying in.

## The WebAssembly outline

`../css-outline-wasm.ts` makes `../css-outline.ts`'s outline in the same module as the lexer: `../wasm-gen/outline.ts` writes it, `../wasm-gen/build.ts` assembles it with `../wasm-gen/lexer.ts` and writes `../css-wasm-bytes.ts`. The tokens never leave the module; only the rule and declaration tables are copied out. The module's one entry takes a flag to lex only, which `tokenize` passes: lexing alone does not enter the outline's code, and is as fast as before. Texts under 16 code units, where the call costs more than it saves (about 1 µs either way), stay with `../css-outline.ts`, as do texts where WebAssembly does not compile, and a text the module fails on (memory that cannot grow, or `{` nested a few thousand deep, which overflows the call stack: css-outline.ts may overflow there too). Brackets in values are matched with a stack in memory, so nesting them a million deep works. Texts of 5 Mi code units or more get an instance of their own, as for the lexer.

```sh
# Every field of both outlines on the materials and 2 × 200,000 random fragments, then time,
# allocation, wasm memory per code unit and the module's size; --chrome times both in Chrome too
node --expose-gc outline-wasm.bench.ts [--fragments 200000] [--chrome]
```

The fragments are made by `outline-fragments.ts` from 45 pieces (brackets, at-rules, comments holding a declaration or not, `!important`, `--x`, CDO, non-ASCII and JavaScript-only whitespace…) and random code units, from seeds 1 and 987654321; `../css-outline-wasm.test.ts` runs 20,000 of each in `pnpm test`.

Same machine, Node 24.21.0 and Chrome 157, `node --expose-gc outline-wasm.bench.ts --fragments 250000 --chrome` at the commit that added it (Node times from a second run without `--fragments`):

| Material | TS ms (Node) | wasm ms (Node) | TS ms (Chrome) | wasm ms (Chrome) | TS alloc MB | wasm alloc MB | wasm B/unit |
| --- | --: | --: | --: | --: | --: | --: | --: |
| generated | 16.9 | 7.0 | 16.4 | 9.0 | 24.41 | 4.83 | 7.0 |
| common | 0.248 | 0.127 | 0.3 | 0.2 | 0.51 | 0.06 | 7.9 |
| mixed | 0.793 | 0.460 | 0.6 | 0.4 | 0.93 | 0.17 | 7.6 |
| all.css | 0.586 | 0.347 | 0.6 | 0.4 | 1.04 | 0.08 | 7.2 |

Same outline on 500,004 texts. **wasm B/unit** is the memory a new instance grows to for the text, past the lexer's tables, per code unit: the tables mostly fit in what is set aside for token starts (7 bytes per code unit for the lexer alone), and take up to 14 when every code unit is a token. The module is 9,190 bytes, 3,651 more than the lexer alone.

## Editing declarations in a large sheet

`splice.bench.ts` times `../../text/splice.ts`'s `respliced`, which CSS.setStyleTexts uses, in headless Chrome: a sheet of `--rules` style rules (20,000 by default), flat, in one `@media`, and in `@layer` and `@media`, is paired once; then `--warmup` declarations spread over it (20) are edited unmeasured and `--edits` more (200) measured, one after another, in the CSSOM and then in the source, whose text is checked after each edit. `--rev` adds splice.ts at a revision, bundled with the working tree's other modules.

```sh
node splice.bench.ts --rev <revision> [--rules 20000] [--edits 200] [--warmup 20]
```

It reports the total time of the measured edits, with each edit where `respliced` returns null paired anew, as SheetTexts then does; that total per edit; how many returned null; and the median and 90th percentile of one `respliced` call. An edit changes the source and cannot be repeated, so the total is the figure to compare: Chrome's timer has 0.1 ms steps here.

The rules after an edit are still moved one by one: in a flat sheet, or in a group, an edit costs time in proportion to the rules after it, though they are not outlined or paired again. When the rule edited has rules in it, the pairs left on its old records are looked for among all the sheet's pairs, as many as its rules.

It covers one case: a large sheet of small rules, edited at places spread over it. A long rule edited again and again, or edits in nested style rules, are not measured.

Apple M2, macOS, Node 24.21.0, Chrome 157.0.8103.39 headless; 200 edits after 20 unmeasured. `e03a858` is the commit before `respliced` went down into group rules; the right columns are splice.ts with the drill-down ("perf(devtools-anywhere): re-outline only the innermost rule edited") and its fixes ("fix(devtools-anywhere): drop stale pairs and dead declarations in edits"), as in the commit that added this section:

| Rules | Sheet | e03a858 total ms | returned null | drill-down total ms | returned null |
| --: | --- | --: | --: | --: | --: |
| 20,000 | flat | 70.4 | 0 | 60.7 | 0 |
| 20,000 | `@media` | 1538.4 | 67 | 29.5 | 0 |
| 20,000 | `@layer` `@media` | 1561.4 | 67 | 34.3 | 0 |
| 2,000 | flat | 9.6 | 0 | 8.0 | 0 |
| 2,000 | `@media` | 160.4 | 67 | 4.9 | 0 |
| 2,000 | `@layer` `@media` | 154.3 | 67 | 7.0 | 0 |
