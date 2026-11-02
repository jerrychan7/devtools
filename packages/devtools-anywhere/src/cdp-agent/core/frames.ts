import { EXECUTION_CONTEXT_ID, FRAME_ID, LOADER_ID } from './context';
import { closestOwn } from './nodes';
import { type FrameOwner, documentOf, isElement, isFrameOwner, isNode } from './realm';

/** A document the agent exposes as a frame, with the execution context of its window. */
export interface Frame {
  readonly id: string;
  /** Like Chrome, a new one for each document the frame loads. */
  loaderId: string;
  /** Like Chrome, a new one for each document the frame loads. */
  executionContextId: number;
  /** The frame's WindowProxy: the same object across the frame's navigations. */
  readonly window: Window;
  /** The document the frame shows now. */
  document: Document;
  /** The `<iframe>` or `<frame>` holding the frame; none for the top one. */
  readonly owner?: FrameOwner;
  readonly parent?: Frame;
}

/** A change to the frame tree: a frame came, loaded another document, or went. */
export interface FrameChange {
  type: 'attached' | 'navigated' | 'detached';
  frame: Frame;
}

const newLoaderId = () => `devtools-anywhere-loader-${Math.random().toString(36).slice(2)}`;

/** The document in a frame owner, null for a cross-origin one (out of reach) or none. */
function contentDocumentOf(owner: FrameOwner): Document | null {
  try {
    return owner.contentDocument;
  } catch {
    return null;
  }
}

/** Whether DOM mutation records added or removed a frame owner, possibly within a subtree. */
export function touchesFrames(records: MutationRecord[]): boolean {
  const hasFrame = (n: Node) => isFrameOwner(n) || (isElement(n) && n.querySelector('iframe, frame') !== null);
  return records.some(
    r =>
      r.type === 'childList' && (Array.from(r.addedNodes).some(hasFrame) || Array.from(r.removedNodes).some(hasFrame))
  );
}

/**
 * The page's frames: the top document and its same-origin iframes, which the agent can reach.
 * Cross-origin iframes are not registered (docs/roadmap.md, "iframes").
 *
 * Iframes are found by {@link sync}, which walks the documents; while anyone listens through
 * {@link onChange}, the registry also watches for iframes being added, removed or loading another
 * document and syncs by itself. Domains look frames up here rather than using FRAME_ID and
 * EXECUTION_CONTEXT_ID.
 */
export class FrameRegistry {
  readonly top: Frame;
  readonly #byWindow = new WeakMap<Window, Frame>();
  readonly #byId = new Map<string, Frame>();
  readonly #byContext = new Map<number, Frame>();
  readonly #byOwner = new WeakMap<Element, Frame>();
  readonly #children = new Map<Frame, Frame[]>();
  readonly #listeners = new Set<(change: FrameChange) => void>();
  #frameSeq = 0;
  #contextSeq = EXECUTION_CONTEXT_ID;
  #observer: MutationObserver | null = null;
  readonly #onLoad = (event: Event) => {
    if (isNode(event.target) && isFrameOwner(event.target)) this.sync();
  };

  constructor(top: Window) {
    this.top = {
      id: FRAME_ID,
      loaderId: LOADER_ID,
      executionContextId: EXECUTION_CONTEXT_ID,
      window: top,
      document: top.document,
    };
    this.#add(this.top);
  }

  #add(frame: Frame): void {
    this.#byWindow.set(frame.window, frame);
    this.#byId.set(frame.id, frame);
    this.#byContext.set(frame.executionContextId, frame);
    this.#children.set(frame, []);
    if (frame.owner) this.#byOwner.set(frame.owner, frame);
    if (frame.parent) this.#children.get(frame.parent)?.push(frame);
    this.#watch(frame.document);
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

  /** The frame showing `doc` now, if any: not one a frame has navigated away from. */
  ofDocument(doc: Document): Frame | undefined {
    const frame = doc.defaultView && this.#byWindow.get(doc.defaultView);
    return frame?.document === doc ? frame : undefined;
  }

  /** The frame an `<iframe>` or `<frame>` holds, if it is registered. */
  ofOwner(owner: Element): Frame | undefined {
    return this.#byOwner.get(owner);
  }

  /** The child frames of `frame`, in the order they were found. */
  childrenOf(frame: Frame): readonly Frame[] {
    return this.#children.get(frame) ?? [];
  }

  /** All frames, the top one first, each followed by its descendants. */
  *[Symbol.iterator](): IterableIterator<Frame> {
    const visit = function* (this: FrameRegistry, frame: Frame): Generator<Frame> {
      yield frame;
      for (const child of this.childrenOf(frame)) yield* visit.call(this, child);
    };
    yield* visit.call(this, this.top);
  }

  /**
   * Listens to changes of the frame tree; returns a function that stops listening. While anyone
   * listens, the registry watches the documents itself.
   */
  onChange(listener: (change: FrameChange) => void): () => void {
    this.#listeners.add(listener);
    if (!this.#observer) {
      this.#observer = new MutationObserver(records => {
        if (touchesFrames(records)) this.sync();
      });
      for (const frame of this) this.#watch(frame.document);
      this.sync();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size || !this.#observer) return;
      this.#observer.disconnect();
      this.#observer = null;
      for (const frame of this) frame.document.removeEventListener('load', this.#onLoad, true);
    };
  }

  /** Observes a frame's document for iframes coming and going, and loading (load does not bubble). */
  #watch(doc: Document): void {
    if (!this.#observer) return;
    this.#observer.observe(doc, { childList: true, subtree: true });
    doc.addEventListener('load', this.#onLoad, true);
  }

  #emit(type: FrameChange['type'], frame: Frame): void {
    for (const listener of this.#listeners) listener({ type, frame });
  }

  /**
   * Brings the registry up to date with the documents: registers same-origin iframes found in
   * them, gives a frame that loaded another document a new loader and execution context, and
   * unregisters frames whose iframe is gone or became cross-origin. Listeners hear of each change.
   */
  sync(): void {
    this.#syncChildren(this.top);
  }

  #syncChildren(parent: Frame): void {
    const found = new Set<Frame>();
    for (const owner of Array.from(parent.document.querySelectorAll('iframe, frame'))) {
      if (!isFrameOwner(owner) || closestOwn(owner)) continue;
      const doc = contentDocumentOf(owner);
      const win = owner.contentWindow;
      let frame = this.#byOwner.get(owner);
      // A moved iframe gets a new browsing context: like Chrome, a new frame.
      if (frame && (frame.window !== win || !doc)) {
        this.#detach(frame);
        frame = undefined;
      }
      if (!doc || !win) continue;
      if (!frame) {
        frame = {
          id: `${FRAME_ID}-${++this.#frameSeq}`,
          loaderId: newLoaderId(),
          executionContextId: ++this.#contextSeq,
          window: win,
          document: doc,
          owner,
          parent,
        };
        this.#add(frame);
        this.#emit('attached', frame);
      } else if (frame.document !== doc) {
        this.#byContext.delete(frame.executionContextId);
        frame.document = doc;
        frame.loaderId = newLoaderId();
        frame.executionContextId = ++this.#contextSeq;
        this.#byContext.set(frame.executionContextId, frame);
        this.#watch(doc);
        this.#emit('navigated', frame);
      }
      found.add(frame);
      this.#syncChildren(frame);
    }
    for (const child of Array.from(this.childrenOf(parent))) if (!found.has(child)) this.#detach(child);
  }

  /** Unregisters a frame and its descendants, the descendants first. */
  #detach(frame: Frame): void {
    for (const child of Array.from(this.childrenOf(frame))) this.#detach(child);
    this.#children.delete(frame);
    this.#byId.delete(frame.id);
    this.#byContext.delete(frame.executionContextId);
    if (this.#byWindow.get(frame.window) === frame) this.#byWindow.delete(frame.window);
    if (frame.owner && this.#byOwner.get(frame.owner) === frame) this.#byOwner.delete(frame.owner);
    if (frame.parent) {
      const siblings = this.#children.get(frame.parent);
      siblings?.splice(siblings.indexOf(frame), 1);
    }
    this.#emit('detached', frame);
  }
}

/** The page's frames, shared by all sessions: like frame ids, they belong to the page. */
export const frames = new FrameRegistry(window);
