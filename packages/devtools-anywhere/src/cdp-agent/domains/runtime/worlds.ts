import type { Protocol } from 'devtools-protocol';
import type { Frame, FrameRegistry } from '../../core/frames/frames';
import { isNode, realmOf } from '../../core/realm';
import { tokenize } from '../../core/lexer';
import { CdpError, type CdpSession } from '../../core/session';

/**
 * An isolated world (Page.createIsolatedWorld), simulated in the page's own JavaScript world: there
 * is no second realm to run code in. Its code runs in a `with` scope of a view of the frame's window
 * ({@link PageWorlds.global}) whose own properties are the world's alone: the bindings put there,
 * what the code assigns to globals (declared or not) or to the top-level `this`, are not seen by
 * the page, nor the page's own globals by other worlds once the world sets one of that name. A node
 * a function is called on is the page's node itself, but the properties the call leaves on it are
 * kept apart for the world ({@link PageWorlds.callOn}). Everything else, the DOM included, is the
 * page's, as in Chrome, where worlds share the DOM but not JavaScript objects.
 *
 * Like Chrome, the worlds are the page's, shared by every session: a world of a name has one id.
 */
export interface World {
  id: number;
  name: string;
  frame: Frame;
  /** The document it was made for: like Chrome, the frame's next document gets a new one. */
  document: Document;
  /** Runs code with the world's globals (the code's own `var`s stay in it, not in the world). */
  evaluate: (code: string) => unknown;
  /**
   * The property names the world's code assigns or deletes (`.name =`, `['name'] =`, `delete x.name`)
   * and its string arguments: what it may write on nodes, kept for it (see PageWorlds.callOn).
   */
  names: Set<string>;
}

/** Notes the property names `code` writes. */
function noteNames(world: World, code: string): void {
  const assigned = /\.\s*([A-Za-z_$][\w$]*)\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])/g;
  for (const [, name] of code.matchAll(assigned)) world.names.add(name as string);
  for (const [, , name] of code.matchAll(/\[\s*(['"`])([^'"`]+)\1\s*\]\s*=(?![=>])/g)) world.names.add(name as string);
  for (const [, name] of code.matchAll(/\bdelete\s+[\w$.]*\.([A-Za-z_$][\w$]*)/g)) world.names.add(name as string);
}

/** What `typeof name` of the world's code is rewritten to call (see {@link rewriteTypeof}): no name of the page's. */
const TYPEOF = `$typeof${Math.random().toString(36).slice(2)}`;
/** A name: Unicode ID_Start then ID_Continue, as JavaScript identifiers (escapes left out). */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;
/** Words after `typeof` that are not names to look up. */
const NOT_NAMES = new Set([
  'this',
  'super',
  'new',
  'typeof',
  'void',
  'delete',
  'await',
  'yield',
  'function',
  'class',
  'async',
  'import',
  'null',
  'true',
  'false',
]);

/**
 * `code` with each `typeof name` (a bare name, not `typeof a.b`) made `TYPEOF(() => name)`, which
 * gives 'undefined' for a name that exists nowhere. The world's `with` scope finds every name, so
 * that assigning one undeclared makes a global of the world, and throws for one it reads that does
 * not exist: `typeof` would throw too. Strings, comments, regular expressions and templates are told
 * apart by the agent's lexer.
 */
function rewriteTypeof(code: string): string {
  if (!code.includes('typeof')) return code;
  const tokens = tokenize(code);
  const text = (k: number) => {
    const token = tokens[k];
    return token ? code.slice(token.start, token.end) : '';
  };
  let out = '';
  let at = 0;
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i];
    if (!op || op.kind !== 'word' || text(i) !== 'typeof') continue;
    // The name, in as many parentheses as there are: `typeof (name)`.
    let open = 0;
    while (text(i + 1 + open) === '(') open++;
    const name = tokens[i + 1 + open];
    const word = text(i + 1 + open);
    if (!name || name.kind !== 'word' || !IDENTIFIER.test(word) || NOT_NAMES.has(word)) continue;
    let close = 0;
    while (close < open && text(i + 2 + open + close) === ')') close++;
    if (close !== open) continue;
    // A member, a call, an optional chain, a tagged template or a postfix update right after it:
    // `typeof` applies to more than the name. `++` on the next line starts another statement.
    const end = i + 2 + open + close;
    const next = tokens[end];
    const after = next ? code.slice(next.start, next.start + 3) : '';
    if (/^(\.|\[|\(|\?\.(?!\d)|`)/.test(after)) continue;
    if (/^(\+\+|--)/.test(after) && !next?.newline) continue;
    const last = tokens[end - 1];
    if (!last) continue;
    out += `${code.slice(at, op.start)}${TYPEOF}(() => ${word})`;
    at = last.end;
    i = end - 1;
  }
  return out + code.slice(at);
}

/** The names the world's code reads as its global (names, not the top realm's window: scripts/check-realms.ts counts it). */
const GLOBAL_NAMES: PropertyKey[] = ['globalThis', 'self', 'window'];
/** A name the world's code must find as it is: `eval`, for direct eval. */
const UNSCOPED: PropertyKey[] = ['eval'];
/**
 * What the world's runner reads the code to run from, in its `with` scope: not its `arguments`,
 * which its top-level code would see (Chrome's has none).
 */
const CODE = `$code${Math.random().toString(36).slice(2)}`;

/** A session's binding (Runtime.addBinding): the contexts it names, and where its calls go. */
interface Subscriber {
  /** The contexts by name ('' for the frames' default ones), all of them if undefined. */
  contextName?: string | undefined;
  /** A single context (the deprecated executionContextId). */
  contextId?: number | undefined;
  report: (name: string, payload: string, contextId: number) => void;
}

/** The worlds and binding functions of a page, shared by its sessions. */
class PageWorlds {
  readonly #frames: FrameRegistry;
  /** The world names made per frame, in order. */
  #names = new Map<Frame, string[]>();
  #worlds = new Map<number, World>();
  /** Each world's own globals. */
  #globals = new WeakMap<World, { global: object; scope: object }>();
  /** What each world's global shows. */
  #targets = new WeakMap<object, object>();
  /** The code each world runs now (see CODE). */
  #code = new WeakMap<World, string>();
  /** The properties a world's calls left on page objects, kept apart from the page's. */
  #expandos = new WeakMap<World, WeakMap<object, Map<PropertyKey, PropertyDescriptor>>>();
  /** The sessions' bindings by name. */
  readonly subscribers = new Map<string, Set<Subscriber>>();
  /** Where each binding's function was put (a world, or a document for its default context). */
  #installed = new WeakMap<object, Set<string>>();
  readonly listeners = new Set<(world: World) => void>();
  #following = false;

  constructor(frames: FrameRegistry) {
    this.#frames = frames;
  }

  /** Follows the frames, to make the worlds and bindings again for each new document. */
  follow(): void {
    if (this.#following) return;
    this.#following = true;
    this.#frames.onChange(({ type, frame }) => {
      if (type === 'detached') this.#names.delete(frame);
      this.of(frame);
    });
  }

  create(frame: Frame, name: string): World {
    const names = this.#names.get(frame) ?? [];
    if (!names.includes(name)) names.push(name);
    this.#names.set(frame, names);
    this.follow();
    const world = this.of(frame).find(w => w.name === name);
    // A frame gone meanwhile.
    if (!world) throw new CdpError('No frame for given id found');
    return world;
  }

  of(frame: Frame): World[] {
    const live = this.#frames.byContext(frame.executionContextId) === frame;
    for (const [id, world] of this.#worlds)
      if (world.frame === frame && (!live || world.document !== frame.document)) this.#worlds.delete(id);
    if (!live) return [];
    const worlds: World[] = [];
    for (const name of this.#names.get(frame) ?? []) {
      let world = Array.from(this.#worlds.values()).find(w => w.frame === frame && w.name === name);
      if (!world) {
        world = this.#make(frame, name);
        this.#worlds.set(world.id, world);
        this.install(world);
        for (const listener of this.listeners) listener(world);
      }
      worlds.push(world);
    }
    // The default context of a new document gets the bindings that name it.
    this.install(frame);
    return worlds;
  }

  byId(id: number | undefined): World | undefined {
    const world = id === undefined ? undefined : this.#worlds.get(id);
    return world && this.of(world.frame).includes(world) ? world : undefined;
  }

  #make(frame: Frame, name: string): World {
    const world: World = {
      id: this.#frames.newContextId(),
      name,
      frame,
      document: frame.document,
      evaluate: () => 0,
      names: new Set(),
    };
    const win = realmOf(frame.document);
    let run: (() => unknown) | undefined;
    // Compiled on first use, not here: a page whose CSP forbids eval still gets its worlds (as in
    // Chrome), whose code then fails like the page's own context's, with an EvalError.
    world.evaluate = code => {
      noteNames(world, code);
      code = rewriteTypeof(code);
      if (!run) {
        // Indirect eval of the frame's window makes the function there, without declaring anything;
        // direct eval within it then looks global names up in the world's global first.
        const make = Reflect.apply(Reflect.get(win, 'eval'), undefined, [
          // An arrow: no `arguments` of its own for the code to see, and the `this` it is made with.
          `(function (g) { with (g) return () => eval(${CODE}); })`,
        ]) as (global: unknown) => () => unknown;
        // The top-level `this` is the world's global too.
        run = Reflect.apply(make, this.global(world), [this.#scope(world)]) as () => unknown;
      }
      this.#code.set(world, code);
      return run();
    };
    return world;
  }

  /**
   * The world's global: a proxy of the frame's window whose own properties set, deleted or read are
   * the world's, with the window's prototype (`instanceof Window`). In the `with` scope, every name
   * but `eval` and `arguments` is found there, so that assigning one not declared makes a global of
   * the world; reading one that exists nowhere gives undefined (Chrome throws a ReferenceError).
   * The window's methods are bound to it, as the scope calls them with the proxy as `this`.
   */
  global(world: World): object {
    return this.#proxies(world).global;
  }

  /** The object of the world's `with` scope (see {@link global}). */
  #scope(world: World): object {
    return this.#proxies(world).scope;
  }

  #proxies(world: World): { global: object; scope: object } {
    const existing = this.#globals.get(world);
    if (existing) return existing;
    const target = realmOf(world.document);
    const own = new Map<PropertyKey, unknown>();
    const bound = new Map<PropertyKey, { fn: Function; bound: Function }>();
    const read = (key: PropertyKey): unknown => {
      if (own.has(key)) return own.get(key);
      if (GLOBAL_NAMES.includes(key)) return global;
      const result: unknown = Reflect.get(target, key);
      // A method, bound to the window: one of its prototypes (even one the page or the agent
      // wrapped), or a function without `prototype` (the window's own operations, setTimeout, …).
      // Constructors (the window's `Event`, …) and the page's own functions stay as they are.
      if (typeof result !== 'function' || key === 'constructor') return result;
      if (Object.hasOwn(result, 'prototype') && Object.hasOwn(target, key)) return result;
      let entry = bound.get(key);
      if (entry?.fn !== result) bound.set(key, (entry = { fn: result, bound: result.bind(target) }));
      return entry.bound;
    };
    const known = (key: PropertyKey) => own.has(key) || key in target;
    /** The errors thrown for names that exist nowhere, which `typeof` turns into 'undefined'. */
    const unknownNames = new WeakSet<object>();
    const typeOf = (get: () => unknown) => {
      try {
        return typeof get();
      } catch (e) {
        if (typeof e === 'object' && e && unknownNames.has(e)) return 'undefined';
        throw e;
      }
    };
    const traps = {
      set: (_: object, key: PropertyKey, val: unknown) => (own.set(key, val), true),
      deleteProperty: (_: object, key: PropertyKey) => (own.delete(key), true),
      getPrototypeOf: () => Reflect.getPrototypeOf(target),
      // Configurable whatever the page's says: the proxy's own target has none of them.
      getOwnPropertyDescriptor: (_: object, key: PropertyKey) => {
        const desc = own.has(key)
          ? { value: own.get(key), writable: true, enumerable: true }
          : Reflect.getOwnPropertyDescriptor(target, key);
        return desc && { ...desc, configurable: true };
      },
      ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...(own.keys() as Iterable<string | symbol>)])],
    };
    // What the code sees as globalThis, window, self: the names that exist, like a window.
    const global: object = new Proxy(Object.create(null) as object, {
      ...traps,
      get: (_, key) => read(key),
      has: (_, key) => known(key),
    });
    // The `with` scope also finds the names that exist nowhere, so that assigning one makes a global
    // of the world rather than the page's; reading one throws Chrome's ReferenceError. Those the
    // code applies `typeof` to are left to the page's scope, where one not defined is 'undefined'.
    const scope: object = new Proxy(Object.create(null) as object, {
      ...traps,
      get: (_, key) => {
        if (key === TYPEOF) return typeOf;
        if (key === CODE) return this.#code.get(world);
        if (typeof key === 'symbol' || known(key) || GLOBAL_NAMES.includes(key)) return read(key);
        const error = new target.ReferenceError(`${key} is not defined`);
        unknownNames.add(error);
        throw error;
      },
      has: (_, key) => !UNSCOPED.includes(key) && (known(key) || typeof key === 'string'),
    });
    const proxies = { global, scope };
    this.#globals.set(world, proxies);
    this.#targets.set(global, target);
    return proxies;
  }

  unwrap(value: unknown): unknown {
    return ((typeof value === 'object' || typeof value === 'function') && value && this.#targets.get(value)) || value;
  }

  /**
   * Calls `fn` in `world` on `self`. A node stays the page's node (DOM methods take it, identity
   * holds), but the properties the world keeps on it are on the node only while the world's code
   * runs on it: put back before the call, taken back after its synchronous part, and again after
   * the promise it returns settles (what it writes after an `await` is on the node until then).
   *
   * After the synchronous part, every property added, changed or removed is the world's, however
   * written, but for those the page's listeners wrote: the events the call dispatches
   * (`dispatchEvent`, `click`, `focus`, `blur`) are watched meanwhile, and what changed on the node
   * during each is the page's, the world's own value of the name kept apart. After an `await`, only
   * the names its code assigns or deletes (`.name =`, `['name'] =`, `delete x.name`) or gets as
   * string arguments are taken back: the page may have run in between. During the call, the page's
   * code it runs sees the world's properties.
   */
  callOn(world: World, self: unknown, fn: Function, args: unknown[]): unknown {
    if (self === realmOf(world.document)) return Reflect.apply(fn, this.global(world), args);
    if (!isNode(self)) return Reflect.apply(fn, self, args);
    for (const arg of args) if (typeof arg === 'string') world.names.add(arg);
    let byObject = this.#expandos.get(world);
    if (!byObject) this.#expandos.set(world, (byObject = new WeakMap()));
    const kept = byObject.get(self) ?? new Map<PropertyKey, PropertyDescriptor>();
    byObject.set(self, kept);
    const node: object = self;
    type Descriptors = Record<PropertyKey, PropertyDescriptor>;
    const snapshot = () => Object.getOwnPropertyDescriptors(node) as Descriptors;
    const same = (a?: PropertyDescriptor, b?: PropertyDescriptor) =>
      a === b || (!!a && !!b && a.value === b.value && a.get === b.get && a.set === b.set);
    const changedKeys = (from: Descriptors, to: Descriptors) =>
      [...new Set([...Reflect.ownKeys(from), ...Reflect.ownKeys(to)])].filter(
        key => !same(from[key as string], to[key as string])
      );
    /** Gives the page `page` for `key` back on the node (none: removes it). */
    const restore = (key: PropertyKey, page?: PropertyDescriptor) => {
      if (page) Reflect.defineProperty(node, key, page);
      else Reflect.deleteProperty(node, key);
    };
    const keep = (key: PropertyKey, desc?: PropertyDescriptor) => {
      if (desc) kept.set(key, desc);
      else kept.delete(key);
    };

    const pageOwn = snapshot();
    for (const [key, desc] of kept) Reflect.defineProperty(node, key, { ...desc, configurable: true });
    const before = snapshot();
    /** What the page's listeners wrote, per name: the value before the event, and theirs. */
    const pageWrote = new Map<
      PropertyKey,
      { prior?: PropertyDescriptor | undefined; page?: PropertyDescriptor | undefined }
    >();
    const unwatch = this.#watchEvents(realmOf(self), (run: () => unknown) => {
      const pre = snapshot();
      try {
        return run();
      } finally {
        const post = snapshot();
        for (const key of changedKeys(pre, post)) {
          const entry = pageWrote.get(key) ?? { prior: pre[key as string] };
          entry.page = post[key as string];
          pageWrote.set(key, entry);
        }
      }
    });
    let value: unknown;
    try {
      value = Reflect.apply(fn, node, args);
    } finally {
      unwatch();
      const after = snapshot();
      for (const key of new Set([...Reflect.ownKeys(before), ...Reflect.ownKeys(after)])) {
        const now = after[key as string];
        const wrote = pageWrote.get(key);
        if (wrote) {
          // The page's value stays, unless the world wrote the name again after the event.
          if (same(now, wrote.page)) {
            const worldHad = kept.has(key) || !same(wrote.prior, before[key as string]);
            keep(key, worldHad ? wrote.prior : undefined);
          } else {
            keep(key, now);
            restore(key, wrote.page);
          }
          continue;
        }
        if (!kept.has(key) && same(before[key as string], now)) continue;
        keep(key, now);
        restore(key, pageOwn[key as string]);
      }
    }
    if (typeof (value as PromiseLike<unknown> | null)?.then === 'function') {
      const settled = snapshot();
      const later = () => {
        for (const key of changedKeys(settled, snapshot())) {
          if (typeof key !== 'string' || !world.names.has(key)) continue;
          keep(key, Object.getOwnPropertyDescriptor(node, key));
          restore(key, settled[key]);
        }
      };
      Promise.resolve(value).then(later, later);
    }
    return value;
  }

  /**
   * Until the returned function is called, runs the events dispatched in `win` (`dispatchEvent`,
   * and `click`, `focus`, `blur` of its elements) through `around`.
   */
  #watchEvents(win: Window & typeof globalThis, around: (run: () => unknown) => unknown): () => void {
    const undo: (() => void)[] = [];
    const watch = (proto: object | undefined, key: string) => {
      const desc = proto && Reflect.getOwnPropertyDescriptor(proto, key);
      const original: unknown = desc?.value;
      if (!proto || !desc || typeof original !== 'function') return;
      // A proxy of the method, as the probe hooks animate(): its name and length stay, `toString()`
      // keeps the native form, and calls on another `this` throw as before.
      const watched = new Proxy(original, { apply: (f, self, args) => around(() => Reflect.apply(f, self, args)) });
      Reflect.defineProperty(proto, key, { ...desc, value: watched });
      // Put back only if still ours: the page may have replaced it meanwhile.
      undo.push(() => {
        if (Reflect.getOwnPropertyDescriptor(proto, key)?.value === watched) Reflect.defineProperty(proto, key, desc);
      });
    };
    watch(win.EventTarget?.prototype, 'dispatchEvent');
    for (const key of ['click', 'focus', 'blur']) {
      watch(win.HTMLElement?.prototype, key);
      if (key !== 'click') watch(win.SVGElement?.prototype, key);
    }
    return () => undo.reverse().forEach(fn => fn());
  }

  /** Puts the bindings that name it in a world, or in the default context of a frame's document. */
  install(where: World | Frame): void {
    const isWorld = 'evaluate' in where;
    const id = isWorld ? where.id : where.executionContextId;
    const name = isWorld ? where.name : '';
    const win = realmOf(where.document);
    const global = (isWorld ? this.global(where) : win) as Record<string, unknown>;
    // Per document, as a frame's window stays across its documents.
    const key = isWorld ? where : where.document;
    let installed = this.#installed.get(key);
    if (!installed) this.#installed.set(key, (installed = new Set()));
    const names = (sub: Subscriber) =>
      sub.contextId !== undefined ? sub.contextId === id : sub.contextName === undefined || sub.contextName === name;
    for (const [binding, subs] of this.subscribers) {
      if (installed.has(binding) || ![...subs].some(names)) continue;
      installed.add(binding);
      const report = (payload: unknown, args: number) => {
        if (args !== 1 || typeof payload !== 'string')
          throw new win.Error('Invalid arguments: should be exactly one string.');
        // Each session that added it for this context hears the call.
        for (const sub of this.subscribers.get(binding) ?? []) if (names(sub)) sub.report(binding, payload, id);
      };
      // No declared parameter: its length is 0, like Chrome's.
      global[binding] = function () {
        report(arguments[0], arguments.length);
      };
    }
  }

  all(): World[] {
    return Array.from(this.#frames).flatMap(frame => this.of(frame));
  }
}

/** The worlds of each page (its frame registry). */
const pages = new WeakMap<FrameRegistry, PageWorlds>();

/**
 * A session's side of the page's worlds and bindings: the bindings it added (its calls reported to
 * it alone), and the worlds made from now on. Like Chrome, a binding is put in each context it
 * names as it comes; its function stays once removed, its calls no longer reported.
 */
export class IsolatedWorlds {
  readonly #page: PageWorlds;
  readonly #frames: FrameRegistry;
  readonly #session: CdpSession;
  #mine = new Map<string, Subscriber>();
  #listeners = new Set<(world: World) => void>();

  constructor(frames: FrameRegistry, session: CdpSession) {
    let page = pages.get(frames);
    if (!page) pages.set(frames, (page = new PageWorlds(frames)));
    this.#page = page;
    this.#frames = frames;
    this.#session = session;
    session.onReset(() => this.reset());
  }

  /** Forgets the session's bindings and listeners; the page's worlds stay. */
  reset(): void {
    for (const name of this.#mine.keys()) this.removeBinding(name);
    for (const listener of this.#listeners) this.#page.listeners.delete(listener);
    this.#listeners.clear();
  }

  /** Calls `listener` for each world made from now on; returns its removal. */
  onCreated(listener: (world: World) => void): () => void {
    this.#listeners.add(listener);
    this.#page.listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      this.#page.listeners.delete(listener);
    };
  }

  /** The world named `name` of `frame`'s document, made if there is none (Page.createIsolatedWorld). */
  create(frame: Frame, name: string): World {
    return this.#page.create(frame, name);
  }

  /** The worlds of `frame`'s document: like Chrome's, those of a document it left are gone. */
  of(frame: Frame): World[] {
    return this.#page.of(frame);
  }

  /** The world of context id `id`, if it is one of a document still shown. */
  byId(id: number | undefined): World | undefined {
    return this.#page.byId(id);
  }

  /** Every world of the frames' documents. */
  all(): World[] {
    return this.#page.all();
  }

  /** The page object the world's global shows, `value` itself for any other value. */
  unwrap(value: unknown): unknown {
    return this.#page.unwrap(value);
  }

  /** Calls `fn` in `world` on `self` (see {@link PageWorlds.callOn}). */
  callOn(world: World, self: unknown, fn: Function, args: unknown[]): unknown {
    return this.#page.callOn(world, self, fn, args);
  }

  /** Runtime.addBinding: each call in the contexts it names is reported as Runtime.bindingCalled. */
  addBinding({ name, executionContextId, executionContextName }: Protocol.Runtime.AddBindingRequest): void {
    if (executionContextId !== undefined && executionContextName !== undefined)
      throw new CdpError('executionContextName is mutually exclusive with executionContextId', -32602);
    if (
      executionContextId !== undefined &&
      !this.byId(executionContextId) &&
      !this.#frames.byContext(executionContextId)
    )
      throw new CdpError('Cannot find execution context with given executionContextId', -32602);
    this.removeBinding(name);
    const sub: Subscriber = {
      contextId: executionContextId,
      contextName: executionContextName,
      report: (binding, payload, contextId) =>
        this.#session.emit('Runtime.bindingCalled', {
          name: binding,
          payload,
          executionContextId: contextId,
        } satisfies Protocol.Runtime.BindingCalledEvent),
    };
    this.#mine.set(name, sub);
    let subs = this.#page.subscribers.get(name);
    if (!subs) this.#page.subscribers.set(name, (subs = new Set()));
    subs.add(sub);
    this.#page.follow();
    this.all();
  }

  /** Runtime.removeBinding: the functions already put stay, their calls no longer reported to this session. */
  removeBinding(name: string): void {
    const sub = this.#mine.get(name);
    if (!sub) return;
    this.#mine.delete(name);
    this.#page.subscribers.get(name)?.delete(sub);
  }
}
