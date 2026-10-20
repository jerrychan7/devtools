// Early-capture probe.
//
// Load it as the first synchronous script of a page (probe.iife.js). It hooks console,
// uncaught errors, fetch/XHR and WebSocket once, keeps recent events in ring buffers, and the CDP
// server reads those buffers later. The CDP server installs it itself when no earlier
// probe exists, so every API is hooked exactly once either way.
import {
  PROBE_KEY,
  type ConsoleEntry,
  type ConsoleType,
  type ListenerRecord,
  type LogEntry,
  type Probe,
  type RequestRecord,
  type RequestType,
  type SocketRecord,
  type ToolRecord,
} from './types';

import { isShellPage, readShellConfig, writeShellDocument } from './shell';

export * from './types';
export * from './shell';

const MAX_LOGS = 1000;
const MAX_REQUESTS = 300;
const MAX_SOCKETS = 300;
const MAX_SOCKET_EVENTS = 500;
const MAX_BODY_LENGTH = 5 * 1024 * 1024;
const MAX_TOOL_OUTCOMES = 50;

export function installProbe(): Probe {
  const w = window;
  const existing: Probe | undefined = Reflect.get(w, PROBE_KEY);
  if (existing) return existing;

  const logs: LogEntry[] = [];
  const requests: RequestRecord[] = [];
  const logListeners = new Set<(entry: LogEntry) => void>();
  const requestListeners = new Set<(record: RequestRecord) => void>();
  const sockets: SocketRecord[] = [];
  const socketListeners = new Set<(record: SocketRecord) => void>();

  const shadowRootListeners = new Set<(root: ShadowRoot) => void>();
  const probe: Probe = {
    version: 1,
    logs,
    requests,
    onLog(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    onRequest(listener) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    sockets,
    onSocket(listener) {
      socketListeners.add(listener);
      return () => socketListeners.delete(listener);
    },
    clearLogs() {
      logs.length = 0;
    },
    shadowRoots: new WeakMap(),
    onShadowRoot(listener) {
      shadowRootListeners.add(listener);
      return () => void shadowRootListeners.delete(listener);
    },
    listeners: new WeakMap(),
    ownUrls: new Set(),
    // Old WebViews without fetch: a rejection callers handle like any failed request.
    fetch: w.fetch ? w.fetch.bind(w) : () => Promise.reject(new TypeError('fetch is not available')),
    tools: new Map(),
  };
  Object.defineProperty(w, PROBE_KEY, { value: probe });

  const now = () => performance.timeOrigin + performance.now();

  function addLog(entry: LogEntry) {
    if (logs.push(entry) > MAX_LOGS) logs.shift();
    logListeners.forEach(fn => fn(entry));
  }

  let seq = 0;
  // Before hookListeners: the socket's own listeners are not the page's.
  hookWebSocket(rec => {
    if (!rec.requestId) {
      rec.requestId = 'probe.' + ++seq;
      if (sockets.push(rec) > MAX_SOCKETS) sockets.shift();
    }
    socketListeners.forEach(fn => fn(rec));
  });
  hookConsole(addLog, now);
  hookDebugger(addLog, now);
  hookErrors(addLog, now);
  hookShadowRoots(probe.shadowRoots, shadowRootListeners);
  // The XHR hook's own listeners are not the page's either.
  const listen = EventTarget.prototype.addEventListener;
  hookListeners(probe.listeners);
  hookModelContext(probe.tools);

  function add(rec: RequestRecord) {
    rec.requestId = 'probe.' + ++seq;
    if (requests.push(rec) > MAX_REQUESTS) requests.shift();
    requestListeners.forEach(fn => fn(rec));
    return rec;
  }
  const track: Track = record =>
    add({ ...record, requestId: '', startTime: performance.now(), wallTime: Date.now(), state: 'pending' });
  function update(rec: RequestRecord, patch: Partial<RequestRecord>) {
    Object.assign(rec, patch);
    requestListeners.forEach(fn => fn(rec));
  }
  hookFetch(track, update);
  hookXhr(track, update, listen);
  const shell = readShellConfig();
  observeResources(add, update, requests, shell?.sw);

  if (shell && window === top) {
    writeShellDocument(shell);
  } else if (shell && isShellPage()) {
    // Load the bundle that connects this page to the shell; capture continues meanwhile.
    const script = document.createElement('script');
    script.src = shell.bundle;
    probe.ownUrls.add(script.src);
    document.documentElement.appendChild(script);
  }

  return probe;
}

// ---- other requests (Resource Timing) ----

/** CDP resource type of a Resource Timing entry, from its MIME type or initiator. */
function resourceType(entry: PerformanceResourceTiming, mimeType: string): RequestType {
  if (entry.entryType === 'navigation') return 'Document';
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
 * `buffered` also delivers those from before the probe ran, such as the document itself.
 */
function observeResources(
  add: (rec: RequestRecord) => void,
  update: Update,
  requests: RequestRecord[],
  swUrl: string | undefined
) {
  if (typeof PerformanceObserver === 'undefined') return;
  // In shell mode with the Service Worker, it reports what Resource Timing does not expose
  // (headers, status text) of same-origin subresources, before the request's entry exists.
  // They are matched by URL; a late report still completes the record.
  const details = new Map<string, Partial<RequestRecord>[]>();
  const sw = navigator.serviceWorker;
  if (sw && swUrl) {
    // Only reports from our own worker (its URL differs in the query only), and only the
    // fields it sends: the page's own worker must not rewrite the records.
    const ours = new URL(swUrl, location.href);
    const isOurs = (source: unknown) => {
      if (!(source instanceof ServiceWorker)) return false;
      const url = new URL(source.scriptURL);
      return url.origin === ours.origin && url.pathname === ours.pathname;
    };
    const headers = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== 'object') return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
      return out;
    };
    sw.addEventListener('message', event => {
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || !isOurs(event.source)) return;
      const { type, url, requestHeaders, status, statusText, responseHeaders } = data as Record<string, unknown>;
      if (type !== 'devtools-anywhere:response' || typeof url !== 'string') return;
      const patch: Partial<RequestRecord> = {};
      const req = headers(requestHeaders);
      if (req) patch.requestHeaders = req;
      if (typeof status === 'number') patch.status = status;
      if (typeof statusText === 'string') patch.statusText = statusText;
      const res = headers(responseHeaders);
      if (res) patch.responseHeaders = res;
      const rec = requests.find(r => r.url === url && r.initiatorType && !Object.keys(r.responseHeaders || {}).length);
      if (rec) update(rec, patch);
      else {
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
    if (entry.entryType === 'navigation') seen.add(entry);
    // fetch() and XHR are hooked, with more detail; DevTools' own fetches are unhooked.
    if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') return;
    // The browser's own favicon request is not the page's, and Chrome does not report it.
    if (entry.initiatorType === 'other' && (entry.name.split(/[?#]/)[0] ?? '').endsWith('/favicon.ico')) return;
    // Not in TypeScript's DOM types yet (Chrome 129+).
    const mimeType = (entry as PerformanceResourceTiming & { contentType?: string }).contentType || '';
    const status = entry.responseStatus || 0;
    add({
      requestId: '',
      type: resourceType(entry, mimeType),
      initiatorType: entry.entryType === 'navigation' ? 'navigation' : entry.initiatorType,
      method: 'GET',
      url: entry.name,
      requestHeaders: {},
      startTime: entry.startTime,
      wallTime: performance.timeOrigin + entry.startTime,
      state: 'done',
      responseTime: entry.responseStart || entry.responseEnd,
      status,
      statusText: '',
      responseHeaders: {},
      mimeType,
      encodedDataLength: entry.transferSize,
      endTime: entry.responseEnd,
      ...details.get(entry.name)?.shift(),
    });
  };
  for (const type of ['navigation', 'resource']) {
    try {
      new PerformanceObserver(list => list.getEntries().forEach(e => record(e as PerformanceResourceTiming))).observe({
        type,
        buffered: true,
      });
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
function hookWebSocket(notify: (rec: SocketRecord) => void) {
  const WS = window.WebSocket;
  if (!WS) return;
  const listen = EventTarget.prototype.addEventListener;
  const records = new WeakMap<WebSocket, SocketRecord>();
  const push = (rec: SocketRecord, type: 'sent' | 'received' | 'error', data?: unknown) => {
    if (rec.events.push({ type, time: performance.now(), data }) > MAX_SOCKET_EVENTS) rec.events.shift();
    notify(rec);
  };
  window.WebSocket = class WebSocket extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const rec: SocketRecord = {
        requestId: '',
        url: this.url,
        stack: new Error().stack,
        startTime: performance.now(),
        wallTime: Date.now(),
        events: [],
      };
      records.set(this, rec);
      notify(rec);
      listen.call(this, 'open', () => {
        rec.openTime = performance.now();
        notify(rec);
      });
      listen.call(this, 'message', e => push(rec, 'received', (e as MessageEvent).data));
      listen.call(this, 'error', () => push(rec, 'error'));
      listen.call(this, 'close', () => {
        rec.closeTime = performance.now();
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

// ---- debugger ----

/** Called instead of each `debugger` statement by the shell's Service Worker (sw.ts DEBUGGER_CALL). */
const DEBUGGER_HOOK = '_$dbg';

/** Statements cannot be paused at: the shell's Service Worker makes each `debugger` log a warning. */
function hookDebugger(addLog: (entry: LogEntry) => void, now: () => number) {
  Object.defineProperty(window, DEBUGGER_HOOK, {
    value() {
      const error = new Error();
      addLog({
        kind: 'console',
        type: 'warning',
        args: ['debugger statement hit (pausing is not supported)'],
        time: now(),
        // The hook's own frame is dropped like the console wrapper's.
        get stack() {
          return error.stack;
        },
      });
    },
  });
}

// ---- console ----

function hookConsole(addLog: (entry: LogEntry) => void, now: () => number) {
  const counts: Record<string, number> = {};
  const timers: Record<string, number> = {};

  const wrap = (name: string, capture: (args: unknown[]) => Pick<ConsoleEntry, 'type' | 'args'> | null) => {
    const orig: unknown = Reflect.get(console, name);
    if (typeof orig !== 'function') return;
    Reflect.set(console, name, function (this: unknown, ...args: unknown[]) {
      const captured = capture(args);
      if (captured) {
        // V8 formats a stack only when it is read: most entries are never shown, and
        // formatting one on every call slows down pages that log a lot.
        const error = new Error();
        addLog({
          kind: 'console',
          type: captured.type,
          args: captured.args,
          time: now(),
          get stack() {
            return error.stack;
          },
        });
      }
      return orig.apply(this, args);
    });
  };

  const plain: [string, ConsoleType][] = [
    ['log', 'log'],
    ['debug', 'debug'],
    ['info', 'info'],
    ['error', 'error'],
    ['warn', 'warning'],
    ['dir', 'dir'],
    ['dirxml', 'dirxml'],
    ['table', 'table'],
    ['trace', 'trace'],
    ['group', 'startGroup'],
    ['groupCollapsed', 'startGroupCollapsed'],
    ['groupEnd', 'endGroup'],
  ];
  // Like V8: calls without arguments are dropped, except for these, which log their own name.
  const namedWhenEmpty = new Set(['group', 'groupCollapsed', 'groupEnd', 'trace']);
  for (const [name, type] of plain) {
    wrap(name, args => {
      if (args.length) return { type, args };
      return namedWhenEmpty.has(name) ? { type, args: ['console.' + name] } : null;
    });
  }

  wrap('clear', () => ({ type: 'clear', args: [] }));
  wrap('assert', ([condition, ...rest]) =>
    condition ? null : { type: 'assert', args: rest.length ? rest : ['console.assert'] }
  );
  wrap('count', ([value = 'default']) => {
    const label = String(value);
    counts[label] = (counts[label] || 0) + 1;
    return { type: 'count', args: [`${label}: ${counts[label]}`] };
  });
  // Misuses are reported as V8 does, with a warning naming the label.
  const warn = (text: string) => ({ type: 'warning' as const, args: [text] });
  wrap('countReset', ([value = 'default']) => {
    const label = String(value);
    if (!(label in counts)) return warn(`Count for '${label}' does not exist`);
    counts[label] = 0;
    return null;
  });
  wrap('time', ([value = 'default']) => {
    const label = String(value);
    // An existing timer keeps its start.
    if (label in timers) return warn(`Timer '${label}' already exists`);
    timers[label] = performance.now();
    return null;
  });
  const elapsed = (label: string) => `${label}: ${performance.now() - (timers[label] ?? 0)} ms`;
  wrap('timeLog', ([value = 'default', ...rest]) => {
    const label = String(value);
    return label in timers ? { type: 'log', args: [elapsed(label), ...rest] } : warn(`Timer '${label}' does not exist`);
  });
  wrap('timeEnd', ([value = 'default']) => {
    const label = String(value);
    if (!(label in timers)) return warn(`Timer '${label}' does not exist`);
    const args = [elapsed(label)];
    delete timers[label];
    return { type: 'timeEnd', args };
  });
}

// ---- shadow roots ----

/** Records shadow roots as they are attached: closed ones are not reachable otherwise. */
function hookShadowRoots(roots: WeakMap<Element, ShadowRoot>, listeners: Set<(root: ShadowRoot) => void>) {
  const attachShadow = Element.prototype.attachShadow;
  if (!attachShadow) return;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init);
    roots.set(this, root);
    for (const listener of listeners) listener(root);
    return root;
  };
}

// ---- WebMCP ----

/**
 * Records where each WebMCP tool was registered, and what its `execute` returns or throws:
 * the browser's `executeTool` gives only JSON text, or the fact that the tool failed.
 */
function hookModelContext(tools: Probe['tools']) {
  const ctor: unknown = Reflect.get(window, 'ModelContext');
  const proto: unknown = typeof ctor === 'function' ? ctor.prototype : undefined;
  const registerTool: unknown = proto && Reflect.get(proto, 'registerTool');
  if (!proto || typeof registerTool !== 'function') return;
  Reflect.set(proto, 'registerTool', function (this: unknown, tool: unknown, ...rest: unknown[]) {
    const execute: unknown = tool && typeof tool === 'object' ? Reflect.get(tool, 'execute') : undefined;
    let kept: { name: string; record: ToolRecord } | undefined;
    if (tool && typeof tool === 'object' && typeof execute === 'function') {
      const record: ToolRecord = { stack: new Error().stack, outcomes: [] };
      kept = { name: String(Reflect.get(tool, 'name')), record };
      const settle = (threw: boolean, value: unknown) => {
        // Calls nobody takes the outcome of (another agent's) must not pile up.
        if (record.outcomes.push({ threw, value }) > MAX_TOOL_OUTCOMES) record.outcomes.shift();
      };
      const done = (value: unknown) => {
        settle(false, value);
        return value;
      };
      const fail = (value: unknown) => {
        settle(true, value);
        throw value;
      };
      const wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          const result: unknown = Reflect.apply(execute, this, args);
          return result instanceof Promise ? result.then(done, fail) : done(result);
        } catch (error) {
          return fail(error);
        }
      };
      // Only `execute` is replaced: the other fields are read from the page's object as is,
      // including getters and fields on its prototype (a class instance).
      tool = new Proxy(tool, {
        get: (target, key) => (key === 'execute' ? wrapped : Reflect.get(target, key)),
      });
    }
    const registered: unknown = Reflect.apply(registerTool, this, [tool, ...rest]);
    // Kept only once the browser accepted the tool, and only while it stays registered: the
    // record holds the tool's last results, and a later tool of the same name needs its own.
    if (kept) {
      const { name, record } = kept;
      tools.set(name, record);
      const options = rest[0];
      const signal: unknown = options && typeof options === 'object' ? Reflect.get(options, 'signal') : undefined;
      if (signal instanceof AbortSignal) {
        if (signal.aborted) forgetTool(tools, name, record);
        else signal.addEventListener('abort', () => forgetTool(tools, name, record), { once: true });
      }
    }
    return registered;
  });
  const unregisterTool: unknown = Reflect.get(proto, 'unregisterTool');
  if (typeof unregisterTool === 'function')
    Reflect.set(proto, 'unregisterTool', function (this: unknown, name: unknown, ...rest: unknown[]) {
      const result: unknown = Reflect.apply(unregisterTool, this, [name, ...rest]);
      tools.delete(String(name));
      return result;
    });
}

function forgetTool(tools: Probe['tools'], name: string, record: ToolRecord) {
  if (tools.get(name) === record) tools.delete(name);
}

// ---- event listeners ----

/**
 * Records listeners as the DOM keeps them: duplicates are ignored, `once` listeners are
 * forgotten after they run, and listeners with an aborted `signal` are forgotten too.
 */
function hookListeners(listeners: WeakMap<EventTarget, ListenerRecord[]>) {
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  // Undoes what was added alongside a record (see below), for when the page removes it first.
  const cleanups = new WeakMap<ListenerRecord, () => void>();
  const captureOf = (options?: boolean | EventListenerOptions) =>
    typeof options === 'boolean' ? options : !!options?.capture;

  proto.addEventListener = function (this: EventTarget, type, listener, options) {
    add.call(this, type, listener, options);
    // Unqualified calls like addEventListener('load', f) run on the global object.
    const target: EventTarget = this ?? globalThis;
    const opts = typeof options === 'object' ? options : undefined;
    if (!listener || opts?.signal?.aborted) return;
    const capture = captureOf(options);
    let found = listeners.get(target);
    if (!found) listeners.set(target, (found = []));
    const list = found;
    if (list.some(r => r.type === type && r.listener === listener && r.capture === capture)) return;
    const record: ListenerRecord = { type, listener, capture, passive: !!opts?.passive, once: !!opts?.once };
    list.push(record);
    // A method keeps its name through minification, so browser DevTools attached to the
    // page (which also list this helper) show what it is.
    const forget = {
      devtoolsAnywhereForget() {
        const i = list.indexOf(record);
        if (i >= 0) list.splice(i, 1);
      },
    }.devtoolsAnywhereForget;
    const signal = opts?.signal;
    if (record.once) add.call(target, type, forget, { capture, once: true });
    if (signal) add.call(signal, 'abort', forget, { once: true });
    if (record.once || signal)
      cleanups.set(record, () => {
        if (record.once) remove.call(target, type, forget, { capture });
        if (signal) remove.call(signal, 'abort', forget);
      });
  };

  proto.removeEventListener = function (this: EventTarget, type, listener, options) {
    remove.call(this, type, listener, options);
    const list = listeners.get(this ?? globalThis);
    const capture = captureOf(options);
    const i = list ? list.findIndex(r => r.type === type && r.listener === listener && r.capture === capture) : -1;
    if (!list || i < 0) return;
    const [record] = list.splice(i, 1);
    if (record) cleanups.get(record)?.();
  };
}

// ---- uncaught errors ----

/** The stack of a thrown value, if it has a string one: page values may have anything there. */
function stackOf(value: unknown): string | undefined {
  try {
    const stack: unknown = (value as { stack?: unknown } | null | undefined)?.stack;
    return typeof stack === 'string' ? stack : undefined;
  } catch {
    return undefined;
  }
}

function hookErrors(addLog: (entry: LogEntry) => void, now: () => number) {
  window.addEventListener('error', e => {
    if (!(e instanceof ErrorEvent)) return;
    addLog({
      kind: 'exception',
      text: 'Uncaught',
      error: e.error !== undefined ? e.error : e.message,
      time: now(),
      stack: stackOf(e.error),
      url: e.filename,
      line: e.lineno,
      column: e.colno,
    });
  });
  window.addEventListener('unhandledrejection', e => {
    addLog({
      kind: 'exception',
      text: 'Uncaught (in promise)',
      error: e.reason,
      time: now(),
      stack: stackOf(e.reason),
    });
  });
}

// ---- network ----

type Track = (record: Omit<RequestRecord, 'requestId' | 'startTime' | 'wallTime' | 'state'>) => RequestRecord;
type Update = (rec: RequestRecord, patch: Partial<RequestRecord>) => void;

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((v, k) => (obj[k] = v));
  return obj;
}

function bodyToString(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

function mimeTypeOf(contentType: string | null | undefined) {
  return ((contentType || '').split(';')[0] ?? '').trim();
}

function hookFetch(track: Track, update: Update) {
  const origFetch = window.fetch;
  if (!origFetch) return;
  const failed = (rec: RequestRecord, err: unknown) =>
    update(rec, {
      state: 'failed',
      // Like Chrome, a request stopped through its AbortSignal is reported as canceled.
      ...(err instanceof DOMException && err.name === 'AbortError'
        ? { errorText: 'net::ERR_ABORTED', canceled: true }
        : // The page only sees a TypeError; the net error behind it is not exposed.
          { errorText: 'net::ERR_FAILED' }),
      endTime: performance.now(),
    });
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const req = input instanceof Request ? input : null;
    const headers = init?.headers || req?.headers;
    let url: string;
    let requestHeaders: Record<string, string>;
    try {
      url = new URL(req ? req.url : String(input), location.href).href;
      requestHeaders = headers ? headersToObject(new Headers(headers)) : {};
    } catch {
      // An invalid URL or header: fetch itself rejects, without making a request.
      return origFetch.call(this, input, init);
    }
    const postData = bodyToString(init?.body);
    // Other bodies (in a Request, FormData, Blob, buffers) are read from a copy, afterwards.
    let copy: Request | undefined;
    if (postData === undefined) {
      const body = init?.body;
      try {
        if (body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body))
          copy = new Request(url, { method: 'POST', body });
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
        if (text.length <= MAX_BODY_LENGTH) update(rec, { postData: text });
      },
      () => {}
    );
    let promise: Promise<Response>;
    try {
      promise = origFetch.call(this, input, init);
    } catch (err) {
      failed(rec, err);
      return Promise.reject(err);
    }
    promise.then(
      res => {
        const contentType = res.headers.get('content-type');
        update(rec, {
          state: 'headers',
          responseTime: performance.now(),
          status: res.status,
          statusText: res.statusText,
          responseHeaders: headersToObject(res.headers),
          mimeType: mimeTypeOf(contentType),
        });
        const length = Number(res.headers.get('content-length'));
        // Never read streams that may not end, or bodies that are too large to keep.
        if (!res.body || mimeTypeOf(contentType) === 'text/event-stream' || length > MAX_BODY_LENGTH) {
          update(rec, { state: 'done', endTime: performance.now(), encodedDataLength: length || 0 });
          return;
        }
        const copy = res.clone().body;
        if (!copy) return;
        readCapped(copy, contentType ?? '').then(
          ({ blob, size }) =>
            update(rec, {
              state: 'done',
              body: blob,
              encodedDataLength: length || size,
              endTime: performance.now(),
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
 * Reads a copy of a response body chunk by chunk, up to MAX_BODY_LENGTH: past it the copy is
 * cancelled, so a body without content-length that turns out large, or a stream that does not
 * end, is never buffered whole (neither here nor in the tee feeding the page's copy).
 */
async function readCapped(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  type: string
): Promise<{ blob?: Blob; size: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { blob: new Blob(chunks, { type }), size };
    size += value.byteLength;
    if (size > MAX_BODY_LENGTH) {
      void reader.cancel().catch(() => {});
      return { size };
    }
    chunks.push(value);
  }
}

function parseRawHeaders(raw: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':');
    if (i > 0) obj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return obj;
}

interface XhrInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function hookXhr(track: Track, update: Update, listen: EventTarget['addEventListener']) {
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origSetRequestHeader = proto.setRequestHeader;
  const infos = new WeakMap<XMLHttpRequest, XhrInfo>();
  // The record of the request each XHR is making now: an XHR can be reused for another one.
  const current = new WeakMap<XMLHttpRequest, RequestRecord>();
  const watched = new WeakSet<XMLHttpRequest>();

  proto.open = function (
    this: XMLHttpRequest,
    ...args: [method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null]
  ) {
    // open() stops the request in progress without any event.
    const rec = current.get(this);
    if (rec) {
      current.delete(this);
      update(rec, { state: 'failed', errorText: 'net::ERR_ABORTED', canceled: true, endTime: performance.now() });
    }
    infos.set(this, {
      method: String(args[0]).toUpperCase(),
      url: new URL(String(args[1]), location.href).href,
      headers: {},
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
      // Tracked before sending: a synchronous request completes within send().
      const rec = track({
        type: 'XHR',
        method: info.method,
        url: info.url,
        requestHeaders: info.headers,
        postData: bodyToString(body),
        stack: new Error().stack,
      });
      if (!watched.has(this)) {
        watched.add(this);
        watchXhr(this, current, update, listen);
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
          errorText: String((err instanceof Error && err.message) || err),
          endTime: performance.now(),
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
  current: WeakMap<XMLHttpRequest, RequestRecord>,
  update: Update,
  listen: EventTarget['addEventListener']
) {
  const finish = (patch: Partial<RequestRecord>) => {
    const rec = current.get(xhr);
    if (!rec) return;
    current.delete(xhr);
    update(rec, { ...patch, endTime: performance.now() });
  };
  const responseMeta = () => {
    const responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
    return {
      status: xhr.status,
      statusText: xhr.statusText,
      responseHeaders,
      mimeType: mimeTypeOf(responseHeaders['content-type']),
    };
  };
  listen.call(xhr, 'readystatechange', () => {
    const rec = current.get(xhr);
    if (!rec) return;
    if (xhr.readyState === 2) {
      update(rec, { state: 'headers', responseTime: performance.now(), ...responseMeta() });
    } else if (xhr.readyState === 4) {
      // Failures are told apart by the event that follows: abort, timeout or error.
      if (!xhr.status) return;
      const type = xhr.responseType;
      let body: string | Blob | undefined;
      if (type === '' || type === 'text') body = xhr.responseText;
      else if (type === 'json') body = JSON.stringify(xhr.response);
      else if (type === 'blob' && xhr.response instanceof Blob) body = xhr.response;
      // Bytes on the wire, as fetch() reports them: the header, else the body's UTF-8 size.
      const length = Number(xhr.getResponseHeader('content-length'));
      let size = typeof body === 'string' ? new Blob([body]).size : body?.size || 0;
      if (type === 'arraybuffer' && xhr.response instanceof ArrayBuffer) {
        // Copied only when kept: the page may still change its buffer.
        size = xhr.response.byteLength;
        if (size <= MAX_BODY_LENGTH) body = new Blob([xhr.response]);
      }
      // Like fetch(), bodies too large to keep are left out; only their length is reported.
      finish({
        state: 'done',
        ...responseMeta(),
        body: size > MAX_BODY_LENGTH ? undefined : body,
        encodedDataLength: length || size,
      });
    }
  });
  listen.call(xhr, 'abort', () => finish({ state: 'failed', errorText: 'net::ERR_ABORTED', canceled: true }));
  // Chrome reports a timed-out XHR as aborted too.
  listen.call(xhr, 'timeout', () => finish({ state: 'failed', errorText: 'net::ERR_ABORTED', canceled: true }));
  listen.call(xhr, 'error', () => finish({ state: 'failed', errorText: 'net::ERR_FAILED' }));
}
