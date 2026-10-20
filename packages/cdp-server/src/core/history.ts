/** An edit that can be taken back and done again. */
export interface Action {
  undo(): void;
  redo(): void;
}

/** Separates undoable steps (DOM.markUndoableState). */
const MARK: Action = { undo: () => {}, redo: () => {} };

/**
 * The DOM editing history behind DOM.undo / DOM.redo, after Chrome's InspectorHistory: edits are
 * recorded as they are done, DOM.markUndoableState ends a step, and undo / redo replay a whole step.
 * A new edit drops what could be redone.
 */
export class History {
  private actions: Action[] = [];
  /** Number of actions currently done. */
  private index = 0;

  record(action: Action) {
    this.actions.length = this.index;
    this.actions.push(action);
    this.index++;
  }

  markUndoableState() {
    this.record(MARK);
  }

  undo() {
    while (this.index > 0 && this.actions[this.index - 1] === MARK) this.index--;
    while (this.index > 0) {
      const action = this.actions[this.index - 1];
      if (!action) break;
      this.replay(() => action.undo());
      this.index--;
      if (action === MARK) break;
    }
  }

  redo() {
    while (this.index < this.actions.length && this.actions[this.index] === MARK) this.index++;
    while (this.index < this.actions.length) {
      const action = this.actions[this.index];
      if (!action) break;
      this.replay(() => action.redo());
      this.index++;
      if (action === MARK) break;
    }
  }

  reset() {
    this.actions = [];
    this.index = 0;
  }

  /** Like Chrome, a step that cannot be replayed (the page changed the DOM since) clears the history. */
  private replay(fn: () => void) {
    try {
      fn();
    } catch (e) {
      this.reset();
      throw e;
    }
  }
}

/**
 * The history of a session: like Chrome's InspectorHistory, the DOM and CSS domains share it, so
 * DOM.undo also takes back style edits.
 */
const histories = new WeakMap<object, History>();
export function historyOf(owner: object): History {
  let history = histories.get(owner);
  if (!history) {
    history = new History();
    histories.set(owner, history);
  }
  return history;
}

type Attributes = Map<string, { namespace: string | null; value: string }>;

function snapshotAttributes(el: Element): Attributes {
  return new Map(Array.from(el.attributes, a => [a.name, { namespace: a.namespaceURI, value: a.value }]));
}

function applyAttributes(el: Element, from: Attributes, to: Attributes) {
  for (const name of from.keys()) if (!to.has(name)) el.removeAttribute(name);
  for (const [name, { namespace, value }] of to)
    if (from.get(name)?.value !== value) el.setAttributeNS(namespace, name, value);
}

/** Does `edit` to the attributes of `el` and returns how to undo it. */
export function editAttributes(el: Element, edit: () => void): Action {
  const before = snapshotAttributes(el);
  edit();
  const after = snapshotAttributes(el);
  // Only the attributes the edit changed.
  for (const name of new Set([...before.keys(), ...after.keys()]))
    if (before.get(name)?.value === after.get(name)?.value) {
      before.delete(name);
      after.delete(name);
    }
  return { undo: () => applyAttributes(el, after, before), redo: () => applyAttributes(el, before, after) };
}

/** Does `edit` to the value of `node` and returns how to undo it. */
export function editNodeValue(node: Node, edit: () => void): Action {
  const before = node.nodeValue;
  edit();
  const after = node.nodeValue;
  return {
    undo: () => {
      node.nodeValue = before;
    },
    redo: () => {
      node.nodeValue = after;
    },
  };
}

type Position = { parent: Node | null; next: Node | null };

const positionOf = (node: Node): Position => ({ parent: node.parentNode, next: node.nextSibling });

function place(node: Node, { parent, next }: Position) {
  if (parent) parent.insertBefore(node, next);
  else node.parentNode?.removeChild(node);
}

/** Does `edit`, which inserts, moves or removes `node`, and returns how to undo it. */
export function editPosition(node: Node, edit: () => void): Action {
  const before = positionOf(node);
  edit();
  const after = positionOf(node);
  return { undo: () => place(node, before), redo: () => place(node, after) };
}

/**
 * Does `edit`, which replaces `node` (and, if `movesChildren`, takes its children along), and
 * returns how to undo it. The replacements are what ends up between the old siblings.
 */
export function editReplace(node: Node, edit: () => void, movesChildren = false): Action {
  const parent = node.parentNode;
  const previous = node.previousSibling;
  const next = node.nextSibling;
  const children = movesChildren ? Array.from(node.childNodes) : [];
  edit();
  if (!parent) return { undo: () => {}, redo: () => {} };
  const replacements: Node[] = [];
  for (let n = previous ? previous.nextSibling : parent.firstChild; n && n !== next; n = n.nextSibling)
    replacements.push(n);
  return {
    undo: () => {
      parent.insertBefore(node, replacements[0] ?? next);
      for (const n of replacements) parent.removeChild(n);
      for (const child of children) node.appendChild(child);
    },
    redo: () => {
      const target = replacements.length === 1 ? replacements[0] : undefined;
      if (target) for (const child of children) target.appendChild(child);
      for (const n of replacements) parent.insertBefore(n, node);
      parent.removeChild(node);
    },
  };
}
