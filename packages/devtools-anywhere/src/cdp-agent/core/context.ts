import type { FrameRegistry } from './frames/frames';
import type { NodeRegistry, PseudoType } from './nodes/nodes';
import type { ObjectRegistry } from './objects';
import type { ProbeView } from './probe-view';
import type { CdpSession } from './session';
import type { ShadowRootTracker } from './nodes/shadow-roots';
import type { IsolatedWorlds } from '../domains/runtime/worlds';

/** A style matching an element, as the Animation domain asks for it (see {@link Context.matchingStyles}). */
export interface MatchingStyle {
  /**
   * Its style rule, as its style sheet's id and its selector; null for the inline style and
   * nested declarations, which are not style rules.
   */
  rule: string | null;
  /** Whether it declares the property: null when not, else as `!important` or not. */
  declares(property: string): 'important' | 'normal' | null;
}

/** State shared by all domains. */
export interface Context {
  session: CdpSession;
  objects: ObjectRegistry;
  nodes: NodeRegistry;
  probe: ProbeView;
  frames: FrameRegistry;
  /** The shadow roots in the frames, shared by the domains that look into shadow trees. */
  shadowRoots: ShadowRootTracker;
  /** The isolated worlds (Page.createIsolatedWorld) and bindings (Runtime.addBinding). */
  worlds: IsolatedWorlds;
  /** Re-checks which pseudo-elements exist, e.g. after a style edit. Set by the DOM domain. */
  refreshPseudoElements?: (roots?: Node[]) => void;
  /**
   * The styles matching an element or its pseudo-element, highest priority first: its inline
   * style (not a pseudo-element's), then its rules, those of user agent and constructed sheets left
   * out, like Chrome's `InspectorCSSAgent::MatchingStyles`. Set by the CSS domain, enabled or not.
   */
  matchingStyles?: (el: Element, pseudo: PseudoType | null) => MatchingStyle[];
}

/** The top frame's id; its execution context is EXECUTION_CONTEXT_ID (core/frames/frames.ts). @internal */
export const FRAME_ID = 'devtools-anywhere-frame';
/**
 * Like Chrome, every document gets its own loader id: each page load evaluates this module
 * again, so requests of a reloaded page can be told apart from the previous one's.
 *
 * @internal
 */
export const LOADER_ID = `devtools-anywhere-loader-${Math.random().toString(36).slice(2)}`;
export const EXECUTION_CONTEXT_ID = 1;
