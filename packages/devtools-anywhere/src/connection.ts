import { FRAME_ID, LOADER_ID, type CdpSession } from './cdp-agent';
import {
  HELLO_METHOD,
  PING_METHOD,
  RelayCore,
  parse,
  type Frame,
  type HelloParams,
  type Session,
} from '@devtools-anywhere/relay-core';

/**
 * Sent by a page in shell mode when its CDP session starts listening, or when pinged. Carries
 * the page's loader id, which the shell needs for the `Page.frameNavigated` it reports.
 */
const HELLO = JSON.stringify({ method: HELLO_METHOD, params: { loaderId: LOADER_ID } satisfies Partial<HelloParams> });
/** Sent by the shell on startup, in case the page started listening first. */
const PING = JSON.stringify({ method: PING_METHOD });
/** Domains that keep state while enabled; a new frontend instance must start from disabled. */
const STATEFUL_DOMAINS = ['Runtime', 'Network', 'Debugger', 'CSS', 'DOM', 'DOMStorage', 'Overlay', 'WebMCP'];

interface Link {
  /** Forgets that the peer has spoken; outgoing messages are queued again. */
  reset(): void;
  disconnect(): void;
}

/**
 * Connects a CDP session to a peer window over postMessage.
 *
 * Only messages whose source is the peer window and whose origin is `origin` are accepted,
 * and outgoing messages are addressed to that origin only. Outgoing messages are queued
 * until the peer sends its first message: before that, its window may still be loading.
 */
function link(session: CdpSession, peer: () => Window | null | undefined, origin: string): Link {
  let ready = false;
  const queue: string[] = [];
  const post = (message: string) => peer()?.postMessage(message, origin);

  const offServer = session.onMessage(message => {
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
    session.dispatch(event.data).catch(() => {
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
 * Ends what a frontend started in the page, like a new Chrome session: e.g. Debugger.enable and
 * CSS.enable only report scripts and style sheets again after a disable.
 */
export async function endSession(session: CdpSession): Promise<void> {
  const calls = [...STATEFUL_DOMAINS.map(domain => `${domain}.disable`), 'Page.stopScreencast'];
  await Promise.all(calls.map(method => session.call(method).catch(() => {})));
}

/**
 * Connects a CDP session to a DevTools frontend running in `frame`. When the frame reloads
 * (a new frontend instance), the domains are disabled so that the new instance's `enable`
 * calls replay everything captured so far. Returns a function that disconnects, and undoes what
 * the frontend did to the page.
 */
export function connectFrontend(session: CdpSession, frame: HTMLIFrameElement, frontendOrigin: string): () => void {
  const connection = link(session, () => frame.contentWindow, frontendOrigin);
  let loads = 0;
  const onLoad = () => {
    if (loads++ === 0) return;
    connection.reset();
    void endSession(session);
  };
  frame.addEventListener('load', onLoad);
  return () => {
    connection.disconnect();
    frame.removeEventListener('load', onLoad);
    // Nothing the frontend asked for outlives it: inspect mode, highlights, forced states, the
    // screencast. What the probe captured stays, for the next frontend.
    void endSession(session).then(() => session.reset());
  };
}

/** Connects the CDP session of a page in shell mode to the shell (its parent window). */
export function connectToShell(session: CdpSession): () => void {
  const connection = link(session, () => window.parent, location.origin);
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
        const field = (name: keyof HelloParams): unknown =>
          typeof params === 'object' && params !== null ? Reflect.get(params, name) : undefined;
        const sent = field('loaderId');
        // A page without one (an older probe) is a new instance every time, as it always was.
        const loaderId = typeof sent === 'string' ? sent : `unknown-${++this.unknownLoaders}`;
        this.page.contentWindow?.addEventListener('pagehide', this.onPagehide);
        return this.hello(loaderId);
      }
      this.pageMessage(this.session, event.data);
    }
  };
}

/**
 * Runs in the shell document: relays CDP messages between the DevTools frontend in
 * `devtools` and the page's CDP session in `page`, and keeps DevTools working across page
 * reloads (the relay core's work, shared with the remote server). Returns a function that
 * disconnects.
 */
export function relayShell(page: HTMLIFrameElement, devtools: HTMLIFrameElement, frontendOrigin: string): () => void {
  const relay = new ShellRelay(page, devtools, frontendOrigin);
  window.addEventListener('message', relay.onMessage);
  page.contentWindow?.postMessage(PING, location.origin);
  return () => window.removeEventListener('message', relay.onMessage);
}
