import {
  type ChildLink,
  type ChildSession,
  type ChildTargets,
  childTargets,
  OWN_ID_PREFIX,
  parse,
} from './child-targets';
import { CdpError, type CdpSession } from './session';

/**
 * Sandboxed iframes merged into the page's agent: an iframe whose `sandbox` lacks
 * allow-same-origin, showing a document of the page's origin, about:blank or about:srcdoc, has an
 * opaque origin, out of the page's reach, yet Chrome keeps it in the page's target (no child
 * target, see core/frames.ts, OpaqueFrame). When data-frame-origins names `sandboxed` and the
 * iframe's page loads the probe, the handshake (frame-links/, `merge` welcome) links its agent
 * here instead of to the Target domain: the frontend sees one target, whose commands for the
 * iframe's nodes, objects, contexts, … go to the iframe's agent, and whose events come from both.
 *
 * Interface for the domains (each registers a table, nothing else):
 *
 * - `mergedFrames.registerRoutes(domain, { routeBy, fanOut })`, once, at module load or in the
 *   domain's register function (a later call for the same domain adds to the earlier one):
 *   - `routeBy`: method → paths of its params (dotted: `'nodeId'`, `'callArgument.objectId'`,
 *     `'args.0.objectId'`) that carry an id. The first path whose value belongs to a merged frame
 *     ({@link ownerOfId}, or that frame's id) sends the whole command, as the client sent it, to
 *     that frame's agent, on the client's session with it; its answer (result or error) is the
 *     client's. A value of no merged frame, or of one gone, leaves the command to the page's own
 *     handler, which answers as for any unknown id.
 *   - `fanOut`: methods without an id (`X.enable`, `X.disable`, `Emulation.*`, …): the page's
 *     handler answers, then the command goes to every merged frame's agent too, whose answers and
 *     errors are ignored (each waited for {@link FAN_OUT_TIMEOUT} ms at most, so that what they
 *     report on enable comes before the client's answer). The last params of each are kept, a
 *     `.disable` dropping its `.enable`, and sent again to a merged frame linked later (a reload).
 * - Ids: a merged frame's agent makes its ids in namespace `ns` (1, 2, …, given by the handshake):
 *   integers (nodeId, backendNodeId, executionContextId) from `ns * 2^32`, strings (objectId,
 *   styleSheetId, scriptId, requestId) prefixed `m{ns}.`; frame ids are the page's own for the
 *   iframe. {@link ownerOfId} tells which: the page's own ids are below 2^32 and unprefixed.
 * - Events of a merged frame's agent reach the client as they are, on the page's session.
 * - Grafting (a result that must include the merged frames', as DOM.getDocument's iframe
 *   contentDocument): the domain asks each frame's agent itself, on the client's session with it,
 *   `mergedFrames.forSession(session).ask(ns, method, params)`, for `ns` of
 *   `mergedFrames.linkOf(owner)` or of each of `mergedFrames.frames()`; `send(ns, message)` sends a
 *   raw message there, whose answer is not awaited. Neither reaches the page's own handlers.
 *
 * Each client (CdpSession of the page's agent) gets a session of its own with each frame's agent,
 * opened when first needed, closed when the client goes (its reset) or the link does.
 */

/** Where the integer ids of namespace `ns` start: `ns * NS_STRIDE`. */
export const NS_STRIDE = 2 ** 32;

/** The prefix of the string ids of namespace `ns`. */
export const nsPrefix = (ns: number) => `m${ns}.`;

/** How long, in ms, a fanned-out command waits for each merged frame's agent. */
export const FAN_OUT_TIMEOUT = 1000;

/** The merged frame (its namespace) an id belongs to, or undefined for the page's own. */
export function ownerOfId(value: unknown): number | undefined {
  if (typeof value === 'number') {
    const ns = Number.isSafeInteger(value) && value > 0 ? Math.floor(value / NS_STRIDE) : 0;
    return ns > 0 ? ns : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /^m([1-9]\d*)\./.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** What a domain registers ({@link MergedFrames.registerRoutes}). */
export interface RouteTable {
  routeBy?: Readonly<Record<string, readonly string[]>>;
  fanOut?: readonly string[];
}

/** A client's session with one merged frame's agent. */
interface Channel {
  readonly link: ChildLink;
  readonly session: ChildSession;
  readonly pending: Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>;
}

/** What one client has with the merged frames. */
interface ClientState {
  readonly channels: Map<number, Channel>;
  /** The fanned-out commands' last params, sent again to frames linked later. */
  readonly kept: Map<string, object>;
}

/** A client's sessions with the merged frames' agents ({@link MergedFrames.forSession}). */
export interface MergedClient {
  /** Asks frame `ns`'s agent, on this client's session with it; rejects with its error. */
  ask(ns: number, method: string, params?: object, timeout?: number): Promise<unknown>;
  /** Sends frame `ns`'s agent a raw CDP message on this client's session with it. */
  send(ns: number, message: string): void;
}

let ownSeq = 0;

const valueAt = (params: object, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, key) => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined),
      params
    );

function errorOf(error: unknown): CdpError {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  const text = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
  const data = typeof error === 'object' && error !== null ? Reflect.get(error, 'data') : undefined;
  return new CdpError(
    typeof text === 'string' ? text : 'Internal error',
    typeof code === 'number' ? code : -32000,
    typeof data === 'string' ? data : undefined
  );
}

export class MergedFrames {
  readonly #targets: ChildTargets;
  /** The links by namespace. */
  readonly #links = new Map<number, ChildLink>();
  /** Each element's namespace, kept across its documents: they are the one frame. */
  readonly #nsOf = new WeakMap<Element, number>();
  #nsSeq = 0;
  readonly #routes = new Map<string, readonly string[]>();
  readonly #fanOut = new Set<string>();
  readonly #clients = new Map<CdpSession, ClientState>();
  readonly #linked = new Set<(ns: number, link: ChildLink) => void>();

  constructor(targets: ChildTargets = childTargets) {
    this.#targets = targets;
  }

  /** The namespace of an element's merged frame, the same for each of its documents. */
  nsFor(owner: Element): number {
    let ns = this.#nsOf.get(owner);
    if (ns === undefined) this.#nsOf.set(owner, (ns = ++this.#nsSeq));
    return ns;
  }

  /**
   * Called by the handshake with a merged frame's link: the clients that set anything up
   * ({@link RouteTable.fanOut}) get a session with it at once, set up the same.
   */
  addMerged(link: ChildLink, ns: number): void {
    this.#links.get(ns)?.close();
    this.#links.set(ns, link);
    this.#targets.addMerged(link);
    link.onClose(() => {
      if (this.#links.get(ns) === link) this.#links.delete(ns);
      for (const state of this.#clients.values()) {
        const channel = state.channels.get(ns);
        if (channel?.link === link) this.#drop(state, ns, channel);
      }
    });
    for (const [session, state] of this.#clients) if (state.kept.size) this.#channel(session, state, ns);
    for (const listener of this.#linked) listener(ns, link);
  }

  /**
   * Calls `listener` with each frame linked from now on, a frame linked again after its document
   * reloaded included (its sessions already set up as the clients set up others); returns its removal.
   */
  onLinked(listener: (ns: number, link: ChildLink) => void): () => void {
    this.#linked.add(listener);
    return () => this.#linked.delete(listener);
  }

  /** The merged frames' namespaces, with their links. */
  frames(): IterableIterator<[number, ChildLink]> {
    return this.#links.entries();
  }

  /** The link and namespace of an element's merged frame, if linked. */
  linkOf(owner: Element): { link: ChildLink; ns: number } | undefined {
    for (const [ns, link] of this.#links) if (link.owner === owner) return { link, ns };
    return undefined;
  }

  /** Adds a domain's routes ({@link RouteTable}); the module comment says how. */
  registerRoutes(domain: string, { routeBy = {}, fanOut = [] }: RouteTable): void {
    for (const [method, paths] of Object.entries(routeBy)) {
      if (!method.startsWith(`${domain}.`)) throw new Error(`${method} is not of ${domain}`);
      this.#routes.set(method, paths);
    }
    for (const method of fanOut) {
      if (!method.startsWith(`${domain}.`)) throw new Error(`${method} is not of ${domain}`);
      this.#fanOut.add(method);
    }
  }

  /** Has `session`'s commands go through the routes from now on; once per session. */
  attach(session: CdpSession): void {
    if (this.#clients.has(session)) return;
    const state: ClientState = { channels: new Map(), kept: new Map() };
    this.#clients.set(session, state);
    session.intercept = (method, params) =>
      this.#fanOut.has(method) ? this.fanOut(session, method, params) : this.route(session, method, params);
    // The client is gone: so are its sessions with the frames, what it enabled there undone.
    session.onReset(() => {
      for (const [ns, channel] of state.channels) this.#drop(state, ns, channel);
      state.kept.clear();
    });
  }

  /** The merged frame (namespace) a command is for, by its routes; undefined for the page's own. */
  ownerOf(method: string, params: object): number | undefined {
    for (const path of this.#routes.get(method) ?? []) {
      const value = valueAt(params, path);
      const ns = ownerOfId(value) ?? this.#nsOfFrameId(value);
      if (ns !== undefined) return ns;
    }
    return undefined;
  }

  /** Sends a command of a merged frame's to its agent: its answer, or undefined for the page's own. */
  route(session: CdpSession, method: string, params: object): Promise<unknown> | undefined {
    const ns = this.ownerOf(method, params);
    if (ns === undefined || !this.#links.has(ns)) return undefined;
    return this.forSession(session).ask(ns, method, params);
  }

  /** Runs a command in the page, then in every merged frame's agent, whose answers are ignored. */
  async fanOut(session: CdpSession, method: string, params: object): Promise<unknown> {
    const result = await session.call(method, params);
    const state = this.#state(session);
    const client = this.forSession(session);
    // Sessions opened here are set up as before this command, which then follows.
    const asked = [...this.#links.keys()].map(ns => client.ask(ns, method, params, FAN_OUT_TIMEOUT));
    if (method.endsWith('.disable')) state.kept.delete(`${method.slice(0, -'.disable'.length)}.enable`);
    else state.kept.set(method, params);
    await Promise.allSettled(asked);
    return result;
  }

  /** A client's sessions with the merged frames' agents. */
  forSession(session: CdpSession): MergedClient {
    const state = this.#state(session);
    return {
      ask: (ns, method, params = {}, timeout) => {
        const channel = this.#channel(session, state, ns);
        if (!channel) return Promise.reject(new CdpError(`${method}: no merged frame ${ns}`));
        const id = `${OWN_ID_PREFIX}m${++ownSeq}`;
        return new Promise((resolve, reject) => {
          const timer =
            timeout === undefined
              ? undefined
              : setTimeout(() => {
                  channel.pending.delete(id);
                  reject(new CdpError(`${method}: the merged frame's agent did not answer in time`));
                }, timeout);
          channel.pending.set(id, {
            resolve: value => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: error => {
              clearTimeout(timer);
              reject(error);
            },
          });
          channel.session.send(JSON.stringify({ id, method, params }));
        });
      },
      send: (ns, message) => this.#channel(session, state, ns)?.session.send(message),
    };
  }

  #state(session: CdpSession): ClientState {
    this.attach(session);
    const state = this.#clients.get(session);
    if (!state) throw new Error('unreachable');
    return state;
  }

  #nsOfFrameId(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    for (const [ns, link] of this.#links) if (link.frameId === value) return ns;
    return undefined;
  }

  /** The client's session with frame `ns`'s agent, opened (and set up as the client set up others) if none. */
  #channel(session: CdpSession, state: ClientState, ns: number): Channel | undefined {
    const link = this.#links.get(ns);
    if (!link) return undefined;
    const open = state.channels.get(ns);
    if (open?.link === link) return open;
    if (open) this.#drop(state, ns, open);
    const channel: Channel = { link, session: link.openSession(), pending: new Map() };
    state.channels.set(ns, channel);
    channel.session.onMessage(message => {
      const id = message.includes(OWN_ID_PREFIX) ? parse(message)?.['id'] : undefined;
      const waiting = typeof id === 'string' ? channel.pending.get(id) : undefined;
      if (typeof id === 'string' && id.startsWith(OWN_ID_PREFIX)) {
        if (!waiting) return;
        channel.pending.delete(id);
        const reply = parse(message);
        const error = reply?.['error'];
        if (typeof error === 'object' && error !== null) waiting.reject(errorOf(error));
        else waiting.resolve(reply?.['result']);
        return;
      }
      // An event: the client's, on the page's session, as Chrome sends the frame's.
      if (!message.includes('"id"') || parse(message)?.['id'] === undefined) session.post(message);
    });
    channel.session.onClose(() => {
      if (state.channels.get(ns) === channel) this.#drop(state, ns, channel);
    });
    // Set up as the client set up the page, in order: the frame starts from nothing.
    for (const [method, params] of state.kept)
      channel.session.send(JSON.stringify({ id: `${OWN_ID_PREFIX}m${++ownSeq}`, method, params }));
    return channel;
  }

  #drop(state: ClientState, ns: number, channel: Channel): void {
    if (state.channels.get(ns) === channel) state.channels.delete(ns);
    const pending = [...channel.pending.values()];
    channel.pending.clear();
    for (const { reject } of pending) reject(new CdpError('Inspected target navigated or closed'));
    channel.session.close();
  }
}

/** The page's merged frames, shared by all sessions, like its links. */
export const mergedFrames = new MergedFrames();
