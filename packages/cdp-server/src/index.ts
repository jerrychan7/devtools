import type { Context } from './core/context'
import { ObjectRegistry } from './core/objects'
import { CdpServer } from './core/server'
import { registerNetwork } from './domains/network'
import { registerPage } from './domains/page'
import { registerRuntime } from './domains/runtime'
import { registerStubs } from './domains/stubs'
import { installProbe } from './probe'

export { CdpError, CdpServer } from './core/server'
export { installProbe } from './probe'
export { SHELL_KEY, SHELL_PAGE_ID, isShellPage, readShellConfig, type ShellConfig } from './probe/shell'
export { FRAME_ID, LOADER_ID } from './core/context'
export type { Probe } from './probe/types'

/**
 * Creates an in-page CDP server. Reuses the probe if probe.iife.js already ran;
 * otherwise installs it now, so output from this point on is captured.
 */
export function createCdpServer(): CdpServer {
  const ctx: Context = { server: new CdpServer(), objects: new ObjectRegistry(), probe: installProbe() }
  registerStubs(ctx.server)
  registerRuntime(ctx)
  registerNetwork(ctx)
  registerPage(ctx)
  return ctx.server
}
