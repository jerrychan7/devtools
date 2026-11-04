import {
  type LexOptions,
  lastExpressionStatement,
  tokenize,
  topLevelLexicalDeclarations,
  topLevelVarNames,
} from '../../core/lexer';

/** `code` with its last statement returned when it is an expression statement. */
export function returnLast(code: string, options?: LexOptions): string {
  const at = lastExpressionStatement(code, options);
  return at === undefined ? code : `${code.slice(0, at)}return ${code.slice(at)}`;
}

export const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/** Whether global code declares `name`, a binding in its temporal dead zone included. */
export function isDeclared(name: string, evaluate: (code: string) => unknown): boolean {
  if (!IDENTIFIER.test(name)) return false;
  try {
    // A ReferenceError: not declared, or declared but in its temporal dead zone.
    evaluate(name);
    return true;
  } catch {
    try {
      // Like V8, a name in its temporal dead zone counts: only there does `typeof` throw.
      evaluate(`typeof ${name}`);
      return false;
    } catch {
      return true;
    }
  }
}

/** Global function the rewritten console input hands its declarations to. */
const REPL_EXPORT = '__devtoolsAnywhereRepl__';

/** A SyntaxError of the realm `win`, reported like V8's compile errors: no stack of its own. */
function syntaxError(message: string, win: Window & typeof globalThis) {
  const error = new win.SyntaxError(message);
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
 *
 * One per realm: `win` is the window of a frame's document, `evaluate` runs its global code.
 */
export function replBindings(
  win: Window & typeof globalThis,
  evaluate: (code: string) => unknown,
  /** Whether window's `name` is a console utility, there only while console input runs. */
  isUtility: (name: string) => boolean = () => false
) {
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

  /** `error` with its stack starting where the binding is used, not in the accessor `fn`. */
  function thrown<E extends Error>(error: E, fn: (...args: never[]) => unknown): E {
    const capture: unknown = Reflect.get(win.Error, 'captureStackTrace');
    if (typeof capture === 'function') Reflect.apply(capture, win.Error, [error, fn]);
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
    if (isUtility(name)) Reflect.deleteProperty(win, name);
    else if (Object.getOwnPropertyDescriptor(win, name)) return undefined;
    const binding: ReplBinding = { kind, value: undefined, state: 'tdz' };
    bindings.set(name, binding);
    saved.set(binding, { state: 'dead', value: undefined, kind });
    Object.defineProperty(win, name, {
      configurable: false,
      enumerable: false,
      get: function get() {
        // V8's REPL mode says so in the dead zone too.
        if (binding.state !== 'ready') throw thrown(new win.ReferenceError(`${name} is not defined`), get);
        return binding.value;
      },
      set: function set(value: unknown) {
        if (binding.state === 'ready' && binding.kind === 'const')
          throw thrown(new win.TypeError('Assignment to constant variable.'), set);
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

  /** Classes a committed command has yet to hand over, each once: page scripts may call it too. */
  const handing = new Set<string>();
  function receive(name: string, value: unknown) {
    if (handing.delete(name)) hand(name, value);
  }

  /** Declared by a page script (a lexical binding, maybe in its dead zone) or `var`. */
  function declaredByPage(name: string): boolean {
    if (isUtility(name)) return false;
    const own = Object.getOwnPropertyDescriptor(win, name);
    if (own) return !own.configurable || vars.has(name);
    return !(name in win) && isDeclared(name, evaluate);
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
          throw syntaxError(`Identifier '${name}' has already been declared`, win);
        }
      /** What declaring takes, done by `commit` once the input is known to compile. */
      const plan: (() => void)[] = [];
      const canBind = (name: string) =>
        bindings.has(name) || isUtility(name) || !Object.getOwnPropertyDescriptor(win, name);
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
        // Whatever the page put there is replaced: the class lines call ours.
        if (Object.getOwnPropertyDescriptor(win, REPL_EXPORT)?.value !== receive)
          Object.defineProperty(win, REPL_EXPORT, { value: receive, configurable: true });
        for (const step of plan) step();
        for (const name of classes) handing.add(name);
      };
      return { script, body, commit };
    },
  };
}
