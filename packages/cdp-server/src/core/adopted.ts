/**
 * Notices changes to `adoptedStyleSheets` soon after they happen. Assigning goes through the
 * setter; changing the array in place (`push`, `splice`) needs the array, read through the
 * getter first. Both are hooked on the prototypes of Document and ShadowRoot while someone
 * watches. In a microtask, once per turn, the trees touched are compared with their sheets as
 * last seen: listeners are only called when one changed, so merely reading costs a comparison.
 * A change made through an array read long before is only seen at the next read or assignment
 * by anyone (including the page's own code).
 */
type Listener = () => void;
type Tree = Document | ShadowRoot;
type Accessors = {
  descriptor: PropertyDescriptor;
  get: (this: Tree) => unknown;
  set: (this: Tree, v: unknown) => void;
};

const listeners = new Set<Listener>();
const natives = new Map<object, Accessors>();
let pending = false;
let quiet = 0;
let touched = new Set<Tree>();
/** Each tree's sheets as last seen. */
let seen = new WeakMap<Tree, CSSStyleSheet[]>();

const protoOf = (tree: Tree) => (tree instanceof ShadowRoot ? ShadowRoot.prototype : Document.prototype);

function read(tree: Tree): CSSStyleSheet[] {
  const get = natives.get(protoOf(tree))?.get;
  const value: unknown = get ? get.call(tree) : tree.adoptedStyleSheets;
  return Array.isArray(value) ? value.filter((s): s is CSSStyleSheet => s instanceof CSSStyleSheet) : [];
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

function install() {
  for (const proto of [Document.prototype, ShadowRoot.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    const get = descriptor?.get;
    const set = descriptor?.set;
    if (!descriptor || !get || !set) continue;
    natives.set(proto, { descriptor, get, set });
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get(this: Tree): unknown {
        notify(this);
        return get.call(this);
      },
      set(this: Tree, value: unknown) {
        set.call(this, value);
        notify(this);
      },
    });
  }
}

function uninstall() {
  for (const [proto, { descriptor }] of natives) Object.defineProperty(proto, 'adoptedStyleSheets', descriptor);
  natives.clear();
  touched = new Set();
  seen = new WeakMap();
}

/**
 * Calls `listener` after adopted style sheets changed; returns a function to stop. `trees`
 * gives the trees to take as seen now, so that the first read does not count as a change.
 */
export function watchAdopted(listener: Listener, trees: () => Tree[]): () => void {
  if (!listeners.size) install();
  listeners.add(listener);
  for (const tree of trees()) changed(tree);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) uninstall();
  };
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

/** The adopted style sheets of a tree, read without notifying. */
export const adoptedOf = read;
