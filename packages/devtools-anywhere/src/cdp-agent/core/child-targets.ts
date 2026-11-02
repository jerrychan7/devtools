import { FRAME_ID } from './context';

/**
 * Cross-origin iframes as child targets (docs/roadmap.md, "iframes"; what Chrome does is in
 * test-support/oopif-notes.md). An iframe whose page loads the probe too, and whose origin and
 * the parent's trust each other, gets a link: a MessagePort carrying CDP messages between the
 * parent's agent and the iframe's own. The parent's Target domain announces it as an `iframe`
 * target and routes the frontend's messages to it by `sessionId`.
 *
 * This file is the contract between the two halves: the handshake that makes links
 * (trust, the probe attributes, the port) and the Target domain that uses them.
 */

/** The parent's end of a link to a cross-origin iframe's agent. */
export interface ChildLink {
  /** The iframe (or `<object>`, `<embed>`) element in the parent's document. */
  readonly owner: Element;
  /** The frame id the parent gave the iframe: the child target's id, as in Chrome. */
  readonly frameId: string;
  /** Sends a CDP message (without `sessionId`) to the iframe's agent. */
  send(message: string): void;
  /** Listens to the iframe agent's CDP messages: responses and events, without `sessionId`. */
  onMessage(listener: (message: string) => void): () => void;
  /**
   * Ends the session the iframe's agent has for the link's client, as a new Chrome session
   * starts clean: what it enabled is disabled, and its node ids and remote objects are
   * forgotten. Messages sent after it reach the new session.
   */
  endSession(): void;
  /** Listens to the link's end: the iframe navigated away, was removed, or closed it. */
  onClose(listener: () => void): () => void;
  close(): void;
}

/** The iframe's end of the link: where its agent is in the parent's frame tree. */
export interface ParentLink {
  /** The id the parent gave this frame; the frame tree of the iframe's agent uses it. */
  readonly frameId: string;
  /** The parent's frame that holds the iframe. */
  readonly parentFrameId: string;
  /** The parent page's target id: the `parentId` of this page's target, as in Chrome. */
  readonly parentTargetId: string;
  send(message: string): void;
  onMessage(listener: (message: string) => void): () => void;
  /** Listens to the parent ending its client's session ({@link ChildLink.endSession}). */
  onEndSession(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

type Listener<T> = (value: T) => void;

/** The links of a page's agent: to its cross-origin iframes, and to its parent if it is one. */
export class ChildTargets {
  readonly #children = new Set<ChildLink>();
  readonly #listeners = new Set<Listener<ChildLink>>();
  #parent: ParentLink | undefined;
  readonly #parentListeners = new Set<Listener<ParentLink>>();
  readonly #ids = new WeakMap<Element, string>();

  /**
   * The frame id of a cross-origin iframe's element, the same for the handshake (which sends it
   * to the iframe) and for the DOM and Target domains (which report it), and kept for the
   * element's life: like Chrome, the target outlives the iframe's navigations.
   */
  frameIdOf(owner: Element): string {
    let id = this.#ids.get(owner);
    if (id === undefined) {
      // Unique across pages: the frontend sees the frames of every linked page in one tree.
      id = `${FRAME_ID}-${Math.random().toString(36).slice(2)}`;
      this.#ids.set(owner, id);
    }
    return id;
  }

  /** Called by the handshake when a cross-origin iframe is linked. */
  addChild(link: ChildLink): void {
    this.#children.add(link);
    link.onClose(() => this.#children.delete(link));
    this.#listeners.forEach(listener => listener(link));
  }

  children(): Iterable<ChildLink> {
    return this.#children;
  }

  /** Listens to new children; returns its removal. */
  onChild(listener: Listener<ChildLink>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called by the handshake when this page, in a cross-origin iframe, is linked to its parent. */
  setParent(link: ParentLink): void {
    this.#parent = link;
    link.onClose(() => {
      if (this.#parent === link) this.#parent = undefined;
    });
    this.#parentListeners.forEach(listener => listener(link));
  }

  get parent(): ParentLink | undefined {
    return this.#parent;
  }

  onParent(listener: Listener<ParentLink>): () => void {
    this.#parentListeners.add(listener);
    return () => this.#parentListeners.delete(listener);
  }
}

/** The page's links, shared by all sessions, like its frames. */
export const childTargets = new ChildTargets();
