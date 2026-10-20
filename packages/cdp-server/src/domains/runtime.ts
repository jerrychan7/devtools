import type { Protocol } from 'devtools-protocol';
import { EXECUTION_CONTEXT_ID, FRAME_ID, type Context } from '../core/context';
import { CdpError } from '../core/server';
import { parseStack } from '../core/stack';
import type { LogEntry } from '../probe/types';

// Indirect eval runs in the global scope, like code typed into the console.
// oxlint-disable-next-line no-eval -- evaluating console input is the point.
const globalEval: (code: string) => unknown = eval;

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
  // A trailing `;` (`await foo();`) still leaves a single expression whose value is the result.
  const trimmed = expression.replace(/[\s;]+$/, '');
  try {
    return { value: globalEval(`(async () => (${trimmed}\n))()`), isAsync: true };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  // Several statements: their result and top-level declarations are not kept (that needs
  // V8's REPL mode rewrite).
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

const isNative = (fn: unknown) =>
  typeof fn === 'function' && /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn));

/**
 * Reads `key` of `target` unless that would run page code: a getter defined by the page
 * (built-in getters such as `document.body` are fine, like in V8). `done` stops the walk.
 */
function readSafely(target: unknown, key: string): { unsafe: boolean; done: boolean; value?: unknown } {
  if (target === null || target === undefined) return { unsafe: false, done: true };
  for (let o: object | null = Object(target); o; o = Object.getPrototypeOf(o)) {
    const desc = Object.getOwnPropertyDescriptor(o, key);
    if (!desc) continue;
    if ('value' in desc) return { unsafe: false, done: false, value: desc.value };
    if (!isNative(desc.get)) return { unsafe: true, done: true };
    return { unsafe: false, done: false, value: Reflect.get(Object(target), key) };
  }
  return { unsafe: false, done: true };
}

/** Whether reading a property path such as `a.b?.c[0]` could run a getter of the page. */
function pathRunsCode(path: string): boolean {
  const [head = '', ...rest] = path.match(/[A-Za-z_$][\w$]*|\d+/g) ?? [];
  let found = readSafely(globalThis, head);
  if (found.unsafe) return true;
  if (found.done) {
    // Not a property of the global object: a top-level `let`/`const`, read without side effects.
    try {
      found = { unsafe: false, done: false, value: globalEval(head) };
    } catch {
      return false;
    }
  }
  for (const key of rest) {
    found = readSafely(found.value, key);
    if (found.unsafe) return true;
    if (found.done) return false;
  }
  return false;
}

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'typeof', 'void']);

/**
 * Conservative check for eager evaluation (results previewed while typing). V8 tracks side
 * effects precisely; here anything that could call code or assign is refused: calls,
 * assignments, increments, `new`, `delete`, `await`, `yield`, `import` and template tags,
 * getters defined by the page, and operators applied to anything but literals (`a + ''` calls
 * `valueOf`/`toString`). Proxies cannot be told apart and are read as plain objects.
 */
function mayHaveSideEffects(expression: string): boolean {
  const code = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  if (/[(`]|\+\+|--|(?<![=!<>])=(?!=)|\b(?:new|delete|await|yield|import)\b/.test(code)) return true;
  // Property paths with names or numeric indexes; other computed keys are refused.
  const paths = (
    code.match(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[\s*\d+\s*\])*/g) ?? []
  ).filter(path => !LITERALS.has(path));
  if (!paths.length) return false;
  const rest = code.replace(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[\s*\d+\s*\])*/g, ' ');
  if (/[-+*/%<>&|^~?[]|[=!]=|\b(?:in|instanceof)\b/.test(rest)) return true;
  return paths.some(pathRunsCode);
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

/**
 * Copies through a hidden textarea where the Clipboard API is missing (insecure contexts).
 * Read-only with a 16px font so iOS neither opens the keyboard nor zooms; `select()` selects
 * nothing there, hence `setSelectionRange`. The page's focus and selection are restored.
 */
function fallbackCopy(text: string) {
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  (document.body ?? document.documentElement).appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(0, text.length);
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
    if (focused instanceof HTMLElement || focused instanceof SVGElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
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

  /** Keeps the utilities until `fn` settles, so code after an `await` can use them too. */
  async function withCommandLineApi<T>(fn: () => Promise<T>): Promise<T> {
    const added = Object.entries(commandLineApi()).filter(([name]) => !(name in window));
    for (const [name, value] of added) Reflect.set(window, name, value);
    try {
      return await fn();
    } finally {
      for (const [name] of added) Reflect.deleteProperty(window, name);
    }
  }

  function exceptionResult(error: unknown, group?: string, generatePreview = false, inPromise = false) {
    hideEvalFrames(error);
    const frames = error instanceof Error ? parseStack(error.stack) : [];
    // One object for both places, like V8.
    const exception = objects.wrap(error, { generatePreview, group });
    return {
      result: exception,
      exceptionDetails: {
        exceptionId: ++exceptionId,
        // Like V8, a rejection names the error: "Uncaught (in promise) Error: no".
        text: inPromise
          ? `Uncaught (in promise)${error instanceof Error ? ` ${error.name}: ${error.message}` : ''}`
          : 'Uncaught',
        lineNumber: 0,
        columnNumber: 0,
        exception,
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
    const url = entry.url || top?.url;
    server.emit('Runtime.exceptionThrown', {
      timestamp: entry.time,
      exceptionDetails: {
        exceptionId: ++exceptionId,
        text: entry.text,
        lineNumber: entry.line ? entry.line - 1 : (top?.lineNumber ?? 0),
        columnNumber: entry.column ? entry.column - 1 : (top?.columnNumber ?? 0),
        ...(url ? { url } : {}),
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
      // Whether the error is the rejection of a promise the expression returned.
      let inPromise = false;
      try {
        const allowAwait = !!(params.replMode || params.awaitPromise);
        const evaluate = async () => {
          const { value, isAsync } = run(params.expression, allowAwait);
          if (!(isAsync || params.awaitPromise) || !isThenable(value)) return value;
          inPromise = !isAsync;
          return await value;
        };
        const value = params.includeCommandLineAPI ? await withCommandLineApi(evaluate) : await evaluate();
        if (!params.silent) lastResult = value;
        return {
          result: objects.wrap(value, {
            generatePreview: params.generatePreview,
            returnByValue: params.returnByValue,
            group,
          }),
        };
      } catch (e) {
        return exceptionResult(e, group, params.generatePreview, inPromise);
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
      let inPromise = false;
      try {
        const fn = globalEval(`(${params.functionDeclaration}\n)`);
        // Same error as V8 for a declaration that is not a function, a response error.
        if (typeof fn !== 'function') throw new CdpError('Given expression does not evaluate to a function');
        let value: unknown = Reflect.apply(fn, self, args);
        if (params.awaitPromise && isThenable(value)) {
          inPromise = true;
          value = await value;
        }
        return {
          result: objects.wrap(value, {
            generatePreview: params.generatePreview,
            returnByValue: params.returnByValue,
            group: params.objectGroup,
          }),
        };
      } catch (e) {
        if (e instanceof CdpError) throw e;
        return exceptionResult(e, params.objectGroup, params.generatePreview, inPromise);
      }
    },

    compileScript(params: Protocol.Runtime.CompileScriptRequest): Protocol.Runtime.CompileScriptResponse {
      // The console uses this to check whether the input is complete.
      try {
        new Function(params.expression);
        return {};
      } catch {
        if (/\bawait\b/.test(params.expression)) {
          try {
            new Function(`return (async () => {${params.expression}\n})`);
            return {};
          } catch {
            // Fall through to report the original error.
          }
        }
        // Only the details, like V8: no exception object is kept for a check that is made
        // on every key press.
        return {
          exceptionDetails: {
            exceptionId: ++exceptionId,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            executionContextId: EXECUTION_CONTEXT_ID,
          },
        };
      }
    },

    getProperties: (params: Protocol.Runtime.GetPropertiesRequest) => objects.getProperties(params),
    releaseObject: (params: Protocol.Runtime.ReleaseObjectRequest) => objects.release(params.objectId),
    releaseObjectGroup: (params: Protocol.Runtime.ReleaseObjectGroupRequest) =>
      objects.releaseGroup(params.objectGroup),
    discardConsoleEntries: () => {
      probe.clearLogs();
      // Like V8, clearing the messages releases their 'console' handles.
      objects.releaseGroup('console');
    },
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
