import type { Context } from './core/context';
import { NodeRegistry } from './core/nodes';
import { ObjectRegistry } from './core/objects';
import { viewProbe } from './core/probe-view';
import { CdpSession } from './core/session';
import { registerCss } from './domains/css/css';
import { registerDebugger } from './domains/debugger/debugger';
import { registerDom } from './domains/dom/dom';
import { registerDomDebugger } from './domains/dom-debugger/dom-debugger';
import { registerInput } from './domains/input/input';
import { registerNetwork } from './domains/network/network';
import { registerOverlay } from './domains/overlay/overlay';
import { registerPage } from './domains/page/page';
import { registerRuntime } from './domains/runtime/runtime';
import { registerScreencast, type SnapdomLoader } from './domains/page/screencast';
import { registerStorage } from './domains/storage/storage';
import { registerStubs } from './domains/stubs';
import { registerWebMcp } from './domains/webmcp/webmcp';
import { installProbe, keep } from './probe';

export { CdpSession, type Handler } from './core/session';
export { installProbe } from './probe';
export { OWN_ATTRIBUTE, markOwn } from './core/nodes';
export {
  SHELL_KEY,
  SHELL_MODE_KEY,
  SHELL_PAGE_ID,
  isShellPage,
  readShellConfig,
  refuseShell,
  setShellScriptUrl,
  storeShellConfig,
} from './probe/shell';
export { FRAME_ID, LOADER_ID } from './core/context';
export type { SnapdomLoader } from './domains/page/screencast';

/** @internal */
export interface CdpSessionOptions {
  /**
   * Loads snapDOM (`() => import('@zumer/snapdom')`), which renders the frames of
   * Page.startScreencast. Without it, screencasting is not available.
   */
  loadSnapdom?: SnapdomLoader;
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
  const ctx: Context = {
    session: new CdpSession(),
    objects: new ObjectRegistry(),
    nodes: new NodeRegistry(host => host.shadowRoot ?? probe.shadowRoots.get(host) ?? null),
    probe: viewProbe(probe),
  };
  ctx.session.onReset(() => {
    ctx.probe.close();
    ctx.objects.reset();
    ctx.nodes.reset();
    ctx.nodes.inspected = [];
  });
  registerStubs(ctx.session);
  registerRuntime(ctx);
  registerNetwork(ctx);
  registerPage(ctx);
  registerDom(ctx);
  registerOverlay(ctx);
  registerCss(ctx);
  registerStorage(ctx);
  registerDomDebugger(ctx);
  registerDebugger(ctx);
  registerScreencast(ctx, options.loadSnapdom);
  registerInput(ctx);
  registerWebMcp(ctx);
  return ctx.session;
}
