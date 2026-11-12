/**
 * The page's own functions that the agent calls past the page's wrappers. A page may replace a method
 * the agent calls (`getAttribute`, a CSSOM method) or a window function it calls (`requestAnimationFrame`)
 * with a wrapper of its own, which would then see the agent's calls and the values they carry: so the agent
 * calls the function the browser has instead. The probe takes them before the page's code runs
 * (probe/natives.ts), and `useNatives` gives them to the agent; the functions found when this module loads
 * stay in use where there is no probe (an older one, or a page that ran code before the agent loaded).
 * Here, so that the agent's core can call them as well as its domains.
 */
import { captureNatives, captureTop, type Native, type NativeTable, type Part } from '../probe/natives';
import type { Probe, TopNatives } from '../probe/types';

export type { Native };

/** The page's interfaces' functions in use: the probe's, else those found when this module loaded. */
let table: NativeTable = captureNatives();
/** The window's functions in use (`windowOf`): none outside a browser (a unit test of a module importing this one). */
let top: TopNatives | undefined = typeof MutationObserver === 'function' ? captureTop() : undefined;
/** The native function found for each prototype and `part:name` (null: none). */
let nativeCache = new WeakMap<object, Map<string, Native | null>>();

/** Takes the functions the probe saved before the page's code (`probe.natives`, `probe.top`), where it has them. */
export function useNatives(probe: Probe): void {
  if (probe.natives) {
    table = probe.natives;
    nativeCache = new WeakMap();
  }
  if (probe.top) top = probe.top;
}

/** The window's functions the agent calls: frames, timers, the clock, the observers and the listeners. */
export function windowOf(): TopNatives {
  if (!top) throw new TypeError('the window natives are not there: this is not a browser');
  return top;
}

/**
 * The native function `self`'s `part:name` is, up its prototypes: the top window's own, or, in another
 * realm, the top window's of the interface the prototype names (`Symbol.toStringTag`), if it has `name`
 * of its own. The page may rename a prototype: a function that then refuses `self` is given up (`viaNative`).
 */
function nativeOf(self: object, key: string): Native | null {
  const proto: unknown = Object.getPrototypeOf(self);
  if (typeof proto !== 'object' || proto === null) return null;
  let cached = nativeCache.get(proto);
  if (!cached) nativeCache.set(proto, (cached = new Map()));
  let fn = cached.get(key);
  if (fn !== undefined) return fn;
  fn = null;
  const [part, prop] = key.split(':') as [Part, string];
  for (let p: unknown = proto; !fn && typeof p === 'object' && p !== null; p = Object.getPrototypeOf(p)) {
    const found = table.byProto.get(p);
    if (found) {
      fn = found.get(key) ?? null;
      continue;
    }
    if (typeof Object.getOwnPropertyDescriptor(p, prop)?.[part] !== 'function') continue;
    const tag: unknown = Object.getOwnPropertyDescriptor(p, Symbol.toStringTag)?.value;
    fn = (typeof tag === 'string' && table.byName.get(tag)?.get(key)) || null;
  }
  cached.set(key, fn);
  return fn;
}

/**
 * Runs `native` with `self`'s native function for `key`, or `otherwise` when there is none, or when it
 * refuses `self` (a TypeError: an interface the page renamed).
 */
export function viaNative<T>(self: object, key: string, native: (fn: Native) => T, otherwise: () => T): T {
  const fn = nativeOf(self, key);
  if (fn)
    try {
      return native(fn);
    } catch (e) {
      if (!(e instanceof TypeError) && (e as { name?: unknown } | null)?.name !== 'TypeError') throw e;
      nativeCache.get(Object.getPrototypeOf(self) as object)?.set(key, null);
    }
  return otherwise();
}

/**
 * Calls `self`'s method `name` with `args`, the page's native one: past the page's wrappers. Where no
 * native function is known for it, the method the page has is called.
 */
export function nativeCall<T>(self: object, name: string, ...args: unknown[]): T {
  return viaNative(
    self,
    `value:${name}`,
    fn => Reflect.apply(fn, self, args) as T,
    () => Reflect.apply(Reflect.get(self, name) as Native, self, args) as T
  );
}

/** `self`'s `name` read through the page's native getter, like `nativeCall`. */
export function nativeGet<T>(self: object, name: string): T {
  return viaNative(
    self,
    `get:${name}`,
    fn => Reflect.apply(fn, self, []) as T,
    () => Reflect.get(self, name) as T
  );
}

/** `self`'s `name` assigned through the page's native setter, like `nativeCall`. */
export function nativeSet(self: object, name: string, value: unknown): void {
  viaNative(
    self,
    `set:${name}`,
    fn => void Reflect.apply(fn, self, [value]),
    () => void Reflect.set(self, name, value)
  );
}
