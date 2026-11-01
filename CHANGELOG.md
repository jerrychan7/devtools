# Changelog

All packages share one version and are released together (see DEV.md, "Releasing to npm"). Each release says first which Chrome its DevTools frontend comes from; the versioning rules are in DEV.md too. Changes are listed under `Unreleased` as they land, and moved under the version when it is released. The Chinese version is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); the two say the same.

## Unreleased

- `Page.captureScreenshot` and `Page.getLayoutMetrics`: screenshots of the viewport, a region or the whole page, rendered by snapDOM and marked `approximate: true`, for tools and agents that drive the page over CDP.

## 0.1.0

Based on Chrome 156 (156.0.8078.80).

First release.
