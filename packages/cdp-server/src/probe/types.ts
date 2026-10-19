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

export interface RequestRecord {
  requestId: string
  type: 'Fetch' | 'XHR'
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
}
