# Design

English | [简体中文](design.zh-CN.md)

How devtools-anywhere works and why it is built this way. For using it, see the [README](../README.md); for working on it, the [development guide](../DEV.md).

## Technology choices

| Part | Choice | Rationale |
|---|---|---|
| CDP implementation | Written in this project, using [chobitsu](https://github.com/liriliri/chobitsu) as a reference | In-page debugging can only collect data through JS APIs, so it has to be written in JS/TS. Owning it lets the probe and the CDP domains share the same hooks (no replay tricks), fixes chobitsu's known issues, and tracks the latest protocol through [`devtools-protocol`](https://github.com/ChromeDevTools/devtools-protocol) types |
| Frontend | Official devtools-frontend, built from source with a small patch set | The build pins an official revision and keeps patches as `.patch` files that are replayed on upgrade, instead of maintaining a long-lived fork branch. The patches only register an own entrypoint (`anywhere_app`); everything else is done without touching upstream code (see [Working on the frontend](../DEV.md#working-on-the-frontend)) |
| Isolation | iframe | Keeps DevTools' own DOM, logs and requests out of the inspected page, and prevents the two global environments from interfering with each other |

This project depends on neither Chii nor chobitsu. Their source is read as a reference for edge cases, but no code is copied; real Chrome's CDP output and the protocol definition are the source of truth.

## Architecture

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

### 1. Probe

A synchronous script of about 6.2 KB (min+gzip, including shell mode, auto-mounting and remote debugging) that must be the first script executed in `<head>`.

- Immediately hooks `console`, `window.onerror`, `unhandledrejection`, `fetch`, `XHR` and `WebSocket`, and writes events with timestamps into a buffer. WebSocket frames are kept as given; binary payloads are only converted to base64 by the CDP agent. Until a CDP session mounts, each list (console messages, requests, WebSockets, frames per WebSocket) keeps its last 10,000 entries, a bound for pages that never load one; the session then sets its own: it keeps the last 1000 console messages like V8, and every request and WebSocket like Chrome, dropping only the oldest response bodies past the buffer sizes given to `Network.enable` (Chrome's defaults when none are).
- Requests that cannot be hooked (the document, style sheets, scripts, images, fonts, …) are recorded from Resource Timing; a buffered `PerformanceObserver` also delivers those from before the probe ran. They have URL, type, timing, size and (where the browser exposes it) status and MIME type, but no headers; their bodies are loaded again from the HTTP cache on demand. In shell mode with the Service Worker, it adds the request and response headers of same-origin ones. Hooks stay first because they work from the very start, keep call stacks, and need no deployment; a Service Worker only controls pages after it is installed, conflicts with a site's own, and would have to proxy requests to see responses.
- The CDP runtime and the frontend are loaded lazily. The runtime's Runtime and Network domains consume the probe's buffer directly and subscribe to new events, so every API is hooked only once.

Nothing outside a page can observe its output; only a script that runs before the page's own code can capture the earliest output. The full CDP runtime is too large to load synchronously, so only the minimal capture logic goes first.

This approach has been validated: see [experiments/early-capture/RESULTS.md](../experiments/early-capture/RESULTS.md). With a ~1.4 KB probe and chobitsu loaded lazily, every early console call, exception and request reached DevTools, with expandable objects and original timestamps and stacks.

### 2. Shell mode (in-place rewrite)

No standalone `devtools.html` is hosted, and there is no navigation to a blob URL, since blob URLs break on reload and cannot be shared. Instead:

1. With the zero-config probe (`data-devtools-frontend-url`, or the Vite plugin), the top-level page enters shell mode by default on its first load: the probe stores the frontend and bundle URLs in `sessionStorage` itself, before the page's scripts run, so the page is not reloaded. DevTools starts hidden unless `data-open-immediately` is set. Otherwise, the lock button in DevTools' toolbar, "Keep DevTools open across reloads", stores them and reloads the page.
2. The probe, being the first script, sees the config in the top-level window. It writes an unclosed `<plaintext>` so the rest of the page becomes inert text (none of its scripts run), then replaces the document with the shell via `document.open()` / `document.write()`. The shell contains the page iframe (pointing to `location.href`) and `<devtools-anywhere>`, which knows it is the shell's element by the document it is in. (Chrome ignores `document.open()` after `window.stop()`, hence `<plaintext>`.)
3. Inside the iframe, the probe captures as usual and loads the bundle, which connects the page's CDP session to the shell. The shell relays messages between the page and the frontend.
4. When the page reloads or navigates, the new page says hello; the shell tells the frontend the page navigated and re-sends every `enable` command the frontend has sent, so the new page replays its own earliest output. The address bar and title follow the page, through loads, history traversals and same-document navigations (`pushState` where the Navigation API exists), so that a reload or a copied link opens the page shown.
5. DevTools fills the shell and lays out the page and itself, as in Chrome: the page iframe goes where the frontend's page area is, on top of it. Dock side and sizes are DevTools' own (its resizer, and a grip against the middle of DevTools' edge on the page's side, like a tab of the panel, larger on touch screens). Undocked, DevTools is a window over the page. The toolbar's device button is device mode, as in Chrome, in place of the screencast: the page iframe is sized as the device and scaled to fit, and the toolbar's menu takes screenshots. Undocked, device mode's toolbar is drawn in a page of the frontend's (`device_mode_emulation_frame.html`, as Chrome does) shown under the window.
6. The toolbar's × hides DevTools and stays in shell mode; the page fills the shell at its own size until DevTools is shown again. The lock button again clears the config and reloads the page on its own; the choice is remembered in `localStorage`, and wins over the page's `data-default-shell-mode` from then on, unless the page sets `data-shell-mode-locked`.

The stored URLs are only trusted when they have the same origin as the probe script; otherwise the config is cleared and the page loads normally. Shell mode therefore needs the probe, the bundle and the frontend served from the page's origin.

Inside an iframe, `viewport`, `100vh`, `position: fixed`, `window.top` and others may behave differently from a top-level page; the page's HTML is requested twice (by the top-level window, then by the iframe), and a page returned for a form POST is requested again with GET. Turn shell mode off with `data-default-shell-mode="off"` (the Vite plugin's `defaultShellMode: 'off'`), and DevTools is embedded directly in the page. A page that refuses to be framed (`X-Frame-Options`, CSP `frame-ancestors`), or that keeps navigating the shell away, is shown on its own for the rest of the session.

### 3. Injection

| Method | When to use |
|---|---|
| Add a `<script>` manually (must be the first one in `<head>`) | Any page |
| `@devtools-anywhere/vite-plugin`: injects in development only (`vite serve`) | Projects using Vite (a webpack plugin may follow) |
| `devtools-anywhere-service-worker.js`: in shell mode, injects the probe into same-origin pages loaded in the page iframe that do not include it | Secure context (HTTPS or localhost), a scope covering the pages (`Service-Worker-Allowed: /`), and no Service Worker of the site's own |

All methods share the same probe.

## Packaging

Why the packages listed in the [README](../README.md#packaging) are split this way:

- The in-page CDP agent and its probe are not a separate package: the probe and the domains share the same hooks and buffers, and only `devtools-anywhere` uses them. They live in `devtools-anywhere` (`src/cdp-agent/`), which rules out version mismatches; the probe is still built as a separate tiny file, `probe.iife.js`.
- The frontend is separate because it is large (about 16 MB) and follows Chrome's release cadence. Its other languages (about 42 MB) are another package, so that only those who need them install them.
- All packages share one version number and are released together, so matching versions always work together.
