import { FRAME_ID } from './context';

/**
 * Cross-origin iframes as child targets (docs/roadmap.md, "iframes"; what Chrome does is in
 * test-support/oopif-notes.md). An iframe whose page loads the probe too, and whose origin and
 * the parent's trust each other, gets a link: a MessagePort carrying CDP messages between the
 * parent's agent and the iframe's own. The parent's Target domain announces it as an `iframe`
 * target and routes the frontend's messages to it by `sessionId`, each client's over a session of
 * its own with the iframe's agent, as Chrome gives each client its own session with a target.
 *
 * This file is the contract between the two halves: the handshake that makes links
 * (trust, the probe attributes, the port) and the Target domain that uses them.
 */

/**
 * A session of one of the parent's clients with the iframe's agent, over the link: CDP messages
 * without `sessionId`, both ways.
 */
export interface ChildSession {
  send(message: string): void;
  onMessage(listener: (message: string) => void): () => void;
  /** Listens to the session's end: closed by either end, or the link closed. */
  onClose(listener: () => void): () => void;
  /**
   * Ends the session, as a client disconnecting from Chrome: what it enabled in the iframe's
   * agent is disabled, and its node ids and remote objects are forgotten.
   */
  close(): void;
}

/** The parent's end of a link to a cross-origin iframe's agent. */
export interface ChildLink {
  /** The iframe (or `<object>`, `<embed>`) element in the parent's document. */
  readonly owner: Element;
  /** The frame id the parent gave the iframe: the child target's id, as in Chrome. */
  readonly frameId: string;
  /**
   * Sends a CDP message (without `sessionId`) to the iframe's agent, on a session of the parent
   * agent's own (askChild, the Input domain's forwarding), no client's.
   */
  send(message: string): void;
  /** Listens to the iframe agent's CDP messages on that session: responses and events, without `sessionId`. */
  onMessage(listener: (message: string) => void): () => void;
  /** Opens a new session with the iframe's agent, for a client that attaches the target. */
  openSession(): ChildSession;
  /**
   * Listens to the link's end: the iframe navigated away, was removed, or closed it. The target
   * may outlive it (ChildTargets.onGone), for the iframe's next document.
   */
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
  /** Listens to the sessions the parent opens for its clients ({@link ChildLink.openSession}). */
  onSession(listener: (session: ChildSession) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

type Listener<T> = (value: T) => void;

/**
 * How long, in ms, a cross-origin iframe's target outlives its link while the element is still
 * there: for the iframe's next document (a reload, a navigation) to link again and carry the
 * target on, as Chrome keeps the target across the iframe's navigations.
 */
export const RELINK_TIMEOUT = 10_000;
/**
 * How long, in ms, once the iframe's next document has loaded: one with the probe has said hello
 * by then, and one without it (or not trusting this page) never will.
 */
export const RELINK_AFTER_LOAD = 2000;

/**
 * Prefix of the ids of an agent's own commands to an iframe's agent (askChild, the Target
 * domain's replays): their responses are not the client's, and are not passed on to it.
 */
export const OWN_ID_PREFIX = 'target-own-';
let ownSeq = 0;

function parse(message: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(message);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sends the iframe's agent a command of this agent's own, the response to which no client sees;
 * resolves with its result, or undefined on an error, when the link closes or after `timeout` ms.
 */
export function askChild(link: ChildLink, method: string, params: object, timeout: number): Promise<unknown> {
  const id = `${OWN_ID_PREFIX}${++ownSeq}`;
  return new Promise(resolve => {
    const done = (result: unknown) => {
      off();
      offClose();
      clearTimeout(timer);
      resolve(result);
    };
    const off = link.onMessage(message => {
      if (!message.includes(id)) return;
      const parsed = parse(message);
      if (parsed?.['id'] === id) done(parsed['result']);
    });
    const offClose = link.onClose(() => done(undefined));
    const timer = setTimeout(() => done(undefined), timeout);
    link.send(JSON.stringify({ id, method, params }));
  });
}

/** The links of a page's agent: to its cross-origin iframes, and to its parent if it is one. */
export class ChildTargets {
  readonly #children = new Set<ChildLink>();
  readonly #listeners = new Set<(link: ChildLink, previous: ChildLink | undefined) => void>();
  /** The last links of targets kept for the iframe's next document, by frame id, with what stops waiting. */
  readonly #between = new Map<string, { link: ChildLink; stop: () => void }>();
  readonly #goneListeners = new Set<Listener<ChildLink>>();
  #parent: ParentLink | undefined;
  readonly #parentListeners = new Set<Listener<ParentLink>>();
  readonly #ids = new WeakMap<Element, string>();

  /**
   * The frame id of a frame owner's element, the same for the handshake (which sends it to a
   * cross-origin iframe), the DOM and Target domains (which report it) and the frame registry
   * (which gives it to a same-origin iframe's frame): like Chrome's, a frame's id outlives its
   * navigations, to another origin and back too, until the element is removed or moved
   * ({@link forget}). Unique across pages: the frontend sees the frames of every linked page in
   * one tree.
   */
  frameIdOf(owner: Element): string {
    let id = this.#ids.get(owner);
    if (id === undefined) {
      id = `${FRAME_ID}-${Math.random().toString(36).slice(2)}`;
      this.#ids.set(owner, id);
    }
    return id;
  }

  /** Forgets the frame id of an element removed or moved: its next frame is a new one, as in Chrome. */
  forget(owner: Element): void {
    this.#ids.delete(owner);
  }

  /**
   * Called by the handshake when a cross-origin iframe is linked: a new target, or the one the
   * element's previous link left, which this link carries on.
   */
  addChild(link: ChildLink): void {
    const previous = this.#between.get(link.frameId);
    previous?.stop();
    this.#between.delete(link.frameId);
    this.#children.add(link);
    link.onClose(() => this.#closed(link));
    this.#listeners.forEach(listener => listener(link, previous?.link));
  }

  /**
   * A link closed: its target ends at once when its element is gone, and is kept a while
   * otherwise ({@link RELINK_TIMEOUT}), for the iframe's next document.
   */
  #closed(link: ChildLink): void {
    this.#children.delete(link);
    const { owner, frameId } = link;
    if (!owner.isConnected) return this.#gone(link);
    let timer = setTimeout(() => this.end(owner), RELINK_TIMEOUT);
    const onLoad = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.end(owner), RELINK_AFTER_LOAD);
    };
    owner.addEventListener('load', onLoad);
    const stop = () => {
      clearTimeout(timer);
      owner.removeEventListener('load', onLoad);
    };
    this.#between.set(frameId, { link, stop });
  }

  #gone(link: ChildLink): void {
    this.#goneListeners.forEach(listener => listener(link));
  }

  /**
   * Ends the target that the element's last link left, if it is kept for the iframe's next
   * document: the element was removed, the page leaves, or the iframe came back to this page's
   * origin and is a frame of this page again.
   */
  end(owner: Element): void {
    // A link still open is done with too: its document is gone, or going.
    for (const link of this.#children) if (link.owner === owner) link.close();
    for (const [frameId, { link, stop }] of this.#between) {
      if (link.owner !== owner) continue;
      stop();
      this.#between.delete(frameId);
      this.#gone(link);
    }
  }

  /** Listens to targets ending, each with its last link, closed by then; returns its removal. */
  onGone(listener: Listener<ChildLink>): () => void {
    this.#goneListeners.add(listener);
    return () => this.#goneListeners.delete(listener);
  }

  children(): Iterable<ChildLink> {
    return this.#children;
  }

  /** The link of a cross-origin iframe's element, if it has one. */
  childOf(owner: Element): ChildLink | undefined {
    for (const link of this.#children) if (link.owner === owner) return link;
    return undefined;
  }

  /**
   * Listens to new links; returns its removal. `previous` is the closed link whose target the new
   * one carries on (the iframe's previous document's), if any.
   */
  onChild(listener: (link: ChildLink, previous: ChildLink | undefined) => void): () => void {
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
