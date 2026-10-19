import type { Probe } from '../probe/types'
import type { NodeRegistry } from './nodes'
import type { ObjectRegistry } from './objects'
import type { CdpServer } from './server'

/** State shared by all domains. */
export interface Context {
  server: CdpServer
  objects: ObjectRegistry
  nodes: NodeRegistry
  probe: Probe
  /** Re-checks which pseudo-elements exist, e.g. after a style edit. Set by the DOM domain. */
  refreshPseudoElements?: (roots?: Node[]) => void
}

/** The page is exposed as a single frame with a single execution context. */
export const FRAME_ID = 'devtools-anywhere-frame'
export const LOADER_ID = 'devtools-anywhere-loader'
export const EXECUTION_CONTEXT_ID = 1
