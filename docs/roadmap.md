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

## Gaps in Emulation

- `Emulation.setDeviceMetricsOverride` is not implemented: device mode in shell mode is laid out by the frontend, not through CDP, so tools that resize the viewport over CDP cannot. In shell mode it could reuse device mode's sizing of the page iframe.
- `setEmulatedMedia`, `setUserAgentOverride` and others are no-ops that succeed. That is fine for the DevTools frontend but misleading for scripts, which take them as done. Whether they should fail instead depends on whether the frontend relies on them succeeding.

## Patches from an older release line

The two gaps noted in DEV.md, "Patching an older release": CI does not run on `release/**` branches, and a release always moves npm's `latest` and `chrome-<milestone>` and GitHub's Latest release. The plan is for `scripts/release.ts` to decide which tags to move, by semver. To do when an older release first needs a patch.

## Shelved

- **Dragging the divider in shell mode**: Chrome keeps mouse events in the frame where the button was pressed, so a fast drag loses the divider. It does not reproduce headless, and the earlier attempts were reverted.
- **Touch screens**: many small things to improve; low priority.
