// Relays CDP messages between one page (a target) and the DevTools frontend inspecting it, and
// keeps DevTools working across page reloads, the way the shell does in the page's own tab
// (relayShell in packages/devtools-anywhere/src/connection.ts): the two are built separately, so
// keep them in step by hand.
//
// The page says hello when it connects, with its loader id: a new loader id is a new page
// instance (a reload or a navigation), which the frontend is told about, and every `enable`
// command it sent so far is re-sent to the new page, which then replays its own captured
// output. The same loader id is the same instance back from a dropped connection: it sends
// what it queued meanwhile, and nothing is replayed.

/** Sent by the page when it connects, and again when what the target list shows changes. */
export const HELLO_METHOD = 'DevtoolsAnywhere.hello';
/** Sent by the page on pagehide: the commands it did not answer never will be. */
export const PAGEHIDE_METHOD = 'DevtoolsAnywhere.pagehide';
/** Prefix of ids the relay uses for its own commands (no client waits for their responses). */
const RELAY_ID_PREFIX = 'relay-';
/** Chrome's error for commands that were pending when the inspected document went away. */
const NAVIGATED_ERROR = { code: -32000, message: 'Inspected target navigated or closed' };
/** Domains that keep state while enabled; a new frontend must start from disabled. */
const STATEFUL_DOMAINS = ['Runtime', 'Network', 'Debugger', 'CSS', 'DOM', 'DOMStorage', 'Overlay', 'WebMCP'];
/** Messages kept for a page that is not connected; the oldest go first. */
const MAX_QUEUED = 10_000;

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

/** A page as the relay knows it, from its first connection on. */
export class Target {
  info: TargetInfo = { url: '', title: '', favicon: '', userAgent: '' };
  /** When the page first connected. */
  readonly since = Date.now();
  private page: Peer | undefined;
  private client: Peer | undefined;
  private loaderId = '';
  /** The current page instance said hello, and has not gone away since. */
  private pageReady = false;
  private secure = false;
  /** The page's main frame id, from its hello: the same for every instance. */
  private frameId = '';
  /** Commands for the page while it is not connected (with the same instance, or the first). */
  private toPage: string[] = [];
  /** `enable` commands the client sent, with their params, to re-send to a new page instance. */
  private enabled = new Map<string, unknown>();
  /** Ids of client commands sent to the current page instance and not answered yet. */
  private pending = new Map<string | number, string>();
  private seq = 0;

  constructor(readonly id: string) {}

  get connected(): boolean {
    return this.page !== undefined;
  }

  get attached(): boolean {
    return this.client !== undefined;
  }

  /** The page connected: a new connection replaces the old one. */
  attachPage(page: Peer) {
    this.page?.close(4001, 'Replaced by a new connection');
    this.page = page;
  }

  detachPage(page: Peer) {
    if (this.page !== page) return;
    this.page = undefined;
  }

  /** A DevTools frontend connected: it takes over from the one before, if any. */
  attachClient(client: Peer) {
    const previous = this.client;
    this.client = client;
    if (previous) {
      previous.close(4002, 'Another DevTools window is inspecting this page');
      this.reset();
    }
  }

  detachClient(client: Peer) {
    if (this.client !== client) return;
    this.client = undefined;
    this.reset();
  }

  fromPage(data: string) {
    const message = parse(data);
    if (message?.method === HELLO_METHOD) return this.onHello(record(message.params));
    if (message?.method === PAGEHIDE_METHOD) return this.onPagehide();
    if (message && 'id' in message) {
      // Responses go to the client that is waiting for them: not to one that connected since.
      if (!isId(message.id) || !this.pending.delete(message.id)) return;
    }
    this.client?.send(data);
  }

  fromClient(data: string) {
    const { id, method, params } = parse(data) ?? {};
    // Anything else is the page's CDP server's to answer (or reject).
    if (typeof method !== 'string') return this.toPageNow(data);
    if (method.endsWith('.enable')) this.enabled.set(method, params ?? {});
    else if (method.endsWith('.disable')) this.enabled.delete(method.replace(/disable$/, 'enable'));
    if (!isId(id)) return this.toPageNow(data);
    // Between two page instances Chrome fails the command too, and the next may never come.
    if (this.loaderId && !this.pageReady) return this.abandon(id, method);
    this.pending.set(id, method);
    this.toPageNow(data);
  }

  private toPageNow(data: string) {
    if (this.page && this.pageReady) return this.page.send(data);
    this.toPage.push(data);
    if (this.toPage.length > MAX_QUEUED) this.toPage.shift();
  }

  /**
   * Answers a client command the page will never answer. `enable` commands succeed: they are
   * re-sent to the next page instance anyway.
   */
  private abandon(id: string | number, method: string) {
    if (method.endsWith('.enable')) this.client?.send(JSON.stringify({ id, result: {} }));
    else this.client?.send(JSON.stringify({ id, error: NAVIGATED_ERROR }));
  }

  private onPagehide() {
    this.pageReady = false;
    for (const [id, method] of this.pending) this.abandon(id, method);
    this.pending.clear();
    this.toPage.length = 0;
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
    for (const [id, method] of this.pending) this.abandon(id, method);
    this.pending.clear();
    this.toPage.length = 0;
    if (!navigated) return;
    this.navigated(loaderId);
  }

  private flush() {
    const queued = this.toPage.splice(0);
    for (const data of queued) this.page?.send(data);
  }

  /** Tells the client a new page instance replaced the old one, and replays its `enable`s. */
  private navigated(loaderId: string) {
    const url = this.info.url;
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      // Not a URL: the frame then has no security origin.
    }
    this.client?.send(JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }));
    this.client?.send(
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
            secureContextType: this.secure ? 'Secure' : 'InsecureScheme',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
          type: 'Navigation',
        },
      })
    );
    for (const [method, params] of this.enabled) {
      this.page?.send(JSON.stringify({ id: RELAY_ID_PREFIX + ++this.seq, method, params }));
    }
    // The Elements panel requests the new page's document.
    this.client?.send(JSON.stringify({ method: 'DOM.documentUpdated', params: {} }));
  }

  /**
   * Like a new Chrome session for the next client: e.g. Debugger.enable and CSS.enable only
   * report scripts and style sheets again after a disable.
   */
  private reset() {
    this.enabled.clear();
    this.pending.clear();
    this.toPage.length = 0;
    if (!this.page || !this.pageReady) return;
    for (const domain of STATEFUL_DOMAINS) {
      this.page.send(JSON.stringify({ id: RELAY_ID_PREFIX + ++this.seq, method: `${domain}.disable`, params: {} }));
    }
  }
}
