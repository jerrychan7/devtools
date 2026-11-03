import { childTargets } from './child-targets';
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
  /** The top frame's changes once, when the page in a cross-origin iframe is linked to its parent ({@link FrameRegistry.link}). */
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

/** Where the page, in a cross-origin iframe, is in its parent's frame tree once linked to it. */
export interface ParentFrame {
  /** The frame id the parent gave the iframe: the top frame's id from then on. */
  frameId: string;
  /** The parent's frame that holds the iframe. */
  parentFrameId: string;
}

/**
 * The frame of a sandboxed iframe (no allow-same-origin) showing a same-origin or `about:`
 * document: opaque, so out of reach, yet Chrome keeps it in the page's frame tree, with no child
 * target. Its document is not known: its URL is the iframe's `src` (or `srcdoc`) as of its last load.
 */
export interface OpaqueFrame {
  readonly id: string;
  loaderId: string;
  url: string;
  readonly owner: FrameOwner;
  readonly parent: Frame;
  readonly window: Window;
  /** When (epoch ms) its document last committed, as the iframe's load tells; none before. */
  committedAt?: number;
  /** The loader of the document it is loading, once a request for it was seen. */
  pendingLoaderId?: string;
}

/** A change to the opaque frames, as {@link FrameChange} is to the others. */
export interface OpaqueFrameChange {
  type: FrameChange['type'];
  frame: OpaqueFrame;
}

/**
 * The URL a sandboxed iframe without allow-same-origin loads into an opaque document of the
 * parent's origin (or `about:blank`, `about:srcdoc`); undefined for any other owner.
 */
export function opaqueUrlOf(owner: FrameOwner): string | undefined {
  if (!isHtml(owner, 'iframe') || owner.contentDocument || !owner.contentWindow) return undefined;
  const sandbox = owner.getAttribute('sandbox');
  if (sandbox === null || /(^|\s)allow-same-origin(\s|$)/i.test(sandbox)) return undefined;
  if (owner.hasAttribute('srcdoc')) return 'about:srcdoc';
  const src = owner.getAttribute('src')?.trim();
  if (!src) return 'about:blank';
  try {
    const url = new URL(src, owner.baseURI);
    return url.href === 'about:blank' || url.origin === owner.ownerDocument.defaultView?.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
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
 * The page's frames: the top document and the same-origin frames of its frame owners (`<iframe>`,
 * `<frame>`, `<object>`, `<embed>`), which the agent can reach. Cross-origin ones are not
 * registered here: {@link childTargets} exposes them as child targets, under the same frame ids.
 *
 * Iframes are found by {@link sync}, which walks the documents and the shadow trees in them; while
 * anyone listens through
 * {@link onChange}, the registry also watches for iframes being added, removed or loading another
 * document and syncs by itself. Domains look frames up here rather than using FRAME_ID and
 * EXECUTION_CONTEXT_ID.
 */
export class FrameRegistry {
  readonly top: Frame;
  /** The top frame, whose id {@link link} changes. */
  readonly #top: { id: string } & Omit<Frame, 'id'>;
  #parent: ParentFrame | undefined;
  readonly #byWindow = new WeakMap<Window, Frame>();
  readonly #byId = new Map<string, Frame>();
  readonly #byContext = new Map<number, Frame>();
  readonly #byOwner = new WeakMap<Element, Frame>();
  readonly #children = new Map<Frame, Frame[]>();
  readonly #listeners = new Set<(change: FrameChange) => void>();
  readonly #opaque = new Map<FrameOwner, OpaqueFrame>();
  /** Opaque frames whose iframe fired load since the last sync: each load is a new document. */
  readonly #opaqueLoaded = new WeakSet<FrameOwner>();
  readonly #opaqueListeners = new Set<(change: OpaqueFrameChange) => void>();
  /** When each frame was registered, to list opaque frames among the others as Chrome does. */
  readonly #order = new WeakMap<object, number>();
  #orderSeq = 0;
  /**
   * When frame owners were inserted, as read from DOM mutation records: new frames are registered,
   * and listed among their siblings, in this order, as Chrome lists frames in the order it made them.
   */
  readonly #insertedAt = new WeakMap<FrameOwner, number>();
  #insertionSeq = 0;
  #contextSeq = EXECUTION_CONTEXT_ID;
  /** Where the context ids start ({@link setContextIdBase}). */
  #contextBase = 0;
  #observer: MutationObserver | null = null;
  /** Shadow roots watched like documents (load does not cross a shadow boundary). */
  readonly #watchedRoots = new Set<ShadowRoot>();
  /** Set by the agent to reach closed shadow roots too (the probe records them). */
  shadowRootOf: ShadowRootOf = openShadowRoot;
  readonly #onLoad = (event: Event) => {
    if (!isNode(event.target) || !isFrameOwner(event.target)) return;
    if (this.#opaque.has(event.target)) this.#opaqueLoaded.add(event.target);
    this.sync();
  };

  constructor(top: Window) {
    this.#top = {
      id: FRAME_ID,
      loaderId: LOADER_ID,
      executionContextId: EXECUTION_CONTEXT_ID,
      window: top,
      document: top.document,
    };
    this.top = this.#top;
    this.#add(this.top);
  }

  /**
   * The parent's frame holding the page, while the page, in a cross-origin iframe, is linked to
   * its parent: like the main frame of Chrome's iframe target, the top frame then has a parent.
   */
  get parent(): ParentFrame | undefined {
    return this.#parent;
  }

  /**
   * Places the page in its parent's frame tree, linked to it (frame-links/): the top frame takes
   * the id the parent gave the iframe, as the main frame of Chrome's iframe target has the id its
   * parent knows the frame by. A document is linked to one iframe element for its life, which
   * keeps the id it gave (ChildTargets.frameIdOf), so the id changes at most once, and is kept
   * when the link closes; it changes before the link carries anything, while the page's own
   * DevTools is hidden (element/index.ts). Passing undefined leaves the parent's tree.
   */
  link(parent: ParentFrame | undefined): void {
    this.#parent = parent && { ...parent };
    if (!parent || parent.frameId === this.#top.id) return;
    this.#byId.delete(this.#top.id);
    this.#top.id = parent.frameId;
    this.#byId.set(this.#top.id, this.top);
  }

  /**
   * Moves the execution context ids into a namespace that starts at `base` (`ns * 2^32`), for a
   * page whose agent is merged into its parent's (core/merged-frames.ts): the contexts there are
   * renumbered, and those to come counted from there. Set when the merge link is made, before
   * the link carries anything.
   */
  setContextIdBase(base: number): void {
    const shift = base - this.#contextBase;
    if (!shift) return;
    this.#contextBase = base;
    this.#contextSeq += shift;
    const all = Array.from(this.#byContext.values());
    this.#byContext.clear();
    for (const frame of all) {
      frame.executionContextId += shift;
      this.#byContext.set(frame.executionContextId, frame);
    }
  }

  /**
   * The opaque frame a sandboxed iframe's element shows (no child target, see
   * {@link OpaqueFrame}), as of the last sync; undefined for any other element.
   */
  opaqueOf(owner: Element): OpaqueFrame | undefined {
    return isFrameOwner(owner) ? this.#opaque.get(owner) : undefined;
  }

  #add(frame: Frame): void {
    this.#byWindow.set(frame.window, frame);
    this.#byId.set(frame.id, frame);
    this.#byContext.set(frame.executionContextId, frame);
    this.#children.set(frame, []);
    this.#order.set(frame, ++this.#orderSeq);
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

  /** The frame a frame owner (`<iframe>`, `<frame>`, `<object>`, `<embed>`) holds, if registered. */
  ofOwner(owner: Element): Frame | undefined {
    return this.#byOwner.get(owner);
  }

  /** The child frames of `frame`, in the order they were registered, as Chrome lists them. */
  childrenOf(frame: Frame): readonly Frame[] {
    return this.#children.get(frame) ?? [];
  }

  /** The child frames of `frame` with its opaque ones, in the order they were registered. */
  treeChildrenOf(frame: Frame): (Frame | OpaqueFrame)[] {
    const all: (Frame | OpaqueFrame)[] = [...this.childrenOf(frame)];
    for (const opaque of this.#opaque.values()) if (opaque.parent === frame) all.push(opaque);
    const at = (f: object) => this.#order.get(f) ?? 0;
    return all.sort((a, b) => at(a) - at(b));
  }

  /**
   * Listens to changes of the opaque frames; returns a function that stops listening. They are
   * found while anyone listens through {@link onChange}.
   */
  onOpaqueChange(listener: (change: OpaqueFrameChange) => void): () => void {
    this.#opaqueListeners.add(listener);
    return () => this.#opaqueListeners.delete(listener);
  }

  /**
   * The loader id of the opaque frame's document requested at `wallTime` (epoch ms), so that
   * Network gives its request the loader the frame then navigates with, as Chrome does: the
   * current one for a request made before the document committed, else the next one.
   */
  opaqueLoaderId(owner: Element, wallTime: number): string | undefined {
    const frame = isFrameOwner(owner) ? this.#opaque.get(owner) : undefined;
    if (!frame || frame.committedAt === undefined || wallTime < frame.committedAt) return frame?.loaderId;
    return (frame.pendingLoaderId ??= newLoaderId());
  }

  #emitOpaque(type: FrameChange['type'], frame: OpaqueFrame): void {
    for (const listener of this.#opaqueListeners) listener({ type, frame });
  }

  #detachOpaque(frame: OpaqueFrame): void {
    this.#opaque.delete(frame.owner);
    if (!frame.owner.isConnected || contentWindowOf(frame.owner) !== frame.window) childTargets.forget(frame.owner);
    this.#emitOpaque('detached', frame);
  }

  /** Detaches the frames in `frame`'s document, the opaque ones too. */
  #detachChildren(frame: Frame): void {
    for (const child of Array.from(this.childrenOf(frame))) this.#detach(child);
    for (const opaque of Array.from(this.#opaque.values())) if (opaque.parent === frame) this.#detachOpaque(opaque);
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
    // Shadow roots that left the page are let go, not kept with their trees for the page's life.
    for (const root of this.#watchedRoots)
      if (!root.host.isConnected) {
        root.removeEventListener('load', this.#onLoad, true);
        this.#watchedRoots.delete(root);
      }
    this.#syncChildren(this.top);
  }

  #syncChildren(parent: Frame): void {
    const found = new Set<Frame>();
    const owners: FrameOwner[] = [];
    walkFrameOwners(parent.document, this.shadowRootOf, node => {
      if (isShadowRoot(node)) this.#watch(node);
      else owners.push(node);
    });
    const added: { owner: FrameOwner; win: Window; doc?: Document; url?: string }[] = [];
    const opaqueFound = new Set<FrameOwner>();
    for (const owner of owners) {
      const doc = contentDocumentOf(owner);
      const win = contentWindowOf(owner);
      let frame = this.#byOwner.get(owner);
      // A moved iframe gets a new browsing context: like Chrome, a new frame.
      if (frame && (frame.window !== win || !doc)) {
        this.#detach(frame);
        frame = undefined;
      }
      const url = opaqueUrlOf(owner);
      if (url !== undefined && win) {
        opaqueFound.add(owner);
        const opaque = this.#opaque.get(owner);
        if (opaque?.window !== win) {
          if (opaque) this.#detachOpaque(opaque);
          added.push({ owner, win, url });
        } else if (this.#opaqueLoaded.has(owner)) {
          this.#opaqueLoaded.delete(owner);
          opaque.url = url;
          // The first document's loader is the one it was attached with.
          if (opaque.committedAt !== undefined) opaque.loaderId = opaque.pendingLoaderId ?? newLoaderId();
          delete opaque.pendingLoaderId;
          opaque.committedAt = Date.now();
          this.#emitOpaque('navigated', opaque);
        }
        continue;
      }
      if (!doc || !win) continue;
      if (!frame) {
        added.push({ owner, win, doc });
        continue;
      }
      if (frame.document !== doc) {
        // Like Chrome, the old document's frames go before the frame navigates.
        this.#detachChildren(frame);
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
    for (const opaque of Array.from(this.#opaque.values()))
      if (opaque.parent === parent && !opaqueFound.has(opaque.owner)) this.#detachOpaque(opaque);
    for (const { owner, win, doc, url } of added) {
      if (!doc) {
        const opaque: OpaqueFrame = {
          id: childTargets.frameIdOf(owner),
          loaderId: newLoaderId(),
          url: url ?? 'about:blank',
          owner,
          parent,
          window: win,
        };
        this.#opaque.set(owner, opaque);
        this.#order.set(opaque, ++this.#orderSeq);
        this.#emitOpaque('attached', opaque);
        continue;
      }
      const frame: Frame = {
        // The id of the owner's frame, the same whether it is same-origin (here) or cross-origin
        // (a child target's), as Chrome keeps a frame's id when it changes process.
        id: childTargets.frameIdOf(owner),
        loaderId: newLoaderId(),
        executionContextId: ++this.#contextSeq,
        window: win,
        document: doc,
        owner,
        parent,
      };
      this.#add(frame);
      // Back from another origin, the iframe is a frame of this page again: like Chrome, its
      // child target ends first.
      childTargets.end(owner);
      this.#emit('attached', frame);
      found.add(frame);
      this.#syncChildren(frame);
    }
    for (const child of Array.from(this.childrenOf(parent))) if (!found.has(child)) this.#detach(child);
  }

  /** Unregisters a frame and its descendants, the descendants first. */
  #detach(frame: Frame): void {
    this.#detachChildren(frame);
    this.#children.delete(frame);
    this.#byId.delete(frame.id);
    this.#byContext.delete(frame.executionContextId);
    if (this.#byWindow.get(frame.window) === frame) this.#byWindow.delete(frame.window);
    if (frame.owner && this.#byOwner.get(frame.owner) === frame) this.#byOwner.delete(frame.owner);
    // Removed, or moved (another browsing context): like Chrome, the owner's next frame is a new one.
    if (frame.owner && (!frame.owner.isConnected || contentWindowOf(frame.owner) !== frame.window))
      childTargets.forget(frame.owner);
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
  // Only an <iframe> takes srcdoc: in another owner it leaves the document as it is.
  if (isHtml(owner, 'iframe') && owner.hasAttribute('srcdoc')) return true;
  const src = owner.getAttribute(sourceAttribute(owner))?.trim();
  if (!src) return false;
  try {
    return new URL(src, owner.baseURI).href !== 'about:blank';
  } catch {
    return false;
  }
}
