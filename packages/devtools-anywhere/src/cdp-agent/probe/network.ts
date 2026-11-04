// The probe's network hooks: fetch, XHR and WebSocket wrapped, and the other requests read from
// Resource Timing, for one window. Every global is taken from that window, so that the same hooks
// work in a same-origin iframe, whose `fetch`, `XMLHttpRequest`, … are its own.
import { RESPONSE_DETAILS } from './messages';
import type { FrameTag, Probe, ProbeRequest, RequestType, SocketRecord } from './types';

/** `performance.now()`, written once: it is called in many places, and the probe is kept small. */
export const now = () => performance.now();

/** Drops the oldest entries of `list` past `max`. */
export function keep(list: unknown[], max: number): void {
  if (list.length > max) list.splice(0, list.length - max);
}

type Track = (record: Omit<ProbeRequest, 'requestId' | 'startTime' | 'wallTime' | 'state'>) => ProbeRequest;
type Update = (rec: ProbeRequest, patch: Partial<ProbeRequest>) => void;
type Listen = EventTarget['addEventListener'];
/** A window with its own globals: the top one or a same-origin iframe's. */
export type Realm = Window & typeof globalThis;

/** Where the hooks of every window put what they record. */
export interface NetworkSink {
  /** Gives a new request record its id and publishes it. */
  add(rec: ProbeRequest): ProbeRequest;
  /** Changes a request record and publishes the change. */
  update: Update;
  /** Publishes a new or changed WebSocket record, giving it an id the first time. */
  socket(rec: SocketRecord): void;
  /** The request records kept. */
  requests: ProbeRequest[];
}

/** Marks a hooked window (its global object: a navigation may replace it), with what tags its requests. */
const HOOKED = Symbol();

/**
 * Hooks the network APIs of `w`, once per global object. `listen` is the page's addEventListener
 * before it was hooked: the hooks' own listeners are not the page's. `frame` tags the requests
 * of an iframe's window. `serviceWorkerUrl` is shell mode's worker, which reports what Resource
 * Timing does not expose (the top window only).
 */
export function hookNetwork(
  probe: Probe,
  sink: NetworkSink,
  w: Realm,
  listen: Listen,
  frame?: () => FrameTag,
  serviceWorkerUrl?: string | undefined
): void {
  const found: { frame?: (() => FrameTag) | undefined } | undefined = Reflect.get(w, HOOKED);
  if (found) {
    found.frame = frame;
    return;
  }
  const state = { frame };
  Object.defineProperty(w, HOOKED, { value: state });
  const add = (rec: ProbeRequest) => {
    const tag = state.frame?.();
    if (tag) rec.frame = tag;
    return sink.add(rec);
  };
  const track: Track = record =>
    add({ ...record, requestId: '', startTime: now(), wallTime: Date.now(), state: 'pending' });
  hookWebSocket(probe, w, listen, sink.socket);
  hookFetch(track, sink.update, probe, w);
  hookXhr(track, sink.update, listen, probe, w);
  observeResources({ ...sink, add }, w, serviceWorkerUrl);
}

// ---- other requests (Resource Timing) ----

/** CDP resource type of a Resource Timing entry, from its MIME type or initiator. */
function resourceType(entry: PerformanceResourceTiming, mimeType: string): RequestType {
  if (entry.entryType === 'navigation') return 'Document';
  if (entry.initiatorType === 'fetch') return 'Fetch';
  if (entry.initiatorType === 'xmlhttprequest') return 'XHR';
  if (/^text\/css\b/.test(mimeType)) return 'Stylesheet';
  if (/javascript|ecmascript/.test(mimeType)) return 'Script';
  if (mimeType.startsWith('image/')) return 'Image';
  if (/^font\/|woff|opentype|truetype/.test(mimeType)) return 'Font';
  if (/^(audio|video)\//.test(mimeType)) return 'Media';
  if (/^text\/html\b/.test(mimeType)) return 'Document';
  switch (entry.initiatorType) {
    case 'img':
    case 'image':
    case 'input':
      return 'Image';
    case 'script':
      return 'Script';
    case 'audio':
    case 'video':
    case 'track':
      return 'Media';
    case 'iframe':
    case 'frame':
      return 'Document';
    case 'beacon':
      return 'Ping';
    default:
      return 'Other';
  }
}

/**
 * Records the requests that cannot be hooked (the document, style sheets, scripts, images,
 * fonts, …) from Resource Timing. Entries are only created once a request has finished, and
 * `buffered` also delivers those from before the probe ran, such as the document itself and
 * fetch() and XHR requests made before the hooks (in an iframe, those of its first scripts).
 */
function observeResources(sink: NetworkSink, w: Realm, serviceWorkerUrl: string | undefined) {
  const { add, update, requests } = sink;
  if (typeof w.PerformanceObserver === 'undefined') return;
  // An iframe's entries are timed from its own time origin; records from the top one's.
  const shift = w.performance.timeOrigin - performance.timeOrigin;
  const hooked = w.performance.now();
  // In shell mode with the Service Worker, it reports what Resource Timing does not expose
  // (headers, status text) of same-origin subresources, before the request's entry exists.
  // They are matched by URL; a late report still completes the record, but only one that was
  // loaded under our worker and has had no report yet, the latest first: an older one of the
  // same URL (from before the worker took over) must not take the next request's report.
  const details = new Map<string, Partial<ProbeRequest>[]>();
  const awaiting = new WeakSet<ProbeRequest>();
  let isOurs = (_source: unknown) => false;
  // Reading it throws in an opaque origin (a sandbox without allow-same-origin).
  let container: ServiceWorkerContainer | undefined;
  try {
    container = w.navigator.serviceWorker;
  } catch {}
  if (container && serviceWorkerUrl) {
    // Only reports from our own worker (its URL differs in the query only), and only the
    // fields it sends: the page's own worker must not rewrite the records.
    const ours = new URL(serviceWorkerUrl, w.location.href);
    isOurs = (source: unknown) => {
      if (!(source instanceof w.ServiceWorker)) return false;
      const url = new URL(source.scriptURL);
      return url.origin === ours.origin && url.pathname === ours.pathname;
    };
    const headers = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== 'object') return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
      return out;
    };
    container.addEventListener('message', event => {
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || !isOurs(event.source)) return;
      const { type, url, requestHeaders, status, statusText, responseHeaders } = data as Record<string, unknown>;
      if (type !== RESPONSE_DETAILS || typeof url !== 'string') return;
      const patch: Partial<ProbeRequest> = {};
      const req = headers(requestHeaders);
      if (req) patch.requestHeaders = req;
      if (typeof status === 'number') patch.status = status;
      if (typeof statusText === 'string') patch.statusText = statusText;
      const res = headers(responseHeaders);
      if (res) patch.responseHeaders = res;
      let rec: ProbeRequest | undefined;
      for (let i = requests.length; i-- && !rec;) {
        const r = requests[i];
        if (r && r.url === url && awaiting.has(r)) rec = r;
      }
      if (rec) {
        awaiting.delete(rec);
        update(rec, patch);
      } else {
        let list = details.get(url);
        if (!list) details.set(url, (list = []));
        list.push(patch);
      }
    });
    // No startMessages(): that would start delivering before the page's own listeners exist,
    // and its Service Worker's early messages would be lost. The queue starts by itself once
    // the document is parsed, and late reports still complete their records.
  }
  // The navigation entry can be delivered again once the page has loaded. Only it is kept:
  // resource entries are delivered once, and keeping them all would grow without bound.
  const seen = new WeakSet<PerformanceEntry>();
  const record = (entry: PerformanceResourceTiming) => {
    if (seen.has(entry)) return;
    if (entry.entryType === 'navigation') {
      seen.add(entry);
      // An iframe's about:blank or about:srcdoc document: Chrome reports no request for it.
      if (!entry.name.startsWith('http')) return;
    }
    // fetch() and XHR are hooked from then on, with more detail; DevTools' own fetches are unhooked.
    if ((entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') && entry.startTime >= hooked)
      return;
    // The browser's own favicon request is not the page's, and Chrome does not report it.
    if (entry.initiatorType === 'other' && (entry.name.split(/[?#]/)[0] ?? '').endsWith('/favicon.ico')) return;
    // Not in TypeScript's DOM types yet (Chrome 129+).
    const mimeType = (entry as PerformanceResourceTiming & { contentType?: string }).contentType || '';
    const status = entry.responseStatus || 0;
    const patch = details.get(entry.name)?.shift();
    const rec: ProbeRequest = {
      requestId: '',
      type: resourceType(entry, mimeType),
      initiatorType: entry.entryType === 'navigation' ? 'navigation' : entry.initiatorType,
      method: 'GET',
      url: entry.name,
      requestHeaders: {},
      startTime: entry.startTime + shift,
      wallTime: w.performance.timeOrigin + entry.startTime,
      state: 'done',
      responseTime: (entry.responseStart || entry.responseEnd) + shift,
      status,
      statusText: '',
      responseHeaders: {},
      mimeType,
      encodedDataLength: entry.transferSize,
      endTime: entry.responseEnd + shift,
      ...patch,
    };
    if (!patch && isOurs(container?.controller)) awaiting.add(rec);
    add(rec);
  };
  for (const type of ['navigation', 'resource']) {
    try {
      new w.PerformanceObserver(list => list.getEntries().forEach(e => record(e as PerformanceResourceTiming))).observe(
        {
          type,
          buffered: true,
        }
      );
    } catch {
      // Entry type not supported.
    }
  }
}

// ---- WebSocket ----

/**
 * Replaces WebSocket with a subclass that records connection, frames and close. `notify`
 * assigns the record an id the first time and publishes every change.
 */
function hookWebSocket(probe: Probe, w: Realm, listen: Listen, notify: (rec: SocketRecord) => void) {
  const WS = w.WebSocket;
  if (!WS) return;
  const records = new WeakMap<WebSocket, SocketRecord>();
  const push = (rec: SocketRecord, type: 'sent' | 'received' | 'error', data?: unknown) => {
    rec.events.push({ type, time: now(), data });
    keep(rec.events, probe.limits.socketEvents);
    notify(rec);
  };
  w.WebSocket = class WebSocket extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const rec: SocketRecord = {
        requestId: '',
        url: this.url,
        stack: new Error().stack,
        startTime: now(),
        wallTime: Date.now(),
        events: [],
      };
      records.set(this, rec);
      notify(rec);
      listen.call(this, 'open', () => {
        rec.openTime = now();
        notify(rec);
      });
      listen.call(this, 'message', e => push(rec, 'received', (e as MessageEvent).data));
      listen.call(this, 'error', () => push(rec, 'error'));
      listen.call(this, 'close', () => {
        rec.closeTime = now();
        notify(rec);
      });
    }
    override send(data: Parameters<InstanceType<typeof WS>['send']>[0]) {
      super.send(data);
      const rec = records.get(this);
      // Frames given to a closing socket are dropped, and Chrome does not report them.
      if (rec && this.readyState === 1) push(rec, 'sent', data);
    }
  };
}

// ---- fetch ----

/**
 * An object's class, whichever window made it: frames of one origin pass each other Requests and
 * bodies, which are not instanceof the hooked window's classes.
 */
const kind = (x: unknown) => Object.prototype.toString.call(x).slice(8, -1);

function bodyToString(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (kind(body) === 'URLSearchParams') return String(body);
  return undefined;
}

function hookFetch(track: Track, update: Update, probe: Probe, w: Realm) {
  const origFetch = w.fetch;
  if (!origFetch) return;
  const failed = (rec: ProbeRequest, err: unknown) =>
    update(rec, {
      state: 'failed',
      // Like Chrome, a request stopped through its AbortSignal is reported as canceled.
      ...(err instanceof w.DOMException && err.name === 'AbortError'
        ? { errorText: 'net::ERR_ABORTED', canceled: true }
        : // The page only sees a TypeError; the net error behind it is not exposed.
          { errorText: 'net::ERR_FAILED' }),
      endTime: now(),
    });
  w.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const req = kind(input) === 'Request' ? (input as Request) : null;
    const headers = init?.headers || req?.headers;
    let url: string;
    let requestHeaders: Headers;
    try {
      // Against the document's base URL, as fetch() does: a srcdoc iframe's location is about:srcdoc.
      url = new URL(req ? req.url : String(input), w.document.baseURI).href;
      requestHeaders = new Headers(headers);
    } catch {
      // An invalid URL or header: fetch itself rejects, without making a request.
      return origFetch.call(this, input, init);
    }
    // What DevTools does to it (Network.setBlockedURLs, …): its headers are the ones reported.
    const x = probe.intercept?.(url, 'Fetch', (k, v) => requestHeaders.set(k, v));
    const postData = bodyToString(init?.body);
    // Other bodies (in a Request, FormData, Blob, buffers) are read from a copy, afterwards.
    let copy: Request | undefined;
    if (postData === undefined) {
      const body = init?.body;
      try {
        if (/^(Blob|File|FormData|ArrayBuffer)$/.test(kind(body)) || ArrayBuffer.isView(body))
          copy = new w.Request(url, { method: 'POST', body: body ?? null });
        else if (body == null && req?.body) copy = req.clone();
      } catch {
        // A body already used: fetch rejects it.
      }
    }
    const rec = track({
      type: 'Fetch',
      method: String(init?.method || req?.method || 'GET').toUpperCase(),
      url,
      requestHeaders,
      postData,
      ...(copy ? { hasPostData: true } : {}),
      stack: new Error().stack,
    });
    copy?.text().then(
      text => {
        if (text.length <= probe.limits.body) update(rec, { postData: text });
      },
      () => {}
    );
    if (x?.fail) {
      update(rec, { state: 'failed', ...x.fail, endTime: now() });
      return Promise.reject(new w.TypeError('Failed to fetch'));
    }
    let promise: Promise<Response>;
    try {
      promise = x
        ? origFetch.call(
            this,
            new w.Request(input, { ...init, headers: requestHeaders, ...(x.noCache && { cache: 'no-store' }) })
          )
        : origFetch.call(this, input, init);
    } catch (err) {
      failed(rec, err);
      return Promise.reject(err);
    }
    promise.then(
      res => {
        const contentType = res.headers.get('content-type');
        update(rec, {
          state: 'headers',
          responseTime: now(),
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
        // Never read streams that may not end, or bodies that are too large to keep.
        if (
          !res.body ||
          contentType?.split(';')[0]?.trim() === 'text/event-stream' ||
          Number(res.headers.get('content-length')) > probe.limits.body
        ) {
          update(rec, { state: 'done', endTime: now(), encodedDataLength: 0 });
          return;
        }
        const copy = res.clone().body;
        if (!copy) return;
        readCapped(copy, contentType ?? '', probe.limits.body).then(
          ({ blob, size }) =>
            update(rec, {
              state: 'done',
              body: blob,
              encodedDataLength: size,
              endTime: now(),
            }),
          err => failed(rec, err)
        );
      },
      err => failed(rec, err)
    );
    return promise;
  };
}

/**
 * Reads a copy of a response body chunk by chunk, up to `max` bytes: past it the copy is
 * cancelled, so a body without content-length that turns out large, or a stream that does not
 * end, is never buffered whole (neither here nor in the tee feeding the page's copy).
 */
async function readCapped(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  type: string,
  max: number
): Promise<{ blob?: Blob; size: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { blob: new Blob(chunks, { type }), size };
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return { size };
    }
    chunks.push(value);
  }
}

// ---- XHR ----

interface XhrInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
  async: boolean;
}

function hookXhr(track: Track, update: Update, listen: Listen, probe: Probe, w: Realm) {
  const proto = w.XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origSetRequestHeader = proto.setRequestHeader;
  const infos = new WeakMap<XMLHttpRequest, XhrInfo>();
  // The record of the request each XHR is making now: an XHR can be reused for another one.
  const current = new WeakMap<XMLHttpRequest, ProbeRequest>();
  const watched = new WeakSet<XMLHttpRequest>();

  proto.open = function (
    this: XMLHttpRequest,
    ...args: [method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null]
  ) {
    // open() stops the request in progress without any event.
    const rec = current.get(this);
    if (rec) {
      current.delete(this);
      update(rec, { state: 'failed', errorText: 'net::ERR_ABORTED', canceled: true, endTime: now() });
    }
    infos.set(this, {
      method: String(args[0]).toUpperCase(),
      url: new URL(String(args[1]), w.document.baseURI).href,
      headers: {},
      async: args[2] !== false,
    });
    return Reflect.apply(origOpen, this, args);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const info = infos.get(this);
    if (info) info.headers[name] = value;
    return origSetRequestHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = infos.get(this);
    if (info) {
      const previous = current.get(this);
      const requestHeaders = { ...info.headers };
      const x = probe.intercept?.(info.url, 'XHR', (k, v) => {
        origSetRequestHeader.call(this, k, v);
        requestHeaders[k] = v;
      });
      // Tracked before sending: a synchronous request completes within send().
      const rec = track({
        type: 'XHR',
        method: info.method,
        url: info.url,
        requestHeaders,
        postData: bodyToString(body),
        stack: new Error().stack,
      });
      if (x?.fail) {
        update(rec, { state: 'failed', ...x.fail, endTime: now() });
        // A URL that cannot load fails it as the network would: an error event, or a throw when synchronous.
        origOpen.call(this, info.method, 'x:', info.async);
        return origSend.call(this);
      }
      if (!watched.has(this)) {
        watched.add(this);
        watchXhr(this, current, update, listen, probe, w);
      }
      current.set(this, rec);
      try {
        return origSend.call(this, body);
      } catch (err) {
        // Not sent (sent twice, …): the request in progress, if any, goes on.
        if (previous) current.set(this, previous);
        else if (current.get(this) === rec) current.delete(this);
        update(rec, {
          state: 'failed',
          errorText: String((err instanceof w.Error && err.message) || err),
          endTime: now(),
        });
        throw err;
      }
    }
    return origSend.call(this, body);
  };
}

/** Updates the record of the XHR's current request as it progresses. */
function watchXhr(
  xhr: XMLHttpRequest,
  current: WeakMap<XMLHttpRequest, ProbeRequest>,
  update: Update,
  listen: Listen,
  probe: Probe,
  w: Realm
) {
  const finish = (patch: Partial<ProbeRequest>) => {
    const rec = current.get(xhr);
    if (!rec) return;
    current.delete(xhr);
    update(rec, { ...patch, endTime: now() });
  };
  const responseMeta = () => ({ status: xhr.status, statusText: xhr.statusText, headers: xhr.getAllResponseHeaders() });
  listen.call(xhr, 'readystatechange', () => {
    const rec = current.get(xhr);
    if (!rec) return;
    if (xhr.readyState === 2) {
      update(rec, { state: 'headers', responseTime: now(), ...responseMeta() });
    } else if (xhr.readyState === 4) {
      // Failures are told apart by the event that follows: abort, timeout or error.
      if (!xhr.status) return;
      const type = xhr.responseType;
      let body: string | Blob | undefined;
      if (type === '' || type === 'text') body = xhr.responseText;
      else if (type === 'json') body = JSON.stringify(xhr.response);
      else if (type === 'blob' && xhr.response instanceof w.Blob) body = xhr.response;
      // The body's UTF-8 size: bytes on the wire when content-length is absent, as for fetch().
      let size = typeof body === 'string' ? new Blob([body]).size : body?.size || 0;
      if (type === 'arraybuffer' && xhr.response instanceof w.ArrayBuffer) {
        // Copied only when kept: the page may still change its buffer.
        size = xhr.response.byteLength;
        if (size <= probe.limits.body) body = new Blob([xhr.response]);
      }
      // Like fetch(), bodies too large to keep are left out; only their length is reported.
      finish({
        state: 'done',
        ...responseMeta(),
        body: size > probe.limits.body ? undefined : body,
        encodedDataLength: size,
      });
    }
  });
  listen.call(xhr, 'abort', () => finish({ state: 'failed', errorText: 'net::ERR_ABORTED', canceled: true }));
  // Chrome reports a timed-out XHR as aborted too.
  listen.call(xhr, 'timeout', () => finish({ state: 'failed', errorText: 'net::ERR_ABORTED', canceled: true }));
  listen.call(xhr, 'error', () => finish({ state: 'failed', errorText: 'net::ERR_FAILED' }));
}
