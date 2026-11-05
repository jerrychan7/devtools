import type { FrameRegistry } from './frames';
import { isOwn } from './nodes';
import { documentOf, isDocument, isElement, isNode, isShadowRoot } from './realm';

/**
 * The shadow roots in the frames' documents, in tree order, for the domains that look into
 * shadow trees (a document's `getAnimations()` or `styleSheets` leave them out).
 *
 * The list is cached only while someone {@link acquire}s the tracker, as only then is anything
 * watching for it to go stale:
 * - a shadow host inserted anywhere (in a document or a known shadow tree) drops it: a host that
 *   attached its shadow root while out of the document (common in custom element constructors),
 *   or one given a declarative shadow root by `setHTMLUnsafe` or the parser (`<template
 *   shadowrootmode>` does not go through `attachShadow`); a host removed takes its roots out (so
 *   they are not kept alive nor asked for animations). Other elements leave the list as it is.
 *   While a document is parsed, a declarative root the streaming parser attaches to a host it
 *   inserted in an earlier chunk is only seen with the next host inserted, or at the latest when
 *   parsing ends: the document reaching `interactive` (DOMContentLoaded) and `complete` (load)
 *   drops the list;
 * - the frame tree changing drops it: a new same-origin iframe's document may already hold shadow
 *   roots;
 * - `attachShadow` on a connected host adds the new root (and its subtree) without walking again.
 *
 * Closed declarative shadow roots are not found: they are neither on `host.shadowRoot` nor
 * recorded by the probe, which only sees `attachShadow`; the page itself has no way to reach them.
 */
export class ShadowRootTracker {
  #cache: ShadowRoot[] | null = null;
  #users = 0;
  #observer: MutationObserver | null = null;
  #stop: (() => void)[] = [];
  /** Documents and shadow roots the observer watches. */
  #observed = new WeakSet<Node>();
  /** Documents still loading, whose `readystatechange` drops the list. */
  #documents = new Set<Document>();
  readonly #ready = (event: Event) => {
    this.#stale();
    const doc = event.currentTarget;
    // Nothing more to wait for: not kept alive until release.
    if (isNode(doc) && isDocument(doc) && doc.readyState === 'complete') {
      doc.removeEventListener('readystatechange', this.#ready);
      this.#documents.delete(doc);
    }
  };

  constructor(
    private readonly frames: FrameRegistry,
    private readonly shadowRootOf: (host: Element) => ShadowRoot | null,
    private readonly onShadowRoot: (listener: (root: ShadowRoot) => void) => () => void
  ) {}

  /** Listeners told, once per microtask at most, that the list went stale. */
  #staleListeners = new Set<() => void>();
  #notifying = false;

  /**
   * Calls `listener` (after the current task's microtasks start) whenever the list may have gone
   * stale, cached or not (so not only after a roots() call), for those with nothing else telling them, e.g. a declarative root found when parsing ends.
   * Only while someone holds the tracker; returns a function that stops.
   */
  onStale(listener: () => void): () => void {
    this.#staleListeners.add(listener);
    return () => void this.#staleListeners.delete(listener);
  }

  #stale() {
    this.#cache = null;
    if (this.#notifying || !this.#staleListeners.size) return;
    this.#notifying = true;
    // Not from within roots(), which drops the list on the records it takes.
    queueMicrotask(() => {
      this.#notifying = false;
      this.#staleListeners.forEach(listener => listener());
    });
  }

  /** Starts keeping the list up to date; returns a function that stops (once per call). */
  acquire(): () => void {
    if (!this.#users++) {
      this.#observer = new MutationObserver(records => this.#changed(records));
      this.#observed = new WeakSet();
      this.#stop = [
        this.frames.onChange(() => {
          // Documents of removed iframes, or navigated away from, while loading never complete.
          const current = new Set(Array.from(this.frames, f => f.document));
          for (const doc of this.#documents)
            if (!current.has(doc)) {
              doc.removeEventListener('readystatechange', this.#ready);
              this.#documents.delete(doc);
            }
          this.#stale();
        }),
        this.onShadowRoot(root => {
          const cache = this.#cache;
          // A detached host: inserting it drops the list. A document no frame has (yet): its frame
          // being found drops the list, through the frames.onChange listener above. FrameRegistry
          // finds it in sync(), run by its own observer when an iframe is inserted (touchesFrames)
          // and by its capturing load listener (#onLoad) when one loads another document;
          // #syncChildren then emits attached or navigated. Both only run while someone listens
          // to onChange, which this tracker does while acquired.
          if (!cache || !root.host.isConnected || isOwn(root.host)) return;
          const doc = documentOf(root.host);
          if (!Array.from(this.frames).some(f => f.document === doc)) return;
          // The probe reports a root as attachShadow returns it, so no list holds it yet.
          const added = [root];
          this.#watch(root);
          this.#visit(root, added);
          // In tree order, like a walk: before the first root whose host comes after this one.
          const at = cache.findIndex(r => this.#precedes(root.host, r.host));
          cache.splice(at < 0 ? cache.length : at, 0, ...added);
        }),
      ];
      this.#cache = null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#users) return;
      this.#observer?.disconnect();
      this.#observer = null;
      this.#stop.forEach(stop => stop());
      this.#stop = [];
      for (const doc of this.#documents) doc.removeEventListener('readystatechange', this.#ready);
      this.#documents.clear();
      this.#cache = null;
    };
  }

  /** The shadow roots, walked again only when the cached list is stale (see the class). */
  roots(): ShadowRoot[] {
    // Changes not yet delivered to the observer would leave a stale list.
    const pending = this.#observer?.takeRecords();
    if (pending?.length) this.#changed(pending);
    if (this.#cache) return this.#cache;
    const roots: ShadowRoot[] = [];
    for (const frame of this.frames) {
      this.#watch(frame.document);
      this.#visit(frame.document, roots);
    }
    if (this.#observer) this.#cache = roots;
    return roots;
  }

  #visit(root: Document | ShadowRoot, roots: ShadowRoot[]) {
    const walker = documentOf(root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!isElement(node) || isOwn(node)) continue;
      const shadowRoot = this.shadowRootOf(node);
      if (!shadowRoot) continue;
      roots.push(shadowRoot);
      // The document's observer does not see into shadow trees.
      this.#watch(shadowRoot);
      this.#visit(shadowRoot, roots);
    }
  }

  #watch(tree: Document | ShadowRoot) {
    if (!this.#observer || this.#observed.has(tree)) return;
    this.#observed.add(tree);
    this.#observer.observe(tree, { childList: true, subtree: true });
    if (isShadowRoot(tree) || tree.readyState === 'complete') return;
    // `readystatechange` comes just before DOMContentLoaded, then just before load (on the window).
    tree.addEventListener('readystatechange', this.#ready);
    this.#documents.add(tree);
  }

  /**
   * Only shadow hosts matter: an added one (or a declarative template not yet turned into a root)
   * drops the list; a removed one takes its roots, and the roots in its shadow tree, out of it.
   * Other elements coming or going, the common case, leave the list as it is.
   */
  #changed(records: MutationRecord[]) {
    let removed = false;
    for (const r of records) {
      if (!this.#cache) return;
      for (const n of Array.from(r.addedNodes)) if (this.#hasHost(n)) return this.#stale();
      for (const n of Array.from(r.removedNodes)) removed ||= this.#hasHost(n);
    }
    // A host moved elsewhere is also in an added list, which dropped the list above.
    if (removed && this.#cache) this.#cache = this.#cache.filter(root => root.host.isConnected);
  }

  /**
   * Whether `a` comes before `b` in the order {@link roots} walks them: frame by frame, each
   * document in shadow-including tree order, a shadow tree right after its host.
   */
  #precedes(a: Node, b: Node): boolean {
    const chain = (node: Node) => {
      const list: Node[] = [];
      for (let n: Node | null = node; n; n = isShadowRoot(n) ? n.host : n.parentNode) list.unshift(n);
      return list;
    };
    const [ca, cb] = [chain(a), chain(b)];
    if (ca[0] !== cb[0]) {
      const docs = Array.from(this.frames, f => f.document);
      return docs.indexOf(documentOf(a)) < docs.indexOf(documentOf(b));
    }
    let i = 0;
    while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
    const [x, y] = [ca[i], cb[i]];
    // An ancestor comes first; a host's shadow root before its children.
    if (!x || !y) return !x;
    if (isShadowRoot(x) || isShadowRoot(y)) return isShadowRoot(x);
    return !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  /**
   * Whether `node` or an element under it (outside shadow trees) is a shadow host. Linear in the
   * size of the subtree: inserting or removing a large one walks all of it, once per record.
   */
  #hasHost(node: Node): boolean {
    if (!isElement(node)) return false;
    const walker = documentOf(node).createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let n: Node | null = node; n; n = walker.nextNode())
      if (isElement(n) && !isOwn(n) && (this.shadowRootOf(n) || n.matches('template[shadowrootmode]'))) return true;
    return false;
  }
}
