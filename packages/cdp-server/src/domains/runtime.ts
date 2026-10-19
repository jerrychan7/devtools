import type { Protocol } from 'devtools-protocol';
import { EXECUTION_CONTEXT_ID, FRAME_ID, type Context } from '../core/context';
import { parseStack } from '../core/stack';
import type { LogEntry } from '../probe/types';

// Indirect eval runs in the global scope, like code typed into the console.
// oxlint-disable-next-line no-eval -- evaluating console input is the point.
const globalEval = eval;

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof Reflect.get(v, 'then') === 'function';

/**
 * Evaluates console input like V8 does: as a script, so `{a: 1}` is a block (the frontend
 * wraps object literals in parentheses itself). Falls back to an async wrapper for
 * top-level await. Returns the value and whether it came from the async wrapper.
 */
function run(expression: string, allowAwait: boolean): { value: unknown; isAsync: boolean } {
  try {
    return { value: globalEval(expression), isAsync: false };
  } catch (e) {
    if (!(e instanceof SyntaxError) || !allowAwait || !/\bawait\b/.test(expression)) throw e;
  }
  try {
    return { value: globalEval(`(async () => (${expression}\n))()`), isAsync: true };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  return { value: globalEval(`(async () => {${expression}\n})()`), isAsync: true };
}

/**
 * Removes this server's own frames from errors thrown by evaluated code, so the console
 * shows `at <anonymous>:1:7` like Chrome instead of the eval machinery underneath.
 */
function hideEvalFrames(error: unknown) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return;
  const lines = error.stack.split('\n');
  const cut = lines.findIndex(line => /^\s*at eval \(<anonymous>\)$/.test(line));
  if (cut < 0) return;
  const stack = lines
    .slice(0, cut)
    .map(line => line.replace(/^(\s*at )(?:eval \(eval at [^)]*\), |eval \()?(<anonymous>:\d+:\d+)\)?$/, '$1$2'))
    .join('\n');
  try {
    Object.defineProperty(error, 'stack', { value: stack, configurable: true, writable: true });
  } catch {
    // Frozen errors keep their original stack.
  }
}

/**
 * Conservative check for eager evaluation (results previewed while typing). V8 tracks side
 * effects precisely; here anything that could call code or assign is refused: calls,
 * assignments, increments, `new`, `delete`, `await`, `yield`, `import` and template tags.
 */
function mayHaveSideEffects(expression: string): boolean {
  const code = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  return /[(`]|\+\+|--|(?<![=!<>])=(?!=)|\b(?:new|delete|await|yield|import)\b/.test(code);
}

function parseUnserializable(value: string): unknown {
  if (value === '-0') return -0;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return undefined;
}

function copyToClipboard(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function registerRuntime({ server, objects, nodes, probe }: Context) {
  let unsubscribe: (() => void) | null = null;
  let exceptionId = 0;
  let lastResult: unknown;

  /** Console utilities, available only while console input is evaluated. */
  function commandLineApi(): Record<string, unknown> {
    const inspected = Object.fromEntries(nodes.inspected.map((node, i) => [`$${i}`, node]));
    return {
      ...inspected,
      $_: lastResult,
      $: (selector: string) => document.querySelector(selector),
      $$: (selector: string) => Array.from(document.querySelectorAll(selector)),
      $x: (path: string) => {
        const result = document.evaluate(path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i));
      },
      copy: copyToClipboard,
      keys: Object.keys,
      values: Object.values,
      clear: () => console.clear(),
    };
  }

  function withCommandLineApi<T>(fn: () => T): T {
    const added = Object.entries(commandLineApi()).filter(([name]) => !(name in window));
    for (const [name, value] of added) Reflect.set(window, name, value);
    try {
      return fn();
    } finally {
      for (const [name] of added) Reflect.deleteProperty(window, name);
    }
  }

  function exceptionResult(error: unknown, group?: string, generatePreview = false) {
    hideEvalFrames(error);
    const frames = error instanceof Error ? parseStack(error.stack) : [];
    return {
      result: objects.wrap(error, { generatePreview, group }),
      exceptionDetails: {
        exceptionId: ++exceptionId,
        text: 'Uncaught',
        lineNumber: 0,
        columnNumber: 0,
        exception: objects.wrap(error, { generatePreview, group }),
        executionContextId: EXECUTION_CONTEXT_ID,
        ...(frames.length ? { stackTrace: { callFrames: frames } } : {}),
      },
    };
  }

  function emitLog(entry: LogEntry) {
    if (entry.kind === 'console') {
      server.emit('Runtime.consoleAPICalled', {
        type: entry.type,
        args: entry.args.map(arg => objects.wrap(arg, { generatePreview: true, group: 'console' })),
        executionContextId: EXECUTION_CONTEXT_ID,
        timestamp: entry.time,
        // Drop the probe's console wrapper frame.
        stackTrace: { callFrames: parseStack(entry.stack, 1) },
      } satisfies Protocol.Runtime.ConsoleAPICalledEvent);
      return;
    }
    const frames = parseStack(entry.stack);
    const top = frames[0];
    server.emit('Runtime.exceptionThrown', {
      timestamp: entry.time,
      exceptionDetails: {
        exceptionId: ++exceptionId,
        text: entry.text,
        lineNumber: entry.line ? entry.line - 1 : (top?.lineNumber ?? 0),
        columnNumber: entry.column ? entry.column - 1 : (top?.columnNumber ?? 0),
        url: entry.url || top?.url,
        scriptId: '',
        exception: objects.wrap(entry.error, { generatePreview: true, group: 'console' }),
        executionContextId: EXECUTION_CONTEXT_ID,
        ...(frames.length ? { stackTrace: { callFrames: frames } } : {}),
      },
    } satisfies Protocol.Runtime.ExceptionThrownEvent);
  }

  server.register('Runtime', {
    enable() {
      if (unsubscribe) return;
      server.emit('Runtime.executionContextCreated', {
        context: {
          id: EXECUTION_CONTEXT_ID,
          origin: location.origin,
          name: '',
          uniqueId: 'devtools-anywhere',
          auxData: { isDefault: true, type: 'default', frameId: FRAME_ID },
        },
      } satisfies Protocol.Runtime.ExecutionContextCreatedEvent);
      // Like V8, report everything logged before the client connected.
      probe.logs.forEach(emitLog);
      unsubscribe = probe.onLog(emitLog);
    },

    disable() {
      unsubscribe?.();
      unsubscribe = null;
    },

    async evaluate(params: Protocol.Runtime.EvaluateRequest): Promise<Protocol.Runtime.EvaluateResponse> {
      const group = params.objectGroup;
      if (params.throwOnSideEffect && mayHaveSideEffects(params.expression)) {
        return exceptionResult(new EvalError('Possible side-effect in debug-evaluate'), group, params.generatePreview);
      }
      try {
        const allowAwait = !!(params.replMode || params.awaitPromise);
        const evaluate = () => run(params.expression, allowAwait);
        let { value, isAsync } = params.includeCommandLineAPI ? withCommandLineApi(evaluate) : evaluate();
        if ((isAsync || params.awaitPromise) && isThenable(value)) value = await value;
        if (!params.silent) lastResult = value;
        return {
          result: objects.wrap(value, {
            generatePreview: params.generatePreview,
            returnByValue: params.returnByValue,
            group,
          }),
        };
      } catch (e) {
        return exceptionResult(e, group, params.generatePreview);
      }
    },

    async callFunctionOn(
      params: Protocol.Runtime.CallFunctionOnRequest
    ): Promise<Protocol.Runtime.CallFunctionOnResponse> {
      const self = params.objectId ? objects.get(params.objectId) : undefined;
      const args = (params.arguments || []).map(arg => {
        if (arg.objectId) return objects.get(arg.objectId);
        if (arg.unserializableValue !== undefined) return parseUnserializable(arg.unserializableValue);
        return arg.value;
      });
      try {
        const fn = globalEval(`(${params.functionDeclaration}\n)`);
        let value = fn.apply(self, args);
        if (params.awaitPromise && isThenable(value)) value = await value;
        return {
          result: objects.wrap(value, {
            generatePreview: params.generatePreview,
            returnByValue: params.returnByValue,
            group: params.objectGroup,
          }),
        };
      } catch (e) {
        return exceptionResult(e, params.objectGroup, params.generatePreview);
      }
    },

    compileScript(params: Protocol.Runtime.CompileScriptRequest): Protocol.Runtime.CompileScriptResponse {
      // The console uses this to check whether the input is complete.
      try {
        new Function(params.expression);
        return {};
      } catch (e) {
        if (/\bawait\b/.test(params.expression)) {
          try {
            new Function(`return (async () => {${params.expression}\n})`);
            return {};
          } catch {
            // Fall through to report the original error.
          }
        }
        return { exceptionDetails: exceptionResult(e).exceptionDetails };
      }
    },

    getProperties: (params: Protocol.Runtime.GetPropertiesRequest) => objects.getProperties(params),
    releaseObject: (params: Protocol.Runtime.ReleaseObjectRequest) => objects.release(params.objectId),
    releaseObjectGroup: (params: Protocol.Runtime.ReleaseObjectGroupRequest) =>
      objects.releaseGroup(params.objectGroup),
    discardConsoleEntries: () => probe.clearLogs(),
    globalLexicalScopeNames: () => ({ names: [] }),
    getIsolateId: () => ({ id: 'devtools-anywhere' }),
    getHeapUsage: () => {
      // Chrome-only, non-standard.
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } })
        .memory;
      return { usedSize: memory?.usedJSHeapSize ?? 0, totalSize: memory?.totalJSHeapSize ?? 0 };
    },
    runIfWaitingForDebugger: () => {},
    setAsyncCallStackDepth: () => {},
    setCustomObjectFormatterEnabled: () => {},
    setMaxCallStackSizeToCapture: () => {},
    addBinding: () => {},
    getExceptionDetails: () => ({}),
  });
}
