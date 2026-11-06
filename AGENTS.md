# Agent instructions

Instructions for coding agents working in this repository. [DEV.md](DEV.md) covers the build, tests and conventions.

## Commit messages

Write every commit message in English, on several lines:

```
type(scope): summary

Body: why the change was needed (the root cause, for a fix), what changed,
and what it affects. Wrap at about 72 columns.
```

- The first line is `type(scope): summary`, such as `fix(devtools-anywhere): …`, `perf(devtools-anywhere): …` or `docs: …`. Do not use `type!:`.
- Leave one blank line, then write the body. Do not commit with the title line alone, even for tests or docs: say what the test covers, or what the doc now says and why.
- Pass the message with a file (`git commit -F <file>`) or several `-m` arguments, so that it keeps its line breaks.
