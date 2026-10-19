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
| Frontend | Prototype: Chii's prebuilt `front_end`. Production: official devtools-frontend plus this project's patch set | Chii's build is ready to use and ideal for quick validation. The production build pins an official version and keeps patches as `.patch` files that are replayed on upgrade, instead of maintaining a long-lived fork branch |
| Isolation | iframe | Keeps DevTools' own DOM, logs and requests out of the inspected page, and prevents the two global environments from interfering with each other |

This project depends on neither Chii nor chobitsu; it uses them only as references.

### Limitations

- An in-page CDP implementation can only use JS APIs, so the following are **not available**: breakpoint debugging, Profiler, Memory, and real network timing. These panels should be hidden rather than shown and found broken.
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

A synchronous script of about 1–2 KB (min+gzip) that must be the first script executed in `<head>`.

- Immediately hooks `console`, `window.onerror`, `unhandledrejection`, `fetch` and `XHR`, and writes events with timestamps into a buffer.
- The CDP runtime and the frontend are loaded lazily. The runtime's Runtime and Network domains consume the probe's buffer directly and subscribe to new events, so every API is hooked only once.

Nothing outside a page can observe its output; only a script that runs before the page's own code can capture the earliest output. The full CDP runtime is too large to load synchronously, so only the minimal capture logic goes first.

This approach has been validated: see [experiments/early-capture/RESULTS.md](experiments/early-capture/RESULTS.md). With a ~1.4 KB probe and chobitsu loaded lazily, every early console call, exception and request reached DevTools, with expandable objects and original timestamps and stacks.

#### 2. Shell mode (in-place rewrite)

No standalone `devtools.html` is hosted, and there is no navigation to a blob URL, since blob URLs break on reload and cannot be shared. Instead:

1. Enabling f12 writes a flag to `sessionStorage` and reloads the page.
2. When the probe runs, sees the flag and is not inside an iframe, it calls `window.stop()` to halt loading of the original page, then writes the shell with `document.open()` / `document.write()`. The shell's page iframe points to `location.href`.
3. The probe runs again inside the iframe, recognizes that it is inside the shell, and works normally.
4. Disabling f12 clears the flag and reloads the page.

The address bar always shows the real URL, so reloading and sharing work as expected, and DevTools stay put when the page inside reloads.

Shell mode is **optional**: inside an iframe, `viewport`, `100vh`, `position: fixed`, `window.top`, `X-Frame-Options` and others may behave differently from a top-level page. The default mode embeds DevTools directly in the page.

#### 3. Injection

| Method | When to use |
|---|---|
| Add a `<script>` manually (must be the first one in `<head>`) | Any page |
| Vite / webpack plugin that injects in development and strips in production builds | Projects using a build tool |
| Service Worker that rewrites the HTML of the page iframe inside the shell | Same-origin, HTTPS, and the site has no Service Worker of its own. It can also record network requests made before the probe runs |

All methods share the same probe.

### Packaging

An umbrella package plus scoped packages under the [`@devtools-anywhere`](https://www.npmjs.com/org/devtools-anywhere) npm organization:

| Package | Contents |
|---|---|
| `devtools-anywhere` | Umbrella package: depends on the packages below and provides the `<devtools-anywhere>` element and the simplest setup |
| `@devtools-anywhere/cdp-server` | In-page CDP server. The probe ships as the `@devtools-anywhere/cdp-server/probe` subpath export, built as a separate tiny file for `<script>` tags and injection |
| `@devtools-anywhere/devtools-frontend` | Prebuilt frontend static assets, self-hostable or served from a CDN |
| `@devtools-anywhere/vite-plugin` | Vite plugin |

- The probe is not a separate package: the Runtime and Network domains read its buffer directly, so the two must always match. Keeping it in cdp-server lets them share types and rules out version mismatches.
- The frontend is separate because it is large (about 14 MB) and follows Chrome's release cadence.
- All packages share one version number and are released together, so matching versions always work together.

### Repository layout (planned)

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
2. **Project skeleton and CDP core**: workspace, TypeScript, latest `devtools-protocol`; shared core state; Runtime and Network domains backed by the probe; conformance tests against real Chrome.
3. **Connection layer and default mode**: handshake timing, buffering on both ends and origin checks; `<devtools-anywhere>` embedded in the page.
4. **Shell mode**: implement the in-place rewrite and verify that DevTools survive reloads and navigations.
5. **Zero-config setup**: Vite plugin and single `<script>` setup, then the optional Service Worker injection.
6. **Remaining domains**: DOM and Overlay, then CSS, then storage domains (DOMStorage, Storage, IndexedDB, CacheStorage).
7. **Frontend customization**: patch set on top of the official devtools-frontend with regular upgrades; hide unsupported panels and adapt to small screens.

## References

- [chobitsu](https://github.com/liriliri/chobitsu): reference for the CDP implementation
- [Chii](https://github.com/liriliri/chii): embedded mode in `src/target/DevtoolsFrame.ts`
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)
- [Puppeteer](https://github.com/puppeteer/puppeteer): used as the source of truth in conformance tests
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## License

[MIT](LICENSE)
