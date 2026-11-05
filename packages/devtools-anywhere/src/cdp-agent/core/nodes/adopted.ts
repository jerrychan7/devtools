import { isCssom, isShadowRoot, realmOf } from '../realm';

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

const protoOf = (tree: Tree) => {
  const realm = realmOf(tree);
  return isShadowRoot(tree) ? realm.ShadowRoot.prototype : realm.Document.prototype;
};

function read(tree: Tree): CSSStyleSheet[] {
  const get = natives.get(protoOf(tree))?.get;
  const value: unknown = get ? get.call(tree) : tree.adoptedStyleSheets;
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
 * The native accessors of a tree's `adoptedStyleSheets`: those our hooks call, so that a wrapper
 * the page put over them since does not see our own changes; the prototype's while not hooked.
 */
export function nativeAdopted(
  tree: Tree
): { get: (this: Tree) => unknown; set: (this: Tree, v: unknown) => void } | null {
  const hooked = natives.get(protoOf(tree));
  if (hooked) return hooked;
  const d = Object.getOwnPropertyDescriptor(protoOf(tree), 'adoptedStyleSheets');
  return d?.get && d.set ? { get: d.get, set: d.set } : null;
}

/** The adopted style sheets of a tree, read without notifying. */
export const adoptedOf = read;
