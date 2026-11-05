import type { FrameRegistry } from './frames';
import type { NodeRegistry } from './nodes';
import type { ObjectRegistry } from './objects';
import type { ProbeView } from './probe-view';
import type { CdpSession } from './session';
import type { ShadowRootTracker } from './shadow-roots';

/** State shared by all domains. */
export interface Context {
  session: CdpSession;
  objects: ObjectRegistry;
  nodes: NodeRegistry;
  probe: ProbeView;
  frames: FrameRegistry;
  /** The shadow roots in the frames, shared by the domains that look into shadow trees. */
  shadowRoots: ShadowRootTracker;
  /** Re-checks which pseudo-elements exist, e.g. after a style edit. Set by the DOM domain. */
  refreshPseudoElements?: (roots?: Node[]) => void;
}

/** The top frame's id; its execution context is EXECUTION_CONTEXT_ID (core/frames.ts). @internal */
export const FRAME_ID = 'devtools-anywhere-frame';
/**
 * Like Chrome, every document gets its own loader id: each page load evaluates this module
 * again, so requests of a reloaded page can be told apart from the previous one's.
 *
 * @internal
 */
export const LOADER_ID = `devtools-anywhere-loader-${Math.random().toString(36).slice(2)}`;
export const EXECUTION_CONTEXT_ID = 1;
