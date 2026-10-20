import { FRAME_ID, LOADER_ID, installProbe, type CdpServer } from '@devtools-anywhere/cdp-server';

// Keep in step with packages/remote-server/src/relay.ts: the two are built separately.
const HELLO_METHOD = 'DevtoolsAnywhere.hello';
const PAGEHIDE_METHOD = 'DevtoolsAnywhere.pagehide';
/** The tab's target id: the same across reloads, so DevTools stays on it. */
const ID_KEY = 'devtools-anywhere:remote-id';
/** Messages kept while the connection is down; the oldest go first. */
const MAX_QUEUED = 10_000;
/** Reconnect delays grow up to this. */
const MAX_DELAY = 10_000;

/** A random target id, also where crypto.randomUUID is missing (not a secure context). */
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function targetId() {
  try {
    const id = sessionStorage.getItem(ID_KEY) ?? newId();
    sessionStorage.setItem(ID_KEY, id);
    return id;
  } catch {
    return newId(); // No sessionStorage: a new target on every load.
  }
}

function favicon() {
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return link?.href ?? new URL('/favicon.ico', location.href).href;
}

/**
 * Connects a CDP server to a remote debugging server (@devtools-anywhere/remote-server) at
 * `serverUrl`, the URL it serves the probe under. The connection comes back when it drops,
 * and what the page sends meanwhile is queued. Returns a function that disconnects.
 */
export function connectRemote(server: CdpServer, serverUrl: string): () => void {
  const url = new URL(`target/${targetId()}`, new URL(serverUrl, location.href));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // The page's own WebSocket: the connection is not one of the page's.
  const Socket = installProbe().WebSocket;
  const queue: string[] = [];
  let socket: WebSocket | undefined;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const send = (message: string) => {
    if (socket?.readyState === Socket.OPEN) return socket.send(message);
    queue.push(message);
    if (queue.length > MAX_QUEUED) queue.shift();
  };
  const hello = () =>
    JSON.stringify({
      method: HELLO_METHOD,
      params: {
        loaderId: LOADER_ID,
        frameId: FRAME_ID,
        url: location.href,
        title: document.title,
        favicon: favicon(),
        userAgent: navigator.userAgent,
        secure: isSecureContext,
      },
    });

  function connect() {
    const ws = new Socket(url);
    socket = ws;
    ws.onopen = () => {
      delay = 500;
      ws.send(hello());
      queue.splice(0).forEach(message => ws.send(message));
    };
    ws.onmessage = event => {
      if (typeof event.data !== 'string') return;
      server.dispatch(event.data).catch(() => {
        // Malformed message: there is no id to answer to.
      });
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  }

  const offServer = server.onMessage(send);
  // The title is often set late: the list shows it once the page has loaded.
  const onLoad = () => send(hello());
  const onPagehide = () => send(JSON.stringify({ method: PAGEHIDE_METHOD, params: {} }));
  // Back from the back/forward cache: the same page instance, which the relay takes back.
  const onPageshow = (event: PageTransitionEvent) => event.persisted && send(hello());
  addEventListener('load', onLoad);
  addEventListener('pagehide', onPagehide);
  addEventListener('pageshow', onPageshow);
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    offServer();
    removeEventListener('load', onLoad);
    removeEventListener('pagehide', onPagehide);
    removeEventListener('pageshow', onPageshow);
    socket?.close();
  };
}
