# Changelog

All packages share one version and are released together (see DEV.md, "Releasing to npm"). Each release says first which Chrome its DevTools frontend comes from; the versioning rules are in DEV.md too. Changes are listed under `Unreleased` as they land, and moved under the version when it is released. The Chinese version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); the two say the same.

## Unreleased

- Same-origin iframes, as in Chrome: Elements expands them; each has its frame in the Page tree and its execution context in the Console's context menu, with its console messages and errors; Styles shows its own sheets and media; Network tags its requests with its frame; highlighting, inspect mode and Input reach into it. Iframes in shadow trees and same-origin `<object>` and `<embed>` documents are frames too; `Page.getResourceTree` lists each frame's own resources. Logs and requests an iframe makes before its load event are missing (except for srcdoc and blank iframes), and its navigations are reported once loaded. Cross-origin iframes are still not inspectable.
- `DOM.getNodeForLocation` takes document coordinates, not viewport ones, and `DOM.scrollIntoViewIfNeeded` centers an element that is out of view, as in Chrome. Hovering with `Input.dispatchMouseEvent` sends `pointerout`, `pointerover`, `mouseout`, `mouseover` in Chrome's order.
- `Page.navigatedWithinDocument` for `history.pushState`, `replaceState`, fragment changes and navigations the Navigation API intercepts, in the top page and in frames.
- Requests the page made before the probe ran are reported from Resource Timing (without stack, headers or body), as Chrome reports them too.
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
