// The probe records raw facts only, to stay small; this turns them into the entries and
// records the domains use, once DevTools connects.
import type { ConsoleEntry, ConsoleType, LogEntry, Probe, ProbeLog, ProbeRequest, RequestRecord } from '../probe/types';

/** The probe as the domains see it: log entries and request records in their final form. */
export interface ProbeView extends Omit<Probe, 'logs' | 'requests' | 'onLog' | 'onRequest' | 'limits' | 'WebSocket'> {
  readonly logs: LogEntry[];
  readonly requests: RequestRecord[];
  onLog(listener: (entry: LogEntry) => void): () => void;
  onRequest(listener: (record: RequestRecord) => void): () => void;
}

const CONSOLE_TYPES: Record<string, ConsoleType> = {
  warn: 'warning',
  group: 'startGroup',
  groupCollapsed: 'startGroupCollapsed',
  groupEnd: 'endGroup',
};
/** Console methods whose name is already their CDP type. */
const SAME_TYPES = new Set<string>([
  'log',
  'debug',
  'info',
  'error',
  'dir',
  'dirxml',
  'table',
  'trace',
  'clear',
  'assert',
  'count',
  'timeEnd',
]);
const isConsoleType = (name: string): name is ConsoleType => SAME_TYPES.has(name);

/** A console call as V8 reports it, with misuses of counters and timers as warnings naming the label. */
function consoleEntry(call: Extract<ProbeLog, { kind: 'console' }>): Omit<ConsoleEntry, 'stack'> {
  const { type: name, args, fact } = call;
  const time = performance.timeOrigin + call.time;
  const entry = (type: ConsoleType, entryArgs: unknown[]) => ({
    kind: 'console' as const,
    type,
    args: entryArgs,
    time,
  });
  const warn = (text: string) => entry('warning', [text]);
  // Counters and timers: the probe put the label string first.
  const label = typeof args[0] === 'string' ? args[0] : '';
  const elapsed = () => `${label}: ${call.time - (fact ?? 0)} ms`;
  switch (name) {
    case 'debugger':
      return warn('debugger statement hit (pausing is not supported)');
    case 'assert':
      return entry('assert', args.length ? args : ['console.assert']);
    case 'count':
      return entry('count', [`${label}: ${fact}`]);
    case 'countReset':
      return warn(`Count for '${label}' does not exist`);
    case 'time':
      return warn(`Timer '${label}' already exists`);
    case 'timeLog':
      return fact === undefined ? warn(`Timer '${label}' does not exist`) : entry('log', [elapsed(), ...args.slice(1)]);
    case 'timeEnd':
      return fact === undefined ? warn(`Timer '${label}' does not exist`) : entry('timeEnd', [elapsed()]);
    default:
      // Calls without arguments are recorded only for the methods that log their own name.
      return entry(
        CONSOLE_TYPES[name] ?? (isConsoleType(name) ? name : 'log'),
        args.length || name === 'clear' ? args : ['console.' + name]
      );
  }
}

function headersToObject(headers: Record<string, string> | Headers | string): Record<string, string> {
  const obj: Record<string, string> = {};
  if (typeof headers === 'string') {
    for (const line of headers.trim().split(/[\r\n]+/)) {
      const i = line.indexOf(':');
      if (i > 0) obj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  } else if (headers instanceof Headers) headers.forEach((v, k) => (obj[k] = v));
  else Object.assign(obj, headers);
  return obj;
}

export function viewProbe(probe: Probe): ProbeView {
  // Same object for the same record: domains keep records in sets and maps.
  const logs = new WeakMap<ProbeLog, LogEntry>();
  const requests = new WeakMap<ProbeRequest, RequestRecord>();
  const log = (raw: ProbeLog): LogEntry => {
    let entry = logs.get(raw);
    if (!entry) {
      if (raw.kind === 'exception') entry = { ...raw, time: performance.timeOrigin + raw.time };
      else {
        const call = raw;
        // The stack is formatted only when read.
        entry = Object.defineProperty(consoleEntry(call), 'stack', {
          get: () => call.stack,
          enumerable: true,
        });
      }
      logs.set(raw, entry);
    }
    return entry;
  };
  // Records change in place, and the probe reports every change: only a changed record is
  // copied again, so reading all of them stays cheap.
  const changed = new WeakSet<ProbeRequest>();
  probe.onRequest(raw => changed.add(raw));
  const request = (raw: ProbeRequest): RequestRecord => {
    const cached = requests.get(raw);
    if (cached && !changed.has(raw)) return cached;
    changed.delete(raw);
    const { headers, requestHeaders, ...rest } = raw;
    const fields: RequestRecord = { ...rest, requestHeaders: headersToObject(requestHeaders) };
    if (headers !== undefined) {
      const responseHeaders = headersToObject(headers);
      fields.responseHeaders = responseHeaders;
      fields.mimeType = ((responseHeaders['content-type'] || '').split(';')[0] ?? '').trim();
      // Bytes on the wire, as fetch() reports them: the header, else the body's size.
      if (raw.encodedDataLength !== undefined)
        fields.encodedDataLength = Number(responseHeaders['content-length']) || raw.encodedDataLength;
    }
    if (cached) return Object.assign(cached, fields);
    requests.set(raw, fields);
    return fields;
  };
  return {
    version: probe.version,
    get logs() {
      return probe.logs.map(log);
    },
    get requests() {
      return probe.requests.map(request);
    },
    sockets: probe.sockets,
    onLog: listener => probe.onLog(raw => listener(log(raw))),
    onRequest: listener => probe.onRequest(raw => listener(request(raw))),
    onSocket: listener => probe.onSocket(listener),
    clearLogs: () => probe.clearLogs(),
    shadowRoots: probe.shadowRoots,
    onShadowRoot: listener => probe.onShadowRoot(listener),
    listeners: probe.listeners,
    ownUrls: probe.ownUrls,
    fetch: probe.fetch,
    tools: probe.tools,
  };
}
