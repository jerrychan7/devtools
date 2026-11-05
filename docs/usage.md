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

From jsDelivr or unpkg, pin an exact version: the probe loads the frontend of that same version from there.

```html
<script src="https://cdn.jsdelivr.net/npm/devtools-anywhere@0.2.0/dist/probe.iife.js"></script>
```

| | Self-hosted | CDN (jsDelivr, unpkg) |
|---|---|---|
| `data-devtools-frontend-url` | Required | Optional: the frontend of the same version on the CDN |
| Shell mode | ✅ On by default | ✅ On by default, without the [Service Worker](#service-worker) |
| UI languages | All, with `@devtools-anywhere/devtools-frontend-locales` in the frontend's directory | English and Chinese |

- After the page loads, the probe mounts one `<devtools-anywhere>` under `<html>`, whatever the page has; a second probe only warns.
- Caching: files under the frontend's `bundle/` are named after their content (cache for good); serve `anywhere_app.html` with `Cache-Control: no-cache`.

### Attributes

| Attribute | Vite option | Default | Effect |
|---|---|---|---|
| `data-devtools-frontend-url` | `devtoolsFrontendUrl` | Script tag from jsDelivr or unpkg: the frontend of the same version there. Other script tags: none. Vite: the installed frontend | The frontend's `anywhere_app.html`. Without one, no panel is mounted |
| `data-no-panel` | — | Off | No panel and no shell mode, whatever the frontend: for a page only [debugged remotely](#remote-debugging) |
| `data-bundle` | — | Next to the probe | URL of `devtools-anywhere.iife.js` |
| `data-open-immediately` | `openImmediately` | Off | Opens DevTools as the page loads |
| `data-default-shell-mode` | `defaultShellMode` | `on` | `off`: no shell mode, the panel covers the page |
| `data-shell-mode-locked` | `shellModeLocked` | Off | Follows `data-default-shell-mode`, ignoring the user's choice (kept for later) and hiding DevTools' switch |
| `data-no-toggler` | `noToggler` | Off | Hides the F12 button |
| `data-service-worker` | `serviceWorker` (on / off) | Off | Turns the [Service Worker](#service-worker) on. As an attribute, its URL (empty: next to the bundle) |
| `data-remote` | `remote` | Off | Connects to a [remote debugging](#remote-debugging) server: its URL (empty: where the probe is served from) |
| `data-id-in-query` | `idInQuery` | Off | For a server with `idInQuery` |
| `data-frame-origins` | `frameOrigins` (array) | None | Origins of [cross-origin iframes](#cross-origin-iframes) this page's DevTools debugs, space-separated; `sandboxed` for its [sandboxed iframes](#sandboxed-iframes) |
| `data-parent-origins` | `parentOrigins` (array) | None | Origins of the pages that may debug this one in their iframe, space-separated |

### Cross-origin iframes

A page cannot reach a cross-origin iframe's document. When the iframe's page loads the probe too, and each side trusts the other, the iframe is debugged from the parent's DevTools as Chrome debugs an out-of-process iframe: its document under the `<iframe>` in Elements, its context in the Console's menu, its requests, styles, highlighting and input.

```html
<!-- https://app.example.com -->
<script src="…/probe.iife.js" data-frame-origins="https://widget.example.net"></script>
<!-- https://widget.example.net, in an iframe of the page above -->
<script src="…/probe.iife.js" data-parent-origins="https://app.example.com"></script>
```

- Both lists are needed, and off by default: the parent's DevTools can run any code in the iframe.
- An entry is an exact origin, or `https://*.example.com` for every subdomain at any depth (not `example.com` itself); scheme and port are exact. `*` alone is ignored, with a warning.
- While linked, the iframe's own F12 button and panel are hidden.
- The link survives the iframe's reloads and navigations to pages that link again; iframes in the iframe link the same way, level by level.

### Sandboxed iframes

An iframe sandboxed without `allow-same-origin` has an opaque (`null`) origin: the page cannot reach its document, and Chrome keeps it in the page's own target, not as a child one. When its document loads the probe too, and the parent allows it, it is merged into the parent's target as in Chrome: Elements shows its document under the `<iframe>`, the Console its context and messages, Network its requests, Sources its scripts, Styles its sheets; highlighting, inspect mode and Input reach into it.

```html
<!-- https://app.example.com -->
<script src="…/probe.iife.js" data-frame-origins="sandboxed"></script>
<!-- the sandboxed document, in <iframe sandbox="allow-scripts" src="/widget.html"> of the page above -->
<script src="…/probe.iife.js" data-parent-origins="https://app.example.com"></script>
```

- Off by default: `sandboxed` in the parent's `data-frame-origins` (it can be listed with origins) turns it on, and the sandboxed document lists the parent's origin in `data-parent-origins`. The parent's DevTools can run any code in the iframe, and the iframe may load third-party scripts.
- Only for a `src` of the page's origin, `about:blank` or `srcdoc`. One whose `src` is of another origin is refused, of the same site too (which Chrome keeps in the page's target): shown as elements only, not listed in the frame tree.
- The check is on the iframe's `src`, not on the document it holds: a sandboxed document has the `null` origin, so the page cannot tell where it came from. Once the iframe navigates (a link followed in it, or its `src` redirected) to another origin, a document there that speaks the probe's handshake is merged too, and what it reports shows up in the page's DevTools. Turn it on only for iframes that stay on your own pages.
- Without it, or without the probe in the sandboxed document, the iframe is shown as in the [limitations](#limitations).

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

On by default for the top-level page, when the bundle and frontend (and Service Worker) are where the probe trusts: on its origin, or from jsDelivr or unpkg, in the probe's package and the frontend's at the same version. It is off when:

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
- With a frontend too (`data-devtools-frontend-url`, or the probe from jsDelivr or unpkg), the page also has its own panel; `data-no-panel` goes without it.
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
- Shell mode needs the frontend where the probe trusts it: not with the probe from the server and a frontend elsewhere.

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
| Browser default styles | ⚠️ | "user agent stylesheet" rules in Styles, from a copy of Chromium's `html.css` (`chromium-html.css`, loaded next to the bundle on first use). Rules with Blink-internal selectors are left out, `@supports blink-feature()` takes the feature-off branch, and only `html.css` is used (not Chrome's other default sheets); with the bundle inlined (no URL), none are shown. The Computed pane refreshes on DOM mutations and DevTools' own edits, not on every style change; not for nodes in merged sandboxed iframes |
| Event listeners | ⚠️ | Only those added after the probe ran; no source location |
| WebSocket | ⚠️ | Connections and frames; no handshake headers |
| Same-origin iframes | ⚠️ | An iframe's navigation is seen at its load event, later than in Chrome: logs and requests before it are missing, except in srcdoc and blank iframes; so are closed shadow roots its scripts attach before it. No isolated worlds (`Page.createIsolatedWorld`) |
| Sandboxed iframes (no `allow-same-origin`) | ⚠️ | [Merged](#sandboxed-iframes) into the page's target, as in Chrome: their DOM, styles, execution context, console, requests and scripts in the page's, highlighted, inspected and given input. Merged: moving or copying a node across the iframe's edge fails; `DOM.performSearch` lists the page's results first, then the iframe's; when the iframe's document reloads, its new `contentDocument` comes with its child count, without `childNodeCountUpdated` or `scrollableFlagUpdated`; the execution context Chrome reports for the iframe's initial about:blank is missing; a request to the iframe for its document, a node or a point unanswered within 1 s is taken as the iframe not answering (its document is not grafted, a point over it hits the `<iframe>` itself); an uncaught error thrown later by code run from the Console in the iframe (in a timer, say) has no exception object (`exception` is null), no position and no stack, as the iframe's document sees the probe's script as cross-origin and mutes its errors; its own scripts' errors are not affected; its scripts' sources are fetched again by the page from their URLs, so only those the page can fetch; in inspect mode the hover highlight is clipped by the iframe, and a `highlightNode` highlight of its node does not follow scrolling; `frameNavigated` keeps the same `loaderId` after the iframe's document navigates; after the frame navigates to a page without the probe, the page still shows the old document. Not merged (off, or no probe in it): listed in the frame tree as in Chrome, but shown as elements only, with no execution context or child frames of their own, and of its requests only its document's. The URL is the iframe's `src` (or `srcdoc`) as of its last load, not where its scripts navigated it; the MIME type is always text/html; the name is the iframe's `name` attribute, not a name its scripts set. The navigation is seen at the load event |
| Cross-origin iframes | ⚠️ | Only with the probe in the iframe's page and both [origin lists](#cross-origin-iframes); otherwise shown as elements only. Linked once the iframe's probe runs: its document's own request is reported in its session, not the parent's; breakpoints by URL are not set again after it navigates. A page that does not link again after a navigation is detached up to 10 s later |
| Cross-origin style sheets | ⚠️ | Need CORS; read-only. Without CORS, `CSS.getStyleSheetText` fails (Chrome has the text) and no rules are shown |
| Style sheet text | ⚠️ | The text a sheet was written in, with Chrome's ranges, and edits made in it as written. A `<style>` starts at 0:0, not where it is in the HTML. Once the page changes a sheet through the CSSOM (not `replace()` or `replaceSync()`), its text is serialized from the CSSOM, one rule per line (Chrome concatenates its rules, and lags behind); so it is when the rules found in the text cannot be paired with the CSSOM's, and for a constructed sheet made before DevTools opened. Changes made with `style.color = …` and the like, or to a media list's text, are not seen (no `CSS.styleSheetChanged`; Styles may show the text as it was). Editing the condition of an `@supports`, `@container` or `@scope` replaces the rule (the CSSOM cannot change it): rule objects the page holds for it and the rules in it are detached, where Chrome keeps them. The file of a `<link>` or `@import` is fetched again (from the HTTP cache when it may) |
| Forced `:hover`, `:focus`, … | ⚠️ | Not for `@import` and `adoptedStyleSheets` sheets |
| Screencast (device button outside shell mode) | ⚠️ | Redrawn by [snapDOM](https://github.com/zumerlab/snapdom) from the DOM: canvas, video and cross-origin images may be missing; ≤ 2 fps. Input replayed with `isTrusted: false` |
| Screenshots | ⚠️ | See [below](#screenshots) |
| Device mode | ⚠️ | Shell mode only. Sets the size only: no pixel ratio, user agent or touch; its screenshots are snapDOM's, at the page's pixel ratio. `Emulation.setDeviceMetricsOverride` works there from any client (a remote agent too), the last one set applying, as in Chrome; elsewhere it fails. Remote clients' overrides survive page reloads, as in Chrome. The override's params are checked as Chrome checks them, with Chrome's errors, except that "Invalid parameters" data leaves out Chrome's "at position N" (a byte offset in Chrome's own encoding), and a `devicePosture` of an unknown type is taken, where Chrome stops answering |
| Fullscreen pages | ⚠️ | While an element is fullscreen, DevTools cannot be used, in shell mode too. Esc leaves fullscreen |
| Rendering panel emulation | ⚠️ | "Emulate a focused page" cannot be done: using DevTools in the page really takes focus from its elements, and their `:focus` styles go; turning it on fails. Auto dark mode and resetting the pinch zoom cannot be done either and fail. Every command the page cannot carry out fails with "Not supported in the page: <why>"; those that could be done but are not yet are in the [roadmap](roadmap.md) |
| Accessibility tree | ⚠️ | The Elements panel's Accessibility pane and `Accessibility.getPartialAXTree`, `getFullAXTree`, `queryAXTree`, `getRootAXNode`, `getChildAXNodes`, `getAXNodeAndAncestors`: computed in the page from the DOM, ARIA attributes and computed styles, compared with Chrome's. No inline text boxes, list markers or nodes of user-agent shadow trees; the default names of inputs (such as "Submit") are in English; no `loadComplete` or `nodesUpdated` events. Computed by `accessibility.js` (about 29 KB), loaded on first use from next to the bundle: self-hosted, serve it in the same directory |
| Animations panel | ⚠️ | CSS animations, transitions and Web Animations from `getAnimations()`, and those made with `animate()` or `new Animation()` (without a target, out of the document, over at once): listed, paused, seeked, retimed. The playback rate is set on each animation, not on the timeline as in Chrome, so the page reads it multiplied in `playbackRate` (a rate the page sets is kept, but one equal to the negated rate is taken for `reverse()`); one that ended outside `getAnimations()` and is restarted other than by `play()` is not seen; only the page's documents and its same-origin frames. Animations in shadow trees are listed (declarative ones, hosts inserted later, and those in iframes too), but not those in closed declarative shadow roots (the page has no handle on them) or in user-agent shadow trees (such as `input::placeholder`'s). A `::backdrop` animation names its `<dialog>`, which the Elements panel shows. `cssId` (what the panel groups by) is approximated from the page's styles: the same declarations in two rules count as one group, and a `:hover` transition and the one back share a group. `seekAnimations` takes `currentTimes` in milliseconds, as the protocol says (Chrome 156 takes them as seconds). While the rate is changed, an animation started meanwhile gets another start time than in Chrome, which slows the document timeline instead. An animation that stays pending (its timeline inactive) keeps the panel's rate after `disable`. An animation cancelled or paused before it started is reported created and cancelled only: when a frame's animation update ran before the cancel (a frame, then a timer that cancels it), Chrome reports a start first, which is missing here. An animation the page dropped and that was garbage-collected can no longer be found by its id (Chrome keeps it until `disable`). While a document is still being parsed, the animations and style sheets of its declarative shadow roots may come late; all are there once parsing ends. Scroll-driven animations (`scroll()`, `view()`, `ScrollTimeline`, `ViewTimeline`) report their `viewOrScrollTimeline` (the root scroller's as `document`), with Chrome's time unit of 16 µs per pixel. Seeking one that runs has no effect; a paused one is seeked to the converted time, clamped to its end. The playback rate does not apply to them (the panel disables its rate buttons while a scroll-driven group is selected). The panel does not follow the page's own scrolling (that needs an isolated world with `Page.createIsolatedWorld` and `Runtime.addBinding`); dragging the scrubber does set the scroll position |
| Emulated media | ⚠️ | `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-reduced-data`, `prefers-reduced-transparency`, `prefers-contrast`, `forced-colors`, `color-gamut` and the media type, by rewriting the page's style sheets. Not in cross-origin sheets, inline styles or `matchMedia()`; the colors `light-dark()` and forced colors pick are not changed |
| Emulated safe area insets | ⚠️ | `env(safe-area-inset-*)` replaced in the page's style sheets: not in cross-origin sheets or inline styles; Styles shows the replaced values |
| Vision deficiencies | ✅ | SVG filters on `<html>`, as in Chrome: they replace a `filter` of the page's own on `<html>`, apply to an embedded panel too, and `getComputedStyle` sees them |
| Layout overlays | ⚠️ | Grid, flex, container query, scroll-snap, isolation, hinge, display cutout and frame overlays, drawn approximately from the computed styles: grids have no line labels; isolation mode's resizing does not reach into iframes |
| Network conditions | ⚠️ | Blocked URLs, extra headers, cache disabled, offline and the user agent override apply to the `fetch()` and XHR the probe hooks only, not the document's own request or other subresources. Disabling the cache of XHR works for same-origin requests only; extra headers on a cross-origin request make it need a CORS preflight; the user agent is overridden in the page and its same-origin iframes found so far. Throttling is not supported. Reporting API: the reports the page sees only |
| Application panel | ⚠️ | IndexedDB and Cache Storage views refresh on writes of this window only (not workers or other windows); the storage bucket is the page's default one. Service workers: listed, updated and unregistered; whether one is running cannot be seen, so it shows running until redundant; inspecting, starting and stopping workers fail |
| Issues panel | ⚠️ | CSP violations, deprecations, quirks mode and form issues. CSP and deprecations of the top document only; no interventions, no low contrast (Chrome has no such check either); cookies, CORS and mixed content are the browser's |
| Console violations | ⚠️ | `[Violation]` messages for slow handlers and forced reflows from `long-animation-frame` entries, without line numbers; the browser needs long-animation-frame, otherwise `Log.startViolationsReport` fails |
| `DOM.scrollIntoViewIfNeeded` in a cross-origin iframe | ✅ | Scrolls the parent pages on too, asynchronously after the answer |
| Frontend on the page's origin | ⚠️ | DevTools' settings share the page's `localStorage`: host it on another origin |
| Browsers | ⚠️ | Page side: any modern browser. DevTools UI: verified in Chrome only; newer frontends may need compatibility patches |

snapDOM (about 90 KB gzip) loads only for the screencast and screenshots; `accessibility.js` only for the accessibility tree; `chromium-html.css` only for the browser default styles. It is a copy of Chromium's `html.css`, the package's only file under the LGPL (2.0 or later; its license is next to it as `chromium-html.LICENSE.txt`, and in THIRD_PARTY_LICENSES.md). A site that does not want it can leave both files out: Styles then shows no user agent stylesheet rules, and nothing else changes.

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
| `devtools-anywhere` | `probe.iife.js`, `devtools-anywhere.iife.js` (the element), `devtools-anywhere-service-worker.js`, `snapdom.js`, `accessibility.js`, `chromium-html.css` (with `chromium-html.LICENSE.txt`); TypeScript types for the element, its events and the attributes. No module to import |
| `@devtools-anywhere/devtools-frontend` | The frontend, English and Chinese UI |
| `@devtools-anywhere/devtools-frontend-locales` | The other 80 UI languages; serve from the frontend's directory. Missing languages fall back to English |
| `@devtools-anywhere/vite-plugin` | Vite plugin |
| `@devtools-anywhere/remote-server` | Remote debugging server and CLI (`devtools-anywhere-remote`) |
