# Changelog

All packages share one version and are released together (see DEV.md, "Releasing to npm"). Each release says first which Chrome its DevTools frontend comes from; the versioning rules are in DEV.md too. Changes are listed under `Unreleased` as they land, and moved under the version when it is released. The Chinese version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); the two say the same.

## Unreleased

- The Accessibility pane in Elements shows the accessibility tree, and `Accessibility.getPartialAXTree`, `getFullAXTree`, `queryAXTree`, `getRootAXNode`, `getChildAXNodes` and `getAXNodeAndAncestors` answer as in Chrome, for tools and agents reading the page's structure. The tree is computed in the page by `accessibility.js`, loaded next to the bundle on first use; it includes dom-accessibility-api (MIT).
- The Animations panel lists the page's CSS animations, transitions and Web Animations, and pauses, seeks, retimes and changes their speed.
- Emulated media features (`prefers-color-scheme`, reduced motion, contrast, forced colors, …) and media type, safe area insets and vision deficiencies in the Rendering panel and device mode take effect, by rewriting the page's style sheets and with Chrome's SVG filters.
- Styles shows the browser's "user agent stylesheet" rules, from a copy of Chromium's `html.css` shipped as `chromium-html.css`; the Computed pane refreshes by itself.
- Network: blocked URLs, extra headers, disabling the cache, offline and the user agent override apply to the page's `fetch()` and XHR; the Reporting API's reports the page sees are listed.
- The Application panel's IndexedDB and Cache Storage views refresh on the page's writes, and the Service workers view lists the page's registrations, which it can update and unregister; commands that need the worker itself fail with "Not supported in the page".
- The Layout pane's grid, flex, container query and scroll-snap overlays, isolation mode, device mode's hinge and display cutout, and frame highlights are drawn in the page.
- The Issues panel shows CSP violations, deprecations, quirks mode and form issues; the Console shows `[Violation]` messages for slow handlers and forced reflows.
- `DOM.scrollIntoViewIfNeeded` in a linked cross-origin iframe scrolls the pages holding it too, as in Chrome.

### API changes

Public API, as in `packages/*/etc/*.public.api.md`: unchanged since 0.3.0.

- `devtools-anywhere` ships two more files in `dist/`, loaded on first use: `accessibility.js` (exported as `./accessibility.js`) and `chromium-html.css`; self-hosted, serve them with the bundle. It depends on `dom-accessibility-api` now.
- The probe grows from 18948 to 19385 bytes minified.
- The messages between the probe in a cross-origin iframe and its parent gained the internal event `DevtoolsAnywhere.scrollParent`: use the same version of the probe on both sides.

## 0.3.0

Based on Chrome 156 (156.0.8078.80).

- Same-origin iframes, as in Chrome: Elements expands them; each has its frame in the Page tree and its execution context in the Console's context menu, with its console messages and errors; Styles shows its own sheets and media; Network tags its requests with its frame; highlighting, inspect mode and Input reach into it. Iframes in shadow trees and same-origin `<object>` and `<embed>` documents are frames too; `Page.getResourceTree` lists each frame's own resources. Logs and requests an iframe makes before its load event are missing (except for srcdoc and blank iframes), and its navigations are reported once loaded.
- Cross-origin iframes whose page loads the probe too, when each side trusts the other (`data-frame-origins` in the parent, `data-parent-origins` in the iframe; the Vite options `frameOrigins` and `parentOrigins`): they are child targets, as Chrome's out-of-process iframes, through `Target.setAutoAttach` and messages routed by `sessionId`, in every setup (embedded, shell mode, remote). Elements shows their document under the `<iframe>` (`DOM.getFrameOwner`), the Console their contexts; input over them reaches them, and wheels chain back to the parent. Each client attaching them gets a session of its own, as in Chrome (the page's DevTools and a remote agent at once). Their targets survive navigations, and iframes in them link level by level.
- Sandboxed iframes without `allow-same-origin` (with a `src` of the page's origin, `about:blank` or `srcdoc`) whose document loads the probe, when the parent lists `sandboxed` in `data-frame-origins` and the document the parent's origin in `data-parent-origins`: they are merged into the parent's target, as Chrome keeps them there, with no child target. Elements shows their document under the `<iframe>`, the Console their context and messages, Network their requests, Sources their scripts, Styles their sheets; highlighting, inspect mode and Input reach into them. Off by default; those with a `src` of another origin, same-site too, are still refused. The remaining gaps are in the usage guide's limitations.
- `DOM.getNodeForLocation` takes document coordinates, not viewport ones, and `DOM.scrollIntoViewIfNeeded` centers an element that is out of view, as in Chrome. Hovering with `Input.dispatchMouseEvent` sends `pointerout`, `pointerover`, `mouseout`, `mouseover` in Chrome's order.
- `Page.navigatedWithinDocument` for `history.pushState`, `replaceState`, fragment changes and navigations the Navigation API intercepts, in the top page and in frames.
- Requests the page made before the probe ran are reported from Resource Timing (without stack, headers or body), as Chrome reports them too.
- `DOM.requestChildNodes` no longer sends children the client already has, as in Chrome: the frontend asking twice emptied an expanded iframe.
- In shell mode, a reloaded frontend starts a new session, as in Chrome.
- In shell mode, `Emulation.setDeviceMetricsOverride` and `clearDeviceMetricsOverride` work from any client of the page (a remote agent, a `createCdpSession`), not only the shell's frontend: the last override set applies, and a client's clear or end only lifts its own; a remote client's override survives page reloads, re-applied in the order the clients attached, as in Chrome. Their parameters are checked with Chrome's errors; outside shell mode the two commands fail, saying so.
- Commands the page cannot carry out (auto dark mode, turning focus emulation on, the pinch zoom, background services, bypassing the Service Worker, autofill addresses, the security isolation status, browser feature flags, network throttling, enabling domains whose events only the browser has such as the profilers, …) fail with "Not supported in the page: <why>" instead of succeeding without effect or answering with made-up data; `CSS.getEnvironmentVariables` returns the env() values the page resolves; those that could be done in the page still succeed, and are listed in the roadmap.
- An embedded frontend that reloads is told by its command ids starting again, not by its frame's load event, which comes after its first commands: what it enabled at once is no longer ended by the load.
- `CSS.createStyleSheet` fails with "Frame not found" for an unknown `frameId`, as in Chrome.
- Merged sandboxed iframes, as in Chrome: each new document gets new ids, and a reloaded one's execution contexts are destroyed and not reused, while a document linking again keeps its own; DOM undo and redo cover the page and its merged frames in one history, in the order of the edits, CSS edits in the frames included; a frame not answering within 1 s for its document, a node or a point is taken as not answering; `Page.navigate` takes a sandboxed iframe's `frameId`, merged or not; after `Page.disable`, the frames' queued events are no longer sent.

### API changes

Public API, as in `packages/*/etc/*.public.api.md`: additions only, nothing removed, renamed or changed.

- Probe script attributes (`devtools-anywhere`): `data-frame-origins` (origins of cross-origin iframes this page's DevTools debugs, space-separated; `sandboxed` for its sandboxed iframes) and `data-parent-origins` (origins of the pages that may debug this one in their iframe).
- Vite plugin options (`@devtools-anywhere/vite-plugin`): `frameOrigins` and `parentOrigins` (arrays), written into those two attributes.
- CDP: commands the page cannot carry out now fail with -32000 "Not supported in the page: <reason>" instead of succeeding without effect (listed above); `CSS.createStyleSheet` with an unknown `frameId` fails. Other changes to CDP answers and events are behavior fixes towards Chrome, listed above.
- The messages between the probe, the shell and the remote server gained the internal methods `DevtoolsAnywhere.attach` and `DevtoolsAnywhere.metrics`: use the probe and `@devtools-anywhere/remote-server` of the same version.

## 0.2.0

Based on Chrome 156 (156.0.8078.80).

- From jsDelivr or unpkg, the probe needs no other attribute: it loads the frontend of its own version from there, and shell mode works (without the Service Worker). Shell configs from such a CDN are trusted only in the probe's package and the frontend's at that version, no longer anywhere on the CDN. `data-no-panel` goes without the panel: a page from such a CDN only debugged remotely (`data-remote`) needs it, or it now gets a panel too.
- The docked panel is resized with a grip on the middle of its inner edge, on the page's side, in place of the bar across its whole edge: it covers neither DevTools nor more of the page than it shows, and looks the same in and out of shell mode. The undocked window keeps its bar, which moves it.
- Device mode in shell mode, as in Chrome: DevTools lays out the page and itself, the toolbar's device button sizes the page as a device (scaled to fit) and its menu takes screenshots, docked or undocked. It sets the page's size only, not its pixel ratio, user agent or touch input. A grip against the middle of DevTools' edge, on the page's side, resizes them without covering DevTools, larger on touch screens. Outside shell mode the button is still the screencast's.
- `console.table` of objects shows their fields as columns, as in Chrome, instead of a single "Value" column; columns given as an array filter them.
- `Page.captureScreenshot` and `Page.getLayoutMetrics`: screenshots of the viewport, a region or the whole page, rendered by snapDOM and marked `approximate: true`, for tools and agents that drive the page over CDP.

## 0.1.0

Based on Chrome 156 (156.0.8078.80).

First release.
