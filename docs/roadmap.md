# Roadmap

English | [简体中文](roadmap.zh-CN.md)

What has been discussed and is not done yet, and why. Directions and known trade-offs only, no dates. Items move to the CHANGELOG when done.

## The accessibility tree (the `Accessibility` domain)

**Now**: missing. There is only `Accessibility.enable`, a no-op (`cdp-agent/domains/stubs.ts`), so that the frontend starts without errors.

**What it means**:

- The Elements panel's Accessibility pane (the tree, the computed role and name and where the name comes from) is empty.
- Most tools that read a page over CDP get its structure from `Accessibility.getFullAXTree` / `queryAXTree`, which they do not get here. They can still compute it in the page with `Runtime.evaluate`, so for agents it is not a hard blocker.

**How**: compute CDP's `AXNode`s in the page from the DOM, ARIA attributes and implicit roles, and test them node by node against real Chrome's `getFullAXTree`, as the conformance tests do.

- References: Blink's `third_party/blink/renderer/modules/accessibility/` (BSD), and the specifications HTML-AAM (implicit roles) and accname 1.2 (names). Blink's code depends on the layout tree: its rules can be rewritten in JS, not ported line by line.
- A library to start from: [`dom-accessibility-api`](https://github.com/eps1lon/dom-accessibility-api) (MIT, no dependencies, about 15 KB minified, runs in browsers) implements accname, `getRole` and `isInaccessible`. It can do names and descriptions, the hardest part to match.
- Still to write:
  - the context rules of role mapping: for example `header` / `footer` in a `section` are generic, a `section` without a name is not a region, row and column headers for `th`, and elements without a mapping are generic;
  - the tree: ignored nodes, `aria-owns`, text nodes as StaticText;
  - node properties: focusable, checked, expanded, level, value, …;
  - where a name comes from (`sources`), which the Accessibility pane shows.

**In steps**: first `getPartialAXTree`, which the Elements pane uses, then `getFullAXTree` / `queryAXTree`.

**Size**: not in the probe. Loaded next to the bundle when first used, like snapDOM.

## Real CDP on Android, through ADB wireless debugging

**Why**: some things a page's own CDP cannot do: screenshots (now redrawn from the DOM by snapDOM, marked `approximate`), real network timing, the Performance panel, breakpoints. Chrome on Android has all of CDP, and with Android's Wireless debugging (Android 11 and later) a computer reaches it without a cable.

**The idea**: the remote server connects to that Chrome's real CDP through `adb` (pairing, connecting, `adb forward tcp:<port> localabstract:chrome_devtools_remote`). The probe in the page still provides what real CDP does not have, such as the earliest logs; the frontend gets both, or switches to real CDP where it can.

**Open questions**:

- how the two sources of CDP are combined: by method, all or nothing, or two connections in the frontend;
- where pairing (pairing code, mDNS discovery) happens: the CLI or a UI;
- what to do without `adb` on the computer: ship one, or implement the ADB protocol in JS;
- how to test it: CI has no phone; whether an emulator will do.

**Status**: a direction only; no design discussed yet.

## More that can be filled in the page

All with standard page APIs, matching Chrome. By value for effort; the first three are small.

| Item | Now | How, in the page |
|---|---|---|
| Sandboxed iframes with a cross-site `src` | Refused: shown as elements only | Out-of-process iframes in Chrome, so child targets: trusted by the `null` origin plus the origin the iframe's `src` would have had (its precursor), as Chrome tells them apart |
| Sandboxed iframes with a same-site, cross-origin `src` | Refused like cross-site ones: shown as elements only, not in the frame tree | Chrome keeps them in the page's target: merged as those of the page's origin are, taking a `src` of the page's site as an opaque frame of the page |
| Debugger breakpoints (`setBreakpointByUrl` and the like) | No-ops: no `locations` returned | Chrome resolves them to locations; the page can match the URL and position against the scripts it has seen and return them |
| Merged sandboxed iframes: the initial about:blank's context, the `loaderId` of their navigations, their URL after `pushState` | The context is missing; `frameNavigated` keeps the old `loaderId`; the URL waits for the next `getFrameTree` | The page sees the iframe's initial about:blank and can announce its context; the iframe's agent can give each new document's loader id and tell the page of `pushState` as it does Page.navigatedWithinDocument |
| The Animations panel (`Animation` domain) | `enable` is a no-op | `document.getAnimations()` has CSS animations, transitions and Web Animations; listing, pausing, playback rate and seeking map onto it |
| Vision deficiencies (`setEmulatedVisionDeficiency`) | No-op | An SVG filter on `<html>`; Chrome uses color matrices too |
| Network: blocked URLs, cache disabled, extra headers, offline | `setBlockedURLs`, `setCacheDisabled`, `setExtraHTTPHeaders`, `overrideNetworkState` and offline in `emulateNetworkConditions` are no-ops | For the fetch and XHR already intercepted; in shell mode, images and scripts too through the Service Worker. Throttling fails: the page cannot slow requests down |
| The browser's default styles | Not in Styles | A copy of Chromium's `html.css` (open source), loaded when used, matched to give the "user agent stylesheet" rules; to be kept in step with each Chrome |
| Grid, flex, container query and scroll-snap overlays | `Overlay.setShow*Overlays` are no-ops | Drawn in the page: `getComputedStyle` gives a grid's resolved tracks; the same layer as `highlightNode` |
| Emulated `prefers-color-scheme`, print and other media | `setEmulatedMedia` is a no-op | `@media` conditions rewritten through the CSSOM; the limits of forced `:hover`: not `@import`, cross-origin sheets or `matchMedia` |
| Application panel updates (`Storage.track*`, `setStorageBucketTracking`) | No-ops: refreshed by hand | IDB writes and `caches.put` wrapped to send `indexedDBContentUpdated`, … |
| The Service Workers view | `ServiceWorker.enable` is a no-op | `navigator.serviceWorker.getRegistrations()`: listing, unregistering, updating; no debugging |
| The Issues panel (`Audits` domain) | `enable` is a no-op | The issues the page can see, as Chrome words them: CSP violations (`securitypolicyviolation`), deprecations and interventions (`ReportingObserver`), quirks mode, form issues (labels, duplicate ids, `autocomplete`) from the DOM, low contrast. Not cookies, CORS or mixed content, which only the browser sees |
| Violations and long tasks (`Log.startViolationsReport`) | No-op | `PerformanceObserver` on `longtask` and `long-animation-frame`, reported in the Console |
| User agent override (`Emulation` / `Network.setUserAgentOverride`) | No-op | `navigator.userAgent`, `platform` and `userAgentData` redefined, and the header set on the intercepted fetch and XHR; not on the document's own request or other subresources |
| Computed style updates (`CSS.trackComputedStyleUpdatesForNode`) | No-op | A `MutationObserver` and `getComputedStyle` on the tracked nodes, sending `computedStyleUpdated` |
| Frame, isolated element, hinge and cutout overlays | `Overlay.highlightFrame`, `setShowIsolatedElements`, `setShowHinge`, `setShowDisplayCutout` are no-ops | Drawn on the same layer as `highlightNode` |
| Emulated safe area insets | `Emulation.setSafeAreaInsetsOverride` is a no-op | `env(safe-area-inset-*)` replaced with the given values through the CSSOM; the limits of emulated media: not `@import` or cross-origin sheets |
| Reporting API and request initiators | `Network.enableReportingApi`, `setAttachDebugStack` are no-ops | A `ReportingObserver` for the reports the page sees; a stack captured in the intercepted fetch and XHR |
| Cross-origin `<embed>` documents as child targets | A cross-origin `<embed>` is not found: it has no `contentWindow`, and the window among the page's child windows whose `frameElement` it is cannot be read across origins. So its document is not linked (its hello is refused, it is not pinged), and DOM does not show it as a cross-origin frame; Chrome gives it a child target as for an iframe | Tell its window apart by elimination: of the page's child windows, the ones no other owner holds (`contentWindow` of iframes, frames and objects, same-origin embeds) match the remaining embeds in document order |
| `DOM.scrollIntoViewIfNeeded` in a cross-origin iframe | Scrolls only within the iframe's own document: the iframe itself is not scrolled into view in the page holding it. Chrome passes the area on to the parent frame, so the node ends up visible in the top viewport | The child target sends the area, mapped to its viewport, to the parent through the frame link; the parent maps it through the iframe and goes on scrolling from there |

Of little value: the performance monitor (`Performance.getMetrics`: only the DOM node count and Chrome's `performance.memory`); event listeners' source locations (a stack captured on each add, which slows pages down).

## Commands without effect

Settled: a command the page cannot carry out fails with a server error (-32000), "Not supported in the page: <why>" (`cdp-agent/domains/stubs.ts`): Autofill's addresses, background service recording, auto dark mode, turning focus emulation on (turning it off succeeds), resetting the pinch zoom, bypassing the service worker, interest group and shared storage tracking, remote target locations, the security isolation status (COOP, COEP and CSP are response headers), the browser's feature flags, network throttling (any latency, throughput or packet loss; without them, and offline, it succeeds), and enabling the domains whose events only the browser has: `Autofill`, `Database` (WebSQL), `HeapProfiler`, `Preload`, `Profiler`. The frontend does not log server errors, and its models start the same when these replies fail; the Frames view leaves out the isolation section and the bounce tracking view shows as disabled, as with the made-up answers before. Read commands fail too rather than answer with made-up data, while `CSS.getEnvironmentVariables` reads the env() values the page resolves. A command the page can only partly carry out is judged by its core effect: without it, the command cannot be carried out (focus emulation cannot keep `:focus` styles); with it, it is not done yet (a user agent override cannot change the document's own request, but scripts and later requests see it). A command that can be done in the page but is not yet still succeeds and is listed in the table above, as does enabling a domain whose events the page can give later (`Accessibility`, `Animation`, `Audits`, `Log`, `ServiceWorker`); `Inspector.enable` succeeds, as it is about the connection itself.

## Patches from an older release line

The two gaps noted in DEV.md, "Patching an older release": CI does not run on `release/**` branches, and a release always moves npm's `latest` and `chrome-<milestone>` and GitHub's Latest release. The plan is for `scripts/release.ts` to decide which tags to move, by semver. To do when an older release first needs a patch.

## Shelved

- **Dragging the divider in shell mode**: Chrome keeps mouse events in the frame where the button was pressed, so a fast drag loses the divider. It does not reproduce headless, and the earlier attempts were reverted.
- **Touch screens**: many small things to improve; low priority.
