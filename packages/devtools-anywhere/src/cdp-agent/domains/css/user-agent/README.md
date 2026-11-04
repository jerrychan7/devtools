# The user agent style sheet

`html.css` is Chromium's default style sheet for HTML, unchanged, from
`third_party/blink/renderer/core/html/resources/html.css` at the tag of the Chrome version in
`CHROME_VERSION` (that of the `chrome` field of `packages/devtools-anywhere/package.json`):
<https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.80/third_party/blink/renderer/core/html/resources/html.css>.

License: GNU Library General Public License, version 2 or later, as its header says (Copyright
Lars Knoll, Apple Inc.). It is shipped as a separate file (`dist/chromium-html.css`), which the
bundle loads at run time, not compiled into it.

`build.ts` copies it to `dist/`; `user-agent.ts` loads it the first time a node's matched styles
are asked for and reports the rules that match as Chrome's `user agent stylesheet` ones.

## When the pinned Chrome changes

After the `chrome` field of `packages/devtools-anywhere/package.json` is bumped:

```sh
node scripts/sync-user-agent-css.ts          # fetch that version's html.css
node scripts/sync-user-agent-css.ts --check  # is the copy that version's?
```

and update the link above.
