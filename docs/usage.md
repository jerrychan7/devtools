# Usage guide

English | [简体中文](usage.zh-CN.md)

Reference for setting devtools-anywhere up. Quick start: [README](../README.md). How it works: [design](design.md).

## Pick a setup

| Scenario | Setup |
|---|---|
| Any page, self-hosted, with shell mode | [Script tag](#script-tag) |
| Any page, nothing to host | [Script tag](#script-tag) from a CDN |
| Vite project, in development | [Vite plugin](#vite) |
| A page on a phone, inspected from a computer | [Remote debugging](#remote-debugging) |
| DevTools in a box of the page's own layout | [Element placed by the page](#element-placed-by-the-page) |

## Script tag

```bash
npm i devtools-anywhere @devtools-anywhere/devtools-frontend
```

Serve the two packages' `dist/`, and put the probe first in `<head>`, synchronous:

```html
<script src="/devtools-anywhere/dist/probe.iife.js"
  data-devtools-frontend-url="/devtools-frontend/dist/anywhere_app.html"></script>
```

From a CDN, pin one exact version for both packages, and turn [shell mode](#shell-mode) off (it is not supported from a CDN):

```html
<script src="https://cdn.jsdelivr.net/npm/devtools-anywhere@0.1.0/dist/probe.iife.js"
  data-devtools-frontend-url="https://cdn.jsdelivr.net/npm/@devtools-anywhere/devtools-frontend@0.1.0/dist/anywhere_app.html"
  data-default-shell-mode="off"></script>
```

| | Self-hosted | CDN (jsDelivr, unpkg) |
|---|---|---|
| Shell mode | ✅ On by default | ❌ Off |
| UI languages | All, with `@devtools-anywhere/devtools-frontend-locales` in the frontend's directory | English and Chinese |

- After the page loads, the probe mounts one `<devtools-anywhere>` under `<html>`, whatever the page has; a second probe only warns.
- Caching: files under the frontend's `bundle/` are named after their content (cache for good); serve `anywhere_app.html` with `Cache-Control: no-cache`.

### Attributes

| Attribute | Vite option | Default | Effect |
|---|---|---|---|
| `data-devtools-frontend-url` | `devtoolsFrontendUrl` | Script tag: none. Vite: the installed frontend | The frontend's `anywhere_app.html`. Without it, no panel is mounted |
| `data-bundle` | — | Next to the probe | URL of `devtools-anywhere.iife.js` |
| `data-open-immediately` | `openImmediately` | Off | Opens DevTools as the page loads |
| `data-default-shell-mode` | `defaultShellMode` | `on` | `off`: no shell mode, the panel covers the page |
| `data-shell-mode-locked` | `shellModeLocked` | Off | Follows `data-default-shell-mode`, ignoring the user's choice (kept for later) and hiding DevTools' switch |
| `data-no-toggler` | `noToggler` | Off | Hides the F12 button |
| `data-service-worker` | `serviceWorker` (on / off) | Off | Turns the [Service Worker](#service-worker) on. As an attribute, its URL (empty: next to the bundle) |
| `data-remote` | `remote` | Off | Connects to a [remote debugging](#remote-debugging) server: its URL (empty: where the probe is served from) |
| `data-id-in-query` | `idInQuery` | Off | For a server with `idInQuery` |

## Vite

```bash
npm i -D @devtools-anywhere/vite-plugin
```

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default { plugins: [devtoolsAnywhere()] }
```

- `vite serve` only. Injects the probe as the first script of every page; serves the bundle, Service Worker and frontend under `/@devtools-anywhere/`.
- Options: those of the [attributes](#attributes), plus `devtoolsFrontendPath` (another frontend build on disk, `…/anywhere_app.html`; its directory is served).
- `serviceWorker: true`: the plugin also sends `Service-Worker-Allowed`.
- With `@devtools-anywhere/devtools-frontend-locales` installed, all UI languages are served.

## Element placed by the page

```html
<devtools-anywhere devtools-frontend-url="/devtools-frontend/dist/anywhere_app.html" style="height: 400px"></devtools-anywhere>
```

- A block in the page's flow, sized by the page's CSS. DevTools loads once it is connected, and stays loaded while `hidden`.
- No F12 button, dock side, resizing or shell mode; inside the shell's page it works as on its own.
- One attribute, `devtools-frontend-url` (default: the probe's); others are ignored.
- Style DevTools' iframe with `devtools-anywhere::part(iframe)`.

## The panel

| Control | Effect |
|---|---|
| F12 button | Opens the panel |
| Grip on the middle of the panel's inner edge | Resizes the docked panel (in shell mode too, next to DevTools' own resizer) |
| ⋮ → Dock side | Bottom (default), right, left, or undocked: a window moved by its bar, resized from its corner |
| Lock button (left of ⚙) | Shell mode on / off; a dialog explains it first, an info bar shows while it is on |
| Refresh button | Reloads the page |
| × | Closes the panel |

- Dock side and sizes are kept in `localStorage`, sizes as percentages of the viewport (`dvh`/`dvw`), so they fit any screen and orientation.
- In shell mode the page shrinks to make room; otherwise the panel covers it.
- Restyle the F12 button with `devtools-anywhere::part(toggler)`, in shell mode too: there it is in the page iframe (the shell shows its own only for a page without the probe, such as another origin's).
- Moving the element in the DOM reloads DevTools.

### Togglers

Any element can open and close the panel:

```html
<button data-devtools-anywhere-toggle>DevTools</button>
```

| `data-devtools-anywhere-toggle` | On click |
|---|---|
| Empty | Toggles the probe's panel; `aria-expanded` follows it |
| Id of an element the page placed | Fires `devtools-toggle-request` on that element; no `aria-expanded` |

- Clicks are caught on the document, so togglers added later work. The default action is not prevented.
- They work once the probe has loaded `devtools-anywhere.iife.js`.
- In the shell's page, every toggler controls the shell's panel.
- Togglers inside a shadow root, or in a page of another origin than the shell, do nothing.
- A toggler naming a missing element warns, once per value.
- The element fires no open / close event: `aria-expanded` on the togglers is the state.

## Shell mode

The top-level page is replaced by a shell: the page runs in an iframe next to DevTools, as in Chrome.

| | Shell mode | Without |
|---|---|---|
| DevTools across reloads and navigations | Stays open, logs kept | Reopens with the page |
| Device mode | ✅ | Screencast instead |
| Layout | The page shrinks next to DevTools | The panel covers the page |

On by default for the top-level page, when the bundle and frontend (and Service Worker) are on the probe's origin. It is off when:

| Condition | |
|---|---|
| `data-default-shell-mode="off"` | Unless the user turned it on |
| The user turned it off (lock button) | Unless `data-shell-mode-locked` |
| The page cannot be framed (`X-Frame-Options`, CSP `frame-ancestors`) | For the rest of the session |
| The page keeps navigating the shell away | For the rest of the session |

Caveats:

- In an iframe, `100vh`, `position: fixed`, `window.top` and the viewport may behave differently.
- The page's HTML is requested twice; a page returned for a form POST is requested again with GET.

### Service Worker

`data-service-worker` / `serviceWorker`, in shell mode:

- Injects the probe into same-origin pages in the page iframe that lack it.
- Adds request and response headers to same-origin requests (documents, style sheets, scripts, images, …).
- Needs a secure context (HTTPS or localhost), a scope covering the pages (`Service-Worker-Allowed: /`), and no Service Worker of the site's own.

## Remote debugging

```bash
npx -p @devtools-anywhere/remote-server devtools-anywhere-remote
```

1. Add the printed `<script>` to the page:

   ```html
   <script src="http://192.168.1.2:8080/probe.iife.js" data-remote></script>
   ```

2. Open the printed target list (it has the token) on the computer, and click "inspect".

The server serves the probe, bundle and frontend itself, and the frontend runs on the computer: the same-origin rules above do not apply.

### CLI options

| Option | Default | Effect |
|---|---|---|
| `--port`, `-p` | `8080` | Port |
| `--host` | All interfaces | Interface to listen on |
| `--public-url` | LAN address | URL printed for pages, e.g. behind a proxy |
| `--base-path` | `/` | Serve under a path |
| `--token <t>` / `--no-token` | Random | Token for the target list and DevTools; pages need none |
| `--cert`, `--key` | — | HTTPS; needed for HTTPS pages |
| `--id-in-query` | Off | Target in the query, for hosts that route WebSocket upgrades by exact path |
| `--devtools-frontend-path` | The bundled frontend | Another frontend build on disk |
| `--devtools-frontend-url` | — | A frontend hosted elsewhere (a CDN; over HTTPS, the server needs HTTPS too). The WebSocket and token go in the URL fragment, not sent to the CDN |

### Behavior

- Pages connect after load; early output is captured as usual.
- DevTools stays connected across reloads and navigations in the tab. A page whose connection drops reconnects by itself, and stays on the list meanwhile.
- Several DevTools windows can inspect one page, each in its own session.
- The target list can be filtered and shows how many DevTools each page has.
- With `data-devtools-frontend-url` too, the page also has its own panel.
- Breakpoints still need the browser's own debugger (`chrome://inspect`, Safari Web Inspector): the page runs the same in-page agent.

`data-remote` with a value names the server, when the probe comes from elsewhere. It resolves like a link:

| `data-remote` | Server |
|---|---|
| `http://host:8080/devtools/` | At `/devtools/` |
| `http://host:8080/devtools` | At `/` |

In shell mode:

- The page in the shell connects, not the shell.
- The shell's probe decides for every page in the shell; their own `data-remote` is ignored, so a page's scripts cannot send later pages elsewhere.
- With `data-service-worker`, pages it injects connect too.
- Shell mode needs the frontend on the probe's origin: not with the probe from the server and a frontend elsewhere.

### Node.js and endpoints

| API / URL | Description |
|---|---|
| `startRemoteServer(options)` | The CLI's server |
| `createRemoteHandler(options)` | Request and upgrade handlers for your own server (Express, Koa, …); `false` for requests not theirs |
| `<base>target/<id>` | The page's WebSocket |
| `<base>client/<id>` | DevTools' WebSocket |
| `<base>?target=<id>`, `<base>?client=<id>` | The same, with `idInQuery` (both forms always accepted) |
| `/json/list` | Targets, in Chrome's format (needs the token) |
| `anywhere_app.html?ws=<host:port/path>` | A frontend opened by itself connects to a target, as Chrome's `devtools_app.html?ws=` (`wss=` over HTTPS; also `#?ws=`) |

## Limitations

Gaps are filled exactly or not at all: nothing approximate is shown as fact.

| Feature | Status | Details |
|---|---|---|
| Breakpoints, Profiler, Memory, Performance | ❌ Panels not included | No JS API. `debugger;` does not pause; in shell mode it logs a warning with its stack |
| Network timing | ❌ | No JS API |
| Sources | ⚠️ | Documents, external scripts and style sheets, images, fonts; no inline scripts; snippets work |
| Browser default styles | ❌ | Not exposed to pages |
| Event listeners | ⚠️ | Only those added after the probe ran; no source location |
| WebSocket | ⚠️ | Connections and frames; no handshake headers |
| Cross-origin style sheets | ⚠️ | Need CORS; read-only |
| Forced `:hover`, `:focus`, … | ⚠️ | Not for `@import` and `adoptedStyleSheets` sheets |
| Screencast (device button outside shell mode) | ⚠️ | Redrawn by [snapDOM](https://github.com/zumerlab/snapdom) from the DOM: canvas, video and cross-origin images may be missing; ≤ 2 fps. Input replayed with `isTrusted: false` |
| Screenshots | ⚠️ | See [below](#screenshots) |
| Device mode | ⚠️ | Shell mode only. Sets the size only: no pixel ratio, user agent or touch; its screenshots are snapDOM's, at the page's pixel ratio |
| Fullscreen pages | ⚠️ | While an element is fullscreen, DevTools cannot be used, in shell mode too. Esc leaves fullscreen |
| Frontend on the page's origin | ⚠️ | DevTools' settings share the page's `localStorage`: host it on another origin |
| Browsers | ⚠️ | Page side: any modern browser. DevTools UI: verified in Chrome only; newer frontends may need compatibility patches |

snapDOM (about 90 KB gzip) loads only for the screencast and screenshots.

### Screenshots

`Page.captureScreenshot`, for tools and agents that drive the page over CDP:

- Rendered by snapDOM like the screencast, and marked `approximate: true` (a field Chrome does not send).
- `clip` is in page coordinates; the image is in device pixels (`devicePixelRatio` × `clip.scale`).
- `captureBeyondViewport` without `clip` takes the whole page.
- Past the canvas limits (32767 px a side, 16384 on Safari, 16384 × 16384 in area) the image is scaled down; snapDOM warns in the console.
- WebP falls back to PNG where it cannot be encoded (Safari).

## Packages

| Package | Contents |
|---|---|
| `devtools-anywhere` | `probe.iife.js`, `devtools-anywhere.iife.js` (the element), `devtools-anywhere-service-worker.js`, `snapdom.js`; TypeScript types for the element, its events and the attributes. No module to import |
| `@devtools-anywhere/devtools-frontend` | The frontend, English and Chinese UI |
| `@devtools-anywhere/devtools-frontend-locales` | The other 80 UI languages; serve from the frontend's directory. Missing languages fall back to English |
| `@devtools-anywhere/vite-plugin` | Vite plugin |
| `@devtools-anywhere/remote-server` | Remote debugging server and CLI (`devtools-anywhere-remote`) |
