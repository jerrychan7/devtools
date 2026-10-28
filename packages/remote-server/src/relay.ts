// Relays CDP messages between one page (a target) and the DevTools frontends inspecting it, and
// keeps DevTools working across page reloads. What happens across reloads is the relay core's
// (packages/relay-core), shared with shell mode; this is the remote server's side of it.
//
// Each frontend is a session, as in Chrome: the page runs a CDP session of its own for it
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

import { RelayCore, parse, type Frame, type Session } from '@devtools-anywhere/relay-core';

/** Sent by the page when it connects, and again when what the target list shows changes. */
export const HELLO_METHOD = 'DevtoolsAnywhere.hello';
/** Sent by the page on pagehide: the commands it did not answer never will be. */
export const PAGEHIDE_METHOD = 'DevtoolsAnywhere.pagehide';
/** Sent to the page when a session ends: its CDP session stops (its domains are disabled). */
export const DETACH_METHOD = 'DevtoolsAnywhere.detach';
/** What a hello's title and url are cut to, in UTF-16 code units: a page cannot fill the server's memory. */
const MAX_TITLE = 4096;
const MAX_URL = 2 * 1024 * 1024;

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

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A page as the relay knows it, from its first connection on. */
export class Target extends RelayCore {
  info: TargetInfo = { url: '', title: '', favicon: '', userAgent: '' };
  /** When the page first connected, and when it last connected or went away. */
  readonly since = Date.now();
  changed = Date.now();
  private page: Peer | undefined;
  private byClient = new Map<Peer, Session>();
  /** The page's current connection said hello: until then, what is for the page waits behind the queue. */
  private greeted = false;
  private secure = false;
  /** The page's main frame id, from its hello: the same for every instance. */
  private frameId = '';

  constructor(readonly id: string) {
    super();
  }

  get connected(): boolean {
    return this.page !== undefined;
  }

  /** How many frontends inspect the page. */
  get clients(): number {
    return this.byClient.size;
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
    this.byClient.set(client, this.openSession(client));
  }

  detachClient(client: Peer) {
    const session = this.byClient.get(client);
    if (!session) return;
    this.byClient.delete(client);
    this.closeSession(session);
    // Like a new Chrome session for whichever frontend gets the page's server next.
    this.sendOwn(JSON.stringify({ method: DETACH_METHOD, params: { session: session.id } }));
  }

  /** A message from the page: one from a connection already replaced is ignored. */
  fromPage(page: Peer, data: string) {
    if (this.page !== page) return;
    if (data.startsWith('{')) {
      const message = parse(data);
      if (message?.method === HELLO_METHOD) this.onHello(record(message.params));
      else if (message?.method === PAGEHIDE_METHOD) this.pagehide();
      return;
    }
    const colon = data.indexOf(':');
    const session = this.sessions.get(Number(data.slice(0, colon)));
    if (session) this.pageMessage(session, data.slice(colon + 1));
  }

  fromClient(client: Peer, data: string) {
    const session = this.byClient.get(client);
    if (session) this.clientMessage(session, data);
  }

  protected override canDeliver() {
    return this.page !== undefined && this.greeted;
  }

  protected override deliver(session: Session | undefined, data: string) {
    this.page?.send(session ? `${session.id}:${data}` : data);
  }

  protected override frame(): Frame {
    return { id: this.frameId, url: this.info.url, secure: this.secure };
  }

  private onHello(params: Record<string, unknown>) {
    this.info = {
      url: text(params['url']).slice(0, MAX_URL),
      title: text(params['title']).slice(0, MAX_TITLE),
      favicon: text(params['favicon']),
      userAgent: text(params['userAgent']),
    };
    this.secure = params['secure'] === true;
    this.frameId = text(params['frameId']);
    this.greeted = true;
    // Servers of sessions from before this relay: no frontend of its own will ever end them.
    const stale = Array.isArray(params['sessions']) ? params['sessions'] : [];
    for (const id of stale) {
      if (!this.sessions.has(Number(id)))
        this.sendOwn(JSON.stringify({ method: DETACH_METHOD, params: { session: id } }));
    }
    this.hello(text(params['loaderId']));
  }
}
