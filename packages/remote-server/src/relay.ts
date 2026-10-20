// Relays CDP messages between one page (a target) and the DevTools frontends inspecting it, and
// keeps DevTools working across page reloads, the way the shell does in the page's own tab
// (relayShell in packages/devtools-anywhere/src/connection.ts): the two are built separately, so
// keep them in step by hand.
//
// Each frontend is a session, as in Chrome: the page runs a CDP server of its own for it
// (packages/devtools-anywhere/src/remote.ts), so that one frontend's domains, node ids and
// remote objects are not another's. Between the relay and the page, a session's messages are
// prefixed with its id and a colon; the relay's own messages (hello, pagehide, detach) are not.
//
// The page says hello when it connects, with its loader id: a new loader id is a new page
// instance (a reload or a navigation), which every frontend is told about, and every `enable`
// command each one sent so far is re-sent to the new page, which then replays its own captured
// output. The same loader id is the same instance back from a dropped connection: it sends
// what it queued meanwhile, and nothing is replayed. The hello lists the sessions the page
// still has servers for: those this relay does not know (it is a new one: the server restarted, or
// the target was forgotten) are detached.

/** Sent by the page when it connects, and again when what the target list shows changes. */
export const HELLO_METHOD = 'DevtoolsAnywhere.hello';
/** Sent by the page on pagehide: the commands it did not answer never will be. */
export const PAGEHIDE_METHOD = 'DevtoolsAnywhere.pagehide';
/** Sent to the page when a session ends: its CDP server stops (its domains are disabled). */
export const DETACH_METHOD = 'DevtoolsAnywhere.detach';
/** Prefix of ids the relay uses for its own commands (no client waits for their responses). */
const RELAY_ID_PREFIX = 'relay-';
/** Chrome's error for commands that were pending when the inspected document went away. */
const NAVIGATED_ERROR = { code: -32000, message: 'Inspected target navigated or closed' };
/** Messages kept for a page that is not connected; the oldest go first. */
const MAX_QUEUED = 10_000;
/** Their total length (in UTF-16 code units), past which the oldest go too. */
const MAX_QUEUED_SIZE = 64 * 1024 * 1024;
/** The error a command gets when it is dropped from the queue, never to reach the page. */
const DROPPED_ERROR = { code: -32000, message: 'Too many messages queued for the page' };

/** One end of the relay: a WebSocket, as far as the relay is concerned. */
export interface Peer {
  send(message: string): void;
  close(code: number, reason: string): void;
}

/** What the target list shows of a page, from its hello. */
export interface TargetInfo {
  url: string;
  title: string;
  favicon: string;
  userAgent: string;
}

/** A CDP message as the relay sees it: only the fields it routes by are checked. */
interface Envelope {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function parse(data: string): Envelope | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isId = (id: unknown): id is string | number => typeof id === 'string' || typeof id === 'number';
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** One frontend's session with the page. */
interface Session {
  id: number;
  client: Peer;
  /** `enable` commands the client sent, with their params, to re-send to a new page instance. */
  enabled: Map<string, unknown>;
  /** Ids of its commands sent to the current page instance and not answered yet. */
  pending: Map<string | number, string>;
  /** `enable` commands answered between pagehide and the next hello, not sent to the page. */
  deferred: Set<string>;
}

/** A page as the relay knows it, from its first connection on. */
export class Target {
  info: TargetInfo = { url: '', title: '', favicon: '', userAgent: '' };
  /** When the page first connected, and when it last connected or went away. */
  readonly since = Date.now();
  changed = Date.now();
  private page: Peer | undefined;
  private sessions = new Map<Peer, Session>();
  private bySessionId = new Map<number, Session>();
  /** From the clock: a new relay for the same page (a restarted server) reuses no session id. */
  private sessionSeq = Date.now();
  private loaderId = '';
  /** The current page instance said hello, and has not gone away since. */
  private pageReady = false;
  /** The page's current connection said hello: until then, what is for the page waits behind the queue. */
  private greeted = false;
  private secure = false;
  /** The page's main frame id, from its hello: the same for every instance. */
  private frameId = '';
  /** Messages for the page while it is not connected (with the same instance, or the first). */
  private toPage: string[] = [];
  private queuedSize = 0;
  private seq = 0;

  constructor(readonly id: string) {}

  get connected(): boolean {
    return this.page !== undefined;
  }

  /** How many frontends inspect the page. */
  get clients(): number {
    return this.sessions.size;
  }

  /** The page connected: a new connection replaces the old one. */
  attachPage(page: Peer) {
    this.page?.close(4001, 'Replaced by a new connection');
    this.page = page;
    this.greeted = false;
    this.changed = Date.now();
  }

  detachPage(page: Peer) {
    if (this.page !== page) return;
    this.page = undefined;
    this.changed = Date.now();
  }

  /** A DevTools frontend connected: a session of its own. */
  attachClient(client: Peer) {
    const session: Session = {
      id: ++this.sessionSeq,
      client,
      enabled: new Map(),
      pending: new Map(),
      deferred: new Set(),
    };
    this.sessions.set(client, session);
    this.bySessionId.set(session.id, session);
  }

  detachClient(client: Peer) {
    const session = this.sessions.get(client);
    if (!session) return;
    this.sessions.delete(client);
    this.bySessionId.delete(session.id);
    // Like a new Chrome session for whichever frontend gets the page's server next.
    this.send(JSON.stringify({ method: DETACH_METHOD, params: { session: session.id } }));
  }

  /** A message from the page: one from a connection already replaced is ignored. */
  fromPage(page: Peer, data: string) {
    if (this.page !== page) return;
    const colon = data.indexOf(':');
    if (data.startsWith('{')) {
      const message = parse(data);
      if (message?.method === HELLO_METHOD) this.onHello(record(message.params));
      else if (message?.method === PAGEHIDE_METHOD) this.onPagehide();
      return;
    }
    const session = this.bySessionId.get(Number(data.slice(0, colon)));
    if (!session) return;
    const body = data.slice(colon + 1);
    // Events start with "method"; responses go to the client only while it waits for them.
    if (!body.startsWith('{"method"')) {
      const id = parse(body)?.id;
      if (!isId(id) || !session.pending.delete(id)) return;
    }
    session.client.send(body);
  }

  fromClient(client: Peer, data: string) {
    const session = this.sessions.get(client);
    if (!session) return;
    const { id, method, params } = parse(data) ?? {};
    // Anything else is the page's CDP server's to answer (or reject).
    if (typeof method !== 'string') return this.send(`${session.id}:${data}`);
    if (method.endsWith('.enable')) session.enabled.set(method, params ?? {});
    else if (method.endsWith('.disable')) session.enabled.delete(method.replace(/disable$/, 'enable'));
    if (!isId(id)) return this.send(`${session.id}:${data}`);
    // Between two page instances Chrome fails the command too, and the next may never come.
    if (this.loaderId && !this.pageReady) {
      // The same instance may come back from the back/forward cache: it gets them then.
      if (method.endsWith('.enable')) session.deferred.add(method);
      return this.abandon(session, id, method);
    }
    session.pending.set(id, method);
    this.send(`${session.id}:${data}`);
  }

  private send(data: string) {
    if (this.page && this.pageReady && this.greeted) return this.page.send(data);
    this.toPage.push(data);
    this.queuedSize += data.length;
    while (this.toPage.length > MAX_QUEUED || this.queuedSize > MAX_QUEUED_SIZE) {
      const dropped = this.toPage.shift();
      if (dropped === undefined) break;
      this.queuedSize -= dropped.length;
      this.drop(dropped);
    }
  }

  /** A queued message will never reach the page: the client waiting for it gets an error. */
  private drop(data: string) {
    if (data.startsWith('{')) return;
    const colon = data.indexOf(':');
    const session = this.bySessionId.get(Number(data.slice(0, colon)));
    const id = session && parse(data.slice(colon + 1))?.id;
    if (session && isId(id) && session.pending.delete(id)) {
      session.client.send(JSON.stringify({ id, error: DROPPED_ERROR }));
    }
  }

  /**
   * Answers a client command the page will never answer. `enable` commands succeed: they are
   * re-sent to the next page instance anyway.
   */
  private abandon(session: Session, id: string | number, method: string) {
    if (method.endsWith('.enable')) session.client.send(JSON.stringify({ id, result: {} }));
    else session.client.send(JSON.stringify({ id, error: NAVIGATED_ERROR }));
  }

  /** The page instance went away: commands it did not answer never will be. */
  private abandonAll() {
    for (const session of this.sessions.values()) {
      for (const [id, method] of session.pending) this.abandon(session, id, method);
      session.pending.clear();
    }
    // The relay's own messages (detach) are still for the page: only session messages go.
    this.toPage = this.toPage.filter(data => data.startsWith('{'));
    this.queuedSize = this.toPage.reduce((size, data) => size + data.length, 0);
  }

  private onPagehide() {
    this.pageReady = false;
    this.abandonAll();
  }

  private onHello(params: Record<string, unknown>) {
    this.info = {
      url: text(params['url']),
      title: text(params['title']),
      favicon: text(params['favicon']),
      userAgent: text(params['userAgent']),
    };
    this.secure = params['secure'] === true;
    this.frameId = text(params['frameId']);
    this.greeted = true;
    // Servers of sessions from before this relay: no frontend of its own will ever end them.
    const stale = Array.isArray(params['sessions']) ? params['sessions'] : [];
    for (const id of stale) {
      if (!this.bySessionId.has(Number(id)))
        this.send(JSON.stringify({ method: DETACH_METHOD, params: { session: id } }));
    }
    const loaderId = text(params['loaderId']);
    const first = !this.loaderId;
    const sameInstance = loaderId === this.loaderId && this.pageReady;
    // A hello from the instance that is connected only updates what the list shows.
    if (sameInstance && this.toPage.length === 0) return;
    this.pageReady = true;
    if (first || sameInstance) {
      this.loaderId = loaderId;
      return this.flush();
    }
    // The instance came back after pagehide (from the back/forward cache), or a new one.
    const navigated = loaderId !== this.loaderId;
    this.loaderId = loaderId;
    this.abandonAll();
    this.flush();
    for (const session of this.sessions.values()) {
      if (navigated) this.navigated(session, loaderId);
      else this.resend(session);
      session.deferred.clear();
    }
  }

  private flush() {
    const queued = this.toPage.splice(0);
    this.queuedSize = 0;
    for (const data of queued) this.page?.send(data);
  }

  /** Sends the instance back from the back/forward cache the `enable`s answered while it was away. */
  private resend(session: Session) {
    for (const method of session.deferred) {
      if (!session.enabled.has(method)) continue;
      const params = session.enabled.get(method);
      this.send(`${session.id}:${JSON.stringify({ id: RELAY_ID_PREFIX + ++this.seq, method, params })}`);
    }
  }

  /** Tells a client a new page instance replaced the old one, and replays its `enable`s. */
  private navigated(session: Session, loaderId: string) {
    const url = this.info.url;
    let origin = '';
    let localhost = false;
    try {
      const parsed = new URL(url);
      // As Chrome serializes it (location.origin), where the URL standard says "null".
      origin = parsed.protocol === 'file:' ? 'file://' : parsed.origin;
      localhost = /^(.+\.)?localhost$|^127(\.\d+){3}$|^\[::1\]$/.test(parsed.hostname);
    } catch {
      // Not a URL: the frame then has no security origin.
    }
    // Events only of the domains the client enabled, as Chrome sends them.
    const { enabled } = session;
    if (enabled.has('Runtime.enable')) {
      session.client.send(JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }));
    }
    if (enabled.has('Page.enable'))
      session.client.send(
        JSON.stringify({
          method: 'Page.frameNavigated',
          params: {
            frame: {
              id: this.frameId,
              loaderId,
              url,
              domainAndRegistry: '',
              securityOrigin: origin,
              mimeType: 'text/html',
              secureContextType: !this.secure ? 'InsecureScheme' : localhost ? 'SecureLocalhost' : 'Secure',
              crossOriginIsolatedContextType: 'NotIsolated',
              gatedAPIFeatures: [],
            },
            type: 'Navigation',
          },
        })
      );
    for (const [method, params] of session.enabled) {
      this.send(`${session.id}:${JSON.stringify({ id: RELAY_ID_PREFIX + ++this.seq, method, params })}`);
    }
    // The Elements panel requests the new page's document.
    if (enabled.has('DOM.enable')) session.client.send(JSON.stringify({ method: 'DOM.documentUpdated', params: {} }));
  }
}
