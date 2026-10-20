import { FORCE_ATTRIBUTE, isOwn } from './nodes';

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

/**
 * Chrome's DOMEditor primitives, which DOMPatchSupport is made of: each does its change right away
 * and can be undone and redone.
 */
function removeChild(parent: Node, node: Node): Action {
  const anchor = node.nextSibling;
  const action = { undo: () => void parent.insertBefore(node, anchor), redo: () => void parent.removeChild(node) };
  action.redo();
  return action;
}

function insertBefore(parent: Node, node: Node, anchor: Node | null): Action {
  const removal = node.parentNode ? removeChild(node.parentNode, node) : null;
  parent.insertBefore(node, anchor);
  return {
    undo: () => {
      parent.removeChild(node);
      removal?.undo();
    },
    redo: () => {
      removal?.redo();
      parent.insertBefore(node, anchor);
    },
  };
}

function replaceChild(parent: Node, node: Node, old: Node): Action {
  const action = { undo: () => void parent.replaceChild(old, node), redo: () => void parent.replaceChild(node, old) };
  action.redo();
  return action;
}

function setAttribute(el: Element, name: string, value: string): Action {
  const old = el.getAttribute(name);
  const action = {
    undo: () => (old === null ? el.removeAttribute(name) : el.setAttribute(name, old)),
    redo: () => el.setAttribute(name, value),
  };
  action.redo();
  return action;
}

function removeAttribute(el: Element, name: string): Action {
  const old = el.getAttribute(name) ?? '';
  const action = { undo: () => el.setAttribute(name, old), redo: () => el.removeAttribute(name) };
  action.redo();
  return action;
}

function setNodeValue(node: Node, value: string | null): Action {
  const old = node.nodeValue;
  const action = {
    undo: () => void (node.nodeValue = old),
    redo: () => void (node.nodeValue = value),
  };
  action.redo();
  return action;
}

/** A node and a hash of its subtree, like DOMPatchSupport's Digest (whose hash is a SHA-1). */
interface Digest {
  node: Node;
  hash: string;
  attrsHash: string;
  children: Digest[];
}

/** A 53-bit string hash. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** devtools-anywhere's own attribute is neither compared nor patched. */
const patchedAttributes = (el: Element) => Array.from(el.attributes).filter(a => a.name !== FORCE_ATTRIBUTE);

type Unused = Map<string, Digest>;

/** The children of a node without devtools-anywhere's own (the overlay, …), which patching leaves alone. */
const childrenOf = (node: Node) => Array.from(node.childNodes).filter(n => !(n instanceof Element && isOwn(n)));
const childAt = (node: Node, index: number) => childrenOf(node)[index] ?? null;

function digestOf(node: Node, unused: Unused | null): Digest {
  const children: Digest[] = [];
  let attrsHash = '';
  let key = `${node.nodeType}\0${node.nodeName}\0${node.nodeValue ?? ''}`;
  if (node instanceof Element) {
    for (const child of childrenOf(node)) {
      const digest = digestOf(child, unused);
      key += '\0' + digest.hash;
      children.push(digest);
    }
    const attrs = patchedAttributes(node);
    if (attrs.length) {
      attrsHash = hash(attrs.map(a => `${a.name}\0${a.value}`).join('\0'));
      key += '\0' + attrsHash;
    }
  }
  const digest = { node, hash: hash(key), attrsHash, children };
  if (unused && !unused.has(digest.hash)) unused.set(digest.hash, digest);
  return digest;
}

type Match = { digest: Digest; index: number } | null;

/**
 * DOMPatchSupport, Chrome's DOM.setOuterHTML: rather than replacing the node, patches the old tree
 * into the new one, keeping the nodes that did not change, as a sequence of undoable edits.
 */
class Patcher {
  readonly edits: Action[] = [];
  private unused: Unused = new Map();

  patchNode(node: Node, markup: string) {
    const parent = node.parentNode;
    if (!parent) throw new Error('Node has no parent');
    const context = node.parentElement ?? (parent instanceof ShadowRoot ? document.body : document.documentElement);
    // Parsed in the context of the parent, without running scripts, like a fragment.
    const name = context.localName.includes('-') ? 'div' : context.localName;
    const parser = document.createElementNS(context.namespaceURI, name);
    parser.innerHTML = markup;
    const fragment = document.createDocumentFragment();
    while (parser.firstChild) fragment.appendChild(parser.firstChild);

    const siblings = childrenOf(parent);
    const oldList = siblings.map(child => digestOf(child, null));
    const lower = markup.toLowerCase();
    const index = siblings.findIndex(child => child === node);
    const newList = oldList.slice(0, index);
    for (let child = fragment.firstChild; child; child = child.nextSibling) {
      // The parser adds an empty <head> or <body> by itself.
      if (child instanceof HTMLHeadElement && !child.hasChildNodes() && !lower.includes('</head>')) continue;
      if (child instanceof HTMLBodyElement && !child.hasChildNodes() && !lower.includes('</body>')) continue;
      newList.push(digestOf(child, this.unused));
    }
    newList.push(...oldList.slice(index + 1));
    this.patchChildren(parent, oldList, newList);
  }

  /** PatchDocument: the document element patched into the one of the parsed markup. */
  patchDocument(markup: string): boolean {
    const parsed = new DOMParser().parseFromString(markup, 'text/html').documentElement;
    const root = document.documentElement;
    if (!parsed || !root) return false;
    const nd = digestOf(parsed, this.unused);
    this.patchNodeInPlace(digestOf(root, null), nd);
    return true;
  }

  private do(action: Action) {
    this.edits.push(action);
  }

  private diff(oldList: Digest[], newList: Digest[]): [Match[], Match[]] {
    const oldMap: Match[] = oldList.map(() => null);
    const newMap: Match[] = newList.map(() => null);
    const sameAt = (o: number, n: number) => oldList[o]?.hash === newList[n]?.hash;
    const set = (o: number, n: number) => {
      const od = oldList[o];
      const nd = newList[n];
      if (!od || !nd) return;
      oldMap[o] = { digest: od, index: n };
      newMap[n] = { digest: nd, index: o };
    };
    // Trims the common head and tail.
    let offset = 0;
    for (; offset < oldList.length && offset < newList.length && sameAt(offset, offset); offset++) set(offset, offset);
    let end = 0;
    for (
      ;
      end < oldList.length - offset &&
      end < newList.length - offset &&
      sameAt(oldList.length - end - 1, newList.length - end - 1);
      end++
    )
      set(oldList.length - end - 1, newList.length - end - 1);
    // Matches the nodes that occur once on each side.
    const table = (list: Digest[]) => {
      const t = new Map<string, number[]>();
      for (let i = offset; i < list.length - end; i++) {
        const h = list[i]?.hash ?? '';
        const indices = t.get(h);
        if (indices) indices.push(i);
        else t.set(h, [i]);
      }
      return t;
    };
    const newTable = table(newList);
    const oldTable = table(oldList);
    for (const [h, ns] of newTable) {
      const os = oldTable.get(h);
      const [n] = ns;
      const [o] = os ?? [];
      if (ns.length === 1 && os?.length === 1 && n !== undefined && o !== undefined) set(o, n);
    }
    // Extends the matches to equal neighbors, forwards then backwards.
    for (let i = 0; i < newMap.length - 1; i++) {
      const m = newMap[i];
      if (!m) continue;
      const j = m.index + 1;
      if (j < oldMap.length && !oldMap[j] && sameAt(j, i + 1)) set(j, i + 1);
    }
    for (let i = newMap.length - 1; i > 0; i--) {
      const m = newMap[i];
      if (!m) continue;
      const j = m.index - 1;
      if (j >= 0 && !oldMap[j] && sameAt(j, i - 1)) set(j, i - 1);
    }
    return [oldMap, newMap];
  }

  private patchChildren(parent: Node, oldList: Digest[], newList: Digest[]) {
    const [oldMap, newMap] = this.diff(oldList, newList);
    let oldHead: Digest | null = null;
    let oldBody: Digest | null = null;
    const merges = new Map<Digest, Digest>();
    const usedNew = new Set<number>();
    // 1. Removes all but the nodes that stay, and collects the ones to patch in place.
    for (let i = 0; i < oldList.length; i++) {
      const od = oldList[i];
      if (!od) continue;
      const m = oldMap[i];
      if (m) {
        if (!usedNew.has(m.index)) {
          usedNew.add(m.index);
          continue;
        }
        oldMap[i] = null;
      }
      // <head> and <body> cannot be removed.
      if (od.node instanceof HTMLHeadElement) {
        oldHead = od;
        continue;
      }
      if (od.node instanceof HTMLBodyElement) {
        oldBody = od;
        continue;
      }
      // A change between nodes that stay is a modification.
      const before = i === 0 || !!oldMap[i - 1];
      const after = i === oldMap.length - 1 || !!oldMap[i + 1];
      if (!this.unused.has(od.hash) && before && after) {
        const candidate = i ? (oldMap[i - 1]?.index ?? 0) + 1 : 0;
        const anchorAfter = i === oldMap.length - 1 ? candidate + 1 : (oldMap[i + 1]?.index ?? 0);
        const nd = newList[candidate];
        if (anchorAfter - candidate === 1 && nd) merges.set(nd, od);
        else this.removeAndMoveToNew(od);
      } else {
        this.removeAndMoveToNew(od);
      }
    }
    // Uses each node that stays once.
    const usedOld = new Set<number>();
    for (let i = 0; i < newList.length; i++) {
      const m = newMap[i];
      if (!m) continue;
      if (usedOld.has(m.index)) {
        newMap[i] = null;
        continue;
      }
      usedOld.add(m.index);
      this.markUsed(m.digest);
    }
    // <head> and <body> are patched with the new ones.
    for (const nd of newList) {
      if (oldHead && nd.node instanceof HTMLHeadElement) merges.set(nd, oldHead);
      if (oldBody && nd.node instanceof HTMLBodyElement) merges.set(nd, oldBody);
    }
    // 2. Patches the nodes that changed in place.
    for (const [nd, od] of merges) this.patchNodeInPlace(od, nd);
    // 3. Inserts the new nodes.
    for (let i = 0; i < newList.length; i++) {
      const nd = newList[i];
      if (!nd || newMap[i] || merges.has(nd)) continue;
      this.do(insertBefore(parent, nd.node, childAt(parent, i)));
      this.markUsed(nd);
    }
    // 4. Puts the nodes that stay into their places.
    for (let i = 0; i < oldMap.length; i++) {
      const m = oldMap[i];
      const od = oldList[i];
      if (!m || !od) continue;
      const anchor = childAt(parent, m.index);
      if (od.node === anchor || od.node instanceof HTMLBodyElement || od.node instanceof HTMLHeadElement) continue;
      this.do(insertBefore(parent, od.node, anchor));
    }
  }

  private patchNodeInPlace(od: Digest, nd: Digest) {
    if (od.hash === nd.hash) return;
    const old = od.node;
    const node = nd.node;
    if (old.nodeType !== node.nodeType || old.nodeName !== node.nodeName) {
      if (old.parentNode) this.do(replaceChild(old.parentNode, node, old));
      return;
    }
    if (old.nodeValue !== node.nodeValue) this.do(setNodeValue(old, node.nodeValue));
    if (!(old instanceof Element) || !(node instanceof Element)) return;
    if (od.attrsHash !== nd.attrsHash) {
      for (let attr = patchedAttributes(old)[0]; attr; attr = patchedAttributes(old)[0])
        this.do(removeAttribute(old, attr.name));
      for (const attr of patchedAttributes(node)) this.do(setAttribute(old, attr.name, attr.value));
    }
    this.patchChildren(old, od.children, nd.children);
    this.unused.delete(nd.hash);
  }

  /**
   * Removes an old node; if the new tree has an equal one (say, the markup wrapped it in a new
   * element), the old one takes its place there, so that it is kept.
   */
  private removeAndMoveToNew(od: Digest) {
    const old = od.node;
    if (old.parentNode) this.do(removeChild(old.parentNode, old));
    const nd = this.unused.get(od.hash);
    if (nd) {
      if (nd.node.parentNode) this.do(replaceChild(nd.node.parentNode, old, nd.node));
      nd.node = old;
      this.markUsed(nd);
      return;
    }
    for (const child of od.children) this.removeAndMoveToNew(child);
  }

  private markUsed(digest: Digest) {
    const queue = [digest];
    for (let d = queue.shift(); d; d = queue.shift()) {
      this.unused.delete(d.hash);
      queue.push(...d.children);
    }
  }
}

/** Does DOM.setOuterHTML on `node` like Chrome, and returns how to undo it. */
export function patchOuterHTML(node: Node, markup: string): Action {
  const patcher = new Patcher();
  if (node.parentNode instanceof Document) {
    if (!patcher.patchDocument(markup)) throw new Error('Could not parse the document');
  } else patcher.patchNode(node, markup);
  const edits = patcher.edits;
  return {
    undo: () => {
      for (let i = edits.length - 1; i >= 0; i--) edits[i]?.undo();
    },
    redo: () => {
      for (const edit of edits) edit.redo();
    },
  };
}
