import type { Context } from './core/context';
import { NodeRegistry } from './core/nodes';
import { ObjectRegistry } from './core/objects';
import { viewProbe } from './core/probe-view';
import { CdpServer } from './core/server';
import { registerCss } from './domains/css';
import { registerDebugger } from './domains/debugger';
import { registerDom } from './domains/dom';
import { registerDomDebugger } from './domains/dom-debugger';
import { registerInput } from './domains/input';
import { registerNetwork } from './domains/network';
import { registerOverlay } from './domains/overlay';
import { registerPage } from './domains/page';
import { registerRuntime } from './domains/runtime';
import { registerScreencast, type SnapdomLoader } from './domains/screencast';
import { registerStorage } from './domains/storage';
import { registerStubs } from './domains/stubs';
import { registerWebMcp } from './domains/webmcp';
import { installProbe } from './probe';

export { CdpError, CdpServer } from './core/server';
export { installProbe } from './probe';
export { OWN_ATTRIBUTE, markOwn } from './core/nodes';
export {
  SHELL_KEY,
  SHELL_PAGE_ID,
  isShellPage,
  isTrustedShellConfig,
  readShellConfig,
  setShellScriptUrl,
  type ShellConfig,
} from './probe/shell';
export { FRAME_ID, LOADER_ID } from './core/context';
export type { Probe } from './probe/types';
export type { Snapdom, SnapdomLoader } from './domains/screencast';

export interface CdpServerOptions {
  /**
   * Loads snapDOM (`() => import('@zumer/snapdom')`), which renders the frames of
   * Page.startScreencast. Without it, screencasting is not available.
   */
  loadSnapdom?: SnapdomLoader;
}

/**
 * Creates an in-page CDP server. Reuses the probe if probe.iife.js already ran;
 * otherwise installs it now, so output from this point on is captured.
 */
export function createCdpServer(options: CdpServerOptions = {}): CdpServer {
  const probe = installProbe();
  const ctx: Context = {
    server: new CdpServer(),
    objects: new ObjectRegistry(),
    nodes: new NodeRegistry(host => host.shadowRoot ?? probe.shadowRoots.get(host) ?? null),
    probe: viewProbe(probe),
  };
  registerStubs(ctx.server);
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
  return ctx.server;
}
