/**
 * A CDP method handler. Each handler declares its own params type; `never` accepts all of
 * them, and the dispatcher passes whatever the client sent.
 *
 * @internal
 */
export type Handler = (params: never) => unknown;

/** Message text of anything thrown. */
export const errorMessage = (e: unknown) => String(e instanceof Error ? e.message : e);

/** Domains that keep state while enabled; a new frontend instance must start from disabled. */
const STATEFUL_DOMAINS = ['Runtime', 'Network', 'Debugger', 'CSS', 'DOM', 'DOMStorage', 'Overlay', 'WebMCP'];

/**
 * The calls that end what a frontend started in the page, like a new Chrome session: e.g.
 * Debugger.enable and CSS.enable only report scripts and style sheets again after a disable.
 *
 * @internal
 */
export const END_SESSION_CALLS: readonly string[] = [
  ...STATEFUL_DOMAINS.map(domain => `${domain}.disable`),
  'Page.stopScreencast',
];

/** An error answered to the client as a CDP error response. */
export class CdpError extends Error {
  readonly code: number;
  /** Details Chrome adds to some errors (what failed to deserialize). */
  readonly data: string | undefined;

  constructor(message: string, code = -32000, data?: string) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Transport-agnostic CDP dispatcher. Feed client messages to `dispatch()`, and send every
 * string passed to `onMessage` listeners back to the client.
 *
 * @internal
 */
export class CdpSession {
  private domains = new Map<string, Record<string, Handler>>();
  private listeners = new Set<(message: string) => void>();
  private resets = new Set<() => void>();
  /** Where the client's messages for other sessions (child targets') go, by session id. */
  private routes = new Map<string, (message: Record<string, unknown>) => void>();

  /** Adds the handlers of `domain`'s methods, keeping those registered before. */
  register(domain: string, handlers: Record<string, Handler>) {
    this.domains.set(domain, { ...this.domains.get(domain), ...handlers });
  }

  /** Adds a listener for the messages to send to the client; returns its removal. */
  onMessage(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds what `reset()` clears. */
  onReset(fn: () => void) {
    this.resets.add(fn);
  }

  /**
   * Forgets the state of the session that ended (remote objects, node ids, `$0`, `$_`), so that
   * the next client starts like a new Chrome session. Call after disabling the domains.
   */
  reset() {
    this.resets.forEach(fn => fn());
  }

  /**
   * Routes the client's messages carrying `sessionId` (a child target's session, flattened as
   * Chrome does) to `deliver`, as parsed, `sessionId` included; returns its removal.
   */
  route(sessionId: string, deliver: (message: Record<string, unknown>) => void): () => void {
    this.routes.set(sessionId, deliver);
    return () => {
      if (this.routes.get(sessionId) === deliver) this.routes.delete(sessionId);
    };
  }

  /** Sends the client a message as it is: a child target's, carrying its `sessionId`. */
  post(message: string) {
    this.listeners.forEach(fn => fn(message));
  }

  /** Sends the client an event. */
  emit(method: string, params: object) {
    this.send({ method, params });
  }

  /** Handles one client message and sends the response to the listeners. */
  async dispatch(message: string | { id: number | string; method: string; params?: object }) {
    let parsed: unknown;
    try {
      parsed = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (e) {
      // Like Chrome, an unparsable message gets an error without an id rather than a rejection.
      this.send({ error: { code: -32700, message: errorMessage(e) } });
      return;
    }
    // Like Chrome, a malformed message gets -32600, with its id once the id is valid. Unlike
    // Chrome, string ids are accepted too: the relay tags its own requests with them.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.send({ error: { code: -32600, message: 'Message must be an object' } });
      return;
    }
    const { id, method, params, sessionId } = parsed as {
      id?: unknown;
      method?: unknown;
      params?: object;
      sessionId?: unknown;
    };
    if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isInteger(id))) {
      this.send({ error: { code: -32600, message: "Message must have integer 'id' property" } });
      return;
    }
    if (typeof method !== 'string') {
      this.send({ id, error: { code: -32600, message: "Message must have string 'method' property" } });
      return;
    }
    // Like Chrome's flatten mode, a child target's messages carry its session id; '' is none.
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      this.send({ id, error: { code: -32600, message: "Message may have string 'sessionId' property" } });
      return;
    }
    if (sessionId) {
      const deliver = this.routes.get(sessionId);
      // Chrome answers without the session id.
      if (deliver) deliver(parsed as Record<string, unknown>);
      else this.send({ id, error: { code: -32001, message: 'Session with given id not found.' } });
      return;
    }
    try {
      this.send({ id, result: await this.call(method, params) });
    } catch (e) {
      this.send({
        id,
        error:
          e instanceof CdpError && e.data !== undefined
            ? { code: e.code, message: errorMessage(e), data: e.data }
            : { code: e instanceof CdpError ? e.code : -32000, message: errorMessage(e) },
      });
    }
  }

  /** Calls a method directly and returns its result, without going through listeners. */
  async call(method: string, params: object = {}): Promise<unknown> {
    const [domain = '', name = ''] = method.split('.');
    const handlers = this.domains.get(domain);
    // Own properties only: `Runtime.constructor` must not reach Object.prototype.
    const handler = handlers && Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) throw new CdpError(`'${method}' wasn't found`, -32601);
    return (await (handler as (params: object) => unknown)(params ?? {})) ?? {};
  }

  private send(payload: object) {
    const message = JSON.stringify(payload);
    this.listeners.forEach(fn => fn(message));
  }
}
