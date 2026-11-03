// Early-capture probe.
//
// Load it as the first synchronous script of a page (probe.iife.js). It hooks console,
// uncaught errors, fetch/XHR and WebSocket once, keeps recent events in ring buffers, and the CDP
// agent reads those buffers later. The CDP agent installs it itself when no earlier
// probe exists, so every API is hooked exactly once either way.
import { hookNetwork, keep, now, type NetworkSink } from './network';
import {
  PROBE_KEY,
  type ListenerRecord,
  type Probe,
  type ProbeLog,
  type ProbeRequest,
  type SocketRecord,
  type ToolRecord,
} from './types';

import { isShellPage, readShellConfig, writeShellDocument } from './shell';

export * from './types';
export * from './shell';
export { cdnFrontendUrl } from './trust';
export { keep } from './network';

/** The probe keeps everything up to a coarse bound, for pages that never load the CDP agent. */
const LIMIT = 10_000;
const MAX_TOOL_OUTCOMES = 50;

/** @internal */
export function installProbe(): Probe {
  const w = window;
  const existing: Probe | undefined = Reflect.get(w, PROBE_KEY);
  if (existing) return existing;

  const logs: ProbeLog[] = [];
  const requests: ProbeRequest[] = [];
  const logListeners = new Set<(entry: ProbeLog) => void>();
  const requestListeners = new Set<(record: ProbeRequest) => void>();
  const sockets: SocketRecord[] = [];
  const socketListeners = new Set<(record: SocketRecord) => void>();

  const shadowRootListeners = new Set<(root: ShadowRoot) => void>();
  const hooked = new WeakSet<Console>();
  const probe: Probe = {
    version: 1,
    hookNetwork(win, frame) {
      hookNetwork(probe, sink, win, listen, frame);
    },
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
    hookWindow(win) {
      // Once per global object: the initial about:blank's is kept by the document replacing it.
      const realm = win.console;
      if (hooked.has(realm)) return;
      hooked.add(realm);
      // The document at the time, for the same reason. Not a copy: a console call's stack is a
      // getter, formatted only when read.
      const add = (entry: ProbeLog) => addLog(Object.assign(entry, { inDocument: win.document }));
      hookConsole(add, win);
      hookDebugger(add, win);
      hookErrors(add, win);
      hookShadowRoots(probe.shadowRoots, shadowRootListeners, win);
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
    WebSocket: w.WebSocket,
    tools: new Map(),
    limits: { logs: LIMIT, requests: LIMIT, sockets: LIMIT, socketEvents: LIMIT, body: 5 * 1024 * 1024 },
  };
  Object.defineProperty(w, PROBE_KEY, { value: probe });

  function addLog(entry: ProbeLog) {
    logs.push(entry);
    keep(logs, probe.limits.logs);
    logListeners.forEach(fn => fn(entry));
  }

  hookConsole(addLog);
  hookDebugger(addLog);
  hookErrors(addLog);
  hookShadowRoots(probe.shadowRoots, shadowRootListeners, w);
  // The network hooks' own listeners are not the page's.
  const listen = EventTarget.prototype.addEventListener;
  hookListeners(probe.listeners);
  hookModelContext(probe.tools);

  let seq = 0;
  const sink: NetworkSink = {
    add(rec) {
      rec.requestId = 'probe.' + ++seq;
      requests.push(rec);
      keep(requests, probe.limits.requests);
      requestListeners.forEach(fn => fn(rec));
      return rec;
    },
    update(rec, patch) {
      Object.assign(rec, patch);
      requestListeners.forEach(fn => fn(rec));
    },
    socket(rec) {
      if (!rec.requestId) {
        rec.requestId = 'probe.' + ++seq;
        sockets.push(rec);
        keep(sockets, probe.limits.sockets);
      }
      socketListeners.forEach(fn => fn(rec));
    },
    requests,
  };
  const shell = readShellConfig();
  hookNetwork(probe, sink, w, listen, undefined, shell?.serviceWorker);

  if (shell && window === top) {
    // When it refuses (a loop), the page loads on its own: probe.ts sees no config left.
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

// ---- debugger ----

/** Called instead of each `debugger` statement by the shell's Service Worker (service-worker.ts DEBUGGER_CALL). */
const DEBUGGER_HOOK = '_$dbg';

/** Statements cannot be paused at: the shell's Service Worker makes each `debugger` log a warning. */
function hookDebugger(addLog: (entry: ProbeLog) => void, w: Window = window) {
  Object.defineProperty(w, DEBUGGER_HOOK, {
    value() {
      const error = new Error();
      addLog({
        kind: 'console',
        type: 'debugger',
        args: [],
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

/**
 * Records console calls as they are made; the CDP agent turns them into entries. Only what
 * cannot be known later is decided here: which calls log nothing (V8 drops calls without
 * arguments except group, groupCollapsed, groupEnd and trace, and passing asserts), labels
 * (their toString runs once, at the call), and counter and timer state.
 */
function hookConsole(addLog: (entry: ProbeLog) => void, w: Window & typeof globalThis = window) {
  const console = w.console;
  const counts: Record<string, number> = {};
  const timers: Record<string, number> = {};
  const names =
    'log debug info error warn dir dirxml table trace group groupCollapsed groupEnd clear assert count countReset time timeLog timeEnd';
  for (const name of names.split(' ')) {
    const orig: unknown = Reflect.get(console, name);
    if (typeof orig !== 'function') continue;
    Reflect.set(console, name, function (this: unknown, ...args: unknown[]) {
      const time = now();
      let entry = args;
      let fact: number | undefined;
      let keep: unknown = args.length || /^(group|trace|clear)/.test(name);
      if (/^(count|time)/.test(name)) {
        const [value = 'default', ...rest] = args;
        const label = String(value);
        entry = [label, ...rest];
        keep = 1;
        if (name === 'count') fact = counts[label] = (counts[label] || 0) + 1;
        // Misuses are logged as warnings; an existing timer keeps its start.
        else if (name === 'countReset') keep = !(label in counts) || ((counts[label] = 0), 0);
        else if (name === 'time') keep = label in timers || ((timers[label] = time), 0);
        else {
          fact = timers[label];
          if (name === 'timeEnd') delete timers[label];
        }
      } else if (name === 'assert') {
        keep = !args[0];
        entry = args.slice(1);
      }
      if (keep) {
        // V8 formats a stack only when it is read: most entries are never shown, and
        // formatting one on every call slows down pages that log a lot.
        const error = new Error();
        addLog({
          kind: 'console',
          type: name,
          args: entry,
          time,
          fact,
          get stack() {
            return error.stack;
          },
        });
      }
      return orig.apply(this, args);
    });
  }
}

// ---- shadow roots ----

/** Records shadow roots as they are attached: closed ones are not reachable otherwise. */
function hookShadowRoots(
  roots: WeakMap<Element, ShadowRoot>,
  listeners: Set<(root: ShadowRoot) => void>,
  w: Window & typeof globalThis
) {
  const proto = w.Element.prototype;
  const attachShadow = proto.attachShadow;
  if (!attachShadow) return;
  proto.attachShadow = function (this: Element, init: ShadowRootInit) {
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

function hookErrors(addLog: (entry: ProbeLog) => void, w: Window & typeof globalThis = window) {
  w.addEventListener('error', e => {
    if (!(e instanceof w.ErrorEvent)) return;
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
  w.addEventListener('unhandledrejection', e => {
    addLog({
      kind: 'exception',
      text: 'Uncaught (in promise)',
      error: e.reason,
      time: now(),
      stack: stackOf(e.reason),
    });
  });
}
