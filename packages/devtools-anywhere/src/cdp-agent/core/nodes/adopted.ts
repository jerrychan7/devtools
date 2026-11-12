import { nativeGet, nativeSet } from '../natives';
import { isCssom, realmOf } from '../realm';

/**
 * Notices changes to `adoptedStyleSheets` soon after they happen. Assigning goes through the
 * setter; changing the array in place (`push`, `splice`) needs the array, read through the
 * getter first. Both are hooked on the prototypes of Document and ShadowRoot while someone
 * watches. In a microtask, once per turn, the trees touched are compared with their sheets as
 * last seen: listeners are only called when one changed, so merely reading costs a comparison.
 * A change made through an array read long before is only seen at the next read or assignment
 * by anyone (including the page's own code). Each realm has prototypes of its own: those of a
 * same-origin iframe are hooked once one of its trees is watched.
 */
type Listener = () => void;
type Tree = Document | ShadowRoot;
type Accessors = {
  descriptor: PropertyDescriptor;
  get: (this: Tree) => unknown;
  set: (this: Tree, v: unknown) => void;
  /** Our getter, to tell whether the property is still ours when stopping. */
  hook: (this: Tree) => unknown;
};

const listeners = new Set<Listener>();
const natives = new Map<object, Accessors>();
let pending = false;
let quiet = 0;
let touched = new Set<Tree>();
/** Each tree's sheets as last seen. */
let seen = new WeakMap<Tree, CSSStyleSheet[]>();

/**
 * The native accessors of `adoptedStyleSheets` are what the agent's own reads and writes call (core/natives.ts):
 * the probe's, taken before the page's code, so that a wrapper the page puts over them does not see the sheets
 * the agent hides.
 */
function read(tree: Tree): CSSStyleSheet[] {
  const value: unknown = nativeGet(tree, 'adoptedStyleSheets');
  return Array.isArray(value) ? value.filter((s): s is CSSStyleSheet => isCssom(s, 'CSSStyleSheet')) : [];
}

/** Whether a tree's sheets differ from those last seen; remembers them. */
function changed(tree: Tree): boolean {
  const now = read(tree);
  const before = seen.get(tree) ?? [];
  seen.set(tree, now);
  return now.length !== before.length || now.some((s, i) => s !== before[i]);
}

function notify(tree: Tree) {
  if (!listeners.size) return;
  // Our own changes (made quietly) are not the page's: just remember the result.
  if (quiet) return void changed(tree);
  touched.add(tree);
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    const trees = touched;
    touched = new Set();
    let any = false;
    for (const tree of trees) if (changed(tree)) any = true;
    if (any) for (const listener of listeners) listener();
  });
}

/** Hooks the prototypes of a realm (a window's globals). */
function install(realm: Window & typeof globalThis) {
  for (const proto of [realm.Document.prototype, realm.ShadowRoot.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    const get = descriptor?.get;
    const set = descriptor?.set;
    // Still hooked from before (the page wrapped our hook since): reuse it.
    if (!descriptor || !get || !set || natives.has(proto)) continue;
    const hook = function (this: Tree): unknown {
      notify(this);
      return get.call(this);
    };
    natives.set(proto, { descriptor, get, set, hook });
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get: hook,
      set(this: Tree, value: unknown) {
        set.call(this, value);
        notify(this);
      },
    });
  }
}

function uninstall() {
  // A hook the page wrapped since is kept (it does nothing without listeners), or the page's
  // wrapper would be lost.
  for (const [proto, { descriptor, hook }] of natives) {
    if (Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets')?.get !== hook) continue;
    Object.defineProperty(proto, 'adoptedStyleSheets', descriptor);
    natives.delete(proto);
  }
  touched = new Set();
  seen = new WeakMap();
}

/**
 * Calls `listener` after adopted style sheets changed; returns a function to stop. `trees`
 * gives the trees to take as seen now, so that the first read does not count as a change.
 */
export function watchAdopted(listener: Listener, trees: () => Tree[]): () => void {
  listeners.add(listener);
  watchTrees(trees());
  return () => {
    listeners.delete(listener);
    if (!listeners.size) uninstall();
  };
}

/**
 * Takes `trees` as seen now, and hooks their realms if not yet: e.g. the document of an iframe
 * that loaded after watching started. Does nothing while no one watches.
 */
export function watchTrees(trees: Tree[]): void {
  if (!listeners.size) return;
  for (const tree of trees) {
    install(realmOf(tree));
    changed(tree);
  }
}

/** Runs `fn` without taking its own reads and writes of adopted style sheets for the page's. */
export function quietly<T>(fn: () => T): T {
  quiet++;
  try {
    return fn();
  } finally {
    quiet--;
  }
}

/**
 * The native accessors of a tree's `adoptedStyleSheets` (core/natives.ts): what the agent's own reads and writes
 * call, so that a wrapper the page put over them since does not see our own changes.
 */
export function nativeAdopted(tree: Tree): { get: () => unknown; set: (value: unknown) => void } {
  return {
    get: () => nativeGet(tree, 'adoptedStyleSheets'),
    set: value => nativeSet(tree, 'adoptedStyleSheets', value),
  };
}

/** The adopted style sheets of a tree, read without notifying. */
export const adoptedOf = read;

/** The number of trees each sheet devtools-anywhere adopts hidden is in (a sheet may be in several). */
const hiddenSheets = new WeakMap<CSSStyleSheet, number>();
/** Per tree, the sheets hidden in it (kept at its end, in this order), and the page's own property before. */
const hiddenIn = new WeakMap<Tree, { sheets: Set<CSSStyleSheet>; own: PropertyDescriptor | undefined }>();

/** Whether `sheet` is one devtools-anywhere adopted hidden from the page (`hideAdopted`), not the page's. */
export const isHiddenSheet = (sheet: CSSStyleSheet): boolean => (hiddenSheets.get(sheet) ?? 0) > 0;

/** Counts the trees `sheet` is hidden in by `by`: 1 when it is hidden in one more, -1 when in one fewer. */
function countHidden(sheet: CSSStyleSheet, by: number): void {
  const n = (hiddenSheets.get(sheet) ?? 0) + by;
  if (n > 0) hiddenSheets.set(sheet, n);
  else hiddenSheets.delete(sheet);
}

/**
 * Adopts `sheet` into `tree`, after the page's sheets, hidden from the page: the page's reads of
 * `adoptedStyleSheets` leave it out, and its assignments keep it at the end. Our own writes are not
 * the page's changes (`quietly`), but the page's assignments are still seen by `watchAdopted`.
 * Adopting a sheet again moves it to the end. Returns the function that takes it out of the tree.
 * Several sheets of ours may be hidden in a tree at once.
 *
 * The trade-off of hiding: what the page reads is a copy, so pushing onto or splicing that copy in
 * place has no effect, where the page would change its adopted sheets (a live view would show ours).
 * Changes made in place on the real array, before the hook or by code holding it, move the sheet
 * away from the end: adopting it again repairs that.
 */
export function hideAdopted(tree: Tree, sheet: CSSStyleSheet): () => void {
  // The native accessors (core/natives.ts): a wrapper the page put over the prototype's is not called with the
  // sheets hidden here. The page's own reads and assignments are still told to the watchers, as the
  // prototype's hook tells them.
  let hidden = hiddenIn.get(tree);
  if (!hidden) {
    const sheets = new Set<CSSStyleSheet>();
    hidden = { sheets, own: Object.getOwnPropertyDescriptor(tree, 'adoptedStyleSheets') };
    hiddenIn.set(tree, hidden);
    Object.defineProperty(tree, 'adoptedStyleSheets', {
      configurable: true,
      enumerable: true,
      get: (): CSSStyleSheet[] => {
        const value: unknown = nativeGet(tree, 'adoptedStyleSheets');
        notify(tree);
        return Array.isArray(value) ? value.filter(s => !sheets.has(s)) : [];
      },
      set: (value: CSSStyleSheet[]) => {
        const rest = Array.from(value).filter(s => !sheets.has(s));
        nativeSet(tree, 'adoptedStyleSheets', [...rest, ...sheets]);
        notify(tree);
      },
    });
  }
  const { sheets, own } = hidden;
  if (!sheets.has(sheet)) countHidden(sheet, 1);
  sheets.delete(sheet);
  sheets.add(sheet);
  // Our own reads and writes go around the page's hooks (nativeAdopted): a sheet the page assigned in
  // the same task is still the page's change, and is not taken as seen here.
  quietly(() => {
    const value: unknown = nativeGet(tree, 'adoptedStyleSheets');
    const current = Array.isArray(value) ? (value as CSSStyleSheet[]) : [];
    const wanted = [...current.filter(s => !sheets.has(s)), ...sheets];
    if (wanted.length !== current.length || wanted.some((s, i) => s !== current[i]))
      nativeSet(tree, 'adoptedStyleSheets', wanted);
  });
  return () => {
    if (!sheets.delete(sheet)) return;
    countHidden(sheet, -1);
    quietly(() => {
      const value: unknown = nativeGet(tree, 'adoptedStyleSheets');
      if (Array.isArray(value) && value.includes(sheet))
        nativeSet(
          tree,
          'adoptedStyleSheets',
          value.filter(s => s !== sheet)
        );
    });
    if (sheets.size) return;
    // None of ours is left in the tree: the page's own property is back.
    Reflect.deleteProperty(tree, 'adoptedStyleSheets');
    if (own) Object.defineProperty(tree, 'adoptedStyleSheets', own);
    hiddenIn.delete(tree);
  };
}
