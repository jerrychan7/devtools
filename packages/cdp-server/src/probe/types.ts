/** Global key the probe is installed under, so the CDP server can find an earlier probe. */
export const PROBE_KEY = '__devtoolsAnywhereProbe__';

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
  | 'timeEnd';

export interface ConsoleEntry {
  kind: 'console';
  type: ConsoleType;
  args: unknown[];
  /** Milliseconds since epoch. */
  time: number;
  /** Raw `Error().stack` taken inside the console wrapper. */
  stack?: string | undefined;
}

export interface ExceptionEntry {
  kind: 'exception';
  text: string;
  error: unknown;
  time: number;
  stack?: string | undefined;
  url?: string;
  line?: number;
  column?: number;
}

export type LogEntry = ConsoleEntry | ExceptionEntry;

/** CDP resource types of the requests the probe records. */
export type RequestType =
  | 'Fetch'
  | 'XHR'
  | 'Document'
  | 'Stylesheet'
  | 'Script'
  | 'Image'
  | 'Font'
  | 'Media'
  | 'Ping'
  | 'Other';

export interface RequestRecord {
  requestId: string;
  type: RequestType;
  /**
   * For requests the probe could not hook (documents, style sheets, scripts, images, …),
   * known only from their Resource Timing entry once they finished: the entry's
   * `initiatorType`. Headers and bodies of these requests are not available.
   */
  initiatorType?: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  postData?: string | undefined;
  /** The request has a body that is read afterwards: `postData` is set once it is. */
  hasPostData?: boolean;
  /** Stack of the code that started the request. */
  stack?: string | undefined;
  /** `performance.now()` at start, in milliseconds. */
  startTime: number;
  /** `Date.now()` at start. */
  wallTime: number;
  state: 'pending' | 'headers' | 'done' | 'failed';
  /** `performance.now()` when the response headers arrived. */
  responseTime?: number;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  /**
   * Response body: text, or the raw data of binary responses (decoded only when asked for);
   * absent when it was not captured (streaming or too large).
   */
  body?: string | Blob | undefined;
  encodedDataLength?: number;
  /** `performance.now()` when the response finished or failed. */
  endTime?: number;
  errorText?: string;
  /** Whether a failed request was stopped by the page (abort), not by an error. */
  canceled?: boolean;
}

/** Something that happened on a WebSocket after it was created. */
export interface SocketEvent {
  type: 'sent' | 'received' | 'error';
  /** `performance.now()` when it happened. */
  time: number;
  /** Payload as given to `send()` or carried by the `message` event: a string, Blob, ArrayBuffer or view. */
  data?: unknown;
}

export interface SocketRecord {
  requestId: string;
  url: string;
  /** Stack of the code that created the socket. */
  stack?: string | undefined;
  /** `performance.now()` at creation. */
  startTime: number;
  /** `Date.now()` at creation. */
  wallTime: number;
  /** `performance.now()` when the connection opened. */
  openTime?: number;
  /** `performance.now()` when the connection closed. */
  closeTime?: number;
  /** Frames and errors, oldest first; the oldest are dropped past a limit. */
  events: SocketEvent[];
}

export interface ListenerRecord {
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  passive: boolean;
  once: boolean;
}

export interface Probe {
  version: 1;
  /** Ring buffer of console calls and uncaught exceptions. */
  logs: LogEntry[];
  /** Ring buffer of fetch/XHR requests and the others seen by Resource Timing; records are updated in place. */
  requests: RequestRecord[];
  /** Ring buffer of WebSockets; records are updated in place. */
  sockets: SocketRecord[];
  /** Subscribes to new log entries. Returns an unsubscribe function. */
  onLog(listener: (entry: LogEntry) => void): () => void;
  /** Subscribes to request creation and every later state change. */
  onRequest(listener: (record: RequestRecord) => void): () => void;
  /** Subscribes to WebSocket creation and every later change. */
  onSocket(listener: (record: SocketRecord) => void): () => void;
  clearLogs(): void;
  /** Every shadow root attached since the probe ran, including closed ones. */
  shadowRoots: WeakMap<Element, ShadowRoot>;
  /** Event listeners currently registered with addEventListener, per target. */
  listeners: WeakMap<EventTarget, ListenerRecord[]>;
  /** URLs of devtools-anywhere's own resources (bundle, frontend), left out of the Network panel. */
  ownUrls: Set<string>;
  /** The page's fetch before it was hooked: DevTools' own requests stay out of the Network panel. */
  fetch: typeof fetch;
  /** WebMCP tools registered with `document.modelContext.registerTool`, by name. */
  tools: Map<string, ToolRecord>;
}

export interface ToolRecord {
  /** Raw `Error().stack` taken inside the registerTool wrapper. */
  stack?: string | undefined;
  /**
   * What the tool's `execute` returned or threw, one entry per call in the order they
   * settled, taken by the invocation they belong to: the browser's `executeTool` gives
   * results as JSON text, and errors only as the fact that the tool failed.
   */
  outcomes: ToolOutcome[];
}

export interface ToolOutcome {
  threw: boolean;
  value: unknown;
}
