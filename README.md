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

## Design

### Technology choices

| Part | Choice | Rationale |
|---|---|---|
| CDP implementation | Written in this project, using [chobitsu](https://github.com/liriliri/chobitsu) as a reference | In-page debugging can only collect data through JS APIs, so it has to be written in JS/TS. Owning it lets the probe and the CDP domains share the same hooks (no replay tricks), fixes chobitsu's known issues, and tracks the latest protocol through [`devtools-protocol`](https://github.com/ChromeDevTools/devtools-protocol) types |
| Frontend | Official devtools-frontend, built from source with a small patch set | The build pins an official revision and keeps patches as `.patch` files that are replayed on upgrade, instead of maintaining a long-lived fork branch. The patches only register an own entrypoint (`anywhere_app`); everything else is done without touching upstream code (see [Working on the frontend](DEV.md#working-on-the-frontend)) |
| Isolation | iframe | Keeps DevTools' own DOM, logs and requests out of the inspected page, and prevents the two global environments from interfering with each other |

This project depends on neither Chii nor chobitsu. Their source is read as a reference for edge cases, but no code is copied; real Chrome's CDP output and the protocol definition are the source of truth.

### Limitations

- An in-page CDP implementation can only use JS APIs, so the following are **not available**: breakpoint debugging, Profiler, Memory, and real network timing. These panels are not included in the frontend rather than shown and found broken. A `debugger;` statement in page scripts cannot pause either; in shell mode, each one hit in a same-origin script logs a warning with its stack in the Console instead. Real breakpoints need the browser's own debugger (`chrome://inspect` for Android, Safari's Web Inspector for iOS); [remote debugging](#remote-debugging) does not change this, since the page still runs the same in-page CDP agent. The Sources panel's Page tab lists the page's documents, external scripts and style sheets, images and fonts (inline scripts are not listed, since their position in the document is not known); snippets work.
- Where page scripts lack an API, the gap is filled exactly or not at all; approximations are not shown as facts:
  - User-agent styles are not shown: browsers do not expose their default style sheet, and a bundled copy could differ from the browser's.
  - Event listeners are recorded by the probe from the moment it runs (it must be the first script); their source locations are not available.
  - WebSocket connections and their frames are shown, but not the handshake headers, which the page cannot see.
  - The screencast (the toolbar's device button, off by default) shows the viewport as [snapDOM](https://github.com/zumerlab/snapdom) redraws it from the DOM, not the pixels on screen: canvas, video and cross-origin images may be missing, and it updates about twice a second at most. snapDOM (about 90 KB gzip) is loaded only when the screencast starts.
  - Input from the screencast is replayed as DOM events, which are not trusted (`isTrusted` is false): focus, clicks, scrolling and text editing are carried out, but pages that check `isTrusted` ignore them.
  - Cross-origin style sheets are read through a fetched copy, which needs CORS headers; their rules are read-only.
  - Forced pseudo-classes (`:hover`, `:focus`, … from the Styles pane) are emulated with companion style sheets that keep the cascade order; sheets from `@import` and `adoptedStyleSheets` are not covered.
- Host the frontend on a different origin from the page. On the same origin, DevTools' own settings share the page's `localStorage` and show up in the Application panel.
- The page side uses only standard web APIs and works in any modern browser. The DevTools UI is developed and tested by Google for Chrome; Firefox and Safari are not verified yet, and newer frontend versions may need extra compatibility patches.

### Architecture

```
┌────────── Top-level window (shell) ──────────┐
│  ┌────────────────────────────────────────┐  │
│  │ Page iframe                            │  │
│  │  Probe (first sync script in <head>)   │  │
│  │   └─ buffer → CDP runtime (lazy)       │  │
│  └───────────────────┬────────────────────┘  │
│          postMessage (origin-checked)        │
│  ┌───────────────────┴────────────────────┐  │
│  │ DevTools iframe                        │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

#### 1. Probe

A synchronous script of about 6.2 KB (min+gzip, including shell mode, auto-mounting and remote debugging) that must be the first script executed in `<head>`.

- Immediately hooks `console`, `window.onerror`, `unhandledrejection`, `fetch`, `XHR` and `WebSocket`, and writes events with timestamps into a buffer. WebSocket frames are kept as given; binary payloads are only converted to base64 by the CDP agent. Until a CDP session mounts, each list (console messages, requests, WebSockets, frames per WebSocket) keeps its last 10,000 entries, a bound for pages that never load one; the session then sets its own: it keeps the last 1000 console messages like V8, and every request and WebSocket like Chrome, dropping only the oldest response bodies past the buffer sizes given to `Network.enable` (Chrome's defaults when none are).
- Requests that cannot be hooked (the document, style sheets, scripts, images, fonts, …) are recorded from Resource Timing; a buffered `PerformanceObserver` also delivers those from before the probe ran. They have URL, type, timing, size and (where the browser exposes it) status and MIME type, but no headers; their bodies are loaded again from the HTTP cache on demand. In shell mode with the Service Worker, it adds the request and response headers of same-origin ones. Hooks stay first because they work from the very start, keep call stacks, and need no deployment; a Service Worker only controls pages after it is installed, conflicts with a site's own, and would have to proxy requests to see responses.
- The CDP runtime and the frontend are loaded lazily. The runtime's Runtime and Network domains consume the probe's buffer directly and subscribe to new events, so every API is hooked only once.

Nothing outside a page can observe its output; only a script that runs before the page's own code can capture the earliest output. The full CDP runtime is too large to load synchronously, so only the minimal capture logic goes first.

This approach has been validated: see [experiments/early-capture/RESULTS.md](experiments/early-capture/RESULTS.md). With a ~1.4 KB probe and chobitsu loaded lazily, every early console call, exception and request reached DevTools, with expandable objects and original timestamps and stacks.

#### 2. Shell mode (in-place rewrite)

No standalone `devtools.html` is hosted, and there is no navigation to a blob URL, since blob URLs break on reload and cannot be shared. Instead:

1. With the zero-config probe (`data-frontend`, or the Vite plugin), the top-level page enters shell mode by default on its first load: the probe stores the frontend and bundle URLs in `sessionStorage` itself, before the page's scripts run, so the page is not reloaded. DevTools starts hidden unless `data-open-immediately` is set. Otherwise, the lock button in DevTools' toolbar, "Keep DevTools open across reloads" (`element.enterShell()`), stores them and reloads the page.
2. The probe, being the first script, sees the config in the top-level window. It writes an unclosed `<plaintext>` so the rest of the page becomes inert text (none of its scripts run), then replaces the document with the shell via `document.open()` / `document.write()`. The shell contains the page iframe (pointing to `location.href`) and `<devtools-anywhere shell>`. (Chrome ignores `document.open()` after `window.stop()`, hence `<plaintext>`.)
3. Inside the iframe, the probe captures as usual and loads the bundle, which connects the page's CDP session to the shell. The shell relays messages between the page and the frontend.
4. When the page reloads or navigates, the new page says hello; the shell tells the frontend the page navigated and re-sends every `enable` command the frontend has sent, so the new page replays its own earliest output. The address bar and title follow the page, through loads, history traversals and same-document navigations (`pushState` where the Navigation API exists), so that a reload or a copied link opens the page shown.
5. The toolbar's × hides DevTools and stays in shell mode. The lock button again (`element.exitShell()`) clears the config and reloads the page on its own; the choice is remembered in `localStorage`, and wins over the page's `data-default-shell-mode` from then on, unless the page sets `data-shell-mode-locked`.

The stored URLs are only trusted when they have the same origin as the probe script; otherwise the config is cleared and the page loads normally. Shell mode therefore needs the probe, the bundle and the frontend served from the page's origin.

Inside an iframe, `viewport`, `100vh`, `position: fixed`, `window.top` and others may behave differently from a top-level page; the page's HTML is requested twice (by the top-level window, then by the iframe), and a page returned for a form POST is requested again with GET. Turn shell mode off with `data-default-shell-mode="off"` (the Vite plugin's `defaultShellMode: 'off'`), and DevTools is embedded directly in the page. A page that refuses to be framed (`X-Frame-Options`, CSP `frame-ancestors`), or that keeps navigating the shell away, is shown on its own for the rest of the session.

#### 3. Injection

| Method | When to use |
|---|---|
| Add a `<script>` manually (must be the first one in `<head>`) | Any page |
| `@devtools-anywhere/vite-plugin`: injects in development only (`vite serve`) | Projects using Vite (a webpack plugin may follow) |
| `devtools-anywhere-sw.js`: in shell mode, injects the probe into same-origin pages loaded in the page iframe that do not include it | Secure context (HTTPS or localhost), a scope covering the pages (`Service-Worker-Allowed: /`), and no Service Worker of the site's own |

All methods share the same probe.

### Packaging

An umbrella package plus scoped packages under the [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) npm organization:

| Package | Contents |
|---|---|
| `devtools-anywhere` | Umbrella package: the `<devtools-anywhere>` element, `probe.iife.js` (probe plus auto-mounting), `devtools-anywhere.iife.js`, `devtools-anywhere-sw.js` and `snapdom.js` (the screencast's renderer, loaded on demand) |
| `@devtools-anywhere/devtools-frontend` | Prebuilt frontend static assets with English and Chinese UI, self-hostable or served from a CDN |
| `@devtools-anywhere/devtools-frontend-locales` | Optional: the other 80 UI languages, at the same paths as in the frontend package. Serve both from one directory (the Vite plugin does this when it is installed); a missing language falls back to English |
| `@devtools-anywhere/vite-plugin` | Vite plugin |
| `@devtools-anywhere/remote-server` | Remote debugging server (Node.js) and its CLI, `devtools-anywhere-remote` |

- The in-page CDP agent and its probe are not a separate package: the probe and the domains share the same hooks and buffers, and only `devtools-anywhere` uses them. They live in `devtools-anywhere` (`src/cdp-agent/`), which rules out version mismatches; the probe is still built as a separate tiny file, `probe.iife.js`.
- The frontend is separate because it is large (about 16 MB) and follows Chrome's release cadence. Its other languages (about 42 MB) are another package, so that only those who need them install them.
- All packages share one version number and are released together, so matching versions always work together.

## Usage (preview)

The packages are not published yet; the paths below refer to the builds in this repository. `data-frontend` points at `anywhere_app.html` of a `@devtools-anywhere/devtools-frontend` build. Its `bundle/` files are named after their content and can be cached for good; serve `anywhere_app.html` itself with revalidation (`Cache-Control: no-cache`), so that an update reaches the browser.

### One script tag

```html
<head>
  <!-- First synchronous script: captures output from the very start. -->
  <script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-frontend="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
  ...
</head>
```

After the page loads, the probe loads `devtools-anywhere.iife.js` from next to itself (or `data-bundle`) and mounts `<devtools-anywhere>`. Optional attributes: `data-open-immediately` opens DevTools right away; `data-default-shell-mode="off"` stays out of shell mode, which the top-level page enters by default (`on`); `data-shell-mode-locked` keeps shell mode as `data-default-shell-mode` says, ignoring the user's choice (which stays stored) and hiding DevTools' switch, though a page that refuses to be framed is still shown on its own; `data-no-toggler` hides the F12 button, also in shell mode; `data-sw` enables the Service Worker in shell mode.

### Vite

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default {
  plugins: [devtoolsAnywhere()],
}
```

Only `vite serve` is affected: the probe is injected as the first script of every page, and the bundle, the Service Worker and the frontend are served under `/@devtools-anywhere/`. The frontend comes from `@devtools-anywhere/devtools-frontend`. Options: `frontendDir` (another frontend build), `frontendEntry` (default `anywhere_app.html`), `frontendUrl`, `openImmediately`, `defaultShellMode` (`'on'` or `'off'`), `shellModeLocked`, `toggler` (default `true`; `false` hides the F12 button), `serviceWorker`, which match the probe's attributes, `remote` (the URL of a [remote debugging](#remote-debugging) server to connect pages to, in place of the element).

### The element

A floating F12 button opens the panel; drag its bar to resize. Left of DevTools' settings button, the lock button switches shell mode on and off (a dialog explains it first, and an info bar shows while it is on) and the refresh button reloads the page; the toolbar's × closes the panel. DevTools' main menu (⋮) has "Dock side": bottom (the default), right, left, or undocked, a window over the page moved by its bar and resized from its corner. In shell mode the page shrinks to make room, as in Chrome; otherwise the panel covers the page. The side and sizes are remembered in localStorage, sizes as percentages of the viewport (`dvh`/`dvw`), so they fit any screen and orientation. Attributes: `frontend`, `open`, `dock`, `height`, `width`, `no-toggler`, `shell-mode-locked`, `sw`; methods: `show()`, `hide()`, `toggle()`, `enterShell()`, `exitShell()`. Keep the element in one place, since moving it reloads the iframe.

Any element can open and close the panel: give it `data-devtools-anywhere-toggle`, set to the id of a `<devtools-anywhere>`, or empty for the first one on the page. Clicks are caught on the document, so togglers added later work too; the default action is not prevented, and the togglers' `aria-expanded` follows the panel. A toggler whose element is missing logs a warning, once per value. The element fires `toggle` when `open` changes, a `ToggleEvent` with `oldState` and `newState` (`'open'` or `'closed'`) where the browser has it.

```html
<button data-devtools-anywhere-toggle>DevTools</button>
```

Togglers work once the element is registered with `defineDevtoolsAnywhere()` (the script builds do it), and not inside a shadow root. In shell mode, the togglers of the page inside the shell control the shell's panel, whatever their value. They do nothing in a page of another origin than the shell, such as a cross-origin iframe.

### Remote debugging

To inspect a page on a phone from Chrome on a computer, start the remote debugging server on the computer:

```bash
npx devtools-anywhere-remote --port 8080
```

It prints the target list's URL, with a token, and the script tag for pages, naming the computer by its LAN address (`--public-url` names it otherwise, for example behind a proxy). Load the probe from the server, with `data-remote`, as the first script in the page's `<head>`:

```html
<script src="http://192.168.1.2:8080/probe.iife.js" data-remote></script>
```

The page connects after it loads (early output is captured as usual), and shows up in the target list, which can be filtered and shows how many DevTools windows are attached; "inspect" opens DevTools on it in a tab of its own. DevTools stays connected when the page reloads or navigates within the tab, and the page reconnects by itself when the connection drops (it stays on the list meanwhile). Several DevTools windows can inspect one page at once, each in a session of its own, as in Chrome: the page runs a CDP session per DevTools session. `data-remote` can also name the server (`data-remote="http://host:8080/"`) when the probe comes from elsewhere. It is resolved against the probe's URL like a link, so a server under a path needs the trailing slash: `/devtools/` names the server at `/devtools/`, while `/devtools` names the one at `/`.

- The server serves the probe, its bundle and the DevTools frontend; the frontend runs on the computer, so the same-origin caveat does not apply.
- Inspecting a page means running any script in it: the target list and DevTools connections need the token (`--token <value>`, by default a random one; `--no-token` turns it off). Pages connect without it.
- An HTTPS page can only connect to an HTTPS server: `--cert` and `--key`. Other options: `--host`, `--base-path`, `--frontend-dir`, and `--frontend-url` to open a frontend hosted elsewhere (a CDN; an HTTPS one needs the server over HTTPS too; its links carry `ws=`/`wss=` and the token in the URL fragment, so they are not sent to the CDN). The same is available from Node.js as `startRemoteServer(options)`, and `createRemoteHandler(options)` gives its request and upgrade handlers, to mount under a base path in a server of one's own (Express, Koa, …): each returns false for what is not its own. Pages connect to `<base>target/<id>` and DevTools to `<base>client/<id>`; with `singlePath: true`, for a host that routes WebSocket upgrades by exact path only, both connect to the base path itself (`<base>?target=<id>`, `<base>?client=<id>`): the target list and the printed script tag use that form, whose script tag carries `data-single-path`, and register the base path, with its trailing slash, for upgrades. Both forms are always accepted. A frontend opened by itself connects to any target as `anywhere_app.html?ws=<host:port/path>` (`wss=` over HTTPS; also read from the fragment, `#?ws=`), the WebSocket URL without its scheme, as in Chrome's `devtools://devtools/bundled/devtools_app.html?ws=`.
- `/json/list` (with the token) lists the targets in the shape of Chrome's.

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
