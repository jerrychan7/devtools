import type { Protocol } from 'devtools-protocol';
import type { Frame, FrameRegistry } from '../../core/frames/frames';
import { isNode, realmOf } from '../../core/realm';
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
}

/** The names the world's code reads as its global (names, not the top realm's window: scripts/check-realms.ts counts it). */
const GLOBAL_NAMES: PropertyKey[] = ['globalThis', 'self', 'window'];
/** Names the world's code must find as they are: `eval` for direct eval, `arguments` its function's. */
const UNSCOPED: PropertyKey[] = ['eval', 'arguments'];

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
  #globals = new WeakMap<World, object>();
  /** What each world's global shows. */
  #targets = new WeakMap<object, object>();
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
    const world: World = { id: this.#frames.newContextId(), name, frame, document: frame.document, evaluate: () => 0 };
    const win = realmOf(frame.document);
    let run: ((code: string) => unknown) | undefined;
    // Compiled on first use, not here: a page whose CSP forbids eval still gets its worlds (as in
    // Chrome), whose code then fails like the page's own context's, with an EvalError.
    world.evaluate = code => {
      if (!run) {
        // Indirect eval of the frame's window makes the function there, without declaring anything;
        // direct eval within it then looks global names up in the world's global first.
        const make = Reflect.apply(Reflect.get(win, 'eval'), undefined, [
          '(function (g) { with (g) return function () { return eval(arguments[0]); }; })',
        ]) as (global: unknown) => (code: string) => unknown;
        run = make(this.global(world));
      }
      // The top-level `this` is the world's global too.
      return Reflect.apply(run, this.global(world), [code]);
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
    const existing = this.#globals.get(world);
    if (existing) return existing;
    const target = realmOf(world.document);
    const own = new Map<PropertyKey, unknown>();
    const bound = new Map<PropertyKey, { fn: Function; bound: Function }>();
    const global: object = new Proxy(Object.create(null) as object, {
      get: (_, key) => {
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
      },
      set: (_, key, val) => (own.set(key, val), true),
      has: (_, key) => typeof key === 'string' && !UNSCOPED.includes(key),
      deleteProperty: (_, key) => (own.delete(key), true),
      getPrototypeOf: () => Reflect.getPrototypeOf(target),
      // Configurable whatever the page's says: the proxy's own target has none of them.
      getOwnPropertyDescriptor: (_, key) => {
        const desc = own.has(key)
          ? { value: own.get(key), writable: true, enumerable: true }
          : Reflect.getOwnPropertyDescriptor(target, key);
        return desc && { ...desc, configurable: true };
      },
      ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...(own.keys() as Iterable<string | symbol>)])],
    });
    this.#globals.set(world, global);
    this.#targets.set(global, target);
    return global;
  }

  unwrap(value: unknown): unknown {
    return ((typeof value === 'object' || typeof value === 'function') && value && this.#targets.get(value)) || value;
  }

  /**
   * Calls `fn` in `world` on `self`. A node stays the page's node (DOM methods take it, identity
   * holds), but the properties the world left on it are there only during the call's synchronous
   * part: before it, the world's are put back; after it, those added or changed are kept for the
   * world and the page's restored. Code of the world running later (a listener, after an `await`)
   * reads them from the node only during its own call (Chrome keeps them in the world all along).
   */
  callOn(world: World, self: unknown, fn: Function, args: unknown[]): unknown {
    if (self === realmOf(world.document)) return Reflect.apply(fn, this.global(world), args);
    if (!isNode(self)) return Reflect.apply(fn, self, args);
    let byObject = this.#expandos.get(world);
    if (!byObject) this.#expandos.set(world, (byObject = new WeakMap()));
    const kept = byObject.get(self) ?? new Map<PropertyKey, PropertyDescriptor>();
    byObject.set(self, kept);
    const pageOwn = Object.getOwnPropertyDescriptors(self) as Record<PropertyKey, PropertyDescriptor>;
    for (const [key, desc] of kept) Reflect.defineProperty(self, key, { ...desc, configurable: true });
    const before = Object.getOwnPropertyDescriptors(self) as Record<PropertyKey, PropertyDescriptor>;
    try {
      return Reflect.apply(fn, self, args);
    } finally {
      const after = Object.getOwnPropertyDescriptors(self) as Record<PropertyKey, PropertyDescriptor>;
      const keys = new Set([...Reflect.ownKeys(before), ...Reflect.ownKeys(after)]);
      for (const key of keys) {
        const was = before[key as string];
        const now = after[key as string];
        const changed = !was || !now || was.value !== now.value || was.get !== now.get || was.set !== now.set;
        // The world's: set or changed by the call, or set by it before and left as is.
        if (changed || kept.has(key)) {
          if (now) kept.set(key, now);
          else kept.delete(key);
          const page = pageOwn[key as string];
          if (page) Reflect.defineProperty(self, key, page);
          else Reflect.deleteProperty(self, key);
        }
      }
    }
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
