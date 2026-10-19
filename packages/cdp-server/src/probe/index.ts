// Early-capture probe.
//
// Load it as the first synchronous script of a page (probe.iife.js). It hooks console,
// uncaught errors and fetch/XHR once, keeps recent events in ring buffers, and the CDP
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
} from './types'

import { isShellPage, readShellConfig, writeShellDocument } from './shell'

export * from './types'
export * from './shell'

const MAX_LOGS = 1000
const MAX_REQUESTS = 300
const MAX_BODY_LENGTH = 5 * 1024 * 1024

export function installProbe(): Probe {
  const w = window as any
  if (w[PROBE_KEY]) return w[PROBE_KEY]

  const logs: LogEntry[] = []
  const requests: RequestRecord[] = []
  const logListeners = new Set<(entry: LogEntry) => void>()
  const requestListeners = new Set<(record: RequestRecord) => void>()

  const probe: Probe = {
    version: 1,
    logs,
    requests,
    onLog(listener) {
      logListeners.add(listener)
      return () => logListeners.delete(listener)
    },
    onRequest(listener) {
      requestListeners.add(listener)
      return () => requestListeners.delete(listener)
    },
    clearLogs() {
      logs.length = 0
    },
    shadowRoots: new WeakMap(),
    listeners: new WeakMap(),
    ownUrls: new Set(),
    fetch: w.fetch?.bind(w),
  }
  Object.defineProperty(w, PROBE_KEY, { value: probe })

  const now = () => performance.timeOrigin + performance.now()

  function addLog(entry: LogEntry) {
    if (logs.push(entry) > MAX_LOGS) logs.shift()
    logListeners.forEach(fn => fn(entry))
  }

  hookConsole(addLog, now)
  hookErrors(addLog, now)
  hookShadowRoots(probe.shadowRoots)
  hookListeners(probe.listeners)

  let seq = 0
  function add(rec: RequestRecord) {
    rec.requestId = 'probe.' + ++seq
    if (requests.push(rec) > MAX_REQUESTS) requests.shift()
    requestListeners.forEach(fn => fn(rec))
    return rec
  }
  function track(record: Omit<RequestRecord, 'requestId' | 'startTime' | 'wallTime' | 'state'>): RequestRecord {
    return add({ ...record, requestId: '', startTime: performance.now(), wallTime: Date.now(), state: 'pending' })
  }
  function update(rec: RequestRecord, patch: Partial<RequestRecord>) {
    Object.assign(rec, patch)
    requestListeners.forEach(fn => fn(rec))
  }
  hookFetch(track, update)
  hookXhr(track, update)
  observeResources(add, update, requests)

  const shell = readShellConfig()
  if (shell && window === top) {
    writeShellDocument(shell)
  } else if (shell && isShellPage()) {
    // Load the bundle that connects this page to the shell; capture continues meanwhile.
    const script = document.createElement('script')
    script.src = shell.bundle
    probe.ownUrls.add(script.src)
    document.documentElement.appendChild(script)
  }

  return probe
}

// ---- other requests (Resource Timing) ----

/** CDP resource type of a Resource Timing entry, from its MIME type or initiator. */
function resourceType(entry: PerformanceResourceTiming, mimeType: string): RequestType {
  if (entry.entryType === 'navigation') return 'Document'
  if (/^text\/css\b/.test(mimeType)) return 'Stylesheet'
  if (/javascript|ecmascript/.test(mimeType)) return 'Script'
  if (/^image\//.test(mimeType)) return 'Image'
  if (/^font\/|woff|opentype|truetype/.test(mimeType)) return 'Font'
  if (/^(audio|video)\//.test(mimeType)) return 'Media'
  if (/^text\/html\b/.test(mimeType)) return 'Document'
  switch (entry.initiatorType) {
    case 'img':
    case 'image':
    case 'input':
      return 'Image'
    case 'script':
      return 'Script'
    case 'audio':
    case 'video':
    case 'track':
      return 'Media'
    case 'iframe':
    case 'frame':
      return 'Document'
    case 'beacon':
      return 'Ping'
    default:
      return 'Other'
  }
}

/**
 * Records the requests that cannot be hooked (the document, style sheets, scripts, images,
 * fonts, …) from Resource Timing. Entries are only created once a request has finished, and
 * `buffered` also delivers those from before the probe ran, such as the document itself.
 */
function observeResources(add: (rec: RequestRecord) => void, update: Update, requests: RequestRecord[]) {
  if (typeof PerformanceObserver === 'undefined') return
  // In shell mode with the Service Worker, it reports what Resource Timing does not expose
  // (headers, status text) of same-origin subresources, before the request's entry exists.
  // They are matched by URL; a late report still completes the record.
  const details = new Map<string, Partial<RequestRecord>[]>()
  const sw = navigator.serviceWorker
  if (sw) {
    sw.addEventListener('message', event => {
      const { type, url, ...patch } = event.data || {}
      if (type !== 'devtools-anywhere:response') return
      const rec = requests.find(r => r.url === url && r.initiatorType && !Object.keys(r.responseHeaders || {}).length)
      if (rec) update(rec, patch)
      else (details.get(url) || details.set(url, []).get(url)!).push(patch)
    })
    sw.startMessages()
  }
  // The navigation entry can be delivered again once the page has loaded.
  const seen = new Set<PerformanceEntry>()
  const record = (entry: PerformanceResourceTiming) => {
    if (seen.has(entry)) return
    seen.add(entry)
    // fetch() and XHR are hooked, with more detail; DevTools' own fetches are unhooked.
    if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') return
    // The browser's own favicon request is not the page's, and Chrome does not report it.
    if (entry.initiatorType === 'other' && /\/favicon\.ico$/.test(entry.name.split(/[?#]/)[0])) return
    const mimeType = (entry as any).contentType || ''
    const status: number = (entry as any).responseStatus || 0
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
    })
  }
  for (const type of ['navigation', 'resource']) {
    try {
      new PerformanceObserver(list => list.getEntries().forEach(e => record(e as PerformanceResourceTiming))).observe({
        type,
        buffered: true,
      })
    } catch {
      // Entry type not supported.
    }
  }
}

// ---- console ----

function hookConsole(addLog: (entry: LogEntry) => void, now: () => number) {
  const c = console as any
  const counts: Record<string, number> = {}
  const timers: Record<string, number> = {}

  const wrap = (name: string, capture: (args: any[]) => Pick<ConsoleEntry, 'type' | 'args'> | null) => {
    const orig = c[name]
    if (typeof orig !== 'function') return
    c[name] = function (...args: any[]) {
      const captured = capture(args)
      if (captured) {
        addLog({ kind: 'console', type: captured.type, args: captured.args, time: now(), stack: new Error().stack })
      }
      return orig.apply(this, args)
    }
  }

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
  ]
  // Like V8: calls without arguments are dropped, except for these, which log their own name.
  const namedWhenEmpty = new Set(['group', 'groupCollapsed', 'groupEnd', 'trace'])
  for (const [name, type] of plain) {
    wrap(name, args => {
      if (args.length) return { type, args }
      return namedWhenEmpty.has(name) ? { type, args: ['console.' + name] } : null
    })
  }

  wrap('clear', () => ({ type: 'clear', args: [] }))
  wrap('assert', ([condition, ...rest]) =>
    condition ? null : { type: 'assert', args: rest.length ? rest : ['console.assert'] }
  )
  wrap('count', ([label = 'default']) => {
    counts[label] = (counts[label] || 0) + 1
    return { type: 'count', args: [`${label}: ${counts[label]}`] }
  })
  wrap('countReset', ([label = 'default']) => {
    counts[label] = 0
    return null
  })
  wrap('time', ([label = 'default']) => {
    timers[label] = performance.now()
    return null
  })
  const elapsed = (label: string) => `${label}: ${performance.now() - timers[label]} ms`
  wrap('timeLog', ([label = 'default', ...rest]) =>
    label in timers ? { type: 'log', args: [elapsed(label), ...rest] } : null
  )
  wrap('timeEnd', ([label = 'default']) => {
    if (!(label in timers)) return null
    const args = [elapsed(label)]
    delete timers[label]
    return { type: 'timeEnd', args }
  })
}

// ---- shadow roots ----

/** Records shadow roots as they are attached: closed ones are not reachable otherwise. */
function hookShadowRoots(roots: WeakMap<Element, ShadowRoot>) {
  const attachShadow = Element.prototype.attachShadow
  if (!attachShadow) return
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init)
    roots.set(this, root)
    return root
  }
}

// ---- event listeners ----

/**
 * Records listeners as the DOM keeps them: duplicates are ignored, `once` listeners are
 * forgotten after they run, and listeners with an aborted `signal` are forgotten too.
 */
function hookListeners(listeners: WeakMap<EventTarget, ListenerRecord[]>) {
  const proto = EventTarget.prototype
  const add = proto.addEventListener
  const remove = proto.removeEventListener
  const captureOf = (options?: boolean | EventListenerOptions) =>
    typeof options === 'boolean' ? options : !!options?.capture

  proto.addEventListener = function (this: EventTarget, type, listener, options) {
    add.call(this, type, listener, options)
    // Unqualified calls like addEventListener('load', f) run on the global object.
    const target: EventTarget = this ?? globalThis
    const opts = typeof options === 'object' ? options : undefined
    if (!listener || opts?.signal?.aborted) return
    const capture = captureOf(options)
    let list = listeners.get(target)
    if (!list) listeners.set(target, (list = []))
    if (list.some(r => r.type === type && r.listener === listener && r.capture === capture)) return
    const record: ListenerRecord = { type, listener, capture, passive: !!opts?.passive, once: !!opts?.once }
    list.push(record)
    // A method keeps its name through minification, so browser DevTools attached to the
    // page (which also list this helper) show what it is.
    const forget = {
      devtoolsAnywhereForget() {
        const i = list!.indexOf(record)
        if (i >= 0) list!.splice(i, 1)
      },
    }.devtoolsAnywhereForget
    if (record.once) add.call(target, type, forget, { capture, once: true })
    if (opts?.signal) add.call(opts.signal, 'abort', forget, { once: true })
  }

  proto.removeEventListener = function (this: EventTarget, type, listener, options) {
    remove.call(this, type, listener, options)
    const list = listeners.get(this ?? globalThis)
    const capture = captureOf(options)
    const i = list ? list.findIndex(r => r.type === type && r.listener === listener && r.capture === capture) : -1
    if (i >= 0) list!.splice(i, 1)
  }
}

// ---- uncaught errors ----

function hookErrors(addLog: (entry: LogEntry) => void, now: () => number) {
  window.addEventListener('error', e => {
    if (!(e instanceof ErrorEvent)) return
    addLog({
      kind: 'exception',
      text: 'Uncaught',
      error: e.error !== undefined ? e.error : e.message,
      time: now(),
      stack: e.error?.stack,
      url: e.filename,
      line: e.lineno,
      column: e.colno,
    })
  })
  window.addEventListener('unhandledrejection', e => {
    addLog({
      kind: 'exception',
      text: 'Uncaught (in promise)',
      error: e.reason,
      time: now(),
      stack: e.reason?.stack,
    })
  })
}

// ---- network ----

type Track = (record: Omit<RequestRecord, 'requestId' | 'startTime' | 'wallTime' | 'state'>) => RequestRecord
type Update = (rec: RequestRecord, patch: Partial<RequestRecord>) => void

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {}
  headers.forEach((v, k) => (obj[k] = v))
  return obj
}

function bodyToString(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return undefined
}

function mimeTypeOf(contentType: string | null | undefined) {
  return (contentType || '').split(';')[0].trim()
}

function hookFetch(track: Track, update: Update) {
  const origFetch = window.fetch
  if (!origFetch) return
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const req = input instanceof Request ? input : null
    const headers = init?.headers || req?.headers
    const rec = track({
      type: 'Fetch',
      method: String(init?.method || req?.method || 'GET').toUpperCase(),
      url: new URL(req ? req.url : String(input), location.href).href,
      requestHeaders: headers ? headersToObject(new Headers(headers)) : {},
      postData: bodyToString(init?.body),
      stack: new Error().stack,
    })
    const promise = origFetch.call(this, input as any, init)
    promise.then(
      res => {
        const contentType = res.headers.get('content-type')
        update(rec, {
          state: 'headers',
          responseTime: performance.now(),
          status: res.status,
          statusText: res.statusText,
          responseHeaders: headersToObject(res.headers),
          mimeType: mimeTypeOf(contentType),
        })
        const length = Number(res.headers.get('content-length'))
        // Never read streams that may not end, or bodies that are too large to keep.
        if (!res.body || mimeTypeOf(contentType) === 'text/event-stream' || length > MAX_BODY_LENGTH) {
          update(rec, { state: 'done', endTime: performance.now(), encodedDataLength: length || 0 })
          return
        }
        res
          .clone()
          .text()
          .then(
            text =>
              update(rec, {
                state: 'done',
                body: text.length > MAX_BODY_LENGTH ? undefined : text,
                encodedDataLength: length || text.length,
                endTime: performance.now(),
              }),
            err => update(rec, { state: 'failed', errorText: String(err?.message || err), endTime: performance.now() })
          )
      },
      err => update(rec, { state: 'failed', errorText: String(err?.message || err), endTime: performance.now() })
    )
    return promise
  }
}

function parseRawHeaders(raw: string): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(':')
    if (i > 0) obj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return obj
}

interface XhrInfo {
  method: string
  url: string
  headers: Record<string, string>
}

function hookXhr(track: Track, update: Update) {
  const proto = XMLHttpRequest.prototype
  const origOpen = proto.open
  const origSend = proto.send
  const origSetRequestHeader = proto.setRequestHeader
  const infos = new WeakMap<XMLHttpRequest, XhrInfo>()

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    infos.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), location.href).href, headers: {} })
    return origOpen.apply(this, arguments as any)
  } as typeof proto.open

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const info = infos.get(this)
    if (info) info.headers[name] = value
    return origSetRequestHeader.call(this, name, value)
  }

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = infos.get(this)
    if (info) {
      const xhr = this
      const rec = track({
        type: 'XHR',
        method: info.method,
        url: info.url,
        requestHeaders: info.headers,
        postData: bodyToString(body),
        stack: new Error().stack,
      })
      const responseMeta = () => {
        const responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders())
        return {
          status: xhr.status,
          statusText: xhr.statusText,
          responseHeaders,
          mimeType: mimeTypeOf(responseHeaders['content-type']),
        }
      }
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState === 2) {
          update(rec, { state: 'headers', responseTime: performance.now(), ...responseMeta() })
        } else if (xhr.readyState === 4) {
          if (!xhr.status) {
            update(rec, { state: 'failed', errorText: 'net::ERR_FAILED', endTime: performance.now() })
            return
          }
          let text: string | undefined
          if (xhr.responseType === '' || xhr.responseType === 'text') text = xhr.responseText
          else if (xhr.responseType === 'json') text = JSON.stringify(xhr.response)
          update(rec, {
            state: 'done',
            ...responseMeta(),
            body: text,
            encodedDataLength: text?.length || 0,
            endTime: performance.now(),
          })
        }
      })
    }
    return origSend.call(this, body)
  }
}
