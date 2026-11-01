# devtools-anywhere

English | [简体中文](README.zh-CN.md)

Real Chrome DevTools inside any web page, especially on mobile, where browsers have no developer tools.

## Why

Existing in-page debuggers fall short:

| Tool | Limitation |
|---|---|
| eruda / vConsole | Only capture output after they initialize. They are large and usually loaded asynchronously, so the earliest logs and errors of a page are lost |
| mobile-devtools | A custom UI rather than Chrome DevTools; initialized through framework adapters, so it starts after the app code (based on its README, not verified) |
| Chii | Can capture early output, but setup and configuration are cumbersome, and its frontend is stuck on an old Chrome DevTools (around version 122) |

Goals:

1. **Never miss early output**: console messages, errors and network requests are visible from the very first script on the page.
2. **Zero-config setup**: a single `<script>` tag or a build plugin is all it takes.
3. **DevTools survive reloads**: DevTools stay open across page reloads and navigations, with logs preserved.
4. **Keep up with the latest Chrome DevTools**: maintain a patch set on top of the official devtools-frontend and upgrade regularly instead of staying on an old version.

## Usage (preview)

The packages are on npm (`npm i devtools-anywhere @devtools-anywhere/devtools-frontend`); the paths below refer to their `dist/` directories, which a build of this repository makes too. `data-devtools-frontend-url` points at `anywhere_app.html` of a `@devtools-anywhere/devtools-frontend` build. Its `bundle/` files are named after their content and can be cached for good; serve `anywhere_app.html` itself with revalidation (`Cache-Control: no-cache`), so that an update reaches the browser.

### One script tag

```html
<head>
  <!-- First synchronous script: captures output from the very start. -->
  <script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-devtools-frontend-url="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
  ...
</head>
```

From a CDN: jsDelivr and unpkg serve every npm package, so nothing needs hosting. Pin an exact version, the same for both packages. Only English and Chinese are available this way, since the other languages are in a separate package that has to be served from the frontend's directory. Shell mode is not available either, as it needs the probe, the bundle and the frontend from the page's origin (see [shell mode](docs/design.md#2-shell-mode-in-place-rewrite)): `data-default-shell-mode="off"` embeds DevTools directly in the page.

```html
<!-- jsDelivr -->
<script src="https://cdn.jsdelivr.net/npm/devtools-anywhere@0.1.0/dist/probe.iife.js" data-devtools-frontend-url="https://cdn.jsdelivr.net/npm/@devtools-anywhere/devtools-frontend@0.1.0/dist/anywhere_app.html" data-default-shell-mode="off"></script>
<!-- unpkg -->
<script src="https://unpkg.com/devtools-anywhere@0.1.0/dist/probe.iife.js" data-devtools-frontend-url="https://unpkg.com/@devtools-anywhere/devtools-frontend@0.1.0/dist/anywhere_app.html" data-default-shell-mode="off"></script>
```

After the page loads, the probe loads `devtools-anywhere.iife.js` from next to itself (or `data-bundle`) and mounts its own `<devtools-anywhere>` under `<html>`, next to `<body>`, whatever `<devtools-anywhere>` elements the page has; there is one such global element per page, and another one only logs a warning. Optional attributes: `data-open-immediately` opens DevTools right away; `data-default-shell-mode="off"` stays out of shell mode, which the top-level page enters by default (`on`); `data-shell-mode-locked` keeps shell mode as `data-default-shell-mode` says, ignoring the user's choice (which stays stored) and hiding DevTools' switch, though a page that refuses to be framed is still shown on its own; `data-no-toggler` hides the F12 button, also in shell mode; `data-service-worker` enables the Service Worker in shell mode, which injects the probe into same-origin pages in the page iframe that do not include it and adds the request and response headers of same-origin requests (documents, stylesheets, scripts, images and so on); it is off by default, see its [requirements](docs/design.md#3-injection).

### Vite

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default {
  plugins: [devtoolsAnywhere()],
}
```

Only `vite serve` is affected: the probe is injected as the first script of every page, and the bundle, the Service Worker and the frontend are served under `/@devtools-anywhere/`. The frontend comes from `@devtools-anywhere/devtools-frontend`. Options: `devtoolsFrontendPath` (the entry page of another frontend build on disk, such as `…/anywhere_app.html`; its directory is served), `devtoolsFrontendUrl` (a frontend hosted elsewhere, served in place of it), `openImmediately`, `defaultShellMode` (`'on'` or `'off'`), `shellModeLocked`, `noToggler` (hides the F12 button), `serviceWorker` (see its [requirements](docs/design.md#3-injection); the plugin sends `Service-Worker-Allowed` itself), which match the probe's attributes, `remote` (the URL of a [remote debugging](#remote-debugging) server to connect pages to, alongside the element), with `idInQuery` (`data-id-in-query`, for a server with `idInQuery`).

### The element

A floating F12 button opens the panel; drag its bar to resize (in shell mode, DevTools' own resizer, see [shell mode](docs/design.md#2-shell-mode-in-place-rewrite)). Left of DevTools' settings button, the lock button switches shell mode on and off (a dialog explains it first, and an info bar shows while it is on) and the refresh button reloads the page; the toolbar's × closes the panel. DevTools' main menu (⋮) has "Dock side": bottom (the default), right, left, or undocked, a window over the page moved by its bar and resized from its corner. In shell mode the page shrinks to make room, as in Chrome; otherwise the panel covers the page. The side and sizes are remembered in localStorage, sizes as percentages of the viewport (`dvh`/`dvw`), so they fit any screen and orientation. Its one attribute, `devtools-frontend-url`, is optional: without it, the probe's `data-devtools-frontend-url` is used. The rest is the library's: the probe's options set the element up, and the user opens and closes it; it has no methods of its own. The page can restyle the F12 button with `devtools-anywhere::part(toggler)`, in shell mode too: there the button is in the page iframe, in a `<devtools-anywhere>` under the page's `<html>` that only holds it and opens and closes the shell's DevTools (the shell's own button shows only while the page in the iframe has no probe, such as another origin's page). The probe's element does not expose its iframe as a part. Keep the element in one place, since moving it reloads the iframe.

A page can also place `<devtools-anywhere>` itself, as a box where DevTools shows: a block in the page's flow (`display: block`), sized by the page's CSS, with DevTools loaded as soon as it is connected. The page shows and hides it with CSS or `hidden`; hidden, DevTools stays loaded. It has no F12 button, dock side or resizing, and never enters shell mode (DevTools offers no way to); inside the shell's page it works as on its own. `devtools-frontend-url` is its only attribute; others are ignored. DevTools' iframe in it can be styled with `devtools-anywhere::part(iframe)`.

Any element can open and close the panel: give it `data-devtools-anywhere-toggle`, empty for the probe's element. Set to the id of an element the page placed, a click only fires `devtools-toggle-request` on that element, for the page to act on; such togglers get no `aria-expanded`. Clicks are caught on the document, so togglers added later work too; the default action is not prevented, and the togglers' `aria-expanded` follows the panel. A toggler whose element is missing logs a warning, once per value. Whether the panel is open shows only there, in the togglers' `aria-expanded`: the element fires no event of its own.

```html
<button data-devtools-anywhere-toggle>DevTools</button>
```

Togglers work once the probe has loaded `devtools-anywhere.iife.js`, which registers the element, and not inside a shadow root. In shell mode, the togglers of the page inside the shell control the shell's panel, whatever their value. They do nothing in a page of another origin than the shell, such as a cross-origin iframe.

### Remote debugging

To inspect a page on a phone from Chrome on a computer, start the remote debugging server on the computer:

```bash
npx -p @devtools-anywhere/remote-server devtools-anywhere-remote --port 8080
```

It prints the target list's URL, with a token, and the script tag for pages, naming the computer by its LAN address (`--public-url` names it otherwise, for example behind a proxy). Load the probe from the server, with `data-remote`, as the first script in the page's `<head>`:

```html
<script src="http://192.168.1.2:8080/probe.iife.js" data-remote></script>
```

The page connects after it loads (early output is captured as usual), and shows up in the target list, which can be filtered and shows how many DevTools windows are attached; "inspect" opens DevTools on it in a tab of its own. DevTools stays connected when the page reloads or navigates within the tab, and the page reconnects by itself when the connection drops (it stays on the list meanwhile). Several DevTools windows can inspect one page at once, each in a session of its own, as in Chrome: the page runs a CDP session per DevTools session. `data-remote` can also name the server (`data-remote="http://host:8080/"`) when the probe comes from elsewhere. It is resolved against the probe's URL like a link, so a server under a path needs the trailing slash: `/devtools/` names the server at `/devtools/`, while `/devtools` names the one at `/`. With `data-devtools-frontend-url` as well, the page also gets its own DevTools panel; both inspect it at once, each in a session of its own. Shell mode works as without `data-remote` (it needs the probe, bundle and frontend on one origin, so not with the probe from the server and a frontend elsewhere): the page in the shell connects, the shell itself does not. With `data-service-worker` too, so do the same-origin pages without the probe that the page iframe navigates to: the Service Worker gives them the probe, and they connect to the same server. Whether a page in the shell connects, with a probe of its own or one the Service Worker gave it, is up to the shell's probe: without a server there, none connects, and the page's own `data-remote` has no effect. The shell keeps that server in memory, not in `sessionStorage` with the rest of its config, and tells each page in the shell once it has loaded, so a script of the page cannot point the next pages elsewhere.

- The server serves the probe, its bundle and the DevTools frontend; the frontend runs on the computer, so the same-origin caveat does not apply.
- Inspecting a page means running any script in it: the target list and DevTools connections need the token (`--token <value>`, by default a random one; `--no-token` turns it off). Pages connect without it.
- An HTTPS page can only connect to an HTTPS server: `--cert` and `--key`. Other options: `--host`, `--base-path`, `--id-in-query` (see `idInQuery` below), `--devtools-frontend-path`, and `--devtools-frontend-url` to open a frontend hosted elsewhere (a CDN; an HTTPS one needs the server over HTTPS too; its links carry `ws=`/`wss=` and the token in the URL fragment, so they are not sent to the CDN). The same is available from Node.js as `startRemoteServer(options)`, and `createRemoteHandler(options)` gives its request and upgrade handlers, to mount under a base path in a server of one's own (Express, Koa, …): each returns false for what is not its own. Pages connect to `<base>target/<id>` and DevTools to `<base>client/<id>`; with `idInQuery: true`, for a host that routes WebSocket upgrades by exact path only, both connect to the base path itself (`<base>?target=<id>`, `<base>?client=<id>`): the target list and the printed script tag use that form, whose script tag carries `data-id-in-query`, and register the base path, with its trailing slash, for upgrades. Both forms are always accepted. A frontend opened by itself connects to any target as `anywhere_app.html?ws=<host:port/path>` (`wss=` over HTTPS; also read from the fragment, `#?ws=`), the WebSocket URL without its scheme, as in Chrome's `devtools://devtools/bundled/devtools_app.html?ws=`.
- `/json/list` (with the token) lists the targets in the shape of Chrome's.

## Limitations

- An in-page CDP implementation can only use JS APIs, so the following are **not available**: breakpoint debugging, Profiler, Memory, and real network timing. These panels are not included in the frontend rather than shown and found broken. A `debugger;` statement in page scripts cannot pause either; in shell mode, each one hit in a same-origin script logs a warning with its stack in the Console instead. Real breakpoints need the browser's own debugger (`chrome://inspect` for Android, Safari's Web Inspector for iOS); [remote debugging](#remote-debugging) does not change this, since the page still runs the same in-page CDP agent. The Sources panel's Page tab lists the page's documents, external scripts and style sheets, images and fonts (inline scripts are not listed, since their position in the document is not known); snippets work.
- Where page scripts lack an API, the gap is filled exactly or not at all; approximations are not shown as facts:
  - User-agent styles are not shown: browsers do not expose their default style sheet, and a bundled copy could differ from the browser's.
  - Event listeners are recorded by the probe from the moment it runs (it must be the first script); their source locations are not available.
  - WebSocket connections and their frames are shown, but not the handshake headers, which the page cannot see.
  - The screencast (the toolbar's device button, off by default) shows the viewport as [snapDOM](https://github.com/zumerlab/snapdom) redraws it from the DOM, not the pixels on screen: canvas, video and cross-origin images may be missing, and it updates about twice a second at most. snapDOM (about 90 KB gzip) is loaded only when the screencast starts or a screenshot is taken.
  - Screenshots (`Page.captureScreenshot`, for tools and agents that drive the page over CDP) are rendered by snapDOM the same way, so they miss what the screencast misses. The response says so with a field Chrome does not send, `approximate: true`. Otherwise the parameters behave as in Chrome: `clip` is in page coordinates, the image has device pixels (`devicePixelRatio` times `clip.scale`), and `captureBeyondViewport` without a clip takes the whole page. An image past the browser's canvas limits (32767 pixels a side, 16384 on Safari, 16384 × 16384 in area) is scaled down to fit, and snapDOM warns about it in the page's console. Browsers that cannot encode WebP (Safari) return PNG when WebP is asked for.
  - Device mode (shell mode only, since it needs the page in an iframe it can resize) sets the page's size, as the viewport the page sees: media queries, `vw`/`vh` and `innerWidth` follow. It does not change `devicePixelRatio`, the user agent or touch input, which a page cannot change: the toolbar offers no device pixel ratio or device type, and a device preset sets only the size. Screenshots from its menu are snapDOM's, as above, at the page's own pixel ratio.
  - Input from the screencast is replayed as DOM events, which are not trusted (`isTrusted` is false): focus, clicks, scrolling and text editing are carried out, but pages that check `isTrusted` ignore them.
  - Cross-origin style sheets are read through a fetched copy, which needs CORS headers; their rules are read-only.
  - Forced pseudo-classes (`:hover`, `:focus`, … from the Styles pane) are emulated with companion style sheets that keep the cascade order; sheets from `@import` and `adoptedStyleSheets` are not covered.
- While the page has an element fullscreen (the Fullscreen API), DevTools and its F12 button cannot be used: the browser lets nothing outside the fullscreen element take input, in shell mode too. Leave fullscreen (Esc) to use them again.
- Host the frontend on a different origin from the page. On the same origin, DevTools' own settings share the page's `localStorage` and show up in the Application panel.
- The page side uses only standard web APIs and works in any modern browser. The DevTools UI is developed and tested by Google for Chrome; Firefox and Safari are not verified yet, and newer frontend versions may need extra compatibility patches.

## Packaging

An umbrella package plus scoped packages under the [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) npm organization:

| Package | Contents |
|---|---|
| `devtools-anywhere` | Umbrella package: `probe.iife.js` (probe plus auto-mounting), `devtools-anywhere.iife.js` (the `<devtools-anywhere>` element, which the probe loads), `devtools-anywhere-service-worker.js`, `snapdom.js` (the renderer of the screencast and of screenshots, loaded on demand), and TypeScript types for the element, its events and the script and toggler attributes. There is no module to import: the scripts are the runtime |
| `@devtools-anywhere/devtools-frontend` | Prebuilt frontend static assets with English and Chinese UI, self-hostable or served from a CDN |
| `@devtools-anywhere/devtools-frontend-locales` | Optional: the other 80 UI languages, at the same paths as in the frontend package. Serve both from one directory (the Vite plugin does this when it is installed); a missing language falls back to English |
| `@devtools-anywhere/vite-plugin` | Vite plugin |
| `@devtools-anywhere/remote-server` | Remote debugging server (Node.js) and its CLI, `devtools-anywhere-remote` |

## Design

How it works, and why it is built this way: the probe, shell mode, injection, the technology choices and the packaging are described in [docs/design.md](docs/design.md).

## Development

See the [development guide](DEV.md) for setting up the environment, the repository layout and implementation rules, live rebuilds, tests, building the frontend, and releasing.

## References

- [chobitsu](https://github.com/liriliri/chobitsu): reference for the CDP implementation
- [Chii](https://github.com/liriliri/chii): embedded mode in `src/target/DevtoolsFrame.ts`, and its remote debugging server
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
- [Puppeteer](https://github.com/puppeteer/puppeteer): used as the source of truth in conformance tests
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## License

devtools-anywhere is released under the [MIT](LICENSE) license. Each published package also ships its own `LICENSE` and, where its build contains third-party code, a `THIRD_PARTY_LICENSES.md`.

Third-party code in the published packages, with copyright notices and full license texts, is listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md):

- `@devtools-anywhere/devtools-frontend` and `@devtools-anywhere/devtools-frontend-locales` are built from the Chrome DevTools frontend (BSD-3-Clause, The Chromium Authors), including the libraries it bundles.
- `devtools-anywhere` bundles [snapDOM](https://github.com/zumerlab/snapdom) (MIT).
- The module lexer in `packages/devtools-anywhere/src/cdp-agent/core/lexer.ts` is ported from [es-module-lexer](https://github.com/guybedford/es-module-lexer) (MIT, Guy Bedford).
