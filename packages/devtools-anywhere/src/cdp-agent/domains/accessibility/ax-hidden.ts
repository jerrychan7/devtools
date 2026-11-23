// What Chrome keeps of a hidden subtree (display: none, visibility: hidden, aria-hidden, inert):
// most of it is left out of the tree, but some elements stay in it, ignored, with their own
// subtree: form fields, labels, the targets of aria-labelledby and aria-describedby, and under
// aria-hidden buttons and links too; and what display: none or aria-hidden hides in a label or such
// a target. The hidden elements around them give their place to them.
import { isElement, isHtml } from '../../core/realm';
import {
  attr,
  byId,
  hasAttr,
  domChildren,
  domParent,
  hiddenReason,
  queryAll,
  scopeOf,
  type IgnoredReason,
} from './ax-tree';

/** What hides a node, its first cause from the outermost: no box, not painted, inert or aria-hidden. */
type HiddenMode = 'none' | 'visibility' | 'inert' | 'aria';

/** Inputs that are text fields of some kind (with an inner editor or picker), not buttons or boxes. */
const FIELD_TYPES = new Set(
  'text password search number email tel url date datetime-local month week time color'.split(' ')
);

/** Input types kept under aria-hidden and inert: the input buttons. */
const BUTTON_TYPES = new Set('button submit reset image'.split(' '));

const isField = (el: Element) => isHtml(el, 'input') && FIELD_TYPES.has(el.type);

/** How a hidden node is hidden, with the reason it is ignored and its aria-hidden root, if any. */
export interface Hiding {
  mode: HiddenMode;
  reason: IgnoredReason;
  hiddenRoot?: Element;
}

/** What Chrome keeps of hidden subtrees over one document, worked out once per node. */
export class HiddenKeeper {
  private doc: Document;
  /** The targets of aria-labelledby and aria-describedby, by scope. */
  private referenced = new Map<Document | ShadowRoot, Set<Element>>();
  private keptCache = new WeakMap<Element, boolean>();
  private containsCache = new WeakMap<Element, boolean>();
  private hidingCache = new WeakMap<Node, Hiding | null>();

  constructor(doc: Document) {
    this.doc = doc;
  }

  /** How a node is hidden, or null when it shows. A text node is hidden as its parent. */
  hiding(node: Node): Hiding | null {
    let hiding = this.hidingCache.get(node);
    if (hiding !== undefined) return hiding;
    hiding = this.computeHiding(node);
    this.hidingCache.set(node, hiding);
    return hiding;
  }

  private computeHiding(node: Node): Hiding | null {
    const el = isElement(node) ? node : domParent(node);
    if (!el || !isElement(el)) return null;
    const box = hiddenReason(el);
    if (box === 'notRendered') return { mode: 'none', reason: 'notRendered' };
    let inert: Element | null = null;
    let aria: Element | null = null;
    for (let n: Node | null = el; n && n !== this.doc; n = domParent(n))
      if (isElement(n)) {
        if (!inert && hasAttr(n, 'inert')) inert = n;
        if (!aria && attr(n, 'aria-hidden') === 'true') aria = n;
      }
    // Chrome gives what inert hides inertElement, the inert element and its subtree alike.
    if (inert) return { mode: 'inert', reason: 'inertElement' };
    if (aria)
      return aria === node
        ? { mode: 'aria', reason: 'ariaHiddenElement' }
        : { mode: 'aria', reason: 'ariaHiddenSubtree', hiddenRoot: aria };
    if (box === 'notVisible') return { mode: 'visibility', reason: 'notVisible' };
    return null;
  }

  /** Whether a hidden element is one Chrome keeps, ignored, with its subtree. */
  private keeps(el: Element, mode: HiddenMode): boolean {
    if (mode !== 'inert' && this.isReferenced(el)) return true;
    if (isHtml(el, 'select') || isHtml(el, 'textarea') || isField(el)) return true;
    if (mode === 'visibility') return false;
    if (isHtml(el, 'label') || isHtml(el, 'meter')) return true;
    if (mode === 'none') return false;
    if (isHtml(el, 'input') && BUTTON_TYPES.has(el.type)) return true;
    if (mode === 'inert') return false;
    return (
      isHtml(el, 'button') ||
      (isHtml(el, 'a') && hasAttr(el, 'href')) ||
      (isHtml(el, 'input') && /^(checkbox|radio|file)$/.test(el.type))
    );
  }

  /** Whether a hidden node is kept: it, or a hidden ancestor of it, is one Chrome keeps. */
  isKept(node: Node): boolean {
    const el = isElement(node) ? node : domParent(node);
    if (!el || !isElement(el)) return false;
    let kept = this.keptCache.get(el);
    if (kept === undefined) {
      const hiding = this.hiding(el);
      const parent = domParent(el);
      kept =
        !!hiding &&
        (this.keeps(el, hiding.mode) ||
          (!!parent &&
            isElement(parent) &&
            (this.hiding(parent)
              ? this.isKept(parent)
              : (hiding.mode === 'none' || hiding.mode === 'aria') && this.inNameSource(parent))));
      this.keptCache.set(el, kept);
    }
    return kept;
  }

  /** Whether a hidden element holds a node that is kept or shows again (visibility: visible). */
  holdsKept(el: Element): boolean {
    let holds = this.containsCache.get(el);
    if (holds === undefined) {
      holds = domChildren(el).some(
        child => isElement(child) && (!this.hiding(child) || this.isKept(child) || this.holdsKept(child))
      );
      this.containsCache.set(el, holds);
    }
    return holds;
  }

  /** Whether a shown element is in a label or an aria-labelledby or aria-describedby target. */
  private inNameSource(el: Element): boolean {
    for (let n: Node | null = el; n && n !== this.doc; n = domParent(n))
      if (isElement(n) && (isHtml(n, 'label') || this.isReferenced(n))) return true;
    return false;
  }

  private isReferenced(el: Element): boolean {
    const scope = scopeOf(el);
    if (!scope) return false;
    let set = this.referenced.get(scope);
    if (!set) {
      set = new Set();
      for (const from of queryAll(scope, '[aria-labelledby], [aria-describedby]'))
        for (const name of ['aria-labelledby', 'aria-describedby'])
          for (const id of (attr(from, name) ?? '').split(/[ \t\n\r\f]+/)) {
            const target = id ? byId(scope, id) : null;
            if (target) set.add(target);
          }
      this.referenced.set(scope, set);
    }
    return set.has(el);
  }
}
