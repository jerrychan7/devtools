import { FRAME_ID, LOADER_ID, type CdpServer } from '@devtools-anywhere/cdp-server';

const HELLO_METHOD = 'DevtoolsAnywhere.hello';
/**
 * Sent by a page in shell mode when its CDP server starts listening, or when pinged. Carries
 * the page's loader id, which the shell needs for the `Page.frameNavigated` it reports.
 */
const HELLO = JSON.stringify({ method: HELLO_METHOD, params: { loaderId: LOADER_ID } });
/** Sent by the shell on startup, in case the page started listening first. */
const PING = JSON.stringify({ method: 'DevtoolsAnywhere.ping' });
/** Prefix of ids the shell uses when it re-sends `enable` commands; responses are dropped. */
const SHELL_ID_PREFIX = 'shell-';
/** Chrome's error for commands that were pending when the inspected document went away. */
const NAVIGATED_ERROR = { code: -32000, message: 'Inspected target navigated or closed' };
/** Domains that keep state while enabled; a new frontend instance must start from disabled. */
export const STATEFUL_DOMAINS = ['Runtime', 'Network', 'Debugger', 'CSS', 'DOM', 'DOMStorage', 'Overlay', 'WebMCP'];

/** A CDP message as the shell sees it: only the fields it routes by are checked. */
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

/**
 * Runs in the shell document: relays CDP messages between the DevTools frontend in
 * `devtools` and the page's CDP server in `page`, and keeps DevTools working across page
 * reloads. When a new page instance says hello, the frontend is told the page navigated
 * and every `enable` command it sent so far is re-sent to the new page, which then
 * replays its own captured output. Returns a function that disconnects.
 */
export function relayShell(page: HTMLIFrameElement, devtools: HTMLIFrameElement, frontendOrigin: string): () => void {
  const enabled = new Map<string, unknown>();
  let frontendReady = false;
  let pageReady = false;
  let pageInstances = 0;
  let seq = 0;
  const toFrontend: string[] = [];
  const toPage: string[] = [];
  /** Ids of frontend commands sent to the current page instance and not answered yet. */
  const pending = new Map<string | number, string>();

  const postFrontend = (message: string) => {
    if (frontendReady) devtools.contentWindow?.postMessage(message, frontendOrigin);
    else toFrontend.push(message);
  };
  const postPage = (message: string) => {
    if (pageReady) page.contentWindow?.postMessage(message, location.origin);
    else toPage.push(message);
  };

  /**
   * Answers a frontend command the page will never answer. `enable` commands succeed: they
   * are re-sent to the next page instance anyway.
   */
  function abandon(id: string | number, method: string) {
    if (method.endsWith('.enable')) postFrontend(JSON.stringify({ id, result: {} }));
    else postFrontend(JSON.stringify({ id, error: NAVIGATED_ERROR }));
  }

  /** The page instance went away: commands it did not answer never will be. */
  function onPagehide() {
    pageReady = false;
    for (const [id, method] of pending) abandon(id, method);
    pending.clear();
  }

  /** Sends a frontend command to the page, or answers it if no page instance can. */
  function sendCommand(data: string, id: string | number | undefined, method: string) {
    if (id === undefined) return postPage(data);
    // Before the first hello the page is still loading and will answer; between two page
    // instances, Chrome fails the command too, and the next page may never come (no probe).
    if (!pageReady && pageInstances > 0) return abandon(id, method);
    pending.set(id, method);
    postPage(data);
  }

  function pageUrl() {
    try {
      return page.contentWindow?.location.href ?? page.src;
    } catch {
      return page.src;
    }
  }

  /** Mirrors the page's URL and title in the address bar and tab. */
  function syncLocation() {
    try {
      const win = page.contentWindow;
      const doc = page.contentDocument;
      if (!win || !doc) return;
      if (win.location.href !== location.href) history.replaceState(null, '', win.location.href);
      document.title = doc.title;
    } catch {
      // Cross-origin navigation: leave the shell as it is.
    }
  }

  function onHello(loaderId: string) {
    pageReady = true;
    syncLocation();
    page.contentWindow?.addEventListener('pagehide', onPagehide);
    if (pageInstances++ === 0) {
      toPage.splice(0).forEach(postPage);
      return;
    }
    // A new page instance: whatever was queued was meant for the old one.
    toPage.length = 0;
    const url = pageUrl();
    let secure = isSecureContext;
    try {
      secure = page.contentWindow?.isSecureContext ?? secure;
    } catch {
      // Cross-origin page: assume it is like the shell.
    }
    const { protocol, hostname, origin } = new URL(url);
    const localhost = /^(.+\.)?localhost$|^127(\.\d+){3}$|^\[::1\]$/.test(hostname);
    postFrontend(JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }));
    postFrontend(
      JSON.stringify({
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: FRAME_ID,
            loaderId,
            url,
            domainAndRegistry: '',
            // As Chrome serializes it (location.origin), where the URL standard says "null".
            securityOrigin: protocol === 'file:' ? 'file://' : origin,
            mimeType: 'text/html',
            secureContextType: !secure ? 'InsecureScheme' : localhost ? 'SecureLocalhost' : 'Secure',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
          type: 'Navigation',
        },
      })
    );
    for (const [method, params] of enabled) {
      postPage(JSON.stringify({ id: SHELL_ID_PREFIX + ++seq, method, params }));
    }
    // The Elements panel requests the new page's document.
    postFrontend(JSON.stringify({ method: 'DOM.documentUpdated', params: {} }));
  }

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    if (event.source === devtools.contentWindow && event.origin === frontendOrigin) {
      if (!frontendReady) {
        frontendReady = true;
        toFrontend.splice(0).forEach(postFrontend);
      }
      const message = parse(event.data);
      const { id, method, params } = message ?? {};
      // Anything else is the page's CDP server's to answer (or reject).
      if (typeof method !== 'string') return postPage(event.data);
      if (method.endsWith('.enable')) enabled.set(method, params ?? {});
      else if (method.endsWith('.disable')) enabled.delete(method.replace(/disable$/, 'enable'));
      sendCommand(event.data, typeof id === 'string' || typeof id === 'number' ? id : undefined, method);
    } else if (event.source === page.contentWindow && event.origin === location.origin) {
      if (event.data.startsWith(`{"method":"${HELLO_METHOD}"`)) {
        const params = parse(event.data)?.params;
        const loaderId =
          typeof params === 'object' && params !== null && 'loaderId' in params && typeof params.loaderId === 'string'
            ? params.loaderId
            : LOADER_ID;
        return onHello(loaderId);
      }
      if (event.data.includes(`"id":"${SHELL_ID_PREFIX}`)) return;
      // Responses (not events) settle a pending command.
      if (!event.data.startsWith('{"method"')) {
        const id = parse(event.data)?.id;
        if (typeof id === 'string' || typeof id === 'number') pending.delete(id);
      }
      postFrontend(event.data);
    }
  };

  window.addEventListener('message', onMessage);
  page.contentWindow?.postMessage(PING, location.origin);
  return () => window.removeEventListener('message', onMessage);
}
