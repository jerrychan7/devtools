/**
 * The page's own functions that the agent calls past the page's wrappers. A page may replace a method
 * the agent calls (`getAttribute`, a CSSOM method) with a wrapper of its own, which would then see the
 * agent's calls and the values they carry: so the agent calls the function the browser has instead,
 * taken when the agent loads, before the page's code runs (the probe takes `setAttribute` earlier still).
 * Here, so that the agent's core can call them as well as its domains.
 */

/** A function of the page's interfaces, called with the object as `this`. */
export type Native = (...args: unknown[]) => unknown;

/** What of a property is taken: a method (`value`), or an accessor's getter (`get`) or setter (`set`). */
type Part = 'value' | 'get' | 'set';

/**
 * What the agent calls, as `part:name`, on the interfaces `INTERFACES` matches. The CSSOM's are the
 * CSS domain's changes and reads of style sheets (domains/css/sheets/watch/cssom-watch.ts). The
 * attributes are those of elements the emulation rewrites (domains/emulation/rewrite.ts) and that the
 * DOM history reads and writes (core/nodes/history.ts, written-attributes.ts).
 */
const OWN_KEYS = [
  'value:insertRule',
  'value:deleteRule',
  'value:replaceSync',
  'set:cssText',
  'set:selectorText',
  'set:keyText',
  'set:mediaText',
  'get:style',
  // Read by the CSS domain on sheets of its own (style.ts `styleTextFits`).
  'get:cssRules',
  'get:length',
  'value:item',
  'get:selectorText',
  'value:getPropertyValue',
  // Read by the emulation's merge of declaration blocks (domains/emulation/merge.ts).
  'value:getPropertyPriority',
  'value:getAttribute',
  'value:setAttribute',
  'value:removeAttribute',
  'value:setAttributeNS',
  'get:attributes',
];

/** The interfaces whose functions of `OWN_KEYS` are taken: the CSSOM's, and Element's. */
const INTERFACES = /^(CSS\w*|Element|MediaList)$/;

/**
 * The functions of `OWN_KEYS` on the top window's interface prototypes, by prototype and by interface
 * name: taken when the agent loads, before anything the page runs can replace them. They are the native
 * ones unless a page script that ran before the agent replaced them already; those are called then, as
 * they were before. Web IDL checks the interface, not the realm: the top page's take an iframe's objects too.
 */
const topNatives = new Map<object, Map<string, Native>>();
const ownNatives = new Map<string, Map<string, Native>>();
for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (!INTERFACES.test(name)) continue;
  const proto: unknown = (Reflect.get(globalThis, name) as { prototype?: unknown } | undefined)?.prototype;
  if (typeof proto !== 'object' || proto === null) continue;
  const found = new Map<string, Native>();
  for (const key of OWN_KEYS) {
    const [part, prop] = key.split(':') as [Part, string];
    const fn: unknown = Object.getOwnPropertyDescriptor(proto, prop)?.[part];
    if (typeof fn === 'function') found.set(key, fn as Native);
  }
  if (!found.size) continue;
  topNatives.set(proto, found);
  ownNatives.set(name, found);
}
/** The native function found for each prototype and `part:name` (null: none). */
const nativeCache = new WeakMap<object, Map<string, Native | null>>();

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
    const top = topNatives.get(p);
    if (top) {
      fn = top.get(key) ?? null;
      continue;
    }
    if (typeof Object.getOwnPropertyDescriptor(p, prop)?.[part] !== 'function') continue;
    const tag: unknown = Object.getOwnPropertyDescriptor(p, Symbol.toStringTag)?.value;
    fn = (typeof tag === 'string' && ownNatives.get(tag)?.get(key)) || null;
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
