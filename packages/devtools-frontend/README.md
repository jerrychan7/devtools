# @devtools-anywhere/devtools-frontend

The Chrome DevTools frontend for [devtools-anywhere](https://www.npmjs.com/package/devtools-anywhere), built from the official [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) sources with as few patches as possible, and rebundled to open in about ten requests. English and Chinese are included; the other languages are in [@devtools-anywhere/devtools-frontend-locales](https://www.npmjs.com/package/@devtools-anywhere/devtools-frontend-locales).

The entry is `dist/anywhere_app.html`. `chrome` in package.json is the Chrome version the frontend comes from, and `dist/REVISION` its devtools-frontend commit.

See the [README](https://github.com/jerrychan7/devtools#readme) ([中文](https://github.com/jerrychan7/devtools/blob/main/README.zh-CN.md)). The frontend is Chromium's (BSD-3-Clause), the rest MIT.
