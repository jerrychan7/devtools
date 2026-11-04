import type { Context } from './core/context';
import { type Frame, frames } from './core/frames';
import { mergedFrames, NS_STRIDE, nsPrefix } from './core/merged-frames';
import { NodeRegistry, setNodeIdBase } from './core/nodes';
import { ObjectRegistry, setObjectIdPrefix } from './core/objects';
import { setSheetIdPrefix } from './domains/css/sheet-registry';
import { viewProbe } from './core/probe-view';
import { realmOf } from './core/realm';
import { CdpSession } from './core/session';
import { registerAnimation } from './domains/animation/animation';
import { registerAudits } from './domains/audits/audits';
import { registerCss } from './domains/css/css';
import { registerDebugger, setScriptIdPrefix } from './domains/debugger/debugger';
import { registerDom } from './domains/dom/dom';
import { registerDomDebugger } from './domains/dom-debugger/dom-debugger';
import { registerEmulation } from './domains/emulation/emulation';
import { registerInput } from './domains/input/input';
import { hookFrameNetwork } from './domains/network/frames';
import { registerConditions } from './domains/network/conditions';
import { registerNetwork, setRequestIdPrefix } from './domains/network/network';
import { registerReporting } from './domains/network/reporting';
import { registerOverlay } from './domains/overlay/overlay';
import { registerPage } from './domains/page/page';
import { registerRuntime } from './domains/runtime/runtime';
import { createRender, type SnapdomLoader } from './domains/page/render';
import { registerAccessibility, type AccessibilityLoader } from './domains/accessibility/accessibility';
import { registerScreencast } from './domains/page/screencast';
import { registerScreenshot } from './domains/page/screenshot';
import { registerServiceWorker } from './domains/service-worker/service-worker';
import { registerStorage } from './domains/storage/storage';
import { registerStubs } from './domains/stubs';
import { registerTarget } from './domains/target/target';
import { registerWebMcp } from './domains/webmcp/webmcp';
import { installProbe, keep } from './probe';
import type { Probe } from './probe/types';

export { CdpError, CdpSession, END_SESSION_CALLS, type Handler } from './core/session';
export { installProbe } from './probe';
export { OWN_ATTRIBUTE, markOwn } from './core/nodes';
export {
  SHELL_KEY,
  SHELL_MODE_KEY,
  SHELL_PAGE_ID,
  isShellDocument,
  isShellPage,
  readShellConfig,
  refuseShell,
  setShellScriptUrl,
  storeShellConfig,
  storeShellOpen,
} from './probe/shell';
export { isTrusted } from './probe/trust';
export { FRAME_ID, LOADER_ID } from './core/context';
export { frames } from './core/frames';
export {
  childTargets,
  type ChildLink,
  type ChildSession,
  type ChildTargets,
  type ParentLink,
} from './core/child-targets';
export { frameOwners, ownerOfWindow, watchOwner } from './frame-owners';
export { mergedFrames, type MergedFrames, type RouteTable } from './core/merged-frames';

/**
 * Puts the ids this page's agent makes from now on in namespace `ns` (core/merged-frames.ts):
 * called by the handshake when the page, a sandboxed iframe's, is merged into its parent's agent,
 * before the link carries anything.
 *
 * @internal
 */
export function setIdNamespace(ns: number): void {
  setNodeIdBase(ns * NS_STRIDE);
  frames.setContextIdBase(ns * NS_STRIDE);
  const prefix = ns ? nsPrefix(ns) : '';
  setObjectIdPrefix(prefix);
  setSheetIdPrefix(prefix);
  setScriptIdPrefix(prefix);
  setRequestIdPrefix(prefix);
}
export type { SnapdomLoader } from './domains/page/render';
export type { AccessibilityLoader } from './domains/accessibility/accessibility';

/** @internal */
export interface CdpSessionOptions {
  /**
   * Loads snapDOM (`() => import('@zumer/snapdom')`), which renders the frames of
   * Page.startScreencast and the images of Page.captureScreenshot. Without it, neither is
   * available.
   */
  loadSnapdom?: SnapdomLoader;
  /**
   * Loads accessibility.js, which computes the Accessibility domain's tree. Without it, the
   * domain's commands fail.
   */
  loadAccessibility?: AccessibilityLoader;
}

/** Whether the probe hooks the iframes the page's frame registry finds. */
let hookingFrames = false;

/**
 * Has the probe capture the console calls, uncaught errors and requests of each same-origin iframe
 * document, from the moment the frame registry finds it (on load, for a document that replaced
 * another): what a document logged before is not captured; its requests from before are, as far
 * as Resource Timing knows them. For the page's lifetime, like the probe's hooks
 * of the top page; the registry keeps watching the documents for iframes meanwhile.
 */
function hookFrames(probe: Probe) {
  if (hookingFrames) return;
  hookingFrames = true;
  // Iframes in closed shadow trees too, and in shadow trees attached from now on.
  frames.shadowRootOf = host => host.shadowRoot ?? probe.shadowRoots.get(host) ?? null;
  probe.onShadowRoot(root => frames.watchShadowRoot(root));
  const hook = (frame: Frame) => {
    if (frame === frames.top) return;
    probe.hookWindow(realmOf(frame.document));
    hookFrameNetwork(probe, frames, frame);
  };
  frames.onChange(({ type, frame }) => {
    if (type !== 'detached') hook(frame);
  });
  for (const frame of frames) hook(frame);
}

/** How many console messages V8 keeps (V8ConsoleMessageStorage's limit). */
const MAX_CONSOLE_MESSAGES = 1000;

/**
 * Creates an in-page CDP agent. Reuses the probe if probe.iife.js already ran;
 * otherwise installs it now, so output from this point on is captured.
 *
 * @internal
 */
export function createCdpSession(options: CdpSessionOptions = {}): CdpSession {
  const probe = installProbe();
  // The session sets how much the probe keeps: V8 keeps the last 1000 console messages; like
  // Chrome, requests and WebSockets are not limited in number, only their bodies in bytes (set
  // by each session's probe view).
  Object.assign(probe.limits, {
    logs: MAX_CONSOLE_MESSAGES,
    requests: Infinity,
    sockets: Infinity,
    socketEvents: Infinity,
  });
  keep(probe.logs, MAX_CONSOLE_MESSAGES);
  hookFrames(probe);
  const ctx: Context = {
    session: new CdpSession(),
    objects: new ObjectRegistry(),
    nodes: new NodeRegistry(frames.shadowRootOf, frames),
    probe: viewProbe(probe),
    frames,
  };
  // Commands for the sandboxed iframes merged into this page's agent go to theirs.
  mergedFrames.attach(ctx.session);
  ctx.session.onReset(() => {
    ctx.probe.close();
    ctx.objects.reset();
    ctx.nodes.reset();
    ctx.nodes.inspected = [];
  });
  registerStubs(ctx.session);
  registerTarget(ctx);
  registerRuntime(ctx);
  registerNetwork(ctx);
  registerConditions(ctx.session, probe);
  registerReporting(ctx.session);
  registerPage(ctx);
  registerDom(ctx);
  registerOverlay(ctx);
  registerCss(ctx);
  registerStorage(ctx);
  registerServiceWorker(ctx.session);
  registerDomDebugger(ctx);
  registerDebugger(ctx);
  const render = options.loadSnapdom && createRender(options.loadSnapdom);
  registerScreencast(ctx, render);
  registerScreenshot(ctx, render);
  registerInput(ctx);
  registerEmulation(ctx);
  registerWebMcp(ctx);
  registerAnimation(ctx);
  registerAudits(ctx);
  registerAccessibility(ctx, options.loadAccessibility);
  return ctx.session;
}
