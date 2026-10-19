import type { Context } from './core/context';
import { NodeRegistry } from './core/nodes';
import { ObjectRegistry } from './core/objects';
import { CdpServer } from './core/server';
import { registerCss } from './domains/css';
import { registerDom } from './domains/dom';
import { registerDomDebugger } from './domains/dom-debugger';
import { registerNetwork } from './domains/network';
import { registerOverlay } from './domains/overlay';
import { registerPage } from './domains/page';
import { registerRuntime } from './domains/runtime';
import { registerStorage } from './domains/storage';
import { registerStubs } from './domains/stubs';
import { installProbe } from './probe';

export { CdpError, CdpServer } from './core/server';
export { installProbe } from './probe';
export { SHELL_KEY, SHELL_PAGE_ID, isShellPage, readShellConfig, type ShellConfig } from './probe/shell';
export { FRAME_ID, LOADER_ID } from './core/context';
export type { Probe } from './probe/types';

/**
 * Creates an in-page CDP server. Reuses the probe if probe.iife.js already ran;
 * otherwise installs it now, so output from this point on is captured.
 */
export function createCdpServer(): CdpServer {
  const probe = installProbe();
  const ctx: Context = {
    server: new CdpServer(),
    objects: new ObjectRegistry(),
    nodes: new NodeRegistry(host => host.shadowRoot ?? probe.shadowRoots.get(host) ?? null),
    probe,
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
  return ctx.server;
}
