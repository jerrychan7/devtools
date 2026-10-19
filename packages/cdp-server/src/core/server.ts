export type Handler = (params: any) => unknown

/** An error answered to the client as a CDP error response. */
export class CdpError extends Error {
  constructor(
    message: string,
    readonly code = -32000
  ) {
    super(message)
  }
}

/**
 * Transport-agnostic CDP dispatcher. Feed client messages to `dispatch()`, and send every
 * string passed to `onMessage` listeners back to the client.
 */
export class CdpServer {
  private domains = new Map<string, Record<string, Handler>>()
  private listeners = new Set<(message: string) => void>()

  register(domain: string, handlers: Record<string, Handler>) {
    this.domains.set(domain, { ...this.domains.get(domain), ...handlers })
  }

  onMessage(listener: (message: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(method: string, params: object) {
    this.send({ method, params })
  }

  /** Handles one client message and sends the response to the listeners. */
  async dispatch(message: string | { id: number | string; method: string; params?: any }) {
    const { id, method, params } = typeof message === 'string' ? JSON.parse(message) : message
    try {
      this.send({ id, result: await this.call(method, params) })
    } catch (e: any) {
      this.send({
        id,
        error: { code: e instanceof CdpError ? e.code : -32000, message: String(e?.message ?? e) },
      })
    }
  }

  /** Calls a method directly and returns its result, without going through listeners. */
  async call(method: string, params: any = {}): Promise<any> {
    const [domain, name] = method.split('.')
    const handler = this.domains.get(domain)?.[name]
    if (!handler) throw new CdpError(`'${method}' wasn't found`, -32601)
    return (await handler(params ?? {})) ?? {}
  }

  private send(payload: object) {
    const message = JSON.stringify(payload)
    this.listeners.forEach(fn => fn(message))
  }
}
