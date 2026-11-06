# CSS lexer benchmarks

[简体中文](README.zh-CN.md)

Measures `../css-lexer.ts`, and checks that a change to it keeps every token the same. Neither script is part of `pnpm test`: run them by hand when the lexer changes, and put their numbers in the commit message.

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
