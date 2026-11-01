# Changelog

All packages share one version and are released together (see DEV.md, "Releasing to npm"). Each release says first which Chrome its DevTools frontend comes from; the versioning rules are in DEV.md too. Changes are listed under `Unreleased` as they land, and moved under the version when it is released. The Chinese version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); the two say the same.

## Unreleased

- From jsDelivr or unpkg, the probe needs no other attribute: it loads the frontend of its own version from there, and shell mode works (without the Service Worker). Shell configs from such a CDN are trusted only in the probe's package and the frontend's at that version, no longer anywhere on the CDN. `data-no-panel` goes without the panel: a page from such a CDN only debugged remotely (`data-remote`) needs it, or it now gets a panel too.
- The docked panel is resized with a grip on the middle of its inner edge, on the page's side, in place of the bar across its whole edge: it covers neither DevTools nor more of the page than it shows, and looks the same in and out of shell mode. The undocked window keeps its bar, which moves it.
- Device mode in shell mode, as in Chrome: DevTools lays out the page and itself, the toolbar's device button sizes the page as a device (scaled to fit) and its menu takes screenshots, docked or undocked. It sets the page's size only, not its pixel ratio, user agent or touch input. A grip against the middle of DevTools' edge, on the page's side, resizes them without covering DevTools, larger on touch screens. Outside shell mode the button is still the screencast's.
- `Page.captureScreenshot` and `Page.getLayoutMetrics`: screenshots of the viewport, a region or the whole page, rendered by snapDOM and marked `approximate: true`, for tools and agents that drive the page over CDP.

## 0.1.0

Based on Chrome 156 (156.0.8078.80).

First release.
