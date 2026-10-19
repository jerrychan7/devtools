import { FRAME_ID, LOADER_ID, type CdpServer } from '@devtools-anywhere/cdp-server';

/** Sent by a page in shell mode when its CDP server starts listening, or when pinged. */
const HELLO = JSON.stringify({ method: 'DevtoolsAnywhere.hello' });
/** Sent by the shell on startup, in case the page started listening first. */
const PING = JSON.stringify({ method: 'DevtoolsAnywhere.ping' });
/** Prefix of ids the shell uses when it re-sends `enable` commands; responses are dropped. */
const SHELL_ID_PREFIX = 'shell-';

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
    for (const method of ['Runtime.disable', 'Network.disable']) server.call(method).catch(() => {});
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

  const postFrontend = (message: string) => {
    if (frontendReady) devtools.contentWindow?.postMessage(message, frontendOrigin);
    else toFrontend.push(message);
  };
  const postPage = (message: string) => {
    if (pageReady) page.contentWindow?.postMessage(message, location.origin);
    else toPage.push(message);
  };

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

  function onHello() {
    pageReady = true;
    syncLocation();
    page.contentWindow?.addEventListener('pagehide', () => (pageReady = false));
    if (pageInstances++ === 0) {
      toPage.splice(0).forEach(postPage);
      return;
    }
    // A new page instance: whatever was queued was meant for the old one.
    toPage.length = 0;
    const url = pageUrl();
    postFrontend(JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }));
    postFrontend(
      JSON.stringify({
        method: 'Page.frameNavigated',
        params: {
          frame: {
            id: FRAME_ID,
            loaderId: LOADER_ID,
            url,
            domainAndRegistry: '',
            securityOrigin: new URL(url).origin,
            mimeType: 'text/html',
            secureContextType: isSecureContext ? 'Secure' : 'InsecureScheme',
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
      try {
        const { method, params } = JSON.parse(event.data);
        if (method.endsWith('.enable')) enabled.set(method, params ?? {});
        else if (method.endsWith('.disable')) enabled.delete(method.replace(/disable$/, 'enable'));
      } catch {
        return;
      }
      postPage(event.data);
    } else if (event.source === page.contentWindow && event.origin === location.origin) {
      if (event.data === HELLO) return onHello();
      if (event.data.includes(`"id":"${SHELL_ID_PREFIX}`)) return;
      postFrontend(event.data);
    }
  };

  window.addEventListener('message', onMessage);
  page.contentWindow?.postMessage(PING, location.origin);
  return () => window.removeEventListener('message', onMessage);
}
