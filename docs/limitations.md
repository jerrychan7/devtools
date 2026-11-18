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
| Emulated media | Partly supported | Media features and type [by rewriting the page's style sheets, `<source>` elements, image `sizes` and the queries `matchMedia()` gets](#emulated-media) |
| Forced colors | Partly supported | [The system palette and the canvas as own style sheets, with the form controls only recoloured](#forced-colors) |
| Emulated safe area insets | Partly supported | `env(safe-area-inset-*)` [read through custom properties in the page's style sheets and style attributes](#safe-area-insets) |
| Vision deficiencies | Supported | Chrome's SVG filters, as the backdrop filter of a transparent mask in the top layer: the page's own `filter` on `<html>` stays and `getComputedStyle` sees nothing; dialogs, popovers and full-screen elements the page opens later are put under the mask at once, the embedded panel stays above it (after a modal dialog the page opened, it shows but is inert with the page, so the mouse cannot reach it; without the filter the dialog covers it). Not filtered: the browser's own pickers (`<select>` lists, date pickers, a customizable select's `::picker`) and top-layer elements in closed declarative shadow roots, which neither the page nor we can reach. Differences from Chrome: same-origin iframes are filtered with the page in one pass rather than each on its own, the blur does not fade out at the viewport's edges (about 4px: a backdrop filter repeats the edge pixels, and growing the mask past the viewport changes nothing) |
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
- **devtools-anywhere**: these panels are not included. `debugger;` does not pause; in shell mode it logs a warning with its stack. (The Service Worker rewrites it in the page's same-origin scripts. It remembers where each script's `debugger` statements are by the hash of the script's content, so a script loaded again is not parsed again, and an edited one is rewritten on its next load with no forced reload. Only full `200` responses are remembered, for at most 256 URLs, the least recently used dropped first. They are kept in the Cache API as `devtools-anywhere-service-worker-rewrites`: for each script, the SHA-256 of its URL (not the URL, so no query string reaches the disk) and of its content, its charset and the byte offsets of its `debugger` statements, never its text; scripts served with `Cache-Control: no-store` are remembered in memory only. The cache is deleted when shell mode ends, when a page outside shell mode unregisters a left-over worker, and when a new version of the worker activates; a record written by another build is ignored.) With [remote debugging](usage.md#remote-debugging), breakpoints still need the browser's own debugger (`chrome://inspect`, Safari Web Inspector): the page runs the same in-page agent.
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
- **devtools-anywhere**: only those added after the probe ran; no source location. A listener its `signal` removed is not listed, but the probe keeps its record, and with it the listener function, until the page removes it with `removeEventListener()` and the same arguments, the next listener is added to the same target, or the target is collected.
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
- **After CSSOM changes**: once the page changes a sheet's rules through the CSSOM (not `replace()` or `replaceSync()`, nor its own media list, `sheet.media`), its text is serialized from the CSSOM as Chrome serializes a sheet it first sees changed: each rule's text, `@import` ones included, followed by a line break. For a sheet whose text it knew, Chrome splices the rules' texts into it and lags behind. The text is serialized too when the rules found in the text cannot be paired with the CSSOM's, and for a constructed sheet made before DevTools opened.
- **Changed before CSS was enabled**: whether the page changed a sheet before CSS was enabled is found when its text is first used (`CSS.getMatchedStylesForNode`, `CSS.getStyleSheetText`, an edit) or checked while the page is idle, not when it is added: its `CSS.styleSheetAdded` header measures the text as written, and once found changed it is sent `CSS.styleSheetChanged` and served serialized (the header's `length`, `endLine` and `endColumn` stay those sent, as the client keeps them). Chrome gives its final text in the header at once and sends no `CSS.styleSheetChanged`; for a `<style>` a script added, that text is the changed rules' text spliced in front of the `<style>`'s.
- **Properties written by name**: the CSS domain is not told of a write such as `rule.style.color = …` as it is made (in Chrome these names are properties of each style object, and the accessors the agent puts on the prototype for them tell the emulation alone, see [following the page's writes](#following-writes)), so it is found afterwards: the rules whose style the page took through `rule.style` are compared with their text then before the text is next used. The change is found only then, and `CSS.styleSheetChanged` is sent late with it. Not seen: writes through a style taken and kept before CSS was enabled; and, once more than 2048 rules are watched, the sheets they are in are serialized anew and the rules no longer watched, so writes through styles kept from before.
- **`isMutable` in headers**: as in Chrome, a sheet is mutable once its rules were changed through the CSSOM, by the page or by an edit, and constructed sheets always are. Not counted here, where Chrome counts them: changes the page made while CSS was not enabled (before it was, or while it was disabled); a property written by name with a value the property rejects (`rule.style.color = 'nope'`), as the text it is compared with stays the same; and, once more than 2048 rules are watched, writes through the styles taken from them.
- **Media lists**: changes through `mediaText`, `appendMedium()` and `deleteMedium()` are seen, both of a rule's media list (`rule.media`) and of a sheet's own (`sheet.media`); but not those to a list obtained before any session or the emulation started watching the CSSOM, as it is then not known which rule or sheet it belongs to.
- **Cost**: while CSS is enabled or an emulation rewrites the page, an element's own `style.cssText = …` passes through a proxy of the agent's and a hook, and assigning single properties (`el.style.left = …`) through the agent's accessors (see [following the page's writes](#following-writes)): such writes are then noticeably slower than without the agent, by a few times for a property written by name. Once neither is the case the proxies and accessors are taken off, and these writes cost what they cost without the agent. The page reading a rule's `rule.style` or a sheet's `sheet.media` passes through a hook while CSS is enabled or an emulation rewrites the page (and so does `rule.media`); once CSS is disabled the native getters are put back, and such reads cost what they did before.
- **Editing an `@supports`, `@container` or `@scope` condition**: Chrome keeps the rule objects. Here the rule is replaced, as the CSSOM cannot change the condition: rule objects the page holds for it and the rules in it are detached.
- **Replacing a whole text** (`CSS.setStyleSheetText`): Chrome clears all the sheet's rules and parses the text anew, so every rule object the page holds is detached (`parentStyleSheet` becomes `null`), even those whose text is the same. Here only the top-level rules whose text changed are deleted and inserted: the others stay in the sheet as the same objects, which keeps the edit cheap in a large sheet and the page's references working.
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
- **devtools-anywhere**: not for `@import` and `adoptedStyleSheets` sheets. The forced element is marked with the attribute `data-devtools-anywhere-force`, which the client is not shown, but which a query that names it finds: `DOM.querySelector` and `DOM.querySelectorAll` with a selector such as `[data-devtools-anywhere-force]`, and `DOM.performSearch` with such a selector or with an XPath expression such as `//*[@data-devtools-anywhere-force]`. While a sheet of devtools-anywhere's is hidden in a document or a shadow root, a wrapper the page put over its `adoptedStyleSheets` accessors after the probe took them is not called for that tree's reads and assignments; one put over them before the probe is still called (see [page wrappers](#emulated-media)).

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
- **Groups (`cssId`)**: same as Chrome, `cssId` follows the rules that win the animation's properties, so the same declarations in two rules are two groups, and a `:hover` transition and the one back are too. That goes for pseudo-elements as well, including those the Elements panel does not show, such as `::backdrop`, `::scroll-marker`, `::scroll-marker-group`, `::scroll-button()`, `::column` and `::view-transition-group()` (matched by name, `*` and `view-transition-class`). Also as in Chrome, rules of `@import`ed and constructed sheets (which have no `ownerNode`) do not count. Unlike Chrome, rules our CSS matching misses are not seen; of the pseudo-classes after a pseudo-element, only a scroll button's `:disabled` and `:enabled`, `:target-current` (judged by the scroll position) and a view transition image's `:only-child` are matched; a view transition's classes are read when it starts only if it starts after DevTools (otherwise from the elements at the time), elements in shadow trees count for no class, and `auto` and `match-element` names are not matched by class.
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
- **devtools-anywhere**: `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast`, `forced-colors`, `color-gamut` and the media type, by rewriting the page's style sheets and the queries `matchMedia()` gets, the `media` of its `<source>` elements and the `sizes` of its images (as in Chrome, the browser then chooses the resource again of an image in the page: when the image is created, and when its `<source>` changes). The rules of cross-origin sheets are not rewritten (their media is), nor are the queries the page made before the probe ran or, in a same-origin iframe, before its load event; the change events of the queries `matchMedia()` gets come in the next frame and are not trusted (`isTrusted` is false). The colors `light-dark()` picks follow the emulated scheme only through the `color-scheme` values the emulation rewrites (see Color scheme below): where such a value is not rewritten (one with a `var()`, a rule of a cross-origin sheet), they are not changed. Forced colors also paint the page, see [Forced colors](#forced-colors). The page's own script reads these rewritten (`mediaText`, a media list's `item()` and entries, the `media` and `sizes` attributes, `style`), and its own mutation observers see the writes; `appendMedium()` and `deleteMedium()` act on the entries the page wrote, as in Chrome, and leave the list rewritten; only devtools-anywhere's client is shown the values as the page wrote them. `prefers-reduced-data` is not emulated: Chrome 157 does not emulate it, so its queries are left to the browser.
- **Errors** thrown through the hooked `matchMedia()`, its `matches` getter and `Function.prototype.toString` show one extra frame of the bundle (`at Object.apply`), which Chrome's errors do not have. Through the top window's `addEventListener` and `removeEventListener` they show two (that frame, and the probe's own listener wrapper, which was there before), and three were measured for a `change` listener whose options throw when they are read; in a same-origin iframe the probe hooked, where the two functions are proxies of the browser's (they keep their name, their length and `[native code]`), one, and three for such a `change` listener; through `addListener`, `removeListener` and `onchange`, three. The top window's `addEventListener` and `removeEventListener` are that wrapper, so their `toString()` shows its source text, not `[native code]`, their `name` is empty and their `length` is 3, where the browser's are named and take 2. The CSSOM methods and accessors hooked while CSS is enabled or an emulation rewrites the page keep their name and length, but `toString()` prints them without the name, as `function () { [native code] }`. The functions the agent follows the page's writes with are proxied from the moment it loads, and in a same-origin iframe from when its realm is first hooked (see [following the page's writes](#following-writes)): they print so for as long as the page lives. An error thrown through one of them (a rule that does not parse, a write to a computed style) shows one more frame of the bundle (`at Object.apply`), and two while CSS is enabled or an emulation rewrites the page for those that are hooked then as well: the methods that insert and delete rules, `replace()`, `replaceSync()`, `setProperty()`, `removeProperty()` and the `cssText` setter.
- **Realms not hooked yet**: a same-origin iframe before the agent finds it (before its navigation's load event, see [same-origin iframes](#same-origin-iframes)), or a page with the probe but no agent, which never hooks the frames: there, `Function.prototype.toString` prints the top window's hooked functions as `function () { [native code] }`.
- **Listeners the probe does not know**: a listener added through the native `addEventListener` of a realm the probe has not hooked is not known to it. While no listener the probe knows is on the list, it gets no synthetic change events, and the browser's own events of the query as written reach it instead of the emulated ones; with a known listener on the list, it gets the synthetic events as the others do; one added before the first listener the probe knows also gets the browser's own events of the query as written, as the probe's listener that stops them is added with that first known listener and runs after it.
- **Timing**: a rule inserted or changed through the CSSOM, and a sheet's own media list (`sheet.media`), are rewritten in the call that made the change; `replace()` is rewritten once its promise resolves, and `replaceSync()` in the call. A `style` attribute set, or a `<style>` added, is rewritten after the script of its task (in a microtask). A property the page writes by name on a rule's style (`rule.style.color = …`) is rewritten in the call too, through the accessors the agent puts for the names (see [following the page's writes](#following-writes)); in a realm that has none of them, at the next sync of the page's sheets (after a change to a sheet or to the emulation), or when the CSS domain reads the sheet, which may be after the page has read the style.
- **Guards**: a page that puts back an attribute the emulation rewrote (`style`, `media` or `sizes`) whenever the attribute changes, as a guard does, answers each rewrite with a write of its own. The emulation waits before rewriting that attribute again: a put-back that answers a rewrite of ours in the same turn doubles the wait, up to 64 frames (about a second at 60 Hz). A turn ends when its timer runs, or a second after it began: a page that clears every timer id (a loop over them, say) stops that timer, and the turn then ends by the second. The other put-backs, from tasks of their own, are counted within three seconds: up to three of them are rewritten at once, and each further one waits, doubling the wait the same way. A put-back from a timer the guard's observer queues when it sees the emulation's write answers in the same turn, whichever of the guard's observer and the emulation's was created first. A page that writes such values often for other reasons (a media list written in another form, say) is rewritten more slowly too. While the guard holds, the element shows the text the page wrote, where Chrome shows the emulated value: a guard that answers every rewrite keeps the emulation off that element for as long as it runs (a padding of `env(safe-area-inset-top)` then computes to the real inset in every frame), and the emulation takes effect once the guard stops. The page itself keeps running.
- **Color scheme**: a `color-scheme` value that names both light and dark (in a sheet, a style attribute, the CSSOM, or a `<meta name="color-scheme">`) follows the emulated `prefers-color-scheme` as Chrome's does: it is written as that scheme, with `only` kept where the page wrote it (`only light dark` becomes `only dark`), so what follows it, `light-dark()`, CanvasText and form controls, renders as Chrome's does. The root is given no scheme of its own; a value that names one scheme, `normal`, or one Chrome does not read is left as it is. `getComputedStyle().colorScheme`, `style.colorScheme` and the `content` of a `<meta name="color-scheme">` read the written value (`dark` for `light dark` under a dark preference), where Chrome reads the page's own; the Styles pane, the sheet's text and the DOM show the page's own, except in a sheet the page changed through the CSSOM (see copies and queries under emulated media). A value with a function, such as `color-scheme: var(--scheme)`, is not rewritten, so the page follows the browser's own preference.
- **Several clients**: with several clients on the page, a sandboxed iframe merged into it and linked later is set up with the last media emulation call of each client, client by client in the order the clients were first seen, not in the order of the calls; its media type can then differ from the page's.
- **Copies and queries**: an element the page copies while it is rewritten (`cloneNode()`, an `outerHTML` copy made by the page's script) takes the rewritten values as its own, and they stay after the emulation ends. A page write that makes an attribute read exactly the text the emulation wrote is taken as the emulation's. Selector queries (`DOM.querySelector`, the Elements search by selector) match the rewritten values. A style sheet the page changed through the CSSOM is served with its rules serialized from the CSSOM, rewritten values included.
- **Imports and custom elements**: an `@import` is rewritten once its sheet has loaded, at the `load` event of the `<style>` or `<link>` its sheet belongs to, which comes when the imports have loaded (measured for an `@import` in a `<style>`, one added to it with `insertRule()`, and one in the file of a `<link>`). A custom element that changes an attribute the emulation writes, in reaction to the write, is followed by the emulation.
- **Sheet text**: while the media emulation rewrites the `@media` rules of a `<style>`, the client may be sent `CSS.styleSheetChanged` for that sheet when its text is first checked, as its rules no longer read as the text it had. Chrome sends none for it.
- **Page wrappers**: for the calls listed here, the agent calls the browser's own functions, which the probe took before the page's code (the probe is the page's first script), so a wrapper the page puts over one of them after the probe ran is not called:
  - the emulation's rewrites: the attribute methods of the elements they read and write, `matches`, `querySelector` and `querySelectorAll`, an element's `style` getter, the methods and accessors of the style sheets, rules, declaration blocks and media lists they read and write (`cssRules`, `media`, `cssText`, `mediaText`, `setProperty`, `removeProperty` and the like), and `adoptedStyleSheets` of documents and shadow roots;
  - the emulation's waits and turns: its `setTimeout`, `queueMicrotask`, `requestAnimationFrame` and `performance.now` (the frames of the vision deficiency mask among them), and the `queueMicrotask` of the shadow root and style sheet watchers;
  - the mutation observers of the emulation and of the frames and shadow roots it follows, and the `load` listeners the emulation adds to the page's documents;
  - the scan of forced colors: its `getComputedStyle` and `getPropertyValue`, its `querySelectorAll`, and the attribute it marks elements with;
  - the vision deficiency mask's `attachShadow`, `setAttribute`, popover calls and listeners;
  - the DOM domain's reads and edits of attributes (the attribute methods and `attributes`, with the undo and redo of those edits), its `querySelector`, `querySelectorAll` and `matches`, and the CSS domain's reads and writes of a `style` attribute as text and of the attribute that marks forced states.

  Any other call of the agent's may be seen by the page's wrappers. For example: the `getComputedStyle`, mutation observers, timers and `performance.now` of the other domains; the reads and edits of the DOM tree (`parentNode`, `insertBefore`, `innerHTML`, `cloneNode` and the like); the CSS domain where it reads an element's `style` or writes through it (`el.style.setProperty` for `CSS.setEffectivePropertyValueForNode`), and where it fills sheets of its own (`replaceSync`); the emulation where it reads the text of a rewritten declaration block or media list to show the client what the page wrote (`cssText`, `mediaText`), where it makes an element to read how the browser parses a declaration block (`document.createElement`, and that element's `style`), and where it looks a rule up in the text it was written in (a declaration block's `parentRule`, a rule's `parentRule` and `parentStyleSheet`, a sheet's `href`, a `<style>`'s `textContent`, the `cssRules`, `selectorText`, `keyText`, `parentRule` and `parentStyleSheet` of the rules it pairs with that text and the `cssText` of its `@namespace` rules and the `getPropertyValue()` of the declarations nested among them (their `style` is read through the browser's own getter), the `CSSStyleSheet` it makes to parse a selector alone, and the `text()` of the response when a sheet's file is fetched again; the request itself is made with the `fetch` the probe took); the functions the agent follows the page's writes with (see [following the page's writes](#following-writes)), which are put over the ones the page has when the agent loads (those of a style, when CSS is enabled or an emulation starts to rewrite the page) and call those, and the element they make to list the names of a style's properties (`document.createElement`, and its `style`); the `CSSStyleSheet` constructor of each document's window, for the sheets devtools-anywhere injects; the elements of the vision deficiency mask, made and placed through the page's DOM (`createElement`, `append`, `remove`); and the walk up from an element that the scan of forced colors makes for `forced-color-adjust: preserve-parent-color` (`parentElement`, `assignedSlot`, `parentNode` and a shadow root's `host`). Without a probe ahead of the page's code (an older probe, or a page whose code ran before it), the functions are the ones the page has when the agent loads, and its wrappers see every call.
- **Memory**: while the emulation runs, the hooks of a same-origin iframe's realm (the CSSOM's and those of `adoptedStyleSheets`) stay installed after the page removes the iframe, as they do while CSS is enabled: the iframe and its document are collected only once the emulation ends. A shadow host the page removes is collected while it runs. A MediaQueryList whose `change` listeners a signal removed is collected as in Chrome. In a browser without `AbortSignal.any` (before Chrome 116) the probe hears of the abort from the signal's own `abort` event: where a listener of the page stops that event (`stopImmediatePropagation()`), the probe's listeners stay on the list and keep it alive.

<a id="forced-colors"></a>

### Forced colors

- **Chrome**: paints the page with the system palette: the text, borders, links and backgrounds of every element that does not keep its colors (`forced-color-adjust: none`), the form controls with the system theme, and the gradients of a background that has no `url()` image removed.
- **devtools-anywhere**: the palette is own style sheets with `!important` in every frame and shadow root of the page that the agent knows of (see Frames below). An element that keeps its colors, has a background, or loses its gradients is marked with the attribute `data-devtools-anywhere-forced-colors`, whose tokens say which (`kept`, `canvas`, `canvas-<percent>`, `no-image`); the client is not shown the attribute, and the marks and the sheets go when the emulation ends. A background becomes the canvas, as in Chrome, so an opaque one hides what it covers; a translucent one keeps its opacity, rounded to steps of 5%, and one under 2.5% leaves the page's colour in place.
- **Palette**: as in Chrome, the palette is the dark one (white text on a black canvas) or the light one (black text on a white canvas) by the page's `prefers-color-scheme`: the one emulated with forced colors, else the browser's, and it changes when either does. Chrome also takes the colour of the selection (`Highlight`) from the `color-scheme` an element uses: under `color-scheme: dark` it is `rgba(26, 235, 255, 0.8)` in the dark palette and `rgba(55, 0, 110, 0.8)` in the light one. Here the selection always has the colour Chrome gives it under a light `color-scheme`, `rgba(0, 230, 255, 0.8)` and `rgba(5, 0, 73, 0.8)`.
- **Precedence**: Chrome's forced colors replace the page's colors whatever their specificity, `!important` ones and inline `!important` declarations included. The palette's rules are `!important` too but of low specificity, so a declaration of higher specificity with `!important`, and an inline `!important` one, keep their colors.
- **Form controls**: Chrome paints them with the system theme, which gives them its own borders, widths and accent (the check and fill of checkboxes, radios and sliders). Here they are only recoloured: their borders keep the browser's widths and styles, and their accent is the browser's.
- **Timing**: an element is marked when it is added to the page, and the elements already there when the emulation starts. A later change of its gradient, its background or its `forced-color-adjust` (a class change, a hover style, or a parent's `forced-color-adjust` that its children inherit) is not seen, and neither is a move to another parent or to another slot (a change of its `slot` attribute, or of the slots of its host's shadow tree): the element keeps the mark it had, so one with `forced-color-adjust: preserve-parent-color` keeps what the parent or the slot it had when it was marked gave it. A page whose own mutation observer answers the marks by adding elements (one for each attribute change it sees, say) is not left still as under Chrome, which writes nothing such a page could answer. Where it answers in the turn of the mark (in the observer's callback, in a microtask, or in a task that runs before the turn ends: the turn ends with a timer of no delay the emulation queues after the mark, whatever queued the task, and a timer of no delay, a `MessageChannel` message and a `scheduler.postTask()` callback were measured to run before it), the scan of that document holds those elements for some frames before it marks them: two frames for the first batch it holds, and twice as many for each batch after that, up to 64 (about a second at 60 Hz). The answers that come while a batch is held join it, and do not lengthen the wait. An element the page adds outside the turn of a mark starts the waits again from two frames. Such a page adds a few elements in two seconds (6 measured, in a microtask and in each of those three tasks), and until it is marked an element shows its own background and gradients. The waits are forgotten when forced colors end: the next emulation starts from two frames. Where it answers later (from a frame callback, or a timer with a delay), the answer is not told from an addition of the page's own and is marked at once: the page goes on adding at its own pace (measured in two seconds at 60 Hz: 120 elements from a frame callback, one a frame, and 37 from a 50 ms timer). An element the page adds on its own is marked in the frame it is added in, unless it comes in the turn of a mark by chance, as the later parts of a batch added over several microtasks or timers of no delay do: those are marked two frames later (measured: 2000 elements added in one call, 100 in each of 20 frames, and one a frame for three seconds are marked in the frame they are added in; 2000 added in 20 microtasks or 20 timers of no delay within 2 frames; and within 2 frames where these follow one another). The wait is kept per document: a frame that answers the marks does not hold the elements of the page, nor the page those of a frame. In a tab in the background no frames come, and the wait runs on timers, which Chrome slows down there.
- **Pseudo-elements**: the text, borders and shadows of `::before` and `::after` get the palette's colors and no shadow, and their backgrounds are transparent, so what they cover shows through them where Chrome paints the canvas over it. A gradient on them is not removed.
- **Backplates**: where text is drawn over a painted border or a translucent background, Chrome paints a backplate behind the text, which changes the pixels beneath it; here they are not changed.
- **Computed values**: `getComputedStyle()` reports `text-decoration-color` and `column-rule-color` as the palette's colors, where Chrome keeps the page's for most elements, and reports `color-scheme` as the page's, where Chrome computes `light dark`. The `background-color` of the root and of `<body>` reads as the canvas (`rgb(0, 0, 0)` in the dark palette, `rgb(255, 255, 255)` in the light one), where Chrome keeps the page's value and paints the canvas behind it; the other elements' backgrounds read as in Chrome, the canvas at the opacity the page gave them (`rgb(0, 0, 0)` for an opaque one, `rgba(0, 0, 0, 0.5)` for one at 50%, in the dark palette), but for the rounding of a translucent one's opacity and the ones under 2.5% (above). A transparent background keeps the page's value, `rgba(0, 0, 0, 0)`, which in the light palette Chrome reads as `rgba(255, 255, 255, 0)`.
- **Kept colors**: an element with `forced-color-adjust: none` that takes a colour from its parent (it sets no `color` of its own, or a `background-color: inherit`) gets the parent's colour after forcing, the palette's, where Chrome gives it the colour the page gave the parent. `forced-color-adjust: preserve-parent-color` is read along the flat tree, from the slot an element is assigned to, except in a closed shadow root, whose slots are not exposed to the page (`assignedSlot` is null): an element slotted there is taken as the child of its DOM parent.
- **Queries**: a query that names the mark finds the marked elements, though the client is shown no such attribute: `DOM.querySelector` and `DOM.querySelectorAll` with a selector such as `[data-devtools-anywhere-forced-colors]`, and `DOM.performSearch` with such a selector or with an XPath expression such as `//*[@data-devtools-anywhere-forced-colors]`. The search by text does not match it.
- **The page's own view**: its scripts and mutation observers see the marks, and its `outerHTML` contains them; only devtools-anywhere's client is shown the page as it wrote it.
- **Frames**: the palette reaches same-origin iframes and the shadow roots devtools-anywhere knows of, closed ones the probe recorded included; a cross-origin iframe's document is out of reach.

<a id="safe-area-insets"></a>

### Emulated safe area insets

- **devtools-anywhere**: each `env(safe-area-inset-*)` and `env(safe-area-max-inset-*)` in the page's style sheets and in the `style` attributes of its elements is read through a custom property the emulation sets on `:root` (`--da-sai-top`, `--da-sai-max-top` and so on), as `var(--da-sai-top, env(safe-area-inset-top, 7px))`. A side not set keeps its real inset, and changing the insets only changes those properties. Not in the rules of cross-origin sheets.
- **The page's script**: it reads the text as rewritten, through `element.style`, `getAttribute('style')`, a rule's `style` and its `cssText`: `var(--da-sai-top, env(safe-area-inset-top, 7px))` where Chrome gives `env(safe-area-inset-top, 7px)`. `getComputedStyle()` lists the `--da-sai-*` properties and reads them on `:root`, where Chrome has none. The computed values are Chrome's in the cases the conformance tests cover: fallbacks, shorthands, custom properties, max insets, switching and ending the emulation, shadow trees and same-origin frames. A `style` attribute the emulation rewrites, or puts back, gives the page's own mutation observers of that attribute records that Chrome's emulation does not make: one where the attribute is written as text; several where it is written a declaration at a time and the order of its declarations is put back (see Order of declarations below; 10 and 15 were measured for two such attributes, for each setting or clearing of the insets); and, where the block is written again by the page's own writes (see A shorthand with a longhand after it), one for the text the block started from and one for each property set after it (3 for `el.style.padding = …; el.style.paddingBottom = …`). The old values of those records (`attributeOldValue`) show the text as rewritten (`var(--da-sai-top, env(safe-area-inset-top))`). While no emulation rewrites the page, its observers get the records Chrome gives, and no others. The sides the browser writes with no value read the same with and without the emulation.
- **Shown to the client**: the Styles pane, `CSS.getMatchedStylesForNode`, `CSS.getInlineStylesForNode` and `CSS.getStyleSheetText` show the `env()` text the page wrote, as Chrome does, in rules nested in `@media`, `@supports` and the like, and in `@keyframes` and `@font-face` rules; `CSS.getComputedStyleForNode` leaves the `--da-sai-*` properties out. A sheet the page changed through the CSSOM, or one with a rule of a kind the comparison does not know yet, is served with its rules serialized (see [style sheet text](#style-sheet-text)).
- **Partial changes**: a shorthand with `env()` of which the page changes one side (`el.style.paddingLeft = …`) keeps its other sides, which follow the emulation while it runs and read the real insets once it ends, as in Chrome; the page's own declarations are kept as it wrote them. The text of such a shorthand is the browser's own, with the sides written as empty longhands, as Chrome writes it. In a `style` attribute, or a rule the page writes while the insets are emulated, whose block is not known by the page's writes (next item), the other declarations of that block keep their `var()` text after the emulation ends, as the page's script reads it, where Chrome keeps the `env()`; their values are the real insets all the same, and their order is Chrome's. So do those of such a block with a custom property that has no value (`--x: ;`). For a rule rewritten by its own text while it reads sides with no value (one not known by the page's writes, next item), the Styles pane may list fewer of the longhands with no value than Chrome does (`CSS.getMatchedStylesForNode`). A block reads as in Chrome once the emulation ends where what the page wrote it in is known (next item), and as such a `style` attribute does where it is not.
- **A shorthand with a longhand after it**: the browser writes a block that declares a shorthand with an `env()` or a `var()` and then a longhand of the same group (`padding: max(env(safe-area-inset-top), 8px) 16px; padding-bottom: 0`) as longhands with no value (`padding-top: ; padding-right: ; padding-left: ; padding-bottom: 0px;`), and gives the shorthand's text in no other way: the `env()` is not in the text the emulation reads. Such a block is rewritten, and put back when the emulation ends, from what the page wrote it in, which the agent keeps as the page writes it (see [Following the page's writes](#following-writes) below):
  - a rule the page never wrote through the CSSOM: the text of the rule in the text given to `insertRule()` or `addRule()`, to `replace()` or `replaceSync()`, in its `<style>`, or in the file of its `<link>` or `@import`, but only where the agent follows the writes from the moment it loads (`ALWAYS`, see the end of [Following the page's writes](#following-writes)). It does not now: no such text is taken, no file is fetched again for it, and such a rule is not emulated (see below). Where it does, the file is fetched again with the `fetch()` the probe took when it loaded (a wrapper the page puts over it later is not called), from the HTTP cache mostly, with the credentials of a same-origin request, or those of a `<link crossorigin="use-credentials">` to another origin; the request is not reported to the client (the Network domain), and a Service Worker of the page sees it, as a `fetch()` (mode `cors`, cache `force-cache`, no destination) where the sheet's own load was a `style` request;
  - a block written through the CSSOM, a rule's or an element's: the text it was set to (`style.cssText = …`, `el.style = …`) or read as before its first write that is kept, and each property set or removed after that (`setProperty()`, `removeProperty()`, a property by name), in order. The block is rewritten by making the same writes again with each `env()` rewritten, and put back by making them as the page made them: the browser makes the same block of the same writes, so nothing of it is guessed. A block is known so only by what the page wrote while CSS was enabled or an emulation rewrote the page, and from a write of its whole text (`cssText`) or, for a rule, from its first write while so: an element whose style a script sets property by property (`el.style.padding = …; el.style.paddingBottom = …`, as a framework does) while the insets are emulated is emulated so; one set so before is not (below).

  The computed values of such a block, its order (`style[i]`) and, once the emulation ends, its text are then Chrome's. The conformance tests compare them for rules with `padding`, `margin`, `inset`, `border-width`, `scroll-padding` and `padding-inline` on left-to-right, right-to-left and vertical elements, and for an element's style with `padding` and `margin`. An edit of such a rule in the Styles pane is undone (`DOM.undo`) to the block the page wrote, where that block is known so. Where it is not (a rule of a `<style>` the page never wrote while watched, say), the undo sets the rule to the text it read before the edit, which gives the shorthand's sides no value: the shorthand is lost (`padding: env(safe-area-inset-top) 2px; padding-bottom: 0` is left as `padding-bottom: 0px`), where Chrome's undo keeps it.

  What is kept is used only while it is known to be the block:
  - a record of a block's writes ends with a write that is not told as it is made (only that record: a later `cssText` set with an `env()`, or for an element a later write that may call `env()`, starts a new one): a value or a name given as an object; a write through the typed OM (`attributeStyleMap`, `styleMap`); more than 64 writes kept (a property set again right after itself takes the place of the write before, so a block gets there by several properties set in turn, as an animation by script does);
  - an element's block has a record only where the agent knows the element of the style (the style was read as `el.style` in a realm the agent follows) and observes that element's `style` attribute, from before the write that starts the record. Every change of an inline style is a change of that attribute, whoever makes it: one that is not a write the agent saw ends the record, whatever the block then reads. So does a write by the functions of another realm (`frame.contentWindow.CSSStyleDeclaration.prototype.setProperty.call(el.style, …)`), by a function the page took before the agent loaded, by `setAttribute('style', …)` or through the typed OM;
  - a rule's block gives no sign of its changes. Its record keeps the text the block read as after each write, and ends where the block reads another text before the next write, or when the record is used;
  - an element's record is used only while its `style` attribute reads as the browser serializes the block: an attribute set since (`setAttribute('style', …)`) is the block, and is rewritten by its text as any other;
  - before each use, the writes of a record are made again on a block of the agent's own, which must read as the page's block does, text and order; where it does not, the record ends;
  - the text of a sheet or of an inserted rule is not taken for a rule's block now (`ALWAYS` is false): a write made while nobody watched would not have been seen. Where `ALWAYS` is true, it is taken only while the page has written nothing to that block since the agent loaded and the rules of its list are those of the text, the inserted ones aside: a list of rules a rule of the text was deleted from (`deleteRule()`, `removeRule()`), and a `@keyframes` rule to which the page appended a keyframe or from which it deleted one, give no text for their rules from then on; nor does a sheet while its `replace()` has not resolved; the text of a `<style>` or of a file only in the top window; a sheet whose text the client set (`CSS.setStyleSheetText`) by that text, and a rule the client added (`CSS.addRule`) by its own.

  Where what the page wrote is not known so, the `env()` of such a shorthand is not emulated (with a top inset of 20, the padding above computes to `8px 16px 0px`, where Chrome gives `20px 16px 0px`), and the block is not set from a text: its sides stay as they are, its other declarations are emulated, and it is rewritten as any other (see Order of declarations below for what that leaves). That is the case for:
  - a block written while its writes were not followed: while neither CSS was enabled nor an emulation rewrote the page, before the agent loaded, or in a same-origin iframe before its realm was hooked; every record ends when the watching does, and none is taken from before it. So is a rule the page never wrote through the CSSOM, and a rule whose first write while watched found it already holding sides with no value, as its text is not taken (previous list);
  - an element's `style` attribute the page wrote as text and then changed through the element's style with no `env()` in the write (`el.style.color = …` on `<div style="padding: env(…) 2px; padding-left: 0">`): the attribute is then the browser's text, and the block has no record. One left as the page wrote it is emulated, as its text has the `env()`;
  - a record that ended, a list that no longer gives its rules (rules deleted and inserted in turn, say: `deleteRule(1); insertRule('.c {}', 0); deleteRule(1)` leaves the rules of the sheet's text where the text no longer has them; the rules inserted are not emulated either, as their texts are not taken: the sheet reads as in Chrome once the emulation ends), a file that cannot be fetched again or no longer gives the rule, and a rule that does not read as its text in the sheet does;
  - an element's style the agent does not know the element of (one taken by another realm's `style` getter, or before the agent loaded), and one written in a way the agent does not see (previous list).

  One way is left for a block to be set to a text that is no longer its own, and for a rule's block only: writes the agent does not see that leave the block reading as it did after the last write the agent saw (the shorthand set to another `env()` and the same longhand after it, both in ways the agent does not see). The agent does not see a write made by the functions of another realm (an iframe's `CSSStyleDeclaration.prototype.setProperty`, also of an iframe made and used in one task), through a function the page took from a prototype before the agent loaded (a saved `setProperty`), or by a name whose accessor the page took off the prototype again. The rule is then emulated by what was kept, and set to it when the emulation ends: a browser gives a script nothing that tells such a rule from one not written. An element's block is not set so: its record ends with any write the agent did not see.
- **Following the page's writes**: <a id="following-writes"></a>to know what a block was written in (previous item), the agent puts proxies on the CSSOM's prototypes. Two sets, which last for different times (see `ALWAYS` at the end of this item):
  - from the moment the agent loads, in the top window, and in a same-origin iframe when its realm is first hooked (while CSS is enabled or an emulation rewrites the page, for the frames the agent knows of then; a frame the page makes and uses in one task is used before it is hooked, and writes made through its functions are not seen), for as long as the page lives: `insertRule()` and `deleteRule()` (a sheet's, a grouping rule's and a style rule's), `addRule()`, `removeRule()`, `replace()`, `replaceSync()`, a `@keyframes` rule's `appendRule()` and `deleteRule()`, and the `set()`, `append()`, `delete()` and `clear()` of `StylePropertyMap` with the `styleMap` and `attributeStyleMap` getters;
  - only while CSS is enabled or an emulation rewrites the page, and taken off again after: a declaration block's `cssText` and `cssFloat` setters, `setProperty()` and `removeProperty()`, an accessor on `CSSStyleDeclaration.prototype` for each name the browser gives a style, in each spelling it takes (`paddingTop`, `padding-top`, `webkitTransform`, `WebkitTransform`: 1551 of them in Chrome 157), which reads through `getPropertyValue()` and writes through `setProperty()`, and the `style` getters of `HTMLElement.prototype`, `SVGElement.prototype` and `MathMLElement.prototype`, by which the agent knows the element of an inline style. A property written by name (`el.style.padding = …`) passes through no function in Chrome, where the names are properties of each style object: hence the accessors. The conformance tests compare each name with the browser's own for 20 values, read and written.

  The proxies of functions keep their name and length but print as `function () { [native code] }`, without the name Chrome prints there (`function setProperty() { [native code] }`); see Errors under [emulated media](#emulated-media) for the frames they add to an error. What a page can tell, of the first set at any time, and of the second only while it is there:
  - the names are the prototype's, no longer each style's own: `Object.hasOwn(el.style, 'padding')` is false and `Object.getOwnPropertyDescriptor(el.style, 'padding')` undefined, where Chrome has a data property, so the keys `Object.keys(el.style)`, `Object.getOwnPropertyNames(el.style)` and `Reflect.ownKeys(el.style)` list (as in Chrome) do not match the descriptors; `'padding' in CSSStyleDeclaration.prototype` is true, and the prototype has 1561 names of its own, where Chrome's has 10. `for … in` over an element's style, a rule's style or a computed style lists the names Chrome lists, in its order (the accessors are not enumerable), and `in`, `JSON.stringify(el.style)` and `Object.assign(el.style, …)` give what they give in Chrome. A copy of a style's own properties (`{ ...el.style }`, `Object.entries(el.style)`, `Object.values(el.style)`) has none of the names, where Chrome's has them all;
  - `Object.defineProperty(el.style, 'color', { value: 'teal' })` makes a property of the style object, which hides the CSS property from then on (`el.style.color` reads `teal`, and `getPropertyValue('color')` what it was), where Chrome sets the CSS property. A property of a style's name on `Object.prototype` is not read in place of the CSS property, where Chrome reads it;
  - a `Proxy` of a style (`new Proxy(el.style, {})`) reads and writes the style's properties by name as in Chrome, through traps that pass the receiver on too. Each such read or write takes the accessor off the prototype and puts it back, which is much slower than in Chrome, ends every record of the page's writes, as the write is not seen; `Object.hasOwn(proxy, 'color')` is false after a write, where Chrome has true. On a prototype the page froze the accessor cannot be taken off: the read gives undefined and the write is not made;
  - the accessors' functions and the `style` getters are the agent's own: they are named `get padding`, `set padding` and `get style`, and `toString()` prints their source;
  - an error of a write by name (to a computed style, or of a Symbol) says `Failed to execute 'setProperty' on 'CSSStyleDeclaration'`, where Chrome says `Failed to set a named property 'color' on 'CSSStyleDeclaration'`, and has one more frame of the bundle, the accessor's;
  - the page's mutation observers get the records Chrome gives, and no others, while no emulation rewrites the page: the agent observes the `style` attribute of the elements whose block has a record with an observer of its own;
  - the cost: writes of an element's style, by name, through `setProperty()` or `cssText`, reads of `el.style` and of a property by name, of a computed style's too, and `insertRule()` and `deleteRule()` are slower than without the agent, writes by name the most; a block that has a record is checked for writes not seen at each write, which costs more again;
  - memory: what is kept is held weakly by the sheet, the rule or the style it is of, and goes with it; the tables that hold it do not shrink, so a page that makes many rules with an `env()` at once keeps some of that memory after they are gone.

  One constant of the agent (`ALWAYS` in `written-blocks.ts`) says how long the second set lasts. It is `false`: as above, only while CSS is enabled or an emulation rewrites the page. A page where neither is the case differs from one without the agent, of all the above, only by the first set, and its writes and reads by name cost what they cost without the agent; nothing written while it was so is trusted (each record ends when the watching starts or ends), and no text of a sheet, of a `<style>`, of a file or of an inserted rule is taken for a block: only a block written while the second set is there is emulated. With `true`, the second set is there from the moment the agent loads, in the top window, with the same differences and costs at all times, and those texts are taken as the previous item says.
- **Open values**: a value that leaves a function, a block, a string or a `url()` open (`--x: f(a`) is serialized by the browser as written, with a semicolon and the next declarations after it, and that text parsed again takes them into the value. An `env()` in the open value itself is emulated (`--x: calc(env(safe-area-inset-top)` read by `padding-top: var(--x)` gives the inset, as in Chrome). What the page declares in that block afterwards through the CSSOM (`el.style.setProperty('padding-top', 'env(safe-area-inset-top)')`) is emulated where the block has a record of the page's writes (see A shorthand with a longhand after it), as the writes are made again, not the text. Where it has none (a record that ended), the block is written from its text, a declaration at a time, and in that text a declaration set after the open value is part of the value: its `env()` is not emulated. The declarations rewritten before stay emulated, none is lost, and the block reads as under Chrome's emulation once the emulation ends. The Styles pane may read such a `style` attribute otherwise than Chrome's does: where Chrome shows `--x` as `f(a; color: blue` and lists `color` after it, here the value has one more semicolon and `color` is not listed.
- **Order of declarations**: a rewritten block keeps the order of its declarations (`style[i]`), while the emulation runs and once it ends. The browser moves a property that is set where a logical or a physical counterpart of it is declared later in the block (`padding-inline-start` before `padding-top`, `inline-size` before `height`) to the end of the block, where it would win over that counterpart. So the rewrite puts the properties from the moved one on back in the order the block had: each is removed and added again with the value it has, and a shorthand whose value is pending (one with a `var()` or an `env()`) is added whole. The order is the block's own, not that of its text, which does not always tell it: the browser writes `padding: 1px; padding-inline-start: 3px; padding-left: 2px` as `padding: 1px 1px 1px 2px; padding-inline-start: 3px`. A rule is written so, a declaration at a time, where the text to write declares the names the rule's own text declares, which is what the rewrite leaves of it; a text that declares other names is set whole (`cssText`). A block known by what the page wrote it in (A shorthand with a longhand after it) is not written from a text: the page's writes are made again, which gives the block the page made, in its order. A `style` attribute is written as text, in the page's own, unless its text is the one the browser serializes for the element's style (the CSSOM wrote it last): that one is written by the page's writes where they are known, and else a declaration at a time as a rule is, a value left open in it included. One difference is left, in a block written a declaration at a time: a property that has no value to be added again with stays where it is, ahead of the ones put back. Such are `all`, and the sides of a pending shorthand of which another side was set after it (`padding: var(--x); padding-left: 2px`, which the browser writes with empty longhands) in a block that is not known by what the page wrote it in: a rule or a `style` attribute the CSSOM wrote last of the cases listed under A shorthand with a longhand after it. In such a block that reads `padding-inline-start: env(safe-area-inset-left); padding: var(--x); padding-left: 2px` (and the same with `margin`, `border-width` or `inset`), `padding-inline-start` is then listed after `padding-bottom`, where Chrome lists it first, from the moment the insets are emulated on, after the emulation ends too, until the block is written again or the page is loaded again; no declaration is lost. The computed values are Chrome's but where the property that moved sets the same side as one of those it moved past: on a right-to-left element, where `padding-inline-start` is the right padding, and on a vertical one (`writing-mode: vertical-rl`), where it is the top padding, it wins over the shorthand's (measured with `--x: 3px` and a left inset of 6: that padding is 6px while the insets are emulated and 0px after, where Chrome has 3px; a left-to-right element has Chrome's values). Putting the order back costs a removal and a set for each property from the moved one on, which makes setting and clearing the insets on a large sheet whose rules move a property measurably slower than on one where nothing moves; either is far slower than Chrome's own emulation. In `CSS.getMatchedStylesForNode`, the longhands listed without text after a rewritten rule's declarations are read from the page's text parsed again, with the `!important` ones last, whatever order the page gave them through the CSSOM.
- **A `var()` of the emulation's that the page writes itself** (`var(--da-sai-top, env(safe-area-inset-top))`) is not told from the emulation's own: the client is shown `env(safe-area-inset-top)` in its place, and an edit of that style in the Styles pane writes the `env()`.
- **Insets**: they are integers in the int32 range, as in Chrome; other values fail with "Invalid parameters".

<a id="layout-overlays"></a>

### Layout overlays

- **Chrome**: draws the overlays from the layout engine.
- **devtools-anywhere**: grid, flex, container query, scroll-snap, isolation, hinge, display cutout and frame overlays, drawn approximately from the computed styles: grids have no line labels; isolation mode's resizing does not reach into iframes. Remaining gaps that can be filled: see the [roadmap](roadmap.md#more-that-can-be-filled-in-the-page).

<a id="accessibility"></a>

## Accessibility tree

The Elements panel's Accessibility pane and `Accessibility.getPartialAXTree`, `getFullAXTree`, `queryAXTree`, `getRootAXNode`, `getChildAXNodes`, `getAXNodeAndAncestors` are computed in the page from the DOM, ARIA attributes and computed styles, compared with Chrome's. Computed by `accessibility.js` (about 38 KB), loaded on first use from next to the bundle: self-hosted, serve it in the same directory.

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
