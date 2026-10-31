# @devtools-anywhere/vite-plugin

A Vite plugin that injects [devtools-anywhere](https://www.npmjs.com/package/devtools-anywhere) into the pages of the dev server, with the DevTools frontend served alongside.

```ts
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin';

export default { plugins: [devtoolsAnywhere()] };
```

Options: [Vite](https://github.com/jerrychan7/devtools#vite) ([中文](https://github.com/jerrychan7/devtools/blob/main/README.zh-CN.md#vite)). Requires Node.js 22.18 or later. MIT licensed.
