# devtools-anywhere

Real Chrome DevTools inside any web page, with early capture: a probe script captures console output, network requests and errors from the very start, and the DevTools frontend inspects the page through a CDP implementation that runs in the page itself.

```html
<script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-devtools-frontend-url="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
```

The frontend is [@devtools-anywhere/devtools-frontend](https://www.npmjs.com/package/@devtools-anywhere/devtools-frontend). Usage, options and limitations: [README](https://github.com/jerrychan7/devtools#readme) ([中文](https://github.com/jerrychan7/devtools/blob/main/README.zh-CN.md)).

MIT licensed.
