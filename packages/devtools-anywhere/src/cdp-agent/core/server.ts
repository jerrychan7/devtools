/**
 * A CDP method handler. Each handler declares its own params type; `never` accepts all of
 * them, and the dispatcher passes whatever the client sent.
 */
export type Handler = (params: never) => unknown;

/** Message text of anything thrown. */
export const errorMessage = (e: unknown) => String(e instanceof Error ? e.message : e);

/** An error answered to the client as a CDP error response. */
export class CdpError extends Error {
  readonly code: number;

  constructor(message: string, code = -32000) {
    super(message);
    this.code = code;
  }
}

/**
 * Transport-agnostic CDP dispatcher. Feed client messages to `dispatch()`, and send every
 * string passed to `onMessage` listeners back to the client.
 *
 * @internal
 */
export class CdpServer {
  private domains = new Map<string, Record<string, Handler>>();
  private listeners = new Set<(message: string) => void>();
  private resets = new Set<() => void>();

  register(domain: string, handlers: Record<string, Handler>) {
    this.domains.set(domain, { ...this.domains.get(domain), ...handlers });
  }

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

  emit(method: string, params: object) {
    this.send({ method, params });
  }

  /** Handles one client message and sends the response to the listeners. */
  async dispatch(message: string | { id: number | string; method: string; params?: object }) {
    let parsed: { id?: number | string; method: string; params?: object };
    try {
      parsed = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (e) {
      // Like Chrome, an unparsable message gets an error without an id rather than a rejection.
      this.send({ error: { code: -32700, message: errorMessage(e) } });
      return;
    }
    const { id, method, params } = parsed;
    try {
      this.send({ id, result: await this.call(method, params) });
    } catch (e) {
      this.send({
        id,
        error: { code: e instanceof CdpError ? e.code : -32000, message: errorMessage(e) },
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
