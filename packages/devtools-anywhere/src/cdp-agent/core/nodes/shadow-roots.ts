import type { FrameRegistry } from '../frames/frames';
import { disconnect, microtask, nativeCall, newObserver, observe, takeRecords } from '../natives';
import { isOwn } from './nodes';
import { documentOf, isDocument, isElement, isNode, isShadowRoot } from '../realm';

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
 * - `attachShadow` on a connected host drops it, and tells the {@link onStale} listeners.
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

  readonly #frames: FrameRegistry;
  readonly #shadowRootOf: (host: Element) => ShadowRoot | null;
  readonly #onShadowRoot: (listener: (root: ShadowRoot) => void) => () => void;

  constructor(
    frames: FrameRegistry,
    shadowRootOf: (host: Element) => ShadowRoot | null,
    onShadowRoot: (listener: (root: ShadowRoot) => void) => () => void
  ) {
    this.#frames = frames;
    this.#shadowRootOf = shadowRootOf;
    this.#onShadowRoot = onShadowRoot;
  }

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
    microtask(() => {
      this.#notifying = false;
      this.#staleListeners.forEach(listener => listener());
    });
  }

  /** Starts keeping the list up to date; returns a function that stops (once per call). */
  acquire(): () => void {
    if (!this.#users++) {
      this.#observer = newObserver(records => this.#changed(records));
      this.#observed = new WeakSet();
      this.#stop = [
        this.#frames.onChange(() => {
          // Documents of removed iframes, or navigated away from, while loading never complete.
          const current = new Set(Array.from(this.#frames, f => f.document));
          for (const doc of this.#documents)
            if (!current.has(doc)) {
              doc.removeEventListener('readystatechange', this.#ready);
              this.#documents.delete(doc);
            }
          this.#stale();
        }),
        this.#onShadowRoot(root => {
          // A detached host: inserting it drops the list. A document no frame has (yet): its frame
          // being found drops the list, through the frames.onChange listener above. FrameRegistry
          // finds it in sync(), run by its own observer when an iframe is inserted (touchesFrames)
          // and by its capturing load listener (#onLoad) when one loads another document;
          // #syncChildren then emits attached or navigated. Both only run while someone listens
          // to onChange, which this tracker does while acquired.
          if (!root.host.isConnected || isOwn(root.host)) return;
          const doc = documentOf(root.host);
          if (!Array.from(this.#frames).some(f => f.document === doc)) return;
          // Dropped, not spliced in: a page attaching thousands of roots in one task (custom
          // elements upgraded) walks again once, at the next roots(); and the listeners are told,
          // to look into the new tree (a <style> put in it right after).
          this.#stale();
        }),
      ];
      this.#cache = null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#users) return;
      if (this.#observer) disconnect(this.#observer);
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
    const pending = this.#observer && takeRecords(this.#observer);
    if (pending?.length) this.#changed(pending);
    if (this.#cache) return this.#cache;
    const roots: ShadowRoot[] = [];
    for (const frame of this.#frames) {
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
      const shadowRoot = this.#shadowRootOf(node);
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
    observe(this.#observer, tree, { childList: true, subtree: true });
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
   * Whether `node` or an element under it (outside shadow trees) is a shadow host. Linear in the
   * size of the subtree: inserting or removing a large one walks all of it, once per record.
   */
  #hasHost(node: Node): boolean {
    if (!isElement(node)) return false;
    const walker = documentOf(node).createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let n: Node | null = node; n; n = walker.nextNode())
      if (
        isElement(n) &&
        !isOwn(n) &&
        (this.#shadowRootOf(n) || nativeCall<boolean>(n, 'matches', 'template[shadowrootmode]'))
      )
        return true;
    return false;
  }
}
