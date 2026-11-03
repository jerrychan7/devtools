# Changelog

All packages share one version and are released together (see DEV.md, "Releasing to npm"). Each release says first which Chrome its DevTools frontend comes from; the versioning rules are in DEV.md too. Changes are listed under `Unreleased` as they land, and moved under the version when it is released. The Chinese version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); the two say the same.

## Unreleased

- Same-origin iframes, as in Chrome: Elements expands them; each has its frame in the Page tree and its execution context in the Console's context menu, with its console messages and errors; Styles shows its own sheets and media; Network tags its requests with its frame; highlighting, inspect mode and Input reach into it. Iframes in shadow trees and same-origin `<object>` and `<embed>` documents are frames too; `Page.getResourceTree` lists each frame's own resources. Logs and requests an iframe makes before its load event are missing (except for srcdoc and blank iframes), and its navigations are reported once loaded.
- Cross-origin iframes whose page loads the probe too, when each side trusts the other (`data-frame-origins` in the parent, `data-parent-origins` in the iframe; the Vite options `frameOrigins` and `parentOrigins`): they are child targets, as Chrome's out-of-process iframes, through `Target.setAutoAttach` and messages routed by `sessionId`, in every setup (embedded, shell mode, remote). Elements shows their document under the `<iframe>` (`DOM.getFrameOwner`), the Console their contexts; input over them reaches them, and wheels chain back to the parent. Each client attaching them gets a session of its own, as in Chrome (the page's DevTools and a remote agent at once). Their targets survive navigations, and iframes in them link level by level.
- `DOM.getNodeForLocation` takes document coordinates, not viewport ones, and `DOM.scrollIntoViewIfNeeded` centers an element that is out of view, as in Chrome. Hovering with `Input.dispatchMouseEvent` sends `pointerout`, `pointerover`, `mouseout`, `mouseover` in Chrome's order.
- `Page.navigatedWithinDocument` for `history.pushState`, `replaceState`, fragment changes and navigations the Navigation API intercepts, in the top page and in frames.
- Requests the page made before the probe ran are reported from Resource Timing (without stack, headers or body), as Chrome reports them too.
- `DOM.requestChildNodes` no longer sends children the client already has, as in Chrome: the frontend asking twice emptied an expanded iframe.
- In shell mode, a reloaded frontend starts a new session, as in Chrome.
- In shell mode, `Emulation.setDeviceMetricsOverride` and `clearDeviceMetricsOverride` work from any client of the page (a remote agent, a `createCdpSession`), not only the shell's frontend: the last override set applies, and a client's clear or end only lifts its own, as in Chrome.
- An embedded frontend that reloads is told by its command ids starting again, not by its frame's load event, which comes after its first commands: what it enabled at once is no longer ended by the load.
- `CSS.createStyleSheet` fails with "Frame not found" for an unknown `frameId`, as in Chrome.

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
