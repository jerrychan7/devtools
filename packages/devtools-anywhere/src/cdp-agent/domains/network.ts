import type { Protocol } from 'devtools-protocol';
import { FRAME_ID, LOADER_ID, type Context } from '../core/context';
import { base64, readBody } from '../core/body';
import { CdpError } from '../core/session';
import { parseStack } from '../core/stack';
import type { RequestRecord, SocketEvent, SocketRecord } from '../probe/types';

export function parseCookies(): Protocol.Network.Cookie[] {
  if (!document.cookie) return [];
  return document.cookie.split(';').map(pair => {
    const i = pair.indexOf('=');
    const name = (i < 0 ? pair : pair.slice(0, i)).trim();
    const value = i < 0 ? '' : pair.slice(i + 1).trim();
    return {
      name,
      value,
      domain: location.hostname,
      path: '/',
      expires: -1,
      size: name.length + value.length,
      httpOnly: false,
      secure: location.protocol === 'https:',
      session: true,
      priority: 'Medium',
      sameParty: false,
      sourceScheme: location.protocol === 'https:' ? 'Secure' : 'NonSecure',
      sourcePort: Number(location.port) || (location.protocol === 'https:' ? 443 : 80),
    };
  });
}

/**
 * Expires every cookie called `name` that could be visible from `url` (the page by default).
 * The page cannot read a cookie's path or domain, so without them each prefix of the path
 * and each parent of the host (and the host-only form) is tried.
 */
export function deleteCookie(
  name: string,
  { url, path, domain }: { url?: string | undefined; path?: string | undefined; domain?: string | undefined } = {}
) {
  const target = new URL(url ?? location.href, location.href);
  // Every path the url can see, its own included: `/a/b` sees cookies on `/`, `/a` and `/a/b`.
  // Cookies match on the exact path, so each prefix is tried with and without a trailing `/`.
  const segments = target.pathname.split('/').slice(1).filter(Boolean);
  const paths = path
    ? [path]
    : [
        '/',
        ...segments.flatMap((_, i) => [
          '/' + segments.slice(0, i + 1).join('/'),
          '/' + segments.slice(0, i + 1).join('/') + '/',
        ]),
      ];
  const labels = target.hostname.split('.');
  // `undefined`: a host-only cookie, set without a domain attribute.
  const domains = domain ? [domain] : [undefined, ...labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'))];
  for (const p of paths)
    for (const d of domains)
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}${d ? `; domain=${d}` : ''}`;
}

/** Chrome's defaults for Network.enable's buffer sizes (desktop kDefaultTotalBufferSize, kDefaultResourceBufferSize). */
const DEFAULT_TOTAL_BUFFER = 200 * 1000 * 1000;
const DEFAULT_RESOURCE_BUFFER = 20 * 1000 * 1000;

const withoutHash = (url: string) => url.split('#')[0];

/** Whether the request is one of devtools-anywhere's own (its bundle, the frontend, …). */
export const isOwnUrl = (probe: Context['probe'], url: string) => {
  const target = withoutHash(url);
  for (const own of probe.ownUrls) if (withoutHash(own) === target) return true;
  return false;
};
export const isOwnRequest = (probe: Context['probe'], rec: RequestRecord) => isOwnUrl(probe, rec.url);

/**
 * Loads `url` again, from the HTTP cache when possible, with the unhooked fetch (so it does
 * not show up as a new request). An error status becomes a CDP error.
 */
export async function refetch(probe: Context['probe'], url: string, init?: RequestInit): Promise<Response> {
  const res = await probe.fetch(url, { ...init, cache: 'force-cache' });
  if (!res.ok) throw new CdpError(`Failed to load ${url}: ${res.status}`);
  return res;
}

/**
 * CDP frame of a WebSocket payload: text as is, binary data (converted only now) as base64.
 * Like Chrome, a Blob given to `send()` is reported without its payload.
 */
async function frameOf(data: unknown, mask: boolean): Promise<Protocol.Network.WebSocketFrame> {
  if (typeof data === 'string') return { opcode: 1, mask, payloadData: data };
  let blob = new Blob();
  if (data instanceof Blob) {
    if (!mask) blob = data;
  } else if (data instanceof ArrayBuffer) blob = new Blob([data]);
  // A copy: the view may be on a SharedArrayBuffer, which Blob does not take.
  else if (ArrayBuffer.isView(data))
    blob = new Blob([new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()]);
  // A payload that cannot be read (a failed Blob read) is shown empty rather than holding
  // back the socket's later frames and its close.
  const payloadData = await base64(blob).catch(() => '');
  return { opcode: 2, mask, payloadData };
}

export function registerNetwork({ session, probe }: Context) {
  let unsubscribe: (() => void) | null = null;
  let unsubscribeSockets: (() => void) | null = null;
  const sent = new Map<string, Set<'request' | 'response' | 'end'>>();
  const sentSockets = new Map<string, Set<'created' | 'open' | 'closed'>>();
  let sentFrames = new WeakSet<SocketEvent>();
  // Socket events are emitted in order even though reading a Blob payload is asynchronous.
  let queue = Promise.resolve();
  // Bumped by disable(): socket events still queued or waiting for a payload are dropped.
  let generation = 0;

  /**
   * Forgets finished requests (or closed sockets) the probe has evicted, so the tables stay
   * within the probe's own limit. Unfinished ones are kept: their record may still change.
   */
  function prune<T extends string>(table: Map<string, Set<T>>, live: { requestId: string }[], last: T) {
    if (table.size <= live.length) return;
    const ids = new Set(live.map(r => r.requestId));
    for (const [id, done] of table) if (done.has(last) && !ids.has(id)) table.delete(id);
  }

  /** Network.enable's maxPostDataSize; 0 sends every body in requestWillBeSent. */
  let maxPostData = 0;

  function find(requestId: string) {
    return probe.requests.find(r => r.requestId === requestId);
  }

  /** Emits whichever events of the record's lifecycle have not been sent yet. */
  function emit(rec: RequestRecord) {
    if (isOwnRequest(probe, rec)) return;
    prune(sent, probe.requests, 'end');
    let done = sent.get(rec.requestId);
    if (!done) sent.set(rec.requestId, (done = new Set()));

    if (!done.has('request')) {
      done.add('request');
      const request: Protocol.Network.Request = {
        url: rec.url,
        method: rec.method,
        headers: rec.requestHeaders,
        initialPriority: 'High',
        referrerPolicy: 'strict-origin-when-cross-origin',
      };
      // Like Chrome, a body over maxPostDataSize (0: no limit) is left out of the event: the
      // frontend asks for it with getRequestPostData, as for a body read later.
      if (
        rec.postData !== undefined &&
        (!maxPostData || new TextEncoder().encode(rec.postData).length <= maxPostData)
      ) {
        request.postData = rec.postData;
        request.hasPostData = true;
      } else if (rec.postData !== undefined || rec.hasPostData) {
        request.hasPostData = true;
      }
      const callFrames = parseStack(rec.stack, 1);
      session.emit('Network.requestWillBeSent', {
        requestId: rec.requestId,
        loaderId: LOADER_ID,
        documentURL: location.href,
        request,
        timestamp: rec.startTime / 1000,
        wallTime: rec.wallTime / 1000,
        // Requests known from Resource Timing do not tell who started them.
        initiator: callFrames.length ? { type: 'script', stack: { callFrames } } : { type: 'other' },
        redirectHasExtraInfo: false,
        type: rec.type,
        frameId: FRAME_ID,
      } satisfies Protocol.Network.RequestWillBeSentEvent);
    }

    if ((rec.state === 'headers' || rec.state === 'done') && !done.has('response')) {
      done.add('response');
      session.emit('Network.responseReceived', {
        requestId: rec.requestId,
        loaderId: LOADER_ID,
        timestamp: (rec.responseTime ?? performance.now()) / 1000,
        type: rec.type,
        response: {
          url: rec.url,
          status: rec.status ?? 0,
          statusText: rec.statusText ?? '',
          headers: rec.responseHeaders ?? {},
          mimeType: rec.mimeType ?? '',
          charset: '',
          connectionReused: false,
          connectionId: 0,
          encodedDataLength: 0,
          securityState: 'unknown',
        },
        hasExtraInfo: false,
        frameId: FRAME_ID,
      } satisfies Protocol.Network.ResponseReceivedEvent);
    }

    if (rec.state === 'done' && !done.has('end')) {
      done.add('end');
      session.emit('Network.loadingFinished', {
        requestId: rec.requestId,
        timestamp: (rec.endTime ?? performance.now()) / 1000,
        encodedDataLength: rec.encodedDataLength ?? 0,
      } satisfies Protocol.Network.LoadingFinishedEvent);
    } else if (rec.state === 'failed' && !done.has('end')) {
      done.add('end');
      session.emit('Network.loadingFailed', {
        requestId: rec.requestId,
        timestamp: (rec.endTime ?? performance.now()) / 1000,
        type: rec.type,
        errorText: rec.errorText ?? '',
        canceled: !!rec.canceled,
      } satisfies Protocol.Network.LoadingFailedEvent);
    }
  }

  /** Emits whichever events of the socket's lifecycle have not been sent yet. */
  async function emitSocket(rec: SocketRecord, gen: number) {
    if (gen !== generation || isOwnUrl(probe, rec.url)) return;
    const { requestId } = rec;
    prune(sentSockets, probe.sockets, 'closed');
    let done = sentSockets.get(requestId);
    if (!done) sentSockets.set(requestId, (done = new Set()));

    if (!done.has('created')) {
      done.add('created');
      const callFrames = parseStack(rec.stack, 1);
      session.emit('Network.webSocketCreated', {
        requestId,
        url: rec.url,
        initiator: callFrames.length ? { type: 'script', stack: { callFrames } } : { type: 'other' },
      } satisfies Protocol.Network.WebSocketCreatedEvent);
      session.emit('Network.webSocketWillSendHandshakeRequest', {
        requestId,
        timestamp: rec.startTime / 1000,
        wallTime: rec.wallTime / 1000,
        // The handshake headers are not visible to the page.
        request: { headers: {} },
      } satisfies Protocol.Network.WebSocketWillSendHandshakeRequestEvent);
    }

    if (rec.openTime !== undefined && !done.has('open')) {
      done.add('open');
      session.emit('Network.webSocketHandshakeResponseReceived', {
        requestId,
        timestamp: rec.openTime / 1000,
        response: { status: 101, statusText: 'Switching Protocols', headers: {} },
      } satisfies Protocol.Network.WebSocketHandshakeResponseReceivedEvent);
    }

    for (const event of rec.events) {
      if (sentFrames.has(event)) continue;
      sentFrames.add(event);
      const timestamp = event.time / 1000;
      if (event.type === 'error') {
        session.emit('Network.webSocketFrameError', {
          requestId,
          timestamp,
          errorMessage: 'WebSocket error',
        } satisfies Protocol.Network.WebSocketFrameErrorEvent);
      } else if (event.type === 'sent') {
        const response = await frameOf(event.data, true);
        if (gen !== generation) return;
        session.emit('Network.webSocketFrameSent', {
          requestId,
          timestamp,
          response,
        } satisfies Protocol.Network.WebSocketFrameSentEvent);
      } else {
        const response = await frameOf(event.data, false);
        if (gen !== generation) return;
        session.emit('Network.webSocketFrameReceived', {
          requestId,
          timestamp,
          response,
        } satisfies Protocol.Network.WebSocketFrameReceivedEvent);
      }
    }

    if (rec.closeTime !== undefined && !done.has('closed')) {
      done.add('closed');
      session.emit('Network.webSocketClosed', {
        requestId,
        timestamp: rec.closeTime / 1000,
      } satisfies Protocol.Network.WebSocketClosedEvent);
    }
  }

  const queueSocket = (rec: SocketRecord) => {
    const gen = generation;
    queue = queue.then(() => emitSocket(rec, gen)).catch(() => {});
  };

  session.register('Network', {
    enable(params: Protocol.Network.EnableRequest) {
      maxPostData = params.maxPostDataSize ?? 0;
      probe.bodyLimits(
        params.maxTotalBufferSize ?? DEFAULT_TOTAL_BUFFER,
        params.maxResourceBufferSize ?? DEFAULT_RESOURCE_BUFFER
      );
      if (unsubscribe) return;
      // Report requests and sockets made before the client connected, including early ones.
      probe.requests.forEach(emit);
      unsubscribe = probe.onRequest(emit);
      probe.sockets.forEach(queueSocket);
      unsubscribeSockets = probe.onSocket(queueSocket);
    },

    disable() {
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeSockets?.();
      unsubscribeSockets = null;
      sent.clear();
      sentSockets.clear();
      sentFrames = new WeakSet();
      generation++;
    },

    async getResponseBody(
      params: Protocol.Network.GetResponseBodyRequest
    ): Promise<Protocol.Network.GetResponseBodyResponse> {
      const rec = find(params.requestId);
      if (rec?.bodyEvicted) throw new CdpError('Request content was evicted from inspector cache');
      if (typeof rec?.body === 'string') return { body: rec.body, base64Encoded: false };
      // Captured binary data: text for textual types, like Chrome, base64 otherwise.
      if (rec?.body)
        return readBody(
          new Response(rec.body, { headers: { 'content-type': rec.responseHeaders?.['content-type'] ?? '' } })
        );
      // Requests known from Resource Timing: load the body again, from the HTTP cache when
      // possible (unhooked, so it does not show up as a new request). Not for other origins:
      // the cache may miss, and loading again would repeat a request with the user's cookies
      // (a tracking pixel, a one-time link) that Chrome only reads from memory.
      if (rec?.initiatorType && rec.method === 'GET' && new URL(rec.url, location.href).origin === location.origin) {
        const res = await refetch(probe, rec.url, { credentials: 'include' }).catch(() => null);
        if (res) return readBody(res);
      }
      throw new CdpError('No data found for resource with given identifier');
    },

    getRequestPostData(
      params: Protocol.Network.GetRequestPostDataRequest
    ): Protocol.Network.GetRequestPostDataResponse {
      const rec = find(params.requestId);
      // Chrome drops the request body along with the response body.
      if (rec?.postData === undefined || rec.bodyEvicted) throw new CdpError('No post data available for the request');
      return { postData: rec.postData, base64Encoded: false };
    },

    getCookies: (): Protocol.Network.GetCookiesResponse => ({ cookies: parseCookies() }),

    deleteCookies(params: Protocol.Network.DeleteCookiesRequest) {
      deleteCookie(params.name, { url: params.url, path: params.path, domain: params.domain });
    },
  });
}
