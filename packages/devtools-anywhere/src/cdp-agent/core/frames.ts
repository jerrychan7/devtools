import { EXECUTION_CONTEXT_ID, FRAME_ID, LOADER_ID } from './context';
import { closestOwn, isOwn } from './nodes';
import {
  type FrameOwner,
  contentDocumentOf,
  contentWindowOf,
  documentOf,
  isElement,
  isFrameOwner,
  isNode,
  isHtml,
  isShadowRoot,
  sourceAttribute,
} from './realm';

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
  /** The `<iframe>`, `<frame>`, `<object>` or `<embed>` holding the frame; none for the top one. */
  readonly owner?: FrameOwner;
  readonly parent?: Frame;
}

/** A change to the frame tree: a frame came, loaded another document, or went. */
export interface FrameChange {
  type: 'attached' | 'navigated' | 'detached';
  frame: Frame;
}

const newLoaderId = () => `devtools-anywhere-loader-${Math.random().toString(36).slice(2)}`;

/** A shadow host's shadow root, if reachable: closed ones only through the probe's record. */
export type ShadowRootOf = (host: Element) => ShadowRoot | null;

const openShadowRoot: ShadowRootOf = host => host.shadowRoot;

/**
 * Calls `visit` with each frame owner in a tree, in tree order, going into the shadow trees of
 * its hosts like Chrome, which gives an iframe in a shadow tree a frame too; and with each shadow
 * root entered, first. devtools-anywhere's own elements are skipped, with their subtrees.
 */
export function walkFrameOwners(
  root: Node,
  shadowRootOf: ShadowRootOf,
  visit: (node: FrameOwner | ShadowRoot) => void
): void {
  if (isElement(root) && isOwn(root)) return;
  if (isElement(root) && isFrameOwner(root)) visit(root);
  const walker = documentOf(root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT, n =>
    isOwn(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  );
  const enter = (host: Node) => {
    const shadow = isElement(host) ? shadowRootOf(host) : null;
    if (!shadow) return;
    visit(shadow);
    walkFrameOwners(shadow, shadowRootOf, visit);
  };
  enter(root);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (isFrameOwner(n)) visit(n);
    enter(n);
  }
}

/** Whether DOM mutation records added or removed a frame owner, possibly within a subtree or shadow tree. */
export function touchesFrames(records: MutationRecord[], shadowRootOf: ShadowRootOf = openShadowRoot): boolean {
  const hasFrame = (n: Node) => {
    if (isFrameOwner(n)) return true;
    if (!isElement(n)) return false;
    let found = false;
    walkFrameOwners(n, shadowRootOf, node => (found ||= !isShadowRoot(node)));
    return found;
  };
  return records.some(
    r =>
      r.type === 'childList' && (Array.from(r.addedNodes).some(hasFrame) || Array.from(r.removedNodes).some(hasFrame))
  );
}

/**
 * The page's frames: the top document and its same-origin iframes, which the agent can reach.
 * Cross-origin iframes are not registered (docs/roadmap.md, "iframes").
 *
 * Iframes are found by {@link sync}, which walks the documents and the shadow trees in them; while
 * anyone listens through
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
  /**
   * When frame owners were inserted, as read from DOM mutation records: new frames are registered,
   * and listed among their siblings, in this order, as Chrome lists frames in the order it made them.
   */
  readonly #insertedAt = new WeakMap<FrameOwner, number>();
  #insertionSeq = 0;
  #contextSeq = EXECUTION_CONTEXT_ID;
  #observer: MutationObserver | null = null;
  /** Shadow roots watched like documents (load does not cross a shadow boundary). */
  readonly #watchedRoots = new Set<ShadowRoot>();
  /** Set by the agent to reach closed shadow roots too (the probe records them). */
  shadowRootOf: ShadowRootOf = openShadowRoot;
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

  /** The child frames of `frame`, in the order they were registered, as Chrome lists them. */
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
        this.#noteInsertions(records);
        if (touchesFrames(records, this.shadowRootOf)) this.sync();
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
      for (const root of this.#watchedRoots) root.removeEventListener('load', this.#onLoad, true);
      this.#watchedRoots.clear();
    };
  }

  /**
   * Observes a frame's document, or a shadow root in it, for iframes coming and going, and loading
   * (load does not bubble). A document's observer does not see into its shadow trees.
   */
  #watch(root: Document | ShadowRoot): void {
    if (!this.#observer) return;
    this.#observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('load', this.#onLoad, true);
    if (isShadowRoot(root)) this.#watchedRoots.add(root);
  }

  /** Watches a shadow root just attached, which may get iframes before anything else changes. */
  watchShadowRoot(root: ShadowRoot): void {
    if (!closestOwn(root)) this.#watch(root);
  }

  #emit(type: FrameChange['type'], frame: Frame): void {
    for (const listener of this.#listeners) listener({ type, frame });
  }

  /**
   * Numbers the frame owners that mutation records inserted in the order Chrome gives them frames.
   * An `<iframe>` or `<frame>` gets its frame as it is inserted; an `<object>` or `<embed>` only
   * later (in Chrome, when the document next updates its plugins), but before one inserted after it
   * does: inserting another `<object>` or `<embed>` gives the earlier ones theirs first. Chrome,
   * from insertions in one task: `<object>`, `<iframe>`, `<iframe>` → iframe, iframe, object;
   * `<object>`, `<embed>`, `<iframe>` → object, iframe, embed.
   */
  #noteInsertions(records: MutationRecord[]): void {
    let pending: FrameOwner[] = [];
    const flush = () => {
      for (const owner of pending) this.#insertedAt.set(owner, ++this.#insertionSeq);
      pending = [];
    };
    const insert = (owner: FrameOwner) => {
      if (isHtml(owner, 'object') || isHtml(owner, 'embed')) {
        flush();
        pending.push(owner);
      } else this.#insertedAt.set(owner, ++this.#insertionSeq);
    };
    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (const node of Array.from(record.addedNodes)) {
        if (!isElement(node)) continue;
        walkFrameOwners(node, this.shadowRootOf, n => {
          if (!isShadowRoot(n)) insert(n);
        });
      }
    }
    flush();
  }

  /**
   * Brings the registry up to date with the documents: registers same-origin iframes found in
   * them, gives a frame that loaded another document a new loader and execution context, and
   * unregisters frames whose iframe is gone or became cross-origin. Listeners hear of each change.
   */
  sync(): void {
    // Insertions not yet delivered to the observer: another observer's callback may sync first.
    if (this.#observer) this.#noteInsertions(this.#observer.takeRecords());
    this.#syncChildren(this.top);
  }

  #syncChildren(parent: Frame): void {
    const found = new Set<Frame>();
    const owners: FrameOwner[] = [];
    walkFrameOwners(parent.document, this.shadowRootOf, node => {
      if (isShadowRoot(node)) this.#watch(node);
      else owners.push(node);
    });
    const added: { owner: FrameOwner; win: Window; doc: Document }[] = [];
    for (const owner of owners) {
      const doc = contentDocumentOf(owner);
      const win = contentWindowOf(owner);
      let frame = this.#byOwner.get(owner);
      // A moved iframe gets a new browsing context: like Chrome, a new frame.
      if (frame && (frame.window !== win || !doc)) {
        this.#detach(frame);
        frame = undefined;
      }
      if (!doc || !win) continue;
      if (!frame) {
        added.push({ owner, win, doc });
        continue;
      }
      if (frame.document !== doc) {
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
    // New frames come after the ones registered before, like Chrome's, in the order their owners
    // were inserted; owners inserted when no one watched, in tree order.
    const at = (owner: FrameOwner) => this.#insertedAt.get(owner) ?? Number.MAX_SAFE_INTEGER;
    added.sort((a, b) => at(a.owner) - at(b.owner));
    for (const { owner, win, doc } of added) {
      const frame: Frame = {
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

/**
 * Whether a frame still shows the initial `about:blank` its `<iframe>` is about to leave for its
 * `src` or `srcdoc`. Chrome reports no navigation and no execution context for that document:
 * the frame navigates when the document of its `src` or `srcdoc` commits.
 */
export function awaitsFirstDocument(frame: Frame): boolean {
  const { owner } = frame;
  if (!owner || frame.document.URL !== 'about:blank') return false;
  if (owner.hasAttribute('srcdoc')) return true;
  const src = owner.getAttribute(sourceAttribute(owner))?.trim();
  if (!src) return false;
  try {
    return new URL(src, owner.baseURI).href !== 'about:blank';
  } catch {
    return false;
  }
}
