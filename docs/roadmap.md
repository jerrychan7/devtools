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

## iframes

**Now**: the agent assumes one document per page. There is a single `FRAME_ID` and `EXECUTION_CONTEXT_ID` (`core/context.ts`) in every event; nodes have no `contentDocument`, so an iframe cannot be expanded in Elements; console, network capture and errors are hooked in the top `window` only.

**Chrome's model**: a same-origin iframe is in the same target as its page, as more frames and execution contexts; only a cross-origin one (an out-of-process iframe) is a child target, through `Target.setAutoAttach`.

**Same-origin iframes (first)**:

| Domain | To do |
|---|---|
| DOM | iframe nodes with `contentDocument` and `frameId`; a MutationObserver per document; an iframe's navigation invalidates its old document and pushes the new one |
| Page | A frame registry; `childFrames` in `frameTree`; `frameAttached`, `frameNavigated`, `frameDetached` |
| Runtime | An execution context per window; `evaluate` and `callFunctionOn` run in the window of their `contextId`; console and exceptions captured in each window |
| CSS | `frameId` on style sheets; `getComputedStyle` of the node's window; the sheet registry and forced pseudo-classes per document |
| Network | `frameId` on requests; fetch, XHR, … wrapped in each window |
| Overlay, Input, geometry | Coordinates offset by the iframe and its scrolling |

- **Realms**: an iframe's elements are not instances of the top page's `Element`. About 166 `instanceof` checks and about 180 uses of the global `document`, `window`, `getComputedStyle`, … in the agent have to use the node's own realm (`node.ownerDocument.defaultView`) or `nodeType` instead.
- **Not possible**: an iframe's earliest logs. The probe cannot run before the iframe's own scripts, only once it has loaded; usage.md has to say so.
- **Size**: large; domain by domain, each with tests against Chrome, about the main work of a minor.

**Cross-origin iframes (later)**: their document is out of reach; the iframe has to load the probe too and be attached as a child target over postMessage (`Target.setAutoAttach`, `attachedToTarget`, messages routed by `sessionId`). The frontend handles child targets already; shell mode's relay works similarly.

**Step 0, the earlier the better**: every new feature adds `instanceof` checks and uses of the global `document`. A step that changes no behavior stops that:

1. A frame registry in the Context: `FRAME_ID` and `EXECUTION_CONTEXT_ID` looked up by document or window instead of constants, with only the top document registered for now;
2. A helper such as `realmOf(node)`, and a lint rule against `instanceof Element` and the global `document` in `cdp-agent`, the existing code exempted and migrated over time.

## More that can be filled in the page

All with standard page APIs, matching Chrome. By value for effort; the first three are small.

| Item | Now | How, in the page |
|---|---|---|
| The Animations panel (`Animation` domain) | `enable` is a no-op | `document.getAnimations()` has CSS animations, transitions and Web Animations; listing, pausing, playback rate and seeking map onto it |
| Vision deficiencies (`setEmulatedVisionDeficiency`) | No-op | An SVG filter on `<html>`; Chrome uses color matrices too |
| Network: blocked URLs, cache disabled, extra headers, offline | `setBlockedURLs`, `setCacheDisabled`, `setExtraHTTPHeaders`, `emulateNetworkConditions` are no-ops | For the fetch and XHR already intercepted; in shell mode, images and scripts too through the Service Worker. Throttling could only be approximate: not done |
| The browser's default styles | Not in Styles | A copy of Chromium's `html.css` (open source), loaded when used, matched to give the "user agent stylesheet" rules; to be kept in step with each Chrome |
| Grid, flex, container query and scroll-snap overlays | `Overlay.setShow*Overlays` are no-ops | Drawn in the page: `getComputedStyle` gives a grid's resolved tracks; the same layer as `highlightNode` |
| Emulated `prefers-color-scheme`, print and other media | `setEmulatedMedia` is a no-op | `@media` conditions rewritten through the CSSOM; the limits of forced `:hover`: not `@import`, cross-origin sheets or `matchMedia` |
| Application panel updates (`Storage.track*`) | No-ops: refreshed by hand | IDB writes and `caches.put` wrapped to send `indexedDBContentUpdated`, … |
| The Service Workers view | `ServiceWorker.enable` is a no-op | `navigator.serviceWorker.getRegistrations()`: listing, unregistering, updating; no debugging |
| Violations and long tasks (`Log.startViolationsReport`) | No-op | `PerformanceObserver` on `longtask` and `long-animation-frame`, reported in the Console |

Of little value: the performance monitor (`Performance.getMetrics`: only the DOM node count and Chrome's `performance.memory`); event listeners' source locations (a stack captured on each add, which slows pages down).

## Gaps in Emulation

- `Emulation.setDeviceMetricsOverride` is not implemented: device mode in shell mode is laid out by the frontend, not through CDP, so tools that resize the viewport over CDP cannot. In shell mode it could reuse device mode's sizing of the page iframe.
- `setEmulatedMedia`, `setUserAgentOverride` and others are no-ops that succeed. That is fine for the DevTools frontend but misleading for scripts, which take them as done. Whether they should fail instead depends on whether the frontend relies on them succeeding.

## Patches from an older release line

The two gaps noted in DEV.md, "Patching an older release": CI does not run on `release/**` branches, and a release always moves npm's `latest` and `chrome-<milestone>` and GitHub's Latest release. The plan is for `scripts/release.ts` to decide which tags to move, by semver. To do when an older release first needs a patch.

## Shelved

- **Dragging the divider in shell mode**: Chrome keeps mouse events in the frame where the button was pressed, so a fast drag loses the divider. It does not reproduce headless, and the earlier attempts were reverted.
- **Touch screens**: many small things to improve; low priority.
