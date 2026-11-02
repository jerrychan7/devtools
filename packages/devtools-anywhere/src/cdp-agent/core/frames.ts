import { EXECUTION_CONTEXT_ID, FRAME_ID, LOADER_ID } from './context';
import { documentOf } from './realm';

/** A document the agent exposes as a frame, with the execution context of its window. */
export interface Frame {
  id: string;
  loaderId: string;
  executionContextId: number;
  window: Window;
  parent?: Frame;
}

/**
 * The page's frames. Only the top document is registered so far: same-origin iframes are to
 * come (docs/roadmap.md, "iframes"). Domains look frames up here rather than using FRAME_ID and
 * EXECUTION_CONTEXT_ID, so that they are ready for more than one.
 */
export class FrameRegistry {
  readonly top: Frame;
  readonly #byWindow = new WeakMap<Window, Frame>();
  readonly #byId = new Map<string, Frame>();
  readonly #byContext = new Map<number, Frame>();

  constructor(top: Window) {
    this.top = { id: FRAME_ID, loaderId: LOADER_ID, executionContextId: EXECUTION_CONTEXT_ID, window: top };
    this.#add(this.top);
  }

  #add(frame: Frame): void {
    this.#byWindow.set(frame.window, frame);
    this.#byId.set(frame.id, frame);
    this.#byContext.set(frame.executionContextId, frame);
  }

  byId(id: string): Frame | undefined {
    return this.#byId.get(id);
  }

  byContext(id: number): Frame | undefined {
    return this.#byContext.get(id);
  }

  ofWindow(win: Window | null | undefined): Frame {
    return (win && this.#byWindow.get(win)) ?? this.top;
  }

  /** The frame of the document a node is in (the top one for a node of no known document). */
  ofNode(node: Node | null | undefined): Frame {
    return this.ofWindow(node && documentOf(node).defaultView);
  }
}

/** The page's frames, shared by all sessions: like frame ids, they belong to the page. */
export const frames = new FrameRegistry(window);
