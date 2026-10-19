/** Global key the probe is installed under, so the CDP server can find an earlier probe. */
export const PROBE_KEY = '__devtoolsAnywhereProbe__'

/** Values of `Runtime.consoleAPICalled` `type`. */
export type ConsoleType =
  | 'log'
  | 'debug'
  | 'info'
  | 'error'
  | 'warning'
  | 'dir'
  | 'dirxml'
  | 'table'
  | 'trace'
  | 'clear'
  | 'startGroup'
  | 'startGroupCollapsed'
  | 'endGroup'
  | 'assert'
  | 'count'
  | 'timeEnd'

export interface ConsoleEntry {
  kind: 'console'
  type: ConsoleType
  args: unknown[]
  /** Milliseconds since epoch. */
  time: number
  /** Raw `Error().stack` taken inside the console wrapper. */
  stack?: string
}

export interface ExceptionEntry {
  kind: 'exception'
  text: string
  error: unknown
  time: number
  stack?: string
  url?: string
  line?: number
  column?: number
}

export type LogEntry = ConsoleEntry | ExceptionEntry

/** CDP resource types of the requests the probe records. */
export type RequestType = 'Fetch' | 'XHR' | 'Document' | 'Stylesheet' | 'Script' | 'Image' | 'Font' | 'Media' | 'Ping' | 'Other'

export interface RequestRecord {
  requestId: string
  type: RequestType
  /**
   * For requests the probe could not hook (documents, style sheets, scripts, images, …),
   * known only from their Resource Timing entry once they finished: the entry's
   * `initiatorType`. Headers and bodies of these requests are not available.
   */
  initiatorType?: string
  method: string
  url: string
  requestHeaders: Record<string, string>
  postData?: string
  /** Stack of the code that started the request. */
  stack?: string
  /** `performance.now()` at start, in milliseconds. */
  startTime: number
  /** `Date.now()` at start. */
  wallTime: number
  state: 'pending' | 'headers' | 'done' | 'failed'
  /** `performance.now()` when the response headers arrived. */
  responseTime?: number
  status?: number
  statusText?: string
  responseHeaders?: Record<string, string>
  mimeType?: string
  /** Response text; absent when it was not captured (binary, streaming or too large). */
  body?: string
  encodedDataLength?: number
  /** `performance.now()` when the response finished or failed. */
  endTime?: number
  errorText?: string
}

export interface ListenerRecord {
  type: string
  listener: EventListenerOrEventListenerObject
  capture: boolean
  passive: boolean
  once: boolean
}

export interface Probe {
  version: 1
  /** Ring buffer of console calls and uncaught exceptions. */
  logs: LogEntry[]
  /** Ring buffer of fetch/XHR requests; records are updated in place. */
  requests: RequestRecord[]
  /** Subscribes to new log entries. Returns an unsubscribe function. */
  onLog(listener: (entry: LogEntry) => void): () => void
  /** Subscribes to request creation and every later state change. */
  onRequest(listener: (record: RequestRecord) => void): () => void
  clearLogs(): void
  /** Every shadow root attached since the probe ran, including closed ones. */
  shadowRoots: WeakMap<Element, ShadowRoot>
  /** Event listeners currently registered with addEventListener, per target. */
  listeners: WeakMap<EventTarget, ListenerRecord[]>
  /** URLs of devtools-anywhere's own resources (bundle, frontend), left out of the Network panel. */
  ownUrls: Set<string>
  /** The page's fetch before it was hooked: DevTools' own requests stay out of the Network panel. */
  fetch: typeof fetch
}
