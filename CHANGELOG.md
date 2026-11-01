# Changelog

All packages share one version and are released together (see DEV.md, "Releasing to npm"). Each release says first which Chrome its DevTools frontend comes from; the versioning rules are in DEV.md too. Changes are listed under `Unreleased` as they land, and moved under the version when it is released. The Chinese version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); the two say the same.

## Unreleased

- Device mode in shell mode, as in Chrome: DevTools lays out the page and itself, the toolbar's device button sizes the page as a device (scaled to fit) and its menu takes screenshots, docked or undocked. It sets the page's size only, not its pixel ratio, user agent or touch input. On touch screens a handle on the edge between the page and DevTools resizes them. Outside shell mode the button is still the screencast's.
- `Page.captureScreenshot` and `Page.getLayoutMetrics`: screenshots of the viewport, a region or the whole page, rendered by snapDOM and marked `approximate: true`, for tools and agents that drive the page over CDP.

## 0.1.0

Based on Chrome 156 (156.0.8078.80).

First release.
