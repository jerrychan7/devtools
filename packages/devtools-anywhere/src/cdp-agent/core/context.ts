import type { NodeRegistry } from './nodes';
import type { ObjectRegistry } from './objects';
import type { ProbeView } from './probe-view';
import type { CdpSession } from './session';

/** State shared by all domains. */
export interface Context {
  session: CdpSession;
  objects: ObjectRegistry;
  nodes: NodeRegistry;
  probe: ProbeView;
  /** Re-checks which pseudo-elements exist, e.g. after a style edit. Set by the DOM domain. */
  refreshPseudoElements?: (roots?: Node[]) => void;
}

/** The page is exposed as a single frame with a single execution context. @internal */
export const FRAME_ID = 'devtools-anywhere-frame';
/**
 * Like Chrome, every document gets its own loader id: each page load evaluates this module
 * again, so requests of a reloaded page can be told apart from the previous one's.
 *
 * @internal
 */
export const LOADER_ID = `devtools-anywhere-loader-${Math.random().toString(36).slice(2)}`;
export const EXECUTION_CONTEXT_ID = 1;
