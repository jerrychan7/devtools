// aria-owns: which element owns which in a document or shadow root (ownerTable), cached for one
// pass over the tree (ownersOf). Part of accessibility.js (ax-node.ts).
import { isDocument, isElement, isHtml } from '../../core/realm';
import { HiddenKeeper } from './ax-hidden';
import { isTextFieldHost } from './ax-virtual';
import { attr, byId, domParent, queryAll } from './ax-dom';
import { meterOf } from './ax-generic';

/** Owner tables, kept for one synchronous pass over the tree like dataTables. */
let owners: WeakMap<Document | ShadowRoot, Map<Element, Element>> | null = null;

/** The ownerTable of a document or shadow root, built once in the current pass. */
export function ownersOf(scope: Document | ShadowRoot): Map<Element, Element> {
  if (!owners) {
    owners = new WeakMap();
    queueMicrotask(() => (owners = null));
  }
  let table = owners.get(scope);
  if (!table) owners.set(scope, (table = ownerTable(scope)));
  return table;
}

/**
 * The elements aria-owns moves in a document or shadow root, each to its owner, in the owners'
 * order. Like Chrome, first come first served: an element owned twice stays with its first owner,
 * and an aria-owns that would make a cycle (an element owning its ancestor in the tree, or one
 * that owns it already) is dropped.
 */
function ownerTable(scope: Document | ShadowRoot): Map<Element, Element> {
  const owner = new Map<Element, Element>();
  // As in Chrome, a hidden owner owns nothing but where inert alone hides it, and nothing owns an
  // element without a box (display: none) or aria-hidden itself; their DOM ancestors are read here.
  // Nor does anything own a meter's content, which has no place in the tree (see parent()), nor
  // does that content own anything; a meter itself does, after its bar (see children()). A text
  // field owns nothing, and a select or optgroup does not take its own options out of its popup or
  // slot; a details element does take its summary, which then follows its slots.
  const doc = isDocument(scope) ? scope : scope.ownerDocument;
  const hidden = new HiddenKeeper(doc);
  // An owner an earlier owner moved out of an aria-hidden subtree shows again, and owns.
  const owners = new HiddenKeeper(doc, el => owner.get(el));
  for (const el of queryAll(scope, '[aria-owns]')) {
    const mode = owners.hiding(el)?.mode;
    if ((mode && mode !== 'inert') || meterOf(el) || isTextFieldHost(el)) continue;
    const keepsOwn = isHtml(el, 'select') || isHtml(el, 'optgroup');
    for (const id of attr(el, 'aria-owns')?.trim().split(/\s+/) ?? []) {
      const target = byId(scope, id);
      if (
        !target ||
        owner.has(target) ||
        (keepsOwn && within(target, el)) ||
        meterOf(target) ||
        hidden.hiding(target)?.mode === 'none' ||
        attr(target, 'aria-hidden') === 'true'
      )
        continue;
      let n: Node | null = el;
      while (n && n !== target) n = (isElement(n) && owner.get(n)) || domParent(n);
      if (!n) owner.set(target, el);
    }
  }
  return owner;
}

/** Whether a node is an element's DOM descendant. */
function within(node: Node, el: Element): boolean {
  for (let n = domParent(node); n; n = domParent(n)) if (n === el) return true;
  return false;
}
