import type { Protocol } from 'devtools-protocol';
import { FRAME_ID, LOADER_ID, type Context } from '../core/context';
import { base64, readBody } from '../core/body';
import { CdpError } from '../core/server';
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

const withoutHash = (url: string) => url.split('#')[0];

/** Whether the request is one of devtools-anywhere's own (its bundle, the frontend, …). */
export const isOwnUrl = (probe: Context['probe'], url: string) => {
  const target = withoutHash(url);
  for (const own of probe.ownUrls) if (withoutHash(own) === target) return true;
  return false;
};
export const isOwnRequest = (probe: Context['probe'], rec: RequestRecord) => isOwnUrl(probe, rec.url);

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
  return { opcode: 2, mask, payloadData: await base64(blob) };
}

export function registerNetwork({ server, probe }: Context) {
  let unsubscribe: (() => void) | null = null;
  let unsubscribeSockets: (() => void) | null = null;
  const sent = new Map<string, Set<'request' | 'response' | 'end'>>();
  const sentSockets = new Map<string, Set<'created' | 'open' | 'closed'>>();
  let sentFrames = new WeakSet<SocketEvent>();
  // Socket events are emitted in order even though reading a Blob payload is asynchronous.
  let queue = Promise.resolve();

  function find(requestId: string) {
    return probe.requests.find(r => r.requestId === requestId);
  }

  /** Emits whichever events of the record's lifecycle have not been sent yet. */
  function emit(rec: RequestRecord) {
    if (isOwnRequest(probe, rec)) return;
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
      if (rec.postData !== undefined) {
        request.postData = rec.postData;
        request.hasPostData = true;
      }
      const callFrames = parseStack(rec.stack, 1);
      server.emit('Network.requestWillBeSent', {
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
      server.emit('Network.responseReceived', {
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
      server.emit('Network.loadingFinished', {
        requestId: rec.requestId,
        timestamp: (rec.endTime ?? performance.now()) / 1000,
        encodedDataLength: rec.encodedDataLength ?? 0,
      } satisfies Protocol.Network.LoadingFinishedEvent);
    } else if (rec.state === 'failed' && !done.has('end')) {
      done.add('end');
      server.emit('Network.loadingFailed', {
        requestId: rec.requestId,
        timestamp: (rec.endTime ?? performance.now()) / 1000,
        type: rec.type,
        errorText: rec.errorText ?? '',
        canceled: false,
      } satisfies Protocol.Network.LoadingFailedEvent);
    }
  }

  /** Emits whichever events of the socket's lifecycle have not been sent yet. */
  async function emitSocket(rec: SocketRecord) {
    if (isOwnUrl(probe, rec.url)) return;
    const { requestId } = rec;
    let done = sentSockets.get(requestId);
    if (!done) sentSockets.set(requestId, (done = new Set()));

    if (!done.has('created')) {
      done.add('created');
      const callFrames = parseStack(rec.stack, 1);
      server.emit('Network.webSocketCreated', {
        requestId,
        url: rec.url,
        initiator: callFrames.length ? { type: 'script', stack: { callFrames } } : { type: 'other' },
      } satisfies Protocol.Network.WebSocketCreatedEvent);
      server.emit('Network.webSocketWillSendHandshakeRequest', {
        requestId,
        timestamp: rec.startTime / 1000,
        wallTime: rec.wallTime / 1000,
        // The handshake headers are not visible to the page.
        request: { headers: {} },
      } satisfies Protocol.Network.WebSocketWillSendHandshakeRequestEvent);
    }

    if (rec.openTime !== undefined && !done.has('open')) {
      done.add('open');
      server.emit('Network.webSocketHandshakeResponseReceived', {
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
        server.emit('Network.webSocketFrameError', {
          requestId,
          timestamp,
          errorMessage: 'WebSocket error',
        } satisfies Protocol.Network.WebSocketFrameErrorEvent);
      } else if (event.type === 'sent') {
        const response = await frameOf(event.data, true);
        server.emit('Network.webSocketFrameSent', {
          requestId,
          timestamp,
          response,
        } satisfies Protocol.Network.WebSocketFrameSentEvent);
      } else {
        const response = await frameOf(event.data, false);
        server.emit('Network.webSocketFrameReceived', {
          requestId,
          timestamp,
          response,
        } satisfies Protocol.Network.WebSocketFrameReceivedEvent);
      }
    }

    if (rec.closeTime !== undefined && !done.has('closed')) {
      done.add('closed');
      server.emit('Network.webSocketClosed', {
        requestId,
        timestamp: rec.closeTime / 1000,
      } satisfies Protocol.Network.WebSocketClosedEvent);
    }
  }

  const queueSocket = (rec: SocketRecord) => {
    queue = queue.then(() => emitSocket(rec)).catch(() => {});
  };

  server.register('Network', {
    enable() {
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
    },

    async getResponseBody(
      params: Protocol.Network.GetResponseBodyRequest
    ): Promise<Protocol.Network.GetResponseBodyResponse> {
      const rec = find(params.requestId);
      if (rec?.body !== undefined) return { body: rec.body, base64Encoded: false };
      // Requests known from Resource Timing: load the body again, from the HTTP cache when
      // possible (unhooked, so it does not show up as a new request).
      if (rec?.initiatorType && rec.method === 'GET') {
        const res = await probe.fetch(rec.url, { cache: 'force-cache', credentials: 'include' }).catch(() => null);
        if (res?.ok) return readBody(res);
      }
      throw new CdpError('No data found for resource with given identifier');
    },

    getRequestPostData(
      params: Protocol.Network.GetRequestPostDataRequest
    ): Protocol.Network.GetRequestPostDataResponse {
      const rec = find(params.requestId);
      if (rec?.postData === undefined) throw new CdpError('No post data available for the request');
      return { postData: rec.postData, base64Encoded: false };
    },

    getCookies: (): Protocol.Network.GetCookiesResponse => ({ cookies: parseCookies() }),

    deleteCookies(params: Protocol.Network.DeleteCookiesRequest) {
      const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie = `${params.name}=; ${expires}; path=${params.path || '/'}`;
      if (params.domain)
        document.cookie = `${params.name}=; ${expires}; path=${params.path || '/'}; domain=${params.domain}`;
    },

    setCacheDisabled: () => {},
    setAttachDebugStack: () => {},
    clearAcceptedEncodingsOverride: () => {},
    emulateNetworkConditions: () => {},
    setBypassServiceWorker: () => {},
    setExtraHTTPHeaders: () => {},
    setBlockedURLs: () => {},
  });
}
