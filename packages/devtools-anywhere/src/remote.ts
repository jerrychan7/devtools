import { FRAME_ID, LOADER_ID, installProbe, type CdpServer } from '@devtools-anywhere/cdp-server';
import { STATEFUL_DOMAINS } from './connection';

// Keep in step with packages/remote-server/src/relay.ts: the two are built separately.
const HELLO_METHOD = 'DevtoolsAnywhere.hello';
const PAGEHIDE_METHOD = 'DevtoolsAnywhere.pagehide';
const DETACH_METHOD = 'DevtoolsAnywhere.detach';
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
 * Connects the page to a remote debugging server (@devtools-anywhere/remote-server) at
 * `serverUrl`, the URL it serves the probe under. Each DevTools frontend inspecting the page is
 * a session with a CDP server of its own, from `createServer`: one frontend's domains, node ids
 * and remote objects are not another's. Servers of ended sessions are kept, their domains
 * disabled, for the next ones. The connection comes back when it drops, and what the page
 * sends meanwhile is queued. Returns a function that disconnects.
 */
export function connectRemote(createServer: () => CdpServer, serverUrl: string): () => void {
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
      if (typeof event.data === 'string') receive(event.data);
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  }

  /** Each session's server, and how to stop sending what it says. */
  const sessions = new Map<string, { server: CdpServer; off: () => void }>();
  const idle: CdpServer[] = [];
  function session(id: string) {
    let found = sessions.get(id);
    if (!found) {
      const server = idle.pop() ?? createServer();
      found = { server, off: server.onMessage(message => send(`${id}:${message}`)) };
      sessions.set(id, found);
    }
    return found.server;
  }
  function detach(id: string) {
    const found = sessions.get(id);
    if (!found) return;
    sessions.delete(id);
    found.off();
    // Like a new Chrome session for the next frontend: e.g. Debugger.enable and CSS.enable only
    // report scripts and style sheets again after a disable.
    const { server } = found;
    const calls = [...STATEFUL_DOMAINS.map(domain => `${domain}.disable`), 'Page.stopScreencast'];
    Promise.all(calls.map(method => server.call(method).catch(() => {}))).then(() => idle.push(server));
  }
  function receive(data: string) {
    if (data.startsWith('{')) {
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof message !== 'object' || !message || !('method' in message) || message.method !== DETACH_METHOD) return;
      const params = 'params' in message ? message.params : undefined;
      if (typeof params === 'object' && params && 'session' in params) detach(String(params.session));
      return;
    }
    const colon = data.indexOf(':');
    session(data.slice(0, colon))
      .dispatch(data.slice(colon + 1))
      .catch(() => {
        // Malformed message: there is no id to answer to.
      });
  }

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
    for (const id of sessions.keys()) detach(id);
    removeEventListener('load', onLoad);
    removeEventListener('pagehide', onPagehide);
    removeEventListener('pageshow', onPageshow);
    socket?.close();
  };
}
