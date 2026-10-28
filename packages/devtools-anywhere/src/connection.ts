import { FRAME_ID, LOADER_ID, type CdpServer } from './cdp-agent';
import { RelayCore, parse, type Frame, type Session } from '@devtools-anywhere/relay-core';

const HELLO_METHOD = 'DevtoolsAnywhere.hello';
/**
 * Sent by a page in shell mode when its CDP server starts listening, or when pinged. Carries
 * the page's loader id, which the shell needs for the `Page.frameNavigated` it reports.
 */
const HELLO = JSON.stringify({ method: HELLO_METHOD, params: { loaderId: LOADER_ID } });
/** Sent by the shell on startup, in case the page started listening first. */
const PING = JSON.stringify({ method: 'DevtoolsAnywhere.ping' });
/** Domains that keep state while enabled; a new frontend instance must start from disabled. */
export const STATEFUL_DOMAINS = ['Runtime', 'Network', 'Debugger', 'CSS', 'DOM', 'DOMStorage', 'Overlay', 'WebMCP'];

interface Link {
  /** Forgets that the peer has spoken; outgoing messages are queued again. */
  reset(): void;
  disconnect(): void;
}

/**
 * Connects a CDP server to a peer window over postMessage.
 *
 * Only messages whose source is the peer window and whose origin is `origin` are accepted,
 * and outgoing messages are addressed to that origin only. Outgoing messages are queued
 * until the peer sends its first message: before that, its window may still be loading.
 */
function link(server: CdpServer, peer: () => Window | null | undefined, origin: string): Link {
  let ready = false;
  const queue: string[] = [];
  const post = (message: string) => peer()?.postMessage(message, origin);

  const offServer = server.onMessage(message => {
    if (ready) post(message);
    else queue.push(message);
  });
  const onMessage = (event: MessageEvent) => {
    if (event.source !== peer() || event.origin !== origin || typeof event.data !== 'string') return;
    if (event.data === PING) return post(HELLO);
    if (!ready) {
      ready = true;
      queue.splice(0).forEach(post);
    }
    server.dispatch(event.data).catch(() => {
      // Malformed message: there is no id to answer to.
    });
  };
  window.addEventListener('message', onMessage);
  return {
    reset() {
      ready = false;
      queue.length = 0;
    },
    disconnect() {
      offServer();
      window.removeEventListener('message', onMessage);
    },
  };
}

/**
 * Connects a CDP server to a DevTools frontend running in `frame`. When the frame reloads
 * (a new frontend instance), the domains are disabled so that the new instance's `enable`
 * calls replay everything captured so far. Returns a function that disconnects.
 */
export function connectFrontend(server: CdpServer, frame: HTMLIFrameElement, frontendOrigin: string): () => void {
  const connection = link(server, () => frame.contentWindow, frontendOrigin);
  let loads = 0;
  const onLoad = () => {
    if (loads++ === 0) return;
    connection.reset();
    // Like a new Chrome session: e.g. Debugger.enable and CSS.enable only report scripts and
    // style sheets again after a disable.
    for (const domain of STATEFUL_DOMAINS) server.call(`${domain}.disable`).catch(() => {});
  };
  frame.addEventListener('load', onLoad);
  return () => {
    connection.disconnect();
    frame.removeEventListener('load', onLoad);
  };
}

/** Connects the CDP server of a page in shell mode to the shell (its parent window). */
export function connectToShell(server: CdpServer): () => void {
  const connection = link(server, () => window.parent, location.origin);
  window.parent.postMessage(HELLO, location.origin);
  return () => connection.disconnect();
}

/** The shell's side of the relay core: one frontend, in an iframe; the page in another. */
class ShellRelay extends RelayCore {
  private frontendReady = false;
  /** Hellos without a loader id so far. */
  private unknownLoaders = 0;
  private readonly toFrontend: string[] = [];
  private readonly session: Session;

  constructor(
    private readonly page: HTMLIFrameElement,
    private readonly devtools: HTMLIFrameElement,
    private readonly frontendOrigin: string
  ) {
    super();
    this.session = this.openSession({ send: message => this.postFrontend(message) });
  }

  private postFrontend(message: string) {
    if (this.frontendReady) this.devtools.contentWindow?.postMessage(message, this.frontendOrigin);
    else this.toFrontend.push(message);
  }

  protected override canDeliver() {
    return true;
  }

  protected override deliver(_session: Session | undefined, data: string) {
    this.page.contentWindow?.postMessage(data, location.origin);
  }

  protected override frame(): Frame {
    let url = this.page.src;
    let secure = isSecureContext;
    try {
      url = this.page.contentWindow?.location.href ?? url;
      secure = this.page.contentWindow?.isSecureContext ?? secure;
    } catch {
      // Cross-origin page: assume it is like the shell.
    }
    return { id: FRAME_ID, url, secure };
  }

  /** Mirrors the page's URL and title in the address bar and tab. */
  private syncLocation() {
    try {
      const win = this.page.contentWindow;
      const doc = this.page.contentDocument;
      if (!win || !doc) return;
      if (win.location.href !== location.href) history.replaceState(null, '', win.location.href);
      document.title = doc.title;
    } catch {
      // Cross-origin navigation: leave the shell as it is.
    }
  }

  private onPagehide = () => this.pagehide();

  readonly onMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    if (event.source === this.devtools.contentWindow && event.origin === this.frontendOrigin) {
      if (!this.frontendReady) {
        this.frontendReady = true;
        this.toFrontend.splice(0).forEach(message => this.postFrontend(message));
      }
      this.clientMessage(this.session, event.data);
    } else if (event.source === this.page.contentWindow && event.origin === location.origin) {
      if (event.data.startsWith(`{"method":"${HELLO_METHOD}"`)) {
        const params = parse(event.data)?.params;
        // A page without one (an older probe) is a new instance every time, as it always was.
        const loaderId =
          typeof params === 'object' && params !== null && 'loaderId' in params && typeof params.loaderId === 'string'
            ? params.loaderId
            : `unknown-${++this.unknownLoaders}`;
        this.syncLocation();
        this.page.contentWindow?.addEventListener('pagehide', this.onPagehide);
        return this.hello(loaderId);
      }
      this.pageMessage(this.session, event.data);
    }
  };
}

/**
 * Runs in the shell document: relays CDP messages between the DevTools frontend in
 * `devtools` and the page's CDP server in `page`, and keeps DevTools working across page
 * reloads (the relay core's work, shared with the remote server). Returns a function that
 * disconnects.
 */
export function relayShell(page: HTMLIFrameElement, devtools: HTMLIFrameElement, frontendOrigin: string): () => void {
  const relay = new ShellRelay(page, devtools, frontendOrigin);
  window.addEventListener('message', relay.onMessage);
  page.contentWindow?.postMessage(PING, location.origin);
  return () => window.removeEventListener('message', relay.onMessage);
}
