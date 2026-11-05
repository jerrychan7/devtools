import type { Protocol } from 'devtools-protocol';
import type { Frame, FrameRegistry } from '../../core/frames/frames';
import { isNode, realmOf } from '../../core/realm';
import { CdpError, type CdpSession } from '../../core/session';

/**
 * An isolated world (Page.createIsolatedWorld), simulated in the page's own JavaScript world: there
 * is no second realm to run code in. Its code sees `globalThis` and `self` (and `window`) as a view
 * of the frame's window ({@link IsolatedWorlds.view}) whose own properties are the world's alone:
 * the bindings put there and what the code assigns are not seen by the page, nor the page's by
 * other worlds. The same goes for the object a function is called on (Runtime.callFunctionOn with
 * an object of the world). Its global names are looked up in that view too (`with`), so that a
 * binding is a global of the world as in Chrome. Everything else, the DOM included, is the page's, as in Chrome, where
 * worlds share the DOM but not JavaScript objects.
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

/** A binding (Runtime.addBinding): where it goes, and whether its calls are still reported. */
interface Binding {
  /** The contexts by name ('' for the frames' default ones), all of them if undefined. */
  contextName?: string | undefined;
  /** A single context (the deprecated executionContextId). */
  contextId?: number | undefined;
}

/**
 * The isolated worlds and bindings of a session. Like Chrome, a world made for a frame is made
 * again, with a new id, for each document the frame loads, and a binding is put in each context it
 * names as it comes.
 */
export class IsolatedWorlds {
  readonly #frames: FrameRegistry;
  readonly #session: CdpSession;
  /** The world names made per frame, in order. */
  #names = new Map<Frame, string[]>();
  #worlds = new Map<number, World>();
  /** Views of page objects per world: the object's own properties as the world sees them. */
  #views = new WeakMap<World, WeakMap<object, object>>();
  /** What each view shows. */
  #targets = new WeakMap<object, object>();
  #bindings = new Map<string, Binding>();
  /** Where each binding's function was put, so it is put there once. */
  #installed = new WeakMap<object, Set<string>>();
  /** Listeners of worlds made. */
  #listeners = new Set<(world: World) => void>();
  #stopFrames: (() => void) | null = null;

  constructor(frames: FrameRegistry, session: CdpSession) {
    this.#frames = frames;
    this.#session = session;
    session.onReset(() => this.reset());
  }

  /** Forgets every world and binding: functions already put stay, but their calls are not reported. */
  reset(): void {
    this.#names.clear();
    this.#worlds.clear();
    this.#bindings.clear();
    this.#stopFrames?.();
    this.#stopFrames = null;
  }

  /** Follows the frames while there are worlds or bindings, to make them for each new document. */
  #follow(): void {
    this.#stopFrames ??= this.#frames.onChange(({ type, frame }) => {
      if (type === 'detached') this.#names.delete(frame);
      this.of(frame);
    });
  }

  /** Calls `listener` for each world made from now on; returns its removal. */
  onCreated(listener: (world: World) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The world named `name` of `frame`'s document, made if there is none (Page.createIsolatedWorld). */
  create(frame: Frame, name: string): World {
    const names = this.#names.get(frame) ?? [];
    if (!names.includes(name)) names.push(name);
    this.#names.set(frame, names);
    this.#follow();
    const world = this.of(frame).find(w => w.name === name);
    // A frame gone meanwhile.
    if (!world) throw new CdpError('No frame for given id found');
    return world;
  }

  /** The worlds of `frame`'s document: like Chrome's, those of a document it left are gone. */
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
        this.#install(world);
        for (const listener of this.#listeners) listener(world);
      }
      worlds.push(world);
    }
    // The default context of a new document gets the bindings that name it.
    this.#install(frame);
    return worlds;
  }

  /** The world of context id `id`, if it is one of a document still shown. */
  byId(id: number | undefined): World | undefined {
    const world = id === undefined ? undefined : this.#worlds.get(id);
    return world && this.of(world.frame).includes(world) ? world : undefined;
  }

  #make(frame: Frame, name: string): World {
    const id = this.#frames.newContextId();
    const world: World = { id, name, frame, document: frame.document, evaluate: () => undefined };
    const win = realmOf(frame.document);
    // Indirect eval of the frame's window makes the function there, without declaring anything;
    // direct eval within it then looks global names up in the world's view of the window first.
    const run = Reflect.apply(Reflect.get(win, 'eval'), undefined, [
      '(function (g) { with (g) return function () { return eval(arguments[0]); }; })',
    ]) as (global: unknown) => (code: string) => unknown;
    world.evaluate = run(this.view(world, win));
    return world;
  }

  /**
   * How `world` sees `value`: for a page object, a proxy whose own properties set, deleted or
   * read are the world's (kept apart from the page's) and whose methods are bound to the object, so
   * that `this.addEventListener(…)` on it works; other values as they are.
   */
  view(world: World, value: unknown): unknown {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
    if (this.#targets.has(value)) return value;
    // Only nodes and windows: other objects (arrays, plain objects) would be told apart from the
    // page's by identity, and they have no expandos of the page to hide.
    if (!isNode(value) && value !== realmOf(world.document)) return value;
    let views = this.#views.get(world);
    if (!views) this.#views.set(world, (views = new WeakMap()));
    let view = views.get(value);
    if (view) return view;
    const target = value;
    const isGlobal = value === realmOf(world.document);
    const own = new Map<PropertyKey, unknown>();
    const bound = new Map<PropertyKey, { fn: Function; bound: Function }>();
    view = new Proxy(Object.create(null) as object, {
      get: (_, key) => {
        if (own.has(key)) return own.get(key);
        if (isGlobal && GLOBAL_NAMES.includes(key)) return view;
        const result: unknown = Reflect.get(target, key);
        // A method, bound to the object: one of its prototypes (even one the page or the agent
        // wrapped), or a function without `prototype` (the window's own operations, setTimeout, …).
        // Constructors (the window's `Event`, …) and the page's own functions stay as they are.
        if (typeof result !== 'function' || key === 'constructor') return result;
        if (Object.hasOwn(result, 'prototype') && Object.hasOwn(target, key)) return result;
        let entry = bound.get(key);
        if (entry?.fn !== result) bound.set(key, (entry = { fn: result, bound: result.bind(target) }));
        return entry.bound;
      },
      set: (_, key, val) => (own.set(key, val), true),
      has: (_, key) => own.has(key) || (!(isGlobal && UNSCOPED.includes(key)) && key in target),
      deleteProperty: (_, key) => (own.delete(key), true),
      // Configurable whatever the page's says: the proxy's own target has none of them.
      getOwnPropertyDescriptor: (_, key) => {
        const desc = own.has(key)
          ? { value: own.get(key), writable: true, enumerable: true }
          : Reflect.getOwnPropertyDescriptor(target, key);
        return desc && { ...desc, configurable: true };
      },
    });
    views.set(value, view);
    this.#targets.set(view, target);
    return view;
  }

  /** The page object a view shows, `value` itself for any other value. */
  unwrap(value: unknown): unknown {
    return ((typeof value === 'object' || typeof value === 'function') && value && this.#targets.get(value)) || value;
  }

  /**
   * Runtime.addBinding: a function `name` in the contexts the binding names, from now on in those
   * to come too; each call is reported as Runtime.bindingCalled.
   */
  addBinding({ name, executionContextId, executionContextName }: Protocol.Runtime.AddBindingRequest): void {
    if (executionContextId !== undefined && executionContextName !== undefined)
      throw new CdpError('executionContextName is mutually exclusive with executionContextId', -32602);
    if (executionContextId !== undefined) {
      const target = this.byId(executionContextId) ?? this.#frames.byContext(executionContextId);
      if (!target) throw new CdpError('Cannot find execution context with given executionContextId', -32602);
      this.#bindings.set(name, { contextId: executionContextId });
    } else {
      this.#bindings.set(name, { contextName: executionContextName });
    }
    this.#follow();
    for (const frame of this.#frames) this.of(frame);
  }

  /**
   * Runtime.removeBinding: like Chrome, the functions already put stay, but their calls are no
   * longer reported, and the contexts to come do not get it.
   */
  removeBinding(name: string): void {
    this.#bindings.delete(name);
  }

  /** Puts the bindings that name it in a world, or in the default context of a frame's document. */
  #install(where: World | Frame): void {
    const isWorld = 'evaluate' in where;
    const id = isWorld ? where.id : where.executionContextId;
    const name = isWorld ? where.name : '';
    const doc = where.document;
    const win = realmOf(doc);
    const global = (isWorld ? this.view(where, win) : win) as Record<string, unknown>;
    // Per document, as a frame's window stays across its documents.
    const key = isWorld ? where : doc;
    let installed = this.#installed.get(key);
    if (!installed) this.#installed.set(key, (installed = new Set()));
    for (const [binding, { contextName, contextId }] of this.#bindings) {
      if (installed.has(binding)) continue;
      if (contextId !== undefined ? contextId !== id : contextName !== undefined && contextName !== name) continue;
      installed.add(binding);
      const report = (payload: unknown, args: number) => {
        if (args !== 1 || typeof payload !== 'string')
          throw new win.Error('Invalid arguments: should be exactly one string.');
        if (!this.#bindings.has(binding)) return;
        this.#session.emit('Runtime.bindingCalled', {
          name: binding,
          payload,
          executionContextId: id,
        } satisfies Protocol.Runtime.BindingCalledEvent);
      };
      // No declared parameter: its length is 0, like Chrome's.
      global[binding] = function () {
        report(arguments[0], arguments.length);
      };
    }
  }

  /** Every world of the frames' documents. */
  all(): World[] {
    return Array.from(this.#frames).flatMap(frame => this.of(frame));
  }
}
