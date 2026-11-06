# Roadmap

English | [简体中文](roadmap.zh-CN.md)

What has been discussed and is not done yet, and why. Directions and known trade-offs only, no dates. Items move to the CHANGELOG when done.

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

All with standard page APIs, matching Chrome.

| Item | Now | How, in the page |
|---|---|---|
| Shell mode: blocked URLs, extra headers and offline for images and scripts | Blocked URLs, extra headers, cache disabled and offline apply to the fetch and XHR the probe intercepts only; the document's own request and other subresources are not affected | In shell mode with the Service Worker, apply them to the same-origin requests it handles (images, scripts, style sheets, …) |
| Remaining gaps of the persistent overlays | Grid, flex, container query, scroll-snap and isolation overlays are drawn approximately: no grid line labels or area names, no offsets of aligned grids, no right-to-left layouts; flex shows no distribution of free space or gaps; container queries do not mark the queried descendants; no persistent overlay in merged sandboxed iframes | Drawn on the same layer from the computed styles and boxes |
| Accessibility events | `Accessibility.loadComplete` and `nodesUpdated` are not sent: the tree is computed per command, so the pane does not refresh by itself | A `MutationObserver` on the documents, sending the nodes whose properties changed |
| `::backdrop` pseudo-elements | The DOM shows no `::backdrop` node under a modal dialog, an open popover or a fullscreen element, and an animation of one names its host element; Chrome shows the pseudo-element (`DOM.pseudoElementAdded`, in the host's `pseudoElements`) and names it | Add `backdrop` to the pseudo-element nodes, present while the host is in the top layer (`:modal`, `:popover-open`, `:fullscreen`). Hard parts: the type list is shared with CSS (matched styles, cascade, computed updates, user agent rules), whose output then changes and needs its own comparison with Chrome; `showPopover()` and fullscreen change no attribute, so the `toggle` and `fullscreenchange` events must be watched |
| Default styles of Firefox and Safari | Only Chromium's `html.css` ships: in Firefox or Safari, the user agent stylesheet rules in Styles are Chrome's, not the ones in effect | Load the sheet of the page's engine, with the same matching: Firefox's are in `layout/style/res/` (`html.css`, `forms.css`, `ua.css`, …, MPL-2.0), Safari's is WebKit's `html.css` (LGPL, the same origin as Chromium's). Hard parts: the many `-moz-` internals are dropped by the page's parser, so measure first how many rules are left; with no CDP to compare rule by rule, only each browser's own DevTools by hand or `getComputedStyle` can check them; one version is pinned as an approximation |
| Cross-origin `<embed>` documents as child targets (not done) | A cross-origin `<embed>` is not found: it has no `contentWindow`, and the window among the page's child windows whose `frameElement` it is cannot be read across origins. So its document is not linked (its hello is refused, it is not pinged), and DOM does not show it as a cross-origin frame; Chrome gives it a child target as for an iframe | Tell its window apart by elimination: of the page's child windows, the ones no other owner holds (`contentWindow` of iframes, frames and objects, same-origin embeds) match the remaining embeds in document order. Not done: the page's child windows come in the order the frames were inserted, not in document order, so the match is not reliable |
| Isolated worlds: what is left | Simulated in the page's world ([limitations](limitations.md#isolated-worlds)): `var` and function declarations of `Runtime.evaluate` in a world do not stay; a merged sandboxed iframe's frame is refused by `Page.createIsolatedWorld` | Declarations: rewrite them into properties of the world's global, as console input's are made bindings (`domains/runtime/repl.ts`). Merged frames: route `Page.createIsolatedWorld` by `frameId` to the iframe's agent (core/frames/merged-frames.ts). Out of reach: the world reading the page's globals and changes to built-ins, which only a realm of its own would avoid |

Of little value: the performance monitor (`Performance.getMetrics`: only the DOM node count and Chrome's `performance.memory`); event listeners' source locations (a stack captured on each add, which slows pages down). Not to do: low contrast in the Issues panel, as Chrome itself no longer has `Audits.checkContrast` or the low text contrast issue.

## Commands without effect

Settled: a command the page cannot carry out fails with a server error (-32000), "Not supported in the page: <why>" (`cdp-agent/domains/stubs.ts`): Autofill's addresses, background service recording, the service worker commands that need the worker itself (inspecting, starting and stopping workers, `skipWaiting`, delivering push messages and sync events) and forcing updates on page load (turning it off succeeds), auto dark mode, turning focus emulation on (turning it off succeeds), resetting the pinch zoom, bypassing the service worker, interest group and shared storage tracking, remote target locations, the security isolation status (COOP, COEP and CSP are response headers), the browser's feature flags, network throttling (any latency, throughput or packet loss; without them, and offline, it succeeds), and enabling the domains whose events only the browser has: `Autofill`, `Database` (WebSQL), `HeapProfiler`, `Preload`, `Profiler`. The frontend does not log server errors, and its models start the same when these replies fail; the Frames view leaves out the isolation section and the bounce tracking view shows as disabled, as with the made-up answers before. Read commands fail too rather than answer with made-up data, while `CSS.getEnvironmentVariables` reads the env() values the page resolves. A command the page can only partly carry out is judged by its core effect: without it, the command cannot be carried out (focus emulation cannot keep `:focus` styles); with it, it is not done yet (a user agent override cannot change the document's own request, but scripts and later requests see it). A command that can be done in the page but is not yet still succeeds and is listed in the table above, as does enabling a domain whose events the page can give later (`Accessibility`, `Log`); `Animation`, `Audits` and `ServiceWorker` are implemented; `Inspector.enable` succeeds, as it is about the connection itself.

## Patches from an older release line

The two gaps noted in DEV.md, "Patching an older release": CI does not run on `release/**` branches, and a release always moves npm's `latest` and `chrome-<milestone>` and GitHub's Latest release. The plan is for `scripts/release.ts` to decide which tags to move, by semver. To do when an older release first needs a patch.

## Shelved

- **Dragging the divider in shell mode**: Chrome keeps mouse events in the frame where the button was pressed, so a fast drag loses the divider. It does not reproduce headless, and the earlier attempts were reverted.
- **Touch screens**: many small things to improve; low priority.
- **Sandboxed iframes whose `src` is of another origin** (same-site or cross-site): refused, shown as elements only. Chrome keeps same-site ones in the page's target and makes cross-site ones child targets. Left as is: a sandboxed document's origin is `null`, so trusting one means trusting its `src`, which its navigations make unverifiable; the cases are rare and the gain does not cover the added trust.
- **Merged sandboxed iframes: the initial about:blank's context and the `loaderId` of their navigations**: the context is missing (Chrome reports it only to a client attached before the iframe navigates, which ours seldom is); `frameNavigated` keeps the old `loaderId`, as the page cannot tell an iframe that loaded before it looked from one that has not loaded yet, and a new one would break the document request's `loaderId`.
