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
| Frontend | Official devtools-frontend, built from source with a small patch set | The build pins an official revision and keeps patches as `.patch` files that are replayed on upgrade, instead of maintaining a long-lived fork branch. The patches only register an own entrypoint (`anywhere_app`); everything else is done without touching upstream code (see [Frontend](#frontend)) |
| Isolation | iframe | Keeps DevTools' own DOM, logs and requests out of the inspected page, and prevents the two global environments from interfering with each other |

This project depends on neither Chii nor chobitsu. Their source is read as a reference for edge cases, but no code is copied; real Chrome's CDP output and the protocol definition are the source of truth.

### Limitations

- An in-page CDP implementation can only use JS APIs, so the following are **not available**: breakpoint debugging, Profiler, Memory, and real network timing. These panels are not included in the frontend rather than shown and found broken. The Sources panel does not list the page's scripts yet (snippets work).
- Where page scripts lack an API, the gap is filled exactly or not at all; approximations are not shown as facts:
  - User-agent styles are not shown: browsers do not expose their default style sheet, and a bundled copy could differ from the browser's.
  - Event listeners are recorded by the probe from the moment it runs (it must be the first script); their source locations are not available.
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

A synchronous script of about 3 KB (min+gzip, including shell mode and auto-mounting) that must be the first script executed in `<head>`.

- Immediately hooks `console`, `window.onerror`, `unhandledrejection`, `fetch` and `XHR`, and writes events with timestamps into a buffer.
- The CDP runtime and the frontend are loaded lazily. The runtime's Runtime and Network domains consume the probe's buffer directly and subscribe to new events, so every API is hooked only once.

Nothing outside a page can observe its output; only a script that runs before the page's own code can capture the earliest output. The full CDP runtime is too large to load synchronously, so only the minimal capture logic goes first.

This approach has been validated: see [experiments/early-capture/RESULTS.md](experiments/early-capture/RESULTS.md). With a ~1.4 KB probe and chobitsu loaded lazily, every early console call, exception and request reached DevTools, with expandable objects and original timestamps and stacks.

#### 2. Shell mode (in-place rewrite)

No standalone `devtools.html` is hosted, and there is no navigation to a blob URL, since blob URLs break on reload and cannot be shared. Instead:

1. The ⟳ button on the DevTools bar (`element.enterShell()`) stores the frontend and bundle URLs in `sessionStorage` and reloads the page.
2. The probe, being the first script, sees the config in the top-level window. It writes an unclosed `<plaintext>` so the rest of the page becomes inert text (none of its scripts run), then replaces the document with the shell via `document.open()` / `document.write()`. The shell contains the page iframe (pointing to `location.href`) and `<devtools-anywhere shell>`. (Chrome ignores `document.open()` after `window.stop()`, hence `<plaintext>`.)
3. Inside the iframe, the probe captures as usual and loads the bundle, which connects the page's CDP server to the shell. The shell relays messages between the page and the frontend.
4. When the page reloads or navigates, the new page says hello; the shell tells the frontend the page navigated and re-sends every `enable` command the frontend has sent, so the new page replays its own earliest output. The address bar and title follow the page.
5. The × button (`element.exitShell()`) clears the config and reloads the page on its own.

Shell mode is **optional**: inside an iframe, `viewport`, `100vh`, `position: fixed`, `window.top`, `X-Frame-Options` and others may behave differently from a top-level page. The default mode embeds DevTools directly in the page.

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
| `devtools-anywhere` | Umbrella package: the `<devtools-anywhere>` element, `probe.iife.js` (probe plus auto-mounting), `devtools-anywhere.iife.js` and `devtools-anywhere-sw.js` |
| `@devtools-anywhere/cdp-server` | In-page CDP server. The probe ships as the `@devtools-anywhere/cdp-server/probe` subpath export, built as a separate tiny file for `<script>` tags and injection |
| `@devtools-anywhere/devtools-frontend` | Prebuilt frontend static assets, self-hostable or served from a CDN |
| `@devtools-anywhere/vite-plugin` | Vite plugin |

- The probe is not a separate package: the Runtime and Network domains read its buffer directly, so the two must always match. Keeping it in cdp-server lets them share types and rules out version mismatches.
- The frontend is separate because it is large (about 15 MB of code plus 43 MB of translations, about 11 MB as a gzipped tarball) and follows Chrome's release cadence.
- All packages share one version number and are released together, so matching versions always work together.

### Repository layout

```
packages/
  cdp-server/     in-page CDP server
    src/probe/    early capture: zero dependencies, size budget, separate build entry
    src/core/     state shared across domains: remote objects, node ids, DOM observer, stylesheets
    src/domains/  one directory per domain: runtime, network, dom, css, overlay, storage, ...
  devtools-frontend/  pinned devtools-frontend version, patches and build scripts
  devtools-anywhere/  umbrella package: <devtools-anywhere>, iframe, connection layer, shell mode
  vite-plugin/    zero-config injection
tests/
  conformance/    compare CDP output against real Chrome via Puppeteer
  e2e/            probe → CDP → frontend
playground/       pages and server for development
experiments/      validation records
```

## Constraints and caveats

- Every `postMessage` must check `event.origin` and `event.source`; otherwise any page could send CDP commands to the runtime.
- Detect whether the page is inside the shell through a postMessage handshake rather than reading properties on `window.parent`, which throws a SecurityError across origins.
- Both ends of the handshake need buffering: messages must not be dropped while DevTools is still loading.
- Frontend assets should be self-hostable, with no dependency on third-party CDNs such as unpkg or jsDelivr.
- When injecting with a Service Worker:
  - Only handle navigation requests with `destination === 'iframe'`, and let everything else pass through.
  - Call `unregister()` when f12 is disabled.
  - Insert the probe with a `TransformStream` so SSR streaming is not broken.
  - Mind the scope: the SW script must sit at the site root, or the server must send a `Service-Worker-Allowed` header.

## Roadmap

1. ✅ **Validate early capture**: probe, buffering and replay ([results](experiments/early-capture/RESULTS.md)).
2. ✅ **Project skeleton and CDP core**: workspace, TypeScript, latest `devtools-protocol`; shared core state; Runtime, Network and Page domains backed by the probe; conformance tests against real Chrome.
3. ✅ **Connection layer and default mode**: handshake timing, buffering on both ends and origin checks; `<devtools-anywhere>` embedded in the page.
4. ✅ **Shell mode**: implement the in-place rewrite and verify that DevTools survive reloads and navigations.
5. ✅ **Zero-config setup**: Vite plugin and single `<script>` setup, then the optional Service Worker injection.
6. ✅ **Remaining domains**: DOM and Overlay, then CSS, then storage domains (DOMStorage, Storage, IndexedDB, CacheStorage).
7. ✅ **Frontend customization**: own build of the official devtools-frontend with a patch set and a one-command upgrade; only panels that work in the page.

## Usage (preview)

The packages are not published yet; the paths below refer to the builds in this repository. `data-frontend` points at `anywhere_app.html` of a `@devtools-anywhere/devtools-frontend` build.

### One script tag

```html
<head>
  <!-- First synchronous script: captures output from the very start. -->
  <script src="/path/to/devtools-anywhere/dist/probe.iife.js" data-frontend="/path/to/devtools-frontend/dist/anywhere_app.html"></script>
  ...
</head>
```

After the page loads, the probe loads `devtools-anywhere.iife.js` from next to itself (or `data-bundle`) and mounts `<devtools-anywhere>`. Optional attributes: `data-open` opens DevTools right away; `data-sw` enables the Service Worker in shell mode.

### Vite

```js
// vite.config.js
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin'

export default {
  plugins: [devtoolsAnywhere()],
}
```

Only `vite serve` is affected: the probe is injected as the first script of every page, and the bundle, the Service Worker and the frontend are served under `/@devtools-anywhere/`. The frontend comes from `@devtools-anywhere/devtools-frontend`. Options: `frontendDir` (another frontend build), `frontendEntry` (default `anywhere_app.html`), `frontendUrl`, `open`, `serviceWorker`.

### The element

A floating F12 button opens the panel; drag its top bar to resize, ⟳ switches to shell mode and × closes. Attributes: `frontend`, `open`, `height`, `no-launcher`, `sw`; methods: `show()`, `hide()`, `toggle()`, `enterShell()`, `exitShell()`. Keep the element in one place, since moving it reloads the iframe.

## Development

Requires Node.js 22.18+ (the build scripts are TypeScript run by Node directly), pnpm and a local Google Chrome (set `CHROME_PATH` if it is not in the default macOS location).

```bash
pnpm install
pnpm test          # build, then run the conformance tests against real Chrome
pnpm playground    # http://localhost:8788/playground/
```

The playground and the real-frontend tests use the frontend in `packages/devtools-frontend/dist` (the tests are skipped until it is built).

### Frontend

`packages/devtools-frontend` builds the official [devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend) at the revision pinned in `REVISION`:

```bash
fetch devtools-frontend   # once, with depot_tools on PATH; checks out into ./devtools-frontend.ignore by default
pnpm --filter @devtools-anywhere/devtools-frontend build:frontend   # pinned revision
pnpm --filter @devtools-anywhere/devtools-frontend update           # latest upstream, pins it on success
```

`DEVTOOLS_FRONTEND_SRC` and `DEPOT_TOOLS` override the default locations (`devtools-frontend.ignore/devtools-frontend`, `depot_tools.ignore`). The script checks out the revision, runs `gclient sync`, applies `patches/*.patch`, copies `src/` into `front_end/entrypoints/`, builds with gn and autoninja, and copies to `dist/` only what the entrypoint can load (modules reachable through imports, their assets, and the UI strings of those modules in every locale).

How it fits into upstream with as few patches as possible:

- **Own entrypoint** `anywhere_app` instead of `devtools_app`: it imports only the panels that work against the in-page CDP server (Elements, Console, Sources, Network, Application), so the others are neither shown nor loaded. The only patch registers this entrypoint in the build (7 lines in 4 `BUILD.gn`/`.gni` files).
- **Embedder through the official host API**: Chrome talks to DevTools through native `InspectorFrontendHost` bindings. The entrypoint keeps the hosted-mode stub and only replaces `sendMessageToBackend`/`isHostedMode`, so CDP messages travel through `postMessage` to the embedding window, which passes its origin as `#?embedded=<origin>`. No connection code is patched.
- **Small screens**: upstream's responsive layouts (vertical split in Elements, overflowing tabs) are kept as is.

## References

- [chobitsu](https://github.com/liriliri/chobitsu): reference for the CDP implementation
- [Chii](https://github.com/liriliri/chii): embedded mode in `src/target/DevtoolsFrame.ts`
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
- [Puppeteer](https://github.com/puppeteer/puppeteer): used as the source of truth in conformance tests
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## License

[MIT](LICENSE)
