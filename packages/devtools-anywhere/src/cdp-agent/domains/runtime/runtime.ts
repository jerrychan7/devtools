import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import type { Frame } from '../../core/frames';
import { returnOutsideFunction } from '../../core/lexer';
import { isHtmlElement, isSvgElement, realmOf } from '../../core/realm';
import { CdpError } from '../../core/session';
import { parseStack } from '../../core/stack';
import type { ConsoleEntry, LogEntry } from '../../probe/types';
import { executionContexts } from './contexts';
import { globalLexicalNames } from './lexical-names';
import { replBindings, returnLast } from './repl';

// Indirect eval runs in the global scope, like code typed into the console.
// oxlint-disable-next-line no-eval -- evaluating console input is the point.
const globalEval: (code: string) => unknown = eval;

/** A realm's global code runner: indirect eval of its window. */
type Evaluate = (code: string) => unknown;

/** Indirect eval of `win`: runs code in its global scope. */
function evaluateIn(win: Window & typeof globalThis): Evaluate {
  return code => {
    let evaluate: unknown;
    try {
      evaluate = Reflect.get(win, 'eval');
    } catch {
      // The frame navigated cross-origin: its document's context is gone.
      throw new CdpError('Cannot find context with specified id');
    }
    if (typeof evaluate !== 'function') throw new CdpError('Cannot evaluate in this context');
    return Reflect.apply(evaluate, undefined, [code]);
  };
}

/** Whether `value` is an Error of the top realm or of `win`'s. */
const isError = (value: unknown, win: Window & typeof globalThis): value is Error =>
  value instanceof Error || value instanceof win.Error;

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof Reflect.get(v, 'then') === 'function';

/**
 * Evaluates console input like V8 does: as a script, so `{a: 1}` is a block (the frontend
 * wraps object literals in parentheses itself). Falls back to an async wrapper for
 * top-level await. Returns the value and whether it came from the async wrapper.
 */
function run(
  { win, evaluate }: Pick<Scope, 'win' | 'evaluate'>,
  expression: string,
  allowAwait: boolean,
  asyncBody = returnLast(expression)
): { value: unknown; isAsync: boolean } {
  // The realm's own SyntaxError: the code is compiled there.
  const isSyntaxError = (e: unknown) => e instanceof win.SyntaxError || e instanceof SyntaxError;
  try {
    return { value: evaluate(expression), isAsync: false };
  } catch (e) {
    if (!isSyntaxError(e) || !allowAwait || !/\bawait\b/.test(expression)) throw e;
  }
  // A trailing `;` (`await foo();`) still leaves a single expression whose value is the result.
  const trimmed = expression.replace(/[\s;]+$/, '');
  try {
    return { value: evaluate(`(async () => (${trimmed}\n))()`), isAsync: true };
  } catch (e) {
    if (!isSyntaxError(e)) throw e;
  }
  // Several statements: the last one's value is returned when it is an expression.
  return { value: evaluate(`(async () => {${asyncBody}\n})()`), isAsync: true };
}

/**
 * Whether `script` compiles as a script, or else `asyncBody` as the body of the async wrapper.
 * Nothing is run. Checked as a function body (`new Function`), plus what only a function body
 * takes: a `return` or `new.target` outside any function. (Wrapping the script in
 * `if (false) { … }` for eval is no pure check: its `var`s and, in sloppy code, its functions
 * would be declared on window.)
 */
function compiles(script: string, asyncBody?: string): boolean {
  const check = (code: string) => {
    try {
      new Function(code);
      return true;
    } catch (e) {
      return !(e instanceof SyntaxError);
    }
  };
  if (returnOutsideFunction(script)) return false;
  // The async wrapper is only tried for input with `await` (see `run`).
  return (
    check(script) ||
    (asyncBody !== undefined && /\bawait\b/.test(script) && check(`return async () => {${asyncBody}\n}`))
  );
}

/**
 * Removes the CDP agent's own frames from errors thrown by evaluated code, so the console
 * shows `at <anonymous>:1:7` like Chrome instead of the eval machinery underneath.
 */
function hideEvalFrames(error: unknown, win: Window & typeof globalThis) {
  if (!isError(error, win) || typeof error.stack !== 'string') return;
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
function pathRunsCode(path: string, { win, evaluate }: Pick<Scope, 'win' | 'evaluate'>): boolean {
  const [head = '', ...rest] = path.match(/[A-Za-z_$][\w$]*|\d+/g) ?? [];
  let found = readSafely(win, head);
  if (found.unsafe) return true;
  if (found.done) {
    // Not a property of the global object: a top-level `let`/`const`, read without side effects.
    try {
      found = { unsafe: false, done: false, value: evaluate(head) };
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
function mayHaveSideEffects(expression: string, scope: Pick<Scope, 'win' | 'evaluate'>): boolean {
  const code = expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  if (/[(`]|\+\+|--|(?<![=!<>])=(?!=)|\b(?:new|delete|await|yield|import)\b/.test(code)) return true;
  // Property paths with names or numeric indexes; other computed keys are refused.
  const paths = (
    code.match(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[\s*\d+\s*\])*/g) ?? []
  ).filter(path => !LITERALS.has(path));
  if (!paths.length) return false;
  const rest = code.replace(/(?<![\w$.])[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*|\s*\[\s*\d+\s*\])*/g, ' ');
  if (/[-+*/%<>&|^~?[]|[=!]=|\b(?:in|instanceof)\b/.test(rest)) return true;
  return paths.some(path => pathRunsCode(path, scope));
}

function parseUnserializable(value: string): unknown {
  if (value === '-0') return -0;
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  return undefined;
}

/** `copy()` of the console, run in the document `doc` of the frame the input runs in. */
function copyToClipboard(value: unknown, doc: Document) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text, doc));
  } else {
    fallbackCopy(text, doc);
  }
}

/**
 * Copies through a hidden textarea where the Clipboard API is missing (insecure contexts).
 * Read-only with a 16px font so iOS neither opens the keyboard nor zooms; `select()` selects
 * nothing there, hence `setSelectionRange`. The page's focus and selection are restored.
 */
function fallbackCopy(text: string, doc: Document) {
  const focused = doc.activeElement;
  const selection = doc.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  (doc.body ?? doc.documentElement).appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(0, text.length);
  try {
    doc.execCommand('copy');
  } finally {
    textarea.remove();
    if (isHtmlElement(focused) || isSvgElement(focused)) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
}

/** What console input of a frame's document runs with: its realm, REPL bindings and global names. */
interface Scope {
  frame: Frame;
  win: Window & typeof globalThis;
  evaluate: Evaluate;
  repl: ReturnType<typeof replBindings>;
  lexicalNames: ReturnType<typeof globalLexicalNames>;
  /** The console utilities put on window and their values, while `utilityUsers` evaluations run. */
  utilities: Map<string, unknown>;
  utilityUsers: number;
}

export function registerRuntime({ session, objects, nodes, probe, frames }: Context) {
  const topFrame = frames.top;
  /** Per document: a navigated frame's new document is a new realm, with bindings of its own. */
  const scopes = new WeakMap<Document, Scope>();
  function scopeOf(frame: Frame): Scope {
    let scope = scopes.get(frame.document);
    if (!scope) {
      const win = realmOf(frame.document);
      // The top page's eval as the agent found it, others' as they are now.
      const evaluate = frame === topFrame ? globalEval : evaluateIn(win);
      const utilities = new Map<string, unknown>();
      scope = {
        frame,
        win,
        evaluate,
        // A declaration shadows a utility, as in Chrome, where they are not window's.
        repl: replBindings(win, evaluate, name => isUtility(win, utilities, name)),
        lexicalNames: globalLexicalNames(probe, frame.document, evaluate, frame === topFrame),
        utilities,
        utilityUsers: 0,
      };
      scopes.set(frame.document, scope);
    }
    return scope;
  }
  let unsubscribe: (() => void) | null = null;
  let exceptionId = 0;
  let lastResult: unknown;
  const contexts = executionContexts(frames, (method, params) => session.emit(method, params));
  session.onReset(() => {
    contexts.disable();
    lastResult = undefined;
    for (const frame of frames) scopes.get(frame.document)?.lexicalNames.stop();
  });

  /** Console utilities, available only while console input is evaluated. */
  function commandLineApi({ frame, win }: Scope): Record<string, unknown> {
    const inspected = Object.fromEntries(nodes.inspected.map((node, i) => [`$${i}`, node]));
    const doc = frame.document;
    return {
      ...inspected,
      $_: lastResult,
      $: (selector: string) => doc.querySelector(selector),
      $$: (selector: string) => Array.from(doc.querySelectorAll(selector)),
      $x: (path: string) => {
        const result = doc.evaluate(path, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i));
      },
      copy: (value: unknown) => copyToClipboard(value, doc),
      keys: Object.keys,
      values: Object.values,
      clear: () => win.console.clear(),
    };
  }

  /** Whether window's `name` is still the utility put there, not something since assigned or declared. */
  function isUtility(win: Window, utilities: Map<string, unknown>, name: string): boolean {
    const own = Object.getOwnPropertyDescriptor(win, name);
    return !!own && 'value' in own && utilities.has(name) && own.value === utilities.get(name);
  }

  /**
   * Keeps the utilities until `fn` settles, so code after an `await` can use them too. Evaluations
   * running at once share them: they go when the last one settles, unless the page changed them.
   */
  async function withCommandLineApi<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
    const { win, utilities } = scope;
    for (const [name, value] of Object.entries(commandLineApi(scope))) {
      if (name in win && !isUtility(win, utilities, name)) continue;
      Reflect.set(win, name, value);
      utilities.set(name, value);
    }
    scope.utilityUsers++;
    try {
      return await fn();
    } finally {
      if (--scope.utilityUsers === 0) {
        for (const name of utilities.keys()) if (isUtility(win, utilities, name)) Reflect.deleteProperty(win, name);
        utilities.clear();
      }
    }
  }

  function exceptionResult(
    { frame, win }: Pick<Scope, 'frame' | 'win'>,
    error: unknown,
    group?: string,
    generatePreview = false,
    inPromise = false
  ) {
    // The context could not run the code at all: a protocol error, not the page's exception.
    if (error instanceof CdpError) throw error;
    hideEvalFrames(error, win);
    const callFrames = isError(error, win) ? parseStack(error.stack) : [];
    // One object for both places, like V8.
    const exception = objects.wrap(error, { generatePreview, group });
    return {
      result: exception,
      exceptionDetails: {
        exceptionId: ++exceptionId,
        // Like V8, a rejection names the error: "Uncaught (in promise) Error: no".
        text: inPromise
          ? `Uncaught (in promise)${isError(error, win) ? ` ${error.name}: ${error.message}` : ''}`
          : 'Uncaught',
        lineNumber: 0,
        columnNumber: 0,
        exception,
        executionContextId: frame.executionContextId,
        ...(callFrames.length ? { stackTrace: { callFrames } } : {}),
      },
    };
  }

  /**
   * Like V8, console.table of an object sends that object alone, previewed as a table; the
   * columns to show, if given as an array, filter its rows.
   */
  function consoleArgs(entry: ConsoleEntry) {
    const [data, columns] = entry.args;
    if (entry.type === 'table' && typeof data === 'object' && data !== null) {
      const names = Array.isArray(columns) ? columns.map(String) : undefined;
      return [objects.wrap(data, { group: 'console', table: { columns: names } })];
    }
    return entry.args.map(arg => objects.wrap(arg, { generatePreview: true, group: 'console' }));
  }

  /**
   * The context an entry was logged in: its iframe document's, the top page's when it names none.
   * Like V8 for messages of a context that is gone (a frame navigated or removed), 0.
   */
  function contextOfEntry(entry: LogEntry): number {
    const doc = entry.inDocument;
    if (!doc) return topFrame.executionContextId;
    // A document still loading, which reused the window of the initial about:blank (and its
    // hooks): the registry learns of it now rather than on load, and its context comes first.
    if (!frames.ofDocument(doc) && doc.defaultView) frames.sync();
    return frames.ofDocument(doc)?.executionContextId ?? 0;
  }

  function emitLog(entry: LogEntry) {
    if (entry.kind === 'console') {
      session.emit('Runtime.consoleAPICalled', {
        type: entry.type,
        args: consoleArgs(entry),
        executionContextId: contextOfEntry(entry),
        timestamp: entry.time,
        // Drop the probe's console wrapper frame.
        stackTrace: { callFrames: parseStack(entry.stack, 1) },
      } satisfies Protocol.Runtime.ConsoleAPICalledEvent);
      return;
    }
    const callFrames = parseStack(entry.stack);
    const top = callFrames[0];
    const url = entry.url || top?.url;
    session.emit('Runtime.exceptionThrown', {
      timestamp: entry.time,
      exceptionDetails: {
        exceptionId: ++exceptionId,
        text: entry.text,
        lineNumber: entry.line ? entry.line - 1 : (top?.lineNumber ?? 0),
        columnNumber: entry.column ? entry.column - 1 : (top?.columnNumber ?? 0),
        ...(url ? { url } : {}),
        scriptId: '',
        exception: objects.wrap(entry.error, { generatePreview: true, group: 'console' }),
        executionContextId: contextOfEntry(entry),
        ...(callFrames.length ? { stackTrace: { callFrames } } : {}),
      },
    } satisfies Protocol.Runtime.ExceptionThrownEvent);
  }

  session.register('Runtime', {
    enable() {
      if (unsubscribe) return;
      contexts.enable();
      // Like V8, report everything logged before the client connected.
      probe.logs.forEach(emitLog);
      unsubscribe = probe.onLog(emitLog);
    },

    disable() {
      unsubscribe?.();
      unsubscribe = null;
      contexts.disable();
    },

    async evaluate(params: Protocol.Runtime.EvaluateRequest): Promise<Protocol.Runtime.EvaluateResponse> {
      const group = params.objectGroup;
      // Like Chrome, in the context asked for, else the top page's.
      const scope = scopeOf(contexts.frameOf(params.contextId, params.uniqueContextId));
      const { repl } = scope;
      if (params.throwOnSideEffect && mayHaveSideEffects(params.expression, scope)) {
        return exceptionResult(
          scope,
          new scope.win.EvalError('Possible side-effect in debug-evaluate'),
          group,
          params.generatePreview
        );
      }
      // Whether the error is the rejection of a promise the expression returned.
      let inPromise = false;
      try {
        const allowAwait = !!(params.replMode || params.awaitPromise);
        const evaluate = async () => {
          const rewritten = params.replMode ? repl.rewrite(params.expression) : undefined;
          const script = rewritten?.script ?? params.expression;
          const body = rewritten?.body ?? returnLast(params.expression);
          // Like V8, input that does not compile declares nothing: the bindings (properties of
          // window that cannot be removed) are only made for input that does.
          const compiled = rewritten !== undefined && compiles(script, allowAwait ? body : undefined);
          if (compiled) rewritten.commit();
          let ran: ReturnType<typeof run>;
          try {
            ran = run(scope, script, allowAwait, body);
          } catch (e) {
            // Whether it compiled, not the error's type: a SyntaxError is also thrown while running
            // (`let x = 1; JSON.parse('{')`), after the declarations were made.
            if (params.replMode) {
              if (compiled) repl.compiled();
              else repl.failed();
            }
            throw e;
          }
          if (params.replMode) repl.compiled();
          const { value, isAsync } = ran;
          if (!(isAsync || params.awaitPromise) || !isThenable(value)) return value;
          inPromise = !isAsync;
          return await value;
        };
        const value = params.includeCommandLineAPI ? await withCommandLineApi(scope, evaluate) : await evaluate();
        if (!params.silent) lastResult = value;
        return {
          result: objects.wrap(value, {
            generatePreview: params.generatePreview,
            returnByValue: params.returnByValue,
            group,
          }),
        };
      } catch (e) {
        return exceptionResult(scope, e, group, params.generatePreview, inPromise);
      }
    },

    async callFunctionOn(
      params: Protocol.Runtime.CallFunctionOnRequest
    ): Promise<Protocol.Runtime.CallFunctionOnResponse> {
      // Like V8: exactly one of them says where to call.
      const targets = [params.objectId, params.executionContextId, params.uniqueContextId].filter(
        target => target !== undefined
      ).length;
      if (targets > 1)
        throw new CdpError('ObjectId, executionContextId and uniqueContextId must mutually exclude each other', -32602);
      if (targets === 0)
        throw new CdpError('Either objectId or executionContextId or uniqueContextId must be specified', -32602);
      const self = params.objectId ? objects.get(params.objectId) : undefined;
      // Like Chrome, in the context asked for, else in the object's.
      const scope = scopeOf(
        params.executionContextId !== undefined || params.uniqueContextId !== undefined
          ? contexts.frameOf(params.executionContextId, params.uniqueContextId)
          : contexts.frameOfValue(self)
      );
      const args = (params.arguments || []).map(arg => {
        if (arg.objectId) return objects.get(arg.objectId);
        if (arg.unserializableValue !== undefined) return parseUnserializable(arg.unserializableValue);
        return arg.value;
      });
      let inPromise = false;
      try {
        const fn = scope.evaluate(`(${params.functionDeclaration}\n)`);
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
        return exceptionResult(scope, e, params.objectGroup, params.generatePreview, inPromise);
      }
    },

    compileScript(params: Protocol.Runtime.CompileScriptRequest): Protocol.Runtime.CompileScriptResponse {
      // Compiling is the same in every realm: only the context reported differs.
      const frame = contexts.frameOf(params.executionContextId);
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
            executionContextId: frame.executionContextId,
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
    async globalLexicalScopeNames(
      params: Protocol.Runtime.GlobalLexicalScopeNamesRequest
    ): Promise<Protocol.Runtime.GlobalLexicalScopeNamesResponse> {
      const { lexicalNames, repl } = scopeOf(contexts.frameOf(params.executionContextId));
      return { names: [...new Set([...(await lexicalNames.list()), ...repl.names()])] };
    },
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
