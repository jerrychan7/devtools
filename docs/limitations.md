# Limitations

English | [简体中文](limitations.zh-CN.md)

What devtools-anywhere cannot do, and where it deliberately differs from Chrome. Setting it up: [usage guide](usage.md). What can be done in the page but is not yet: [roadmap](roadmap.md).

Gaps are filled exactly or not at all: nothing approximate is shown as fact. Each entry says what Chrome does, what devtools-anywhere does, and why, when the reason is known. "Same as Chrome" notes what an entry keeps of Chrome's behavior.

<a id="overview"></a>

## Overview

Support, in the table below: "Supported" works as in Chrome; "Partly supported" works, with the differences in the linked section; "Not supported" cannot be done in the page.

| Feature | Support | Summary |
|---|---|---|
| Breakpoints, Profiler, Memory, Performance | Not supported: panels not included | [No JS API](#breakpoints-and-profiling); `debugger;` does not pause |
| Network timing | Not supported | [No JS API](#network-timing) |
| Sources | Partly supported | Documents, external scripts and style sheets, images, fonts and snippets, [but no inline scripts](#sources) |
| Browser default styles | Partly supported | "user agent stylesheet" rules in Styles come from [a copy of Chromium's `html.css`](#browser-default-styles) |
| Event listeners | Partly supported | [Only those added after the probe ran](#event-listeners), with no source location |
| WebSocket | Partly supported | Connections and frames, [without handshake headers](#websocket) |
| Same-origin iframes | Partly supported | Navigation is seen at the load event, [so logs and requests before it are missing](#same-origin-iframes) |
| Sandboxed iframes (no `allow-same-origin`) | Partly supported | [Merged](usage.md#sandboxed-iframes) into the page's target as in Chrome, [with some differences](#sandboxed-iframes), otherwise [elements only](#sandboxed-iframes-not-merged) |
| Cross-origin iframes | Partly supported | Debugged [only with the probe in the iframe's page](#cross-origin-iframes) and both [origin lists](usage.md#cross-origin-iframes), otherwise elements only |
| Isolated worlds | Partly supported | `Page.createIsolatedWorld` and `Runtime.addBinding`, as the Animations panel uses them, are [simulated in the page's own JavaScript world](#isolated-worlds) |
| Cross-origin style sheets | Partly supported | [They need CORS and are read-only](#cross-origin-style-sheets) |
| Style sheet text | Partly supported | The text as written, with Chrome's ranges, [serialized after CSSOM changes and shared by all clients](#style-sheet-text) |
| `@namespace` | Partly supported | Selectors are matched [by adopting a sheet of our own for a moment](#namespace) |
| Forced `:hover`, `:focus`, … | Partly supported | [Not in `@import` and `adoptedStyleSheets` sheets](#forced-pseudo-classes) |
| Animations panel | Partly supported | Listed, paused, seeked and retimed, [with the playback rate set on each animation, among other differences](#animations) |
| Screencast (device button outside shell mode) | Partly supported | [Redrawn by snapDOM from the DOM](#screencast), at ≤ 2 fps |
| Screenshots | Partly supported | `Page.captureScreenshot` is [rendered by snapDOM](#screenshots) and marked `approximate: true` |
| Device mode | Partly supported | [In shell mode only, and it sets the size only](#device-mode) |
| Fullscreen pages | Partly supported | [DevTools cannot be used while an element is fullscreen](#fullscreen-pages); Esc leaves fullscreen |
| Rendering panel emulation | Partly supported | ["Emulate a focused page", auto dark mode and resetting the pinch zoom cannot be done](#rendering-emulation) and fail |
| Emulated media | Partly supported | Media features and type [by rewriting the page's style sheets](#emulated-media) |
| Emulated safe area insets | Partly supported | `env(safe-area-inset-*)` [replaced in the page's style sheets](#safe-area-insets) |
| Vision deficiencies | Supported | SVG filters on `<html>`, as in Chrome: they replace a `filter` of the page's own on `<html>`, apply to an embedded panel too, and `getComputedStyle` sees them |
| Layout overlays | Partly supported | Grid, flex, container query, scroll-snap, isolation, hinge, display cutout and frame overlays, [drawn approximately](#layout-overlays) |
| Network conditions | Partly supported | [For the `fetch()` and XHR the probe hooks only](#network-conditions), with no throttling |
| Accessibility tree | Partly supported | The Accessibility pane and the `Accessibility` commands, [computed in the page](#accessibility) by `accessibility.js` |
| Application panel | Partly supported | IndexedDB, Cache Storage and service workers, [with gaps](#application-panel) |
| Issues panel | Partly supported | CSP violations, deprecations, quirks mode and form issues, [but no cookies, CORS or mixed content](#issues-panel) |
| Console violations | Partly supported | `[Violation]` messages [from `long-animation-frame` entries](#console-violations) |
| `DOM.scrollIntoViewIfNeeded` in a cross-origin iframe | Supported | It scrolls the parent pages on too, [asynchronously after the answer](#cross-origin-iframes) |
| Frontend on the page's origin | Partly supported | [DevTools' settings share the page's `localStorage`](#frontend-origin), so host it on another origin |
| Browsers | Partly supported | The page side runs in any modern browser; [the DevTools UI is verified in Chrome only](#browsers) |

<a id="panels-without-a-js-api"></a>

## Panels and data without a JavaScript API

<a id="breakpoints-and-profiling"></a>

### Breakpoints, Profiler, Memory, Performance

- **Chrome**: pauses on breakpoints and `debugger;`, profiles CPU and memory, records performance.
- **devtools-anywhere**: these panels are not included. `debugger;` does not pause; in shell mode it logs a warning with its stack. With [remote debugging](usage.md#remote-debugging), breakpoints still need the browser's own debugger (`chrome://inspect`, Safari Web Inspector): the page runs the same in-page agent.
- **Why**: no JS API.

<a id="network-timing"></a>

### Network timing

- **Chrome**: shows each request's timing.
- **devtools-anywhere**: none.
- **Why**: no JS API.

<a id="sources-and-event-listeners"></a>

## Sources and event listeners

<a id="sources"></a>

### Sources

- **Chrome**: lists every script, inline ones included.
- **devtools-anywhere**: documents, external scripts and style sheets, images, fonts; no inline scripts. Snippets work.

<a id="event-listeners"></a>

### Event listeners

- **Chrome**: lists every listener, with its source location.
- **devtools-anywhere**: only those added after the probe ran; no source location.
- **Why**: listeners are seen through hooks the probe installs. A source location would need a stack captured on each add, which slows pages down (see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)).

<a id="css"></a>

## CSS and style sheets

<a id="browser-default-styles"></a>

### Browser default styles

- **Chrome**: shows "user agent stylesheet" rules from all its default sheets.
- **devtools-anywhere**: "user agent stylesheet" rules in Styles come from a copy of Chromium's `html.css` (`chromium-html.css`, loaded next to the bundle on first use). Rules with Blink-internal selectors are left out, `@supports blink-feature()` takes the feature-off branch, and only `html.css` is used (not Chrome's other default sheets). With the bundle inlined (no URL), none are shown; a site that leaves `chromium-html.css` out shows none either (see [Packages](usage.md#packages)).
- **Chrome**: the Computed pane follows every style change.
- **devtools-anywhere**: the Computed pane refreshes on DOM mutations and DevTools' own edits, not on every style change; not for nodes in merged sandboxed iframes.

<a id="cross-origin-style-sheets"></a>

### Cross-origin style sheets

- **Chrome**: has the text of every sheet, and lets it be edited.
- **devtools-anywhere**: needs CORS; read-only. Without CORS, `CSS.getStyleSheetText` fails and no rules are shown.

<a id="style-sheet-text"></a>

### Style sheet text

The text a sheet was written in is served, with Chrome's ranges, and edits are made in it as written. Where that differs:

- **Position of a `<style>`**: its text starts at 0:0, not where it is in the HTML.
- **After CSSOM changes**: once the page changes a sheet through the CSSOM (not `replace()` or `replaceSync()`), its text is serialized from the CSSOM as Chrome serializes a sheet it first sees changed: each rule's text, `@import` ones included, followed by a line break. For a sheet whose text it knew, Chrome splices the rules' texts into it and lags behind. The text is serialized too when the rules found in the text cannot be paired with the CSSOM's, and for a constructed sheet made before DevTools opened.
- **Changes not seen**: changes made with `style.color = …` and the like, or to a media list's text, are not seen (no `CSS.styleSheetChanged`; Styles may show the text as it was).
- **Cost**: while CSS is enabled, an element's own `style.cssText = …` writes cost about 40% more, as they pass through a hook; assigning single properties (`el.style.left = …`) is not affected.
- **Editing an `@supports`, `@container` or `@scope` condition**: Chrome keeps the rule objects. Here the rule is replaced, as the CSSOM cannot change the condition: rule objects the page holds for it and the rules in it are detached.
- **Fetching again**: the file of a `<link>` or `@import` is fetched again (from the HTTP cache when it may).
- **Several clients**: when one client edits a sheet (`CSS.setStyleSheetText`, `CSS.setStyleTexts`, `CSS.addRule` and the like), Chrome tells the other clients nothing and they keep the old text. Here every client sees the latest text, with its ranges (one enabling CSS later too), and the other clients are sent `CSS.styleSheetChanged`. Undoing an edit after another client or the page changed the sheet serves the serialized text.
- **Namespace prefixes in edits**: `CSS.setRuleSelector` and `CSS.addRule` accept selectors with a namespace prefix declared by the sheet's `@namespace` (such as `h|p`). Chrome rejects them, because it checks the text in an empty sheet without the namespaces.

<a id="namespace"></a>

### `@namespace`

- **Chrome**: matches selectors of a sheet declaring namespaces natively.
- **devtools-anywhere**: selectors of a sheet declaring namespaces (prefixes, a default namespace, in `:host()`, `::slotted()` and `@scope` too) are matched by adopting a sheet of our own for a moment, which costs a walk of the document and the restyle of the elements the sheet's rules could match by their last compound (some 15 ms per request with 60,000 elements, 20,000 of them matching). In an `@scope` without a prelude they are matched as if no namespace were declared; in an `@scope` whose root has a namespace prefix, its proximity is not known and taken as the farthest.

<a id="forced-pseudo-classes"></a>

### Forced `:hover`, `:focus`, …

- **Chrome**: forces the state in every sheet.
- **devtools-anywhere**: not for `@import` and `adoptedStyleSheets` sheets.

<a id="animations"></a>

## Animations panel

CSS animations, transitions and Web Animations from `getAnimations()`, and those made with `animate()` or `new Animation()` (without a target, out of the document, over at once), are listed, paused, seeked and retimed. Where that differs from Chrome:

- **Playback rate**: Chrome sets it on the timeline. Here it is set on each animation, so the page reads it multiplied in `playbackRate` (a rate the page sets is kept, but one equal to the negated rate is taken for `reverse()`).
- **Animations started while the rate is changed**: they get another start time than in Chrome, which slows the document timeline instead.
- **Pending animations**: an animation that stays pending (its timeline inactive) keeps the panel's rate after `disable`.
- **Ended animations**: one that ended outside `getAnimations()` and is restarted other than by `play()` is not seen.
- **Documents**: only the page's documents and its same-origin frames.
- **Shadow trees**: animations in shadow trees are listed (declarative ones, hosts inserted later, and those in iframes too), but not those in closed declarative shadow roots (the page has no handle on them) or in user-agent shadow trees (such as `input::placeholder`'s).
- **`::backdrop`**: Chrome names the pseudo-element. Here a `::backdrop` animation names its `<dialog>`, which the Elements panel shows (no `::backdrop` node yet: see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)).
- **Groups (`cssId`)**: same as Chrome, `cssId` follows the rules that win the animation's properties, so the same declarations in two rules are two groups, and a `:hover` transition and the one back are too. Rules of `@import`ed sheets and those our CSS matching misses are not seen, and for a pseudo-element other than `::before`, `::after` and `::marker` it is approximated from the computed styles.
- **`seekAnimations`**: takes `currentTimes` in milliseconds, as the protocol says; Chrome 156 takes them as seconds.
- **Cancelled before start**: an animation cancelled or paused before it started is reported created and cancelled only. When a frame's animation update ran before the cancel (a frame, then a timer that cancels it), Chrome reports a start first, which is missing here.
- **Garbage-collected animations**: an animation the page dropped and that was garbage-collected can no longer be found by its id; Chrome keeps it until `disable`.
- **Documents still being parsed**: the animations and style sheets of their declarative shadow roots may come late; all are there once parsing ends.
- **Scroll-driven animations** (`scroll()`, `view()`, `ScrollTimeline`, `ViewTimeline`): same as Chrome, they report their `viewOrScrollTimeline` (the root scroller's as `document`), with Chrome's time unit of 16 µs per pixel. Seeking one that runs has no effect; a paused one is seeked to the converted time, clamped to its end. The playback rate does not apply to them (the panel disables its rate buttons while a scroll-driven group is selected). The scrubber follows the page's own scrolling, through an [isolated world](#isolated-worlds), and dragging it sets the scroll position.

<a id="isolated-worlds"></a>

## Isolated worlds

- **Chrome**: `Page.createIsolatedWorld` makes a world with a JavaScript realm of its own, sharing only the DOM with the page.
- **devtools-anywhere**: `Page.createIsolatedWorld` and `Runtime.addBinding` (`Runtime.bindingCalled`), as the Animations panel uses them, are simulated in the page's own JavaScript world.
- **Why**: only a realm of its own would avoid the differences in [what the world shares with the page](#isolated-worlds-shared-javascript) (see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)).

<a id="isolated-worlds-global"></a>

### The world's global

- A world's code runs with its own global: a view of the page's window (a `Window`, with `window`, `self`, `globalThis` and the top-level `this`) whose properties set there, bindings included, and names assigned without a declaration stay in the world.
- Same as Chrome, a name that exists nowhere throws a ReferenceError and is not `in window`, and `typeof` of it is 'undefined'. The world's code is rewritten for that: `typeof name`, also in parentheses, calls a lookup. So code `eval` runs within the world is not rewritten, and there `typeof` of such a name throws; a function the world defines shows the rewritten code in `toString()`; and columns in its stack traces are off.

<a id="isolated-worlds-nodes"></a>

### Nodes a function is called on

- **Chrome**: the world has its own wrapper of the node, and the world's properties and the page's are kept apart.
- **devtools-anywhere**: a node a function is called on (`DOM.resolveNode` in the world, then `Runtime.callFunctionOn`) is the page's node itself.
  - The properties the world keeps on it are put on the node for the call and taken back after its synchronous part, and again once the promise it returns settles (what it writes after an `await` is on the node until then).
  - After the synchronous part, every property added, changed or removed on the node is the world's however written (`Object.assign`, a computed key, `Object.defineProperty`), but for those a page listener wrote during an event the call dispatched (`dispatchEvent`, and `click`, `focus`, `blur` of HTML and SVG elements, watched meanwhile): they stay the page's, also under a name the world uses, whose world value is then the one it had before the event.
  - The watched methods are proxies during the call: their name, length and `toString()` are the native ones, and a replacement the page makes meanwhile stays, but the page reads another function than before (`===` fails).
  - Page code run otherwise during the call has its writes taken for the world's: an event dispatched by another method (`requestSubmit()`, `select()`, …), a custom element's callbacks, a getter or setter of the page's that the world uses.
  - After an `await`, only the names the world's code assigns or deletes (`.name =`, `['name'] =`, `delete x.name`) or gets as string arguments are taken back: others written then, such as through `Object.assign` or a computed key, stay on the page's node.
  - During the call the page sees the world's properties on the node, and the world the page's: a listener it runs reads the world's value, and after the event the world reads what the listener wrote under the same name, until the call ends. Chrome keeps the two apart.

<a id="isolated-worlds-shared-javascript"></a>

### What the world shares with the page

Otherwise the world shares the page's JavaScript:

- It reads the page's globals (a binding of the page's own context too) and changes to built-ins.
- `document.defaultView`, and `this` in a sloppy-mode function called plainly, are the page's window rather than the world's global.
- `new.target` at a world's top level is undefined; Chrome throws a SyntaxError.
- Other objects' properties it sets are the page's.
- `var` and function declarations of `Runtime.evaluate` do not stay (to be done: see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)).

<a id="isolated-worlds-csp-and-frames"></a>

### CSP and frames

- **CSP**: Chrome's worlds are not bound by the page's CSP. Here, on a page whose CSP forbids `eval`, worlds are made and announced, but code run in them fails with an EvalError, as in the page's own context.
- **Frames**: worlds of same-origin frames only. A merged sandboxed iframe's frame is refused ("No frame for given id found"); routing it is to be done (see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)).
- **Same as Chrome**: a world is the page's, with one id for every session, and comes again with a new id in each document its frame loads; a binding added by several sessions reports each call to each; its function stays after `Runtime.removeBinding`, its calls no longer reported.

<a id="iframes"></a>

## iframes

<a id="same-origin-iframes"></a>

### Same-origin iframes

- **Chrome**: sees an iframe's navigation as it starts.
- **devtools-anywhere**: an iframe's navigation is seen at its load event, later than in Chrome: logs and requests before it are missing, except in srcdoc and blank iframes; so are closed shadow roots its scripts attach before it.

<a id="sandboxed-iframes"></a>

### Sandboxed iframes (no `allow-same-origin`)

When [merged](usage.md#sandboxed-iframes) into the page's target, as in Chrome, their DOM, styles, execution context, console, requests and scripts are in the page's, highlighted, inspected and given input. Where merged iframes differ from Chrome:

- Moving or copying a node across the iframe's edge fails.
- `DOM.performSearch` lists the page's results first, then the iframe's.
- When the iframe's document reloads, its new `contentDocument` comes with its child count, without `childNodeCountUpdated` or `scrollableFlagUpdated`.
- The execution context Chrome reports for the iframe's initial about:blank is missing.
- A request to the iframe for its document, a node or a point unanswered within 1 s is taken as the iframe not answering (its document is not grafted, a point over it hits the `<iframe>` itself).
- An uncaught error thrown later by code run from the Console in the iframe (in a timer, say) has no exception object (`exception` is null), no position and no stack. Why: the iframe's document sees the probe's script as cross-origin and mutes its errors. Its own scripts' errors are not affected.
- Its scripts' sources are fetched again by the page from their URLs, so only those the page can fetch.
- In inspect mode the hover highlight is clipped by the iframe, and a `highlightNode` highlight of its node does not follow scrolling.
- `frameNavigated` keeps the same `loaderId` after the iframe's document navigates.
- After the frame navigates to a page without the probe, the page still shows the old document.
- Isolated worlds are refused in it: see [CSP and frames](#isolated-worlds-csp-and-frames).

<a id="sandboxed-iframes-not-merged"></a>

Not merged (off, or no probe in it):

- **Chrome**: has the iframe's document, execution context and child frames in the page's target.
- **devtools-anywhere**: listed in the frame tree as in Chrome, but shown as elements only, with no execution context or child frames of their own, and of its requests only its document's. The URL is the iframe's `src` (or `srcdoc`) as of its last load, not where its scripts navigated it; the MIME type is always text/html; the name is the iframe's `name` attribute, not a name its scripts set. The navigation is seen at the load event.
- **Why**: the iframe has an opaque origin, so the page cannot reach its document.

<a id="cross-origin-iframes"></a>

### Cross-origin iframes

- **Chrome**: cross-site iframes are out of process, and debugged as child targets.
- **devtools-anywhere**: only with the probe in the iframe's page and both [origin lists](usage.md#cross-origin-iframes); otherwise shown as elements only. Linked once the iframe's probe runs: its document's own request is reported in its session, not the parent's; breakpoints by URL are not set again after it navigates. A page that does not link again after a navigation is detached up to 10 s later.
- **Why**: a page cannot reach a cross-origin iframe's document.
- **Same as Chrome**: `DOM.scrollIntoViewIfNeeded` in a cross-origin iframe scrolls the parent pages on too.
- **`DOM.scrollIntoViewIfNeeded`**: the parent pages are scrolled asynchronously, after the answer.

<a id="network"></a>

## Network

<a id="websocket"></a>

### WebSocket

- **Chrome**: shows connections, frames and handshake headers.
- **devtools-anywhere**: connections and frames; no handshake headers.

<a id="network-conditions"></a>

### Network conditions

- **Chrome**: applies to every request of the page.
- **devtools-anywhere**: blocked URLs, extra headers, cache disabled, offline and the user agent override apply to the `fetch()` and XHR the probe hooks only, not the document's own request or other subresources (for subresources in shell mode, see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)). Disabling the cache of XHR works for same-origin requests only; extra headers on a cross-origin request make it need a CORS preflight; the user agent is overridden in the page and its same-origin iframes found so far.
- **Throttling**: not supported; it fails (see the roadmap's [commands without effect](roadmap.md#commands-without-effect)).
- **Reporting API**: the reports the page sees only.

<a id="emulation"></a>

## Screencast, device mode and emulation

<a id="screencast"></a>

### Screencast (device button outside shell mode)

- **Chrome**: streams the rendered page.
- **devtools-anywhere**: redrawn by [snapDOM](https://github.com/zumerlab/snapdom) from the DOM: canvas, video and cross-origin images may be missing; ≤ 2 fps. Input replayed with `isTrusted: false`.

<a id="screenshots"></a>

### Screenshots

`Page.captureScreenshot`, for tools and agents that drive the page over CDP:

- Rendered by snapDOM like the screencast, and marked `approximate: true` (a field Chrome does not send).
- The image is in device pixels (`devicePixelRatio` × `clip.scale`).
- Past the canvas limits (32767 px a side, 16384 on Safari, 16384 × 16384 in area) the image is scaled down; snapDOM warns in the console.
- WebP falls back to PNG where it cannot be encoded (Safari).

<a id="device-mode"></a>

### Device mode

- **Chrome**: device mode everywhere, with pixel ratio, user agent and touch.
- **devtools-anywhere**: shell mode only. Sets the size only: no pixel ratio, user agent or touch; its screenshots are snapDOM's, at the page's pixel ratio. `Emulation.setDeviceMetricsOverride` works in shell mode from any client (a remote agent too); elsewhere it fails.
- **Same as Chrome**: the last override set applies; remote clients' overrides survive page reloads; the override's params are checked as Chrome checks them, with Chrome's errors.
- **"Invalid parameters"**: the data leaves out Chrome's "at position N" (a byte offset in Chrome's own encoding).
- **Unknown `devicePosture`**: a `devicePosture` of an unknown type is taken, where Chrome stops answering.

<a id="fullscreen-pages"></a>

### Fullscreen pages

- **Chrome**: DevTools is outside the page, unaffected by the page's fullscreen.
- **devtools-anywhere**: while an element is fullscreen, DevTools cannot be used, in shell mode too. Esc leaves fullscreen.

<a id="rendering-emulation"></a>

### Rendering panel emulation

- **"Emulate a focused page"**: cannot be done; turning it on fails. Why: using DevTools in the page really takes focus from its elements, and their `:focus` styles go.
- **Auto dark mode and resetting the pinch zoom**: cannot be done either and fail.
- Every command the page cannot carry out fails with "Not supported in the page: <why>"; those that could be done but are not yet are in the [roadmap](roadmap.md).

<a id="emulated-media"></a>

### Emulated media

- **Chrome**: emulates media features for the whole page.
- **devtools-anywhere**: `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-reduced-data`, `prefers-reduced-transparency`, `prefers-contrast`, `forced-colors`, `color-gamut` and the media type, by rewriting the page's style sheets. Not in cross-origin sheets, inline styles or `matchMedia()`; the colors `light-dark()` and forced colors pick are not changed.

<a id="safe-area-insets"></a>

### Emulated safe area insets

- **devtools-anywhere**: `env(safe-area-inset-*)` replaced in the page's style sheets: not in cross-origin sheets or inline styles; Styles shows the replaced values.

<a id="layout-overlays"></a>

### Layout overlays

- **Chrome**: draws the overlays from the layout engine.
- **devtools-anywhere**: grid, flex, container query, scroll-snap, isolation, hinge, display cutout and frame overlays, drawn approximately from the computed styles: grids have no line labels; isolation mode's resizing does not reach into iframes. Remaining gaps that can be filled: see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page).

<a id="accessibility"></a>

## Accessibility tree

The Elements panel's Accessibility pane and `Accessibility.getPartialAXTree`, `getFullAXTree`, `queryAXTree`, `getRootAXNode`, `getChildAXNodes`, `getAXNodeAndAncestors` are computed in the page from the DOM, ARIA attributes and computed styles, compared with Chrome's. Computed by `accessibility.js` (about 29 KB), loaded on first use from next to the bundle: self-hosted, serve it in the same directory.

- **Chrome**: computes the tree in the browser, with inline text boxes, list markers and nodes of user-agent shadow trees.
- **devtools-anywhere**: no inline text boxes, list markers or nodes of user-agent shadow trees; the default names of inputs (such as "Submit") are in English.
- **Events**: no `loadComplete` or `nodesUpdated` events (to be done: see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page)).

<a id="application-issues-console"></a>

## Application, Issues and Console

<a id="application-panel"></a>

### Application panel

- **IndexedDB and Cache Storage**: Chrome's views follow the writes of the whole origin (workers and other windows included). Here the views refresh on writes of this window only (not workers or other windows); the storage bucket is the page's default one.
- **Service workers**: listed, updated and unregistered. Whether one is running cannot be seen, so it shows running until redundant; inspecting, starting and stopping workers fail.

<a id="issues-panel"></a>

### Issues panel

- **devtools-anywhere**: CSP violations, deprecations, quirks mode and form issues. CSP and deprecations of the top document only; no interventions.
- **Low contrast**: none; Chrome has no such check either.
- **Cookies, CORS and mixed content**: none. Why: they are the browser's.

<a id="console-violations"></a>

### Console violations

- **devtools-anywhere**: `[Violation]` messages for slow handlers and forced reflows from `long-animation-frame` entries, without line numbers; the browser needs long-animation-frame, otherwise `Log.startViolationsReport` fails.

<a id="hosting-and-browsers"></a>

## Hosting, shell mode and browsers

<a id="shell-mode"></a>

### Shell mode

- **Chrome**: DevTools sits outside the page; the page is the top-level document.
- **devtools-anywhere**: in [shell mode](usage.md#shell-mode) the page runs in an iframe. There `100vh`, `position: fixed`, `window.top` and the viewport may behave differently. The page's HTML is requested twice; a page returned for a form POST is requested again with GET.

<a id="frontend-origin"></a>

### Frontend on the page's origin

- **devtools-anywhere**: DevTools' settings share the page's `localStorage`: host it on another origin.

<a id="browsers"></a>

### Browsers

- **devtools-anywhere**: page side: any modern browser. DevTools UI: verified in Chrome only; newer frontends may need compatibility patches.
