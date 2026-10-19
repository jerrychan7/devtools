# devtools

English | [简体中文](README.zh-CN.md)

A web component that brings Chrome DevTools to mobile web pages.

Mobile browsers have no developer tools, and existing solutions fall short:

- **eruda / vConsole**: only capture output after they initialize. They are large and usually loaded asynchronously, so the earliest logs and errors of a page are lost.
- **Chii**: can capture early output, but setup and configuration are cumbersome, and its frontend is stuck on an old Chrome DevTools (around version 122).

Goals:

1. **Never miss early output**: console messages, errors and network requests are visible from the very first script on the page.
2. **Zero-config setup**: a single `<script>` tag or a build plugin is all it takes.
3. **DevTools survive reloads**: DevTools stay open across page reloads and navigations, with logs preserved.
4. **Keep up with the latest Chrome DevTools**: maintain a patch set on top of the official devtools-frontend and upgrade regularly instead of staying on an old version.

## Design

### Technology choices

| Part | Choice | Rationale |
|---|---|---|
| CDP implementation | [chobitsu](https://github.com/liriliri/chobitsu) for now; may be rewritten later | In-page debugging can only collect data through JS APIs, so implementing it in another language (e.g. Rust compiled to wasm) brings no benefit. A rewrite would fit this project better, e.g. native support for replaying the probe's buffer and keeping up with newer CDP versions |
| Frontend | Prototype: Chii's prebuilt `front_end` from npm. Production: official devtools-frontend plus this project's patch set | Chii's build can be loaded straight from a CDN, which is ideal for quick validation. The production build pins an official version and keeps patches as `.patch` files that are replayed on upgrade, instead of maintaining a long-lived fork branch |
| Isolation | iframe | Keeps DevTools' own DOM, logs and requests out of the inspected page, and prevents the two global environments from interfering with each other |

This project does not depend on Chii itself; it only borrows Chii's embedded mode and handshake protocol as a reference.

### Limitations

An in-page CDP implementation can only use JS APIs, so the following are **not available**: breakpoint debugging, Profiler, Memory, and real network timing. These panels should be hidden rather than shown and found broken.

### Architecture

```
┌────────── Top-level window (shell) ──────────┐
│  ┌────────────────────────────────────────┐  │
│  │ Page iframe                            │  │
│  │  Probe (first sync script in <head>)   │  │
│  │   └─ buffer → chobitsu (lazy-loaded)   │  │
│  └───────────────────┬────────────────────┘  │
│          postMessage (origin-checked)        │
│  ┌───────────────────┴────────────────────┐  │
│  │ DevTools iframe (blob URL)             │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

#### 1. Probe

A synchronous script of only a few KB that must be the first script executed in `<head>`.

- Immediately hooks `console`, `window.onerror`, `unhandledrejection`, `fetch` and `XHR`, and writes events with timestamps into a buffer.
- chobitsu and the frontend are loaded lazily. Once connected, buffered events are replayed into DevTools first, then live forwarding takes over.

The probe exists as a separate script because nothing outside a page can observe its output; only a script that runs before the page's own code can capture the earliest output. chobitsu alone is over 450 KB, and loading it synchronously would slow down first paint, so only the minimal capture logic goes first.

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

## Constraints and caveats

- Every `postMessage` must check `event.origin` and `event.source`; otherwise any page could send CDP commands to chobitsu.
- Detect whether the page is inside the shell through a postMessage handshake rather than reading properties on `window.parent`, which throws a SecurityError across origins.
- Both ends of the handshake need buffering: messages must not be dropped while DevTools is still loading.
- Frontend assets should be self-hostable, with no dependency on third-party CDNs such as unpkg or jsDelivr.
- When injecting with a Service Worker:
  - Only handle navigation requests with `destination === 'iframe'`, and let everything else pass through.
  - Call `unregister()` when f12 is disabled.
  - Insert the probe with a `TransformStream` so SSR streaming is not broken.
  - Mind the scope: the SW script must sit at the site root, or the server must send a `Service-Worker-Allowed` header.

## Roadmap

1. **Validate early capture**: probe, buffering and replay. Log synchronously at the very top of a test page and confirm those logs all show up in the Console panel.
2. **Connection layer**: handshake timing, buffering on both ends and origin checks; get the default mode working.
3. **Shell mode**: implement the in-place rewrite and verify that DevTools survive reloads and navigations.
4. **Zero-config setup**: Vite plugin and single `<script>` setup, then the optional Service Worker injection.
5. **Componentization and frontend customization**: wrap everything as a custom element with attributes, events and methods; hide unsupported panels and adapt to small screens; maintain a patch set on top of the official devtools-frontend and upgrade it regularly.
6. **Own CDP implementation (optional)**: replace chobitsu if needed.

## References

- [Chii](https://github.com/liriliri/chii): embedded mode in `src/target/DevtoolsFrame.ts`
- [chobitsu](https://github.com/liriliri/chobitsu)
- [ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
- [solid-playground preview](https://github.com/solidjs/solid-playground/blob/master/packages/solid-repl/src/components/preview.tsx)

## License

[MIT](LICENSE)
