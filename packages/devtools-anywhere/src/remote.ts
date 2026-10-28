import { FRAME_ID, LOADER_ID, installProbe, type CdpSession } from './cdp-agent';
import {
  DETACH_METHOD,
  HELLO_METHOD,
  PAGEHIDE_METHOD,
  REPLACED_CLOSE_CODE,
  type DetachParams,
  type HelloParams,
} from '@devtools-anywhere/relay-core';
import type { RemoteOptions } from './api';
import { STATEFUL_DOMAINS } from './connection';
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

function targetId(fresh = false) {
  try {
    const id = (!fresh && sessionStorage.getItem(ID_KEY)) || newId();
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
 * Connects the page to a remote debugging server (`@devtools-anywhere/remote-server`) at
 * `serverUrl`, the URL it serves the probe under. Each DevTools frontend inspecting the page is
 * a session with a CDP session of its own, from `createSession`: one frontend's domains, node ids
 * and remote objects are not another's. CDP sessions of ended sessions are kept, their domains
 * disabled, for the next ones. The connection comes back when it drops, and what the page
 * sends meanwhile is queued. With `singlePath`, the page connects to `serverUrl` itself, the
 * target in the query (for a server mounted where upgrades are routed by exact path), instead of
 * to `target/<id>` under it. Returns a function that disconnects.
 */
export function connectRemote(
  createSession: () => CdpSession,
  serverUrl: string,
  { singlePath = false }: RemoteOptions = {}
): () => void {
  const targetUrl = (id: string) => {
    const base = new URL(serverUrl, location.href);
    const url = singlePath ? new URL(`?target=${id}`, base) : new URL(`target/${id}`, base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  };
  let url = targetUrl(targetId());
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
        // For a new relay (the server restarted) to end the sessions it does not know.
        sessions: [...sessions.keys()],
      } satisfies HelloParams,
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
    ws.onclose = event => {
      if (closed || socket !== ws) return;
      // Another page took the id (a duplicated tab copies sessionStorage): this one gets a new one.
      if (event.code === REPLACED_CLOSE_CODE) url = targetUrl(targetId(true));
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  }

  /** Each session's CDP session, and how to stop sending what it says. */
  const sessions = new Map<string, { cdp: CdpSession; off: () => void }>();
  const idle: CdpSession[] = [];
  function cdpOf(id: string) {
    let found = sessions.get(id);
    if (!found) {
      const cdp = idle.pop() ?? createSession();
      found = { cdp, off: cdp.onMessage(message => send(`${id}:${message}`)) };
      sessions.set(id, found);
    }
    return found.cdp;
  }
  function detach(id: string) {
    const found = sessions.get(id);
    if (!found) return;
    sessions.delete(id);
    found.off();
    // Like a new Chrome session for the next frontend: e.g. Debugger.enable and CSS.enable only
    // report scripts and style sheets again after a disable.
    const { cdp } = found;
    const calls = [...STATEFUL_DOMAINS.map(domain => `${domain}.disable`), 'Page.stopScreencast'];
    Promise.all(calls.map(method => cdp.call(method).catch(() => {}))).then(() => {
      cdp.reset();
      idle.push(cdp);
    });
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
      if (typeof params !== 'object' || !params) return;
      const field = (name: keyof DetachParams): unknown => Reflect.get(params, name);
      const session = field('session');
      if (session !== undefined) detach(String(session));
      return;
    }
    const colon = data.indexOf(':');
    cdpOf(data.slice(0, colon))
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
