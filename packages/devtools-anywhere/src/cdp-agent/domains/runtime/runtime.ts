import type { Protocol } from 'devtools-protocol';
import { EXECUTION_CONTEXT_ID, FRAME_ID, type Context } from '../../core/context';
import {
  lastExpressionStatement,
  topLevelLexicalDeclarations,
  topLevelLexicalNames,
  returnOutsideFunction,
  topLevelVarNames,
  tokenize,
  type LexOptions,
} from '../../core/lexer';
import { CdpError } from '../../core/session';
import { parseStack } from '../../core/stack';
import type { ConsoleEntry, LogEntry } from '../../probe/types';
import { refetch } from '../network/network';

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
function run(
  expression: string,
  allowAwait: boolean,
  asyncBody = returnLast(expression)
): { value: unknown; isAsync: boolean } {
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
  // Several statements: the last one's value is returned when it is an expression.
  return { value: globalEval(`(async () => {${asyncBody}\n})()`), isAsync: true };
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

/** `code` with its last statement returned when it is an expression statement. */
function returnLast(code: string, options?: LexOptions): string {
  const at = lastExpressionStatement(code, options);
  return at === undefined ? code : `${code.slice(0, at)}return ${code.slice(at)}`;
}

/**
 * Removes the CDP agent's own frames from errors thrown by evaluated code, so the console
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

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/** Global function the rewritten console input hands its declarations to. */
const REPL_EXPORT = '__devtoolsAnywhereRepl__';

/** A SyntaxError reported like V8's compile errors: no stack of its own. */
function syntaxError(message: string) {
  const error = new SyntaxError(message);
  Object.defineProperty(error, 'stack', { value: `SyntaxError: ${message}`, configurable: true, writable: true });
  return error;
}

type BindingState = 'tdz' | 'ready' | 'dead';

interface ReplBinding {
  kind: 'let' | 'const' | 'class';
  value: unknown;
  /** In its temporal dead zone (its command is running), initialized, or never initialized. */
  state: BindingState;
}

/**
 * Top-level `let`, `const` and `class` of console input in REPL mode, kept across commands like
 * V8's REPL mode. Each is a global accessor property of window standing for the binding (so,
 * unlike V8, `'a' in window` is true): later commands, closures and page scripts all read and
 * write it, assigning a `const` throws, and a page script's `let` of the same name fails (the
 * property is not configurable).
 *
 * The input is rewritten without moving any line or column: `let` / `const` become `var` padded
 * to the same length, and a `var` of the global accessor assigns through it (and, being a
 * declaration, leaves the completion value alone). In the async wrapper for top-level await,
 * where a `var` would be the function's own, they become `0, ` padded instead: an assignment.
 * A class stays a declaration of the input's own; its value is handed over at the end, on a line
 * of its own. Like V8, the console may declare a name again, but not one a page script or `var`
 * declared. Input with a 'use strict' directive is run as it is (strict eval keeps its `var`s).
 */
function replBindings() {
  const bindings = new Map<string, ReplBinding>();
  /** Every name a compiled command declared, initialized or not (V8 lists them all). */
  const declared = new Set<string>();
  /** Top-level `var`s of the console: eval makes them configurable, V8's REPL does not. */
  const vars = new Set<string>();
  let pending: string[] = [];
  let pendingVars: string[] = [];
  /** The bindings the running command declares, as they were before it. */
  let saved = new Map<ReplBinding, { state: BindingState; value: unknown; kind: ReplBinding['kind'] }>();
  let nextTemp = 0;

  function referenceError(message: string, fn: () => unknown) {
    const error = new ReferenceError(message);
    // Thrown where the binding is used, not in the accessor.
    const capture: unknown = Reflect.get(Error, 'captureStackTrace');
    if (typeof capture === 'function') Reflect.apply(capture, Error, [error, fn]);
    return error;
  }

  /** The binding for `name`, created in its dead zone; undefined when window has such a property. */
  function bind(name: string, kind: ReplBinding['kind']): ReplBinding | undefined {
    const known = bindings.get(name);
    if (known) {
      if (!saved.has(known)) saved.set(known, { state: known.state, value: known.value, kind: known.kind });
      known.kind = kind;
      return known;
    }
    // A property of the page's (a configurable one, like `name`) is left as it is.
    if (Object.getOwnPropertyDescriptor(window, name)) return undefined;
    const binding: ReplBinding = { kind, value: undefined, state: 'tdz' };
    bindings.set(name, binding);
    saved.set(binding, { state: 'dead', value: undefined, kind });
    Object.defineProperty(window, name, {
      configurable: false,
      enumerable: false,
      get: function get() {
        // V8's REPL mode says so in the dead zone too.
        if (binding.state !== 'ready') throw referenceError(`${name} is not defined`, get);
        return binding.value;
      },
      set: function set(value: unknown) {
        if (binding.state === 'ready' && binding.kind === 'const') {
          const error = new TypeError('Assignment to constant variable.');
          const capture: unknown = Reflect.get(Error, 'captureStackTrace');
          if (typeof capture === 'function') Reflect.apply(capture, Error, [error, set]);
          throw error;
        }
        // The declaration's initializer.
        binding.value = value;
        binding.state = 'ready';
      },
    });
    return binding;
  }

  function hand(name: string, value: unknown) {
    const binding = bindings.get(name);
    if (!binding) return;
    binding.value = value;
    binding.state = 'ready';
  }

  /** Declared by a page script (a lexical binding, maybe in its dead zone) or `var`. */
  function declaredByPage(name: string): boolean {
    const own = Object.getOwnPropertyDescriptor(window, name);
    if (own) return !own.configurable || vars.has(name);
    if (name in window || !IDENTIFIER.test(name)) return false;
    try {
      globalEval(name);
      return true;
    } catch {
      try {
        globalEval(`typeof ${name}`);
        return false;
      } catch {
        return true;
      }
    }
  }

  return {
    names: () => [...declared],
    /** The command ran (maybe throwing): its declarations count, the ones not reached are dead. */
    compiled() {
      for (const name of pending) {
        declared.add(name);
        const binding = bindings.get(name);
        if (binding?.state === 'tdz') binding.state = 'dead';
      }
      for (const name of pendingVars) vars.add(name);
      pending = [];
      pendingVars = [];
      saved = new Map();
    },
    /** The command did not compile: its bindings are as they were. */
    failed() {
      for (const [binding, before] of saved) Object.assign(binding, before);
      pending = [];
      pendingVars = [];
      saved = new Map();
    },
    /**
     * The input to evaluate as a script and as the body of the async wrapper; throws V8's
     * SyntaxError for a name the page declared.
     */
    rewrite(expression: string): { script: string; body: string; commit: () => void } {
      // Lexed once for every query below.
      const lexed = { tokens: tokenize(expression) };
      const declarations = topLevelLexicalDeclarations(expression, lexed);
      pending = declarations.flatMap(declaration => declaration.names);
      pendingVars = topLevelVarNames(expression, lexed);
      const plain = () => ({ script: expression, body: returnLast(expression, lexed), commit: () => {} });
      if (/^\s*(['"])use strict\1/.test(expression)) {
        // Strict eval code keeps its declarations to itself: none is left to list.
        pending = [];
        pendingVars = [];
        return plain();
      }
      if (!declarations.length) return plain();
      for (const name of pending)
        if (!bindings.has(name) && declaredByPage(name)) {
          pending = [];
          pendingVars = [];
          throw syntaxError(`Identifier '${name}' has already been declared`);
        }
      /** What declaring takes, done by `commit` once the input is known to compile. */
      const plan: (() => void)[] = [];
      const canBind = (name: string) => bindings.has(name) || !Object.getOwnPropertyDescriptor(window, name);
      const declare = (name: string, kind: ReplBinding['kind'], initialized: boolean) =>
        plan.push(() => {
          const binding = bind(name, kind);
          if (!binding) return;
          binding.state = 'tdz';
          if (initialized) hand(name, undefined);
        });
      let script = expression;
      let body = expression;
      const classes: string[] = [];
      /** Insertions into the async body, made last to first so the offsets hold. */
      const inserts: { at: number; text: string }[] = [];
      const splice = (code: string, at: number, length: number, by: string) =>
        code.slice(0, at) + by.padEnd(length) + code.slice(at + length);
      const handOver = (names: string[]) =>
        `let __devtoolsAnywhereRepl${++nextTemp} = [${names
          .map(name => `${REPL_EXPORT}(${JSON.stringify(name)}, ${name})`)
          .join(', ')}];`;
      for (const { kind, names, bare, start, end } of declarations) {
        if (kind === 'class') {
          // Before running: a class used before its declaration is in its dead zone.
          const name = names[0];
          if (name === undefined || !canBind(name)) continue;
          declare(name, kind, false);
          classes.push(name);
          // In the async body, right after the class (its line moves on, as the wrapper's first does).
          inserts.push({ at: end, text: `;${handOver([name])}` });
          continue;
        }
        // A name that cannot be bound (a page property): the declaration stays the input's own.
        if (!names.every(canBind)) continue;
        for (const name of names) declare(name, kind, bare.includes(name));
        script = splice(script, start, kind.length, 'var');
        body = splice(body, start, kind.length, '0,');
      }
      // The completion value is the original's last expression statement, not a rewritten declaration.
      const last = lastExpressionStatement(expression, lexed);
      if (last !== undefined) inserts.push({ at: last, text: 'return ' });
      for (const { at, text } of inserts.sort((x, y) => y.at - x.at)) body = body.slice(0, at) + text + body.slice(at);
      // On a line of its own after the input: no column moves.
      if (classes.length) script += `\n;${handOver(classes)}`;
      const commit = () => {
        if (!Object.getOwnPropertyDescriptor(window, REPL_EXPORT))
          Object.defineProperty(window, REPL_EXPORT, { value: hand, configurable: true });
        for (const step of plan) step();
      };
      return { script, body, commit };
    },
  };
}

/**
 * The names the page's classic scripts declared with top-level `let`, `const` and `class`
 * (Runtime.globalLexicalScopeNames). Page scripts cannot list the global lexical scope, so the
 * sources are lexed: inline `<script>`s and the external scripts the page loaded (fetched again,
 * from the HTTP cache), each once. Module scripts are left out: their declarations are not global.
 * Each name is then looked up, which drops the ones not declared (a script that did not compile, a
 * module's name). The console's declarations (see `replBindings`) are added by the caller.
 */
function globalLexicalNames(probe: Context['probe']) {
  /**
   * Names per external script URL, and per inline script text. Each pass keeps only the entries it
   * used, so scripts gone from the page and from `probe.requests` do not stay in memory.
   */
  let external = new Map<string, Promise<string[]>>();
  let inline = new Map<string, string[]>();
  let nextExternal = new Map<string, Promise<string[]>>();
  let nextInline = new Map<string, string[]>();

  const lex = (source: string) => {
    try {
      return topLevelLexicalNames(source);
    } catch {
      return [];
    }
  };
  const isModule = (script: HTMLScriptElement) => script.type.trim().toLowerCase() === 'module';
  const isClassic = (script: HTMLScriptElement) =>
    !script.type || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/i.test(script.type.trim());

  /**
   * `cachedOnly`: a script no longer in the document (often JSONP, or a URL with a timestamp) is
   * read only from the HTTP cache, and left out when it cannot be: fetching it again would hit the
   * network and run the server's side effects again.
   */
  function fromUrl(url: string, cachedOnly = false): Promise<string[]> {
    let names = nextExternal.get(url) ?? external.get(url);
    if (!names) {
      const res = cachedOnly
        ? url.startsWith(`${location.origin}/`)
          ? probe.fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then(res => {
              if (!res.ok) throw new Error(`${res.status}`);
              return res;
            })
          : Promise.reject(new Error('cross-origin'))
        : refetch(probe, url);
      names = res.then(res => res.text()).then(lex, () => []);
    }
    nextExternal.set(url, names);
    return names;
  }

  function declared(name: string): boolean {
    if (!IDENTIFIER.test(name)) return false;
    try {
      // A ReferenceError: not declared, or declared but in its temporal dead zone.
      globalEval(name);
      return true;
    } catch {
      try {
        // Like V8, a name in its temporal dead zone is listed: only there does `typeof` throw.
        globalEval(`typeof ${name}`);
        return false;
      } catch {
        return true;
      }
    }
  }

  /** The last result, until a script is added, removed or loaded. */
  let cached: Promise<string[]> | undefined;
  /** Stops watching the scripts, while watching. */
  let unwatch: (() => void) | null = null;
  const invalidate = () => {
    cached = undefined;
  };
  const hasScript = (node: Node) =>
    node instanceof HTMLScriptElement || (node instanceof Element && !!node.querySelector('script'));
  function watch() {
    if (unwatch) return;
    const offRequest = probe.onRequest(rec => {
      if (rec.type === 'Script' && rec.state === 'done') invalidate();
    });
    const observer = new MutationObserver(records => {
      const inScript = (node: Node) =>
        node instanceof HTMLScriptElement || node.parentNode instanceof HTMLScriptElement;
      if (records.some(r => inScript(r.target) || [...r.addedNodes, ...r.removedNodes].some(hasScript))) invalidate();
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
    unwatch = () => {
      offRequest();
      observer.disconnect();
    };
  }

  return {
    /** Also the moment to look again: page code may have changed what is declared. */
    invalidate,
    list(): Promise<string[]> {
      watch();
      cached ??= compute();
      return cached;
    },
    /** Stops watching the scripts (the session ended); the next list() looks again. */
    stop() {
      unwatch?.();
      unwatch = null;
      invalidate();
    },
  };

  async function compute(): Promise<string[]> {
    {
      const lists: (string[] | Promise<string[]>)[] = [];
      const modules = new Set<string>();
      for (const script of document.querySelectorAll<HTMLScriptElement>('script')) {
        if (script.src) {
          if (isModule(script)) modules.add(script.src);
          else if (isClassic(script) && /^https?:/.test(script.src) && !probe.ownUrls.has(script.src))
            lists.push(fromUrl(script.src));
        } else if (isClassic(script)) {
          const text = script.text;
          const names = nextInline.get(text) ?? inline.get(text) ?? lex(text);
          nextInline.set(text, names);
          lists.push(names);
        }
      }
      // Scripts added and removed again, or loaded by other means.
      for (const rec of probe.requests)
        if (rec.type === 'Script' && rec.state === 'done' && !modules.has(rec.url) && !probe.ownUrls.has(rec.url))
          lists.push(fromUrl(rec.url, true));
      external = nextExternal;
      inline = nextInline;
      nextExternal = new Map();
      nextInline = new Map();
      const names = new Set<string>();
      for (const list of await Promise.all(lists)) for (const name of list) names.add(name);
      return [...names].filter(declared);
    }
  }
}

export function registerRuntime({ session, objects, nodes, probe }: Context) {
  const lexicalNames = globalLexicalNames(probe);
  const repl = replBindings();
  let unsubscribe: (() => void) | null = null;
  let exceptionId = 0;
  let lastResult: unknown;
  session.onReset(() => {
    lastResult = undefined;
    lexicalNames.stop();
  });

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

  function emitLog(entry: LogEntry) {
    if (entry.kind === 'console') {
      session.emit('Runtime.consoleAPICalled', {
        type: entry.type,
        args: consoleArgs(entry),
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
        executionContextId: EXECUTION_CONTEXT_ID,
        ...(frames.length ? { stackTrace: { callFrames: frames } } : {}),
      },
    } satisfies Protocol.Runtime.ExceptionThrownEvent);
  }

  session.register('Runtime', {
    enable() {
      if (unsubscribe) return;
      session.emit('Runtime.executionContextCreated', {
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
          const rewritten = params.replMode ? repl.rewrite(params.expression) : undefined;
          const script = rewritten?.script ?? params.expression;
          const body = rewritten?.body ?? returnLast(params.expression);
          // Like V8, input that does not compile declares nothing: the bindings (properties of
          // window that cannot be removed) are only made for input that does.
          const compiled = rewritten !== undefined && compiles(script, allowAwait ? body : undefined);
          if (compiled) rewritten.commit();
          let ran: ReturnType<typeof run>;
          try {
            ran = run(script, allowAwait, body);
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
    globalLexicalScopeNames: async (): Promise<Protocol.Runtime.GlobalLexicalScopeNamesResponse> => ({
      names: [...new Set([...(await lexicalNames.list()), ...repl.names()])],
    }),
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
