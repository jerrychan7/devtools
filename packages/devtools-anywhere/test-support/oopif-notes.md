# Cross-origin iframes in Chrome: what a client sees

Development notes for attaching cross-origin iframes as child targets (roadmap, "iframes"). Measured on
headless Chrome with `--site-per-process` (`launchOopif()` in `oopif.ts`), parent on `localhost`, child on
`127.0.0.1`, grandchild on `oopif.test`, over a raw flatten connection set up as the frontend sets up its
targets (`OopifPage`). The sequences below are `compact()` output: sessions `root`, `s1`, `s2`… in attach
order, ids `id1`, `id2`… in order of appearance, `page` for the page's own target/frame id, ports dropped.
Re-run them with `chromeSequence(env, SCENARIOS.x)`; `oopif.conformance.test.ts` pins the main points.

## What the frontend sends

From `front_end/core/sdk/ChildTargetManager.ts`, per target that has the Target capability (frames do):

- With no browser target (our case: the connection is a page): `Target.setAutoAttach({autoAttach: true,
waitForDebuggerOnStart: true, flatten: true})`. With a browser target it sends
  `Target.autoAttachRelated` to the browser instead.
- Unless the parent target is a frame (so on the root only): `Target.setDiscoverTargets({discover: true})`
  and `Target.setRemoteLocations({locations: [{host: 'localhost', port: 9229}]})`.
- `Target.getTargetInfo({})` on the parent (getParentTargetId; an attachedToTarget for the parent's own id
  is ignored).
- On suspend/resume (e.g. pausing): `setAutoAttach` again with `waitForDebuggerOnStart` false/true.
- On `attachedToTarget`: type `iframe` becomes a frame target with its own models (Page, DOM, Runtime,
  Network, CSS…, all enabled on the child session); then, if `waitingForDebugger`,
  `Runtime.runIfWaitingForDebugger` on the child session. `detachedFromTarget({sessionId})` disposes it.
  `targetInfoChanged` updates it (URL/title shown in the target picker).
- `ResourceTreeModel`: a child target's main frame has a `parentId` from another target; the frontend
  looks it up in the parent target's model (`crossTargetParentFrame`), which relies on the parent having
  had the frame through `frameAttached` before the child was attached.
- `DOMModel.requestDocument` of a child target calls `DOM.getFrameOwner({frameId: <child main frame>})` on
  the **parent** session and grafts the child document under that `<iframe>` node (`setContentDocument`),
  which is how the Elements tree shows OOPIF contents inline.

Our agent stubs `Target.setAutoAttach`, `setDiscoverTargets` and `setRemoteLocations` today
(`domains/stubs.ts`).

## attachedToTarget

```json
{"session": "root", "method": "Target.attachedToTarget", "params": {
  "sessionId": "s1",
  "targetInfo": {"targetId": "id2", "type": "iframe", "title": "", "url": "", "attached": true,
    "parentId": "page", "canAccessOpener": false, "parentFrameId": "page", "browserContextId": "…"},
  "waitingForDebugger": true}}
```

- Sent on the session of the target that holds the frame, as soon as the cross-site navigation is ready to
  commit, before the child document exists: `url` and `title` are empty and the child is paused.
- `targetId` **is** the frame id the parent already knew (from `frameAttached`); `parentId` and
  `parentFrameId` are the holding frame's id (for the top page's children, the page's targetId).
- With `waitForDebuggerOnStart: false`, or when auto-attach is turned on after the iframe loaded, the
  child is attached at once with its URL and title filled in and `waitingForDebugger: false`.
- Right after commit the parent session gets `targetInfoChanged` with `url` and `title` (= URL when the
  document has no title yet).
- `Target.getTargets` (browser or page session) lists `iframe` targets with the same fields; with
  `setDiscoverTargets` on the page session, `targetCreated` comes for them too.
- `Target.getTargetInfo` on a child session returns its own info (type `iframe`).

## Setup sequence (parent loads, child and grandchild come in)

```
root Page.frameAttached      {frameId: id2, parentFrameId: page}
root Page.frameNavigated     {frame: {id: id2, parentId: page, name: "child", url: "about:blank"}}
root Runtime.executionContextCreated {context: {id: 3, origin: "http://localhost", frameId: id2}}
root Page.frameStartedNavigating {frameId: id2, url: "http://127.0.0.1/oopif-child.html"}
root Target.attachedToTarget {sessionId: s1, targetInfo: {targetId: id2, type: iframe, url: ""}, waitingForDebugger: true}
s1   Runtime.executionContextsCleared
s1   Page.frameNavigated     {frame: {id: id2, parentId: page, name: "", url: "http://127.0.0.1/oopif-child.html"}}
root Target.targetInfoChanged {targetInfo: {targetId: id2, url: "http://127.0.0.1/oopif-child.html", …}}
root Page.frameDetached      {frameId: id2, reason: "swap"}
root Runtime.executionContextDestroyed {executionContextId: 3}
s1   DOM.documentUpdated
s1   Runtime.executionContextCreated {context: {id: 1, origin: "http://127.0.0.1", frameId: id2}}
s1   Page.frameAttached      {frameId: id5, parentFrameId: id2}        (grandchild, about:blank first)
…    the same again one level down: s1 Target.attachedToTarget {sessionId: s2, targetInfo: {targetId: id5,
     parentId: id2, parentFrameId: id2}}, s1 Page.frameDetached {frameId: id5, reason: "swap"}
```

- The frame lives on the parent first (about:blank, same-origin context), then is **swapped** out:
  `frameDetached` with `reason: "swap"` on the parent once the child target has it. The frontend keeps the
  frame on swap.
- In the child session, Page.frameNavigated of its main frame carries `parentId` = the parent's frame.

## Parent session: the iframe

- `Page.getFrameTree` / `getResourceTree` on the parent: **no** entry for the OOPIF (no `childFrames`).
- DOM: the `<iframe>` element is there with `frameId` = the child's frame id = targetId,
  `childNodeCount: 0`, `children: []` and **no** `contentDocument` (also with `pierce: true`).
- `DOM.getFrameOwner({frameId: child})` on the parent returns the `<iframe>` (`backendNodeId`, `nodeId`);
  on the child session it fails: "Frame with the given id does not belong to the target."
- `DOM.getNodeForLocation` on the parent over the iframe returns the `<iframe>` element.
- Runtime: the parent only has the iframe's initial about:blank context, destroyed at the swap.
- Network: the child's **document request** is reported on the parent session (`requestWillBeSent`,
  `responseReceived`, both ExtraInfo), and its `dataReceived` / `loadingFinished` on the child session.
  Everything the child loads after that (style sheets, fetch, the grandchild's document request) is on
  the child session, the grandchild's document body on the grandchild's.

## Child session

- `Page.getFrameTree`: the child's main frame with `parentId` = parent frame id, `name` "" (the parent's
  view had `name: "child"`), its own `loaderId`; no `childFrames` for its OOPIF grandchild.
- `Page.getNavigationHistory` fails: "Command can only be executed on top-level targets".
- Runtime: its own context ids starting from 1 (ids are per target), `auxData.frameId` = its frame;
  console messages of the child come only on the child session.
- `DOM.getDocument`: a separate document whose ids start again from 1 (`backendNodeId` too), with
  `documentURL` / `baseURL` of the child.
- Geometry is the child's own: `DOM.getBoxModel` in the iframe's coordinates; `Page.getLayoutMetrics`
  gives the iframe's size as layout viewport (visual viewport is the top page's).
- `Overlay.enable` and `Overlay.highlightNode` on the child session succeed (not checked what is drawn).
- `Input.dispatchMouseEvent` on the child session takes coordinates in the **child's** viewport: (10, 10)
  arrives as clientX/Y 10, 10 in the child.

## Input on the parent session

`Input.dispatchMouseEvent` on the parent at a point over the OOPIF is hit-tested by the browser and
delivered to the child: the iframe at (0, 100), a click at (50, 120) arrives in the child as
`mousedown`/`click` at clientX/Y (50, 20). So the frontend's screencast/inspect clicks on the root work
across OOPIFs; our agent would have to forward them, translated by the iframe's position.

## Lifecycle

| Action on the child (`SCENARIOS`) | Child target | Events |
| --- | --- | --- |
| `reload` (child reloads itself) | kept (`s1`) | on s1: navigation; the grandchild's target detached and a new one attached (new frame id, new session s3) |
| `sameOrigin` (child goes to another page of 127.0.0.1) | kept | same as reload |
| `otherSite` (parent sets src to oopif.test) | **kept** too: same targetId and session, though it changes process | same as reload, origin changes |
| `parentOrigin` (parent sets src back to localhost) | detached; the frame returns to the parent | below |
| `remove` | detached, children first | below |

reload / sameOrigin / otherSite:

```
s1   Page.frameStartedNavigating {frameId: id2, url: …, navigationType: "reload" | "differentDocument"}
s1   Target.detachedFromTarget {sessionId: s2, targetId: id5}           (grandchild goes)
s1   Runtime.executionContextsCleared
s1   Page.frameDetached {frameId: id5, reason: "remove"}
s1   Runtime.executionContextsCleared
s1   Page.frameNavigated {frame: {id: id2, parentId: page, url: …}}
root Target.targetInfoChanged {targetInfo: {targetId: id2, url: …}}
s1   DOM.documentUpdated
s1   Runtime.executionContextCreated {context: {id: 3, frameId: id2}}
s1   Page.frameAttached {frameId: id9, parentFrameId: id2}               (new grandchild frame, then a new
                                                                        target s3 for it as in setup)
```

parentOrigin (the frame becomes same-process with the parent again):

```
s1   Page.frameStartedNavigating {frameId: id2, url: "http://localhost/frame-child.html"}
root Target.detachedFromTarget {sessionId: s1, targetId: id2}
root Page.frameAttached {frameId: id2, parentFrameId: page}            (same frame id, re-attached)
root Page.frameNavigated {frame: {id: id2, parentId: page, name: "child", url: "http://localhost/frame-child.html"}}
root Runtime.executionContextCreated {context: {id: 4, origin: "http://localhost", frameId: id2}}
```

No detachedFromTarget is sent for the grandchild in that case before its parent's session goes.

remove:

```
s1   Page.frameDetached {frameId: id5, reason: "remove"}
s1   Target.detachedFromTarget {sessionId: s2, targetId: id5}
root Page.frameDetached {frameId: id2, reason: "remove"}
root Target.detachedFromTarget {sessionId: s1, targetId: id2}
```

## Nesting

A grandchild OOPIF is attached on the **child's** session (the `attachedToTarget` event carries
`sessionId` of s1 at the top level, `params.sessionId` s2), only after the child session itself sent
`Target.setAutoAttach`; its `parentId`/`parentFrameId` is the child's frame id. Sessions are flat: every
session talks over the one connection, so s2's messages carry `sessionId: s2` directly; there is no
nesting in the wire format, only in which session announced and detaches it.

## Points for the design

- A child target's id must equal the frame id the parent reports (`frameAttached`, iframe node `frameId`,
  `getFrameOwner`), and the child's main frame must report `parentId` = that parent frame.
- The parent must report the frame (`frameAttached`/`frameNavigated`) before `attachedToTarget`, then
  drop it with `frameDetached {reason: "swap"}` and leave it out of `getFrameTree`; the `<iframe>` node
  stays, with `frameId` and no `contentDocument`, and `DOM.getFrameOwner` must work for it.
- Keep the same target and session over reloads and navigations of the iframe (even cross-site), with
  `targetInfoChanged` on the parent; detach only when the iframe is removed (or becomes same-origin with
  the parent, where it turns back into an ordinary frame of the parent).
- Attach paused (`waitingForDebugger: true`) and announce with an empty URL only if the probe can really
  be held before running page scripts; otherwise attach with `waitingForDebugger: false` and the URL, as
  Chrome does for iframes that already exist when auto-attach is turned on.
- Nested probes announce their children on their own session.
- Input on the root over an iframe should be forwarded to the iframe with coordinates offset by the
  iframe's content box.
