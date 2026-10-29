// The relay between a page's CDP session and the DevTools frontends inspecting it, shared by shell
// mode (ShellRelay in packages/devtools-anywhere/src/connection.ts: one frontend, the page in an
// iframe) and the remote server (Target in packages/remote-server/src/relay.ts: any number of
// frontends, the page over a WebSocket). Internal: bundled into both, never published.
//
// Each frontend is a session, as in Chrome. The core keeps, per session, the `enable` commands it
// sent and the commands the page has not answered; how messages reach the page (a prefix per
// session, or none) is the subclass's.
//
// The page says hello with its loader id: a new loader id is a new page instance (a reload or a
// navigation), which every frontend is told about, and every `enable` command each one sent so
// far is re-sent to the new page, which then replays its own captured output. The same loader id
// after pagehide is the same instance back from the back/forward cache: it gets the `enable`s
// answered while it was away. The same loader id while the page is ready only flushes what was
// queued (a dropped connection, a repeated hello).

export * from './protocol.js';

// The core runs in the shell (a browser) and in the remote server (Node): of their globals it
// only uses URL, which both have. Declared for this module only, instead of taking in either's
// lib, so that nothing else of theirs is used by mistake and no global clashes with theirs.
declare const URL: new (url: string) => {
  readonly protocol: string;
  readonly origin: string;
  readonly hostname: string;
};

/** Prefix of ids the relay uses for its own commands (no frontend waits for their responses). */
const RELAY_ID_PREFIX = 'relay-';
/** Chrome's error for commands that were pending when the inspected document went away. */
const NAVIGATED_ERROR = { code: -32000, message: 'Inspected target navigated or closed' };
/** Messages kept for a page that cannot take them yet; the oldest go first. */
const MAX_QUEUED = 10_000;
/** Their total length (in UTF-16 code units), past which the oldest go too. */
const MAX_QUEUED_SIZE = 64 * 1024 * 1024;
/** The error a command gets when it is dropped from the queue, never to reach the page. */
const DROPPED_ERROR = { code: -32000, message: 'Too many messages queued for the page' };
/** The `enable` whose result only the page has (Chrome always returns a debuggerId): it waits for one. */
const HELD_ENABLE = 'Debugger.enable';

/** A DevTools frontend, as far as the relay is concerned. */
export interface Client {
  send(message: string): void;
}

/** One frontend's session with the page. */
export interface Session {
  readonly id: number;
  readonly client: Client;
  /** `enable` commands the client sent, with their params, to re-send to a new page instance. */
  readonly enabled: Map<string, unknown>;
  /** Ids of its commands sent to the current page instance and not answered yet. */
  readonly pending: Map<string | number, string>;
  /** `enable` commands answered between pagehide and the next hello, not sent to the page. */
  readonly deferred: Set<string>;
  /** Ids of its Debugger.enable commands the page went away from: the next instance answers them. */
  readonly held: Set<string | number>;
}

/** The page's main frame, for the `Page.frameNavigated` a new instance is reported with. */
export interface Frame {
  id: string;
  url: string;
  /** Whether the page is a secure context. */
  secure: boolean;
}

/** A CDP message as the relay sees it: only the fields it routes by are checked. */
export interface Envelope {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export function parse(data: string): Envelope | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export const isId = (id: unknown): id is string | number => typeof id === 'string' || typeof id === 'number';

/** A message waiting for the page: a session's, or the relay's own (no session). */
interface Queued {
  session: Session | undefined;
  data: string;
}

export abstract class RelayCore {
  protected readonly sessions = new Map<number, Session>();
  /** From the clock: a new relay for the same page (a restarted server) reuses no session id. */
  private sessionSeq = Date.now();
  private loaderId = '';
  /** The current page instance said hello, and has not gone away since. */
  private pageReady = false;
  private queue: Queued[] = [];
  private queuedSize = 0;
  private seq = 0;

  /** Whether the page can take messages now, besides its instance being ready (connected, greeted). */
  protected abstract canDeliver(): boolean;
  /** Sends the page a message: one of `session`'s, or the relay's own. */
  protected abstract deliver(session: Session | undefined, data: string): void;
  /** The page's main frame as it is now. */
  protected abstract frame(): Frame;

  protected openSession(client: Client): Session {
    const session: Session = {
      id: ++this.sessionSeq,
      client,
      enabled: new Map(),
      pending: new Map(),
      deferred: new Set(),
      held: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  protected closeSession(session: Session) {
    this.sessions.delete(session.id);
    // Nothing is answered to a frontend that is gone, not even a command dropped from the queue.
    session.pending.clear();
    session.held.clear();
  }

  /** A message from a frontend: CDP, as Chrome takes it. */
  protected clientMessage(session: Session, data: string) {
    const { id, method, params } = parse(data) ?? {};
    // Anything else is the page's CDP session's to answer (or reject).
    if (typeof method !== 'string') return this.send(session, data);
    if (method.endsWith('.enable')) session.enabled.set(method, params ?? {});
    else if (method.endsWith('.disable')) {
      const enable = method.replace(/disable$/, 'enable');
      session.enabled.delete(enable);
      // A held Debugger.enable the frontend disabled since is not sent to the next instance.
      if (enable === HELD_ENABLE) this.release(session);
    }
    if (!isId(id)) return this.send(session, data);
    // Between two page instances Chrome fails the command too, and the next may never come.
    if (this.loaderId && !this.pageReady) {
      // The same instance may come back from the back/forward cache: it gets them then.
      if (method.endsWith('.enable')) session.deferred.add(method);
      return this.abandon(session, id, method);
    }
    session.pending.set(id, method);
    this.send(session, data);
  }

  /** A message from the page for `session`: events go on, responses only while the frontend waits. */
  protected pageMessage(session: Session, body: string) {
    if (!body.startsWith('{"method"')) {
      const id = parse(body)?.id;
      if (!isId(id) || !session.pending.delete(id)) return;
    }
    session.client.send(body);
  }

  /** Sends the page one of the relay's own messages, queued like the sessions' ones. */
  protected sendOwn(data: string) {
    this.send(undefined, data);
  }

  /** The page instance went away: commands it did not answer never will be. */
  protected pagehide() {
    this.pageReady = false;
    this.abandonAll();
  }

  /** The page said hello, with its loader id. */
  protected hello(loaderId: string) {
    const first = !this.loaderId;
    const sameInstance = loaderId === this.loaderId && this.pageReady;
    if (sameInstance && this.queue.length === 0) return;
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

  /** Sends what waited for the page, now that it can take it. */
  protected flush() {
    const queued = this.queue.splice(0);
    this.queuedSize = 0;
    for (const { session, data } of queued) this.deliver(session, data);
  }

  private send(session: Session | undefined, data: string) {
    if (this.pageReady && this.canDeliver()) return this.deliver(session, data);
    this.queue.push({ session, data });
    this.queuedSize += data.length;
    while (this.queue.length > MAX_QUEUED || this.queuedSize > MAX_QUEUED_SIZE) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.queuedSize -= dropped.data.length;
      this.drop(dropped);
    }
  }

  /** A queued message will never reach the page: the frontend waiting for it gets an error. */
  private drop({ session, data }: Queued) {
    const id = session && parse(data)?.id;
    if (session && isId(id) && session.pending.delete(id)) {
      session.client.send(JSON.stringify({ id, error: DROPPED_ERROR }));
    }
  }

  /**
   * Answers a frontend command the page will never answer. `enable` commands succeed: they are
   * re-sent to the next page instance anyway. Debugger.enable waits for that instance's answer.
   */
  private abandon(session: Session, id: string | number, method: string) {
    if (method === HELD_ENABLE) session.held.add(id);
    else if (method.endsWith('.enable')) session.client.send(JSON.stringify({ id, result: {} }));
    else session.client.send(JSON.stringify({ id, error: NAVIGATED_ERROR }));
  }

  /** Fails the session's held Debugger.enable commands, as Chrome fails those of a gone document. */
  private release(session: Session) {
    for (const id of session.held) session.client.send(JSON.stringify({ id, error: NAVIGATED_ERROR }));
    session.held.clear();
  }

  private abandonAll() {
    for (const session of this.sessions.values()) {
      for (const [id, method] of session.pending) this.abandon(session, id, method);
      session.pending.clear();
    }
    // The relay's own messages (detach) are still for the page: only the sessions' ones go.
    this.queue = this.queue.filter(queued => !queued.session);
    this.queuedSize = this.queue.reduce((size, queued) => size + queued.data.length, 0);
  }

  private command(session: Session, method: string, params: unknown) {
    this.send(session, JSON.stringify({ id: RELAY_ID_PREFIX + ++this.seq, method, params }));
  }

  /** Sends the instance back from the back/forward cache the `enable`s answered while it was away. */
  private resend(session: Session) {
    const held = this.sendHeld(session);
    for (const method of session.deferred) {
      if (!session.enabled.has(method) || (held && method === HELD_ENABLE)) continue;
      this.command(session, method, session.enabled.get(method));
    }
  }

  /** Sends the new page instance the frontend's held Debugger.enable commands, under their own ids. */
  private sendHeld(session: Session): boolean {
    if (session.held.size === 0) return false;
    const params = session.enabled.get(HELD_ENABLE) ?? {};
    for (const id of session.held) {
      session.pending.set(id, HELD_ENABLE);
      this.send(session, JSON.stringify({ id, method: HELD_ENABLE, params }));
    }
    session.held.clear();
    return true;
  }

  /** Tells a frontend a new page instance replaced the old one, and replays its `enable`s. */
  private navigated(session: Session, loaderId: string) {
    const { id, url, secure } = this.frame();
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
    // Events only of the domains the frontend enabled, as Chrome sends them.
    const { enabled, client } = session;
    if (enabled.has('Runtime.enable')) {
      client.send(JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }));
    }
    if (enabled.has('Page.enable'))
      client.send(
        JSON.stringify({
          method: 'Page.frameNavigated',
          params: {
            frame: {
              id,
              loaderId,
              url,
              domainAndRegistry: '',
              securityOrigin: origin,
              mimeType: 'text/html',
              secureContextType: !secure ? 'InsecureScheme' : localhost ? 'SecureLocalhost' : 'Secure',
              crossOriginIsolatedContextType: 'NotIsolated',
              gatedAPIFeatures: [],
            },
            type: 'Navigation',
          },
        })
      );
    const held = this.sendHeld(session);
    for (const [method, params] of enabled) {
      if (held && method === HELD_ENABLE) continue;
      this.command(session, method, params);
    }
    // The Elements panel requests the new page's document.
    if (enabled.has('DOM.enable')) client.send(JSON.stringify({ method: 'DOM.documentUpdated', params: {} }));
  }
}
