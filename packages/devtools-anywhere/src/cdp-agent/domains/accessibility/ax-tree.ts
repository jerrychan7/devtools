// The shape of the accessibility tree: which DOM nodes are in it, with which role, and in which
// order. Part of accessibility.js, loaded on demand (ax-node.ts).
//
// Blink builds its tree from the layout tree (third_party/blink/renderer/modules/accessibility/),
// which a page cannot read: these rules redo the common cases from the DOM and computed styles,
// checked against Chrome's getFullAXTree (accessibility.conformance.test.ts). The role mapping
// starts from dom-accessibility-api's getRole (HTML-AAM) and adds Chrome's own choices.
import { getRole } from 'dom-accessibility-api';
import { isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';

/** Chrome's roles that are not ARIA roles, reported as `internalRole`. */
export const INTERNAL_ROLES = new Set([
  'RootWebArea',
  'StaticText',
  'LabelText',
  'DisclosureTriangle',
  'DescriptionList',
  'Legend',
  'Figcaption',
]);

/** Why a node in the tree is ignored (CDP `AXPropertyName`). */
export type IgnoredReason =
  | 'uninteresting'
  | 'ariaHiddenElement'
  | 'ariaHiddenSubtree'
  | 'notRendered'
  | 'notVisible'
  | 'presentationalRole'
  | 'emptyAlt';

/**
 * How a DOM node takes part in the tree: `included`, ignored but kept (`reason`), left out with its
 * children taking its place (`lifted`), or left out with its subtree (`excluded`).
 */
export type Inclusion =
  | { kind: 'included' }
  | { kind: 'ignored'; reason: IgnoredReason; hiddenRoot?: Element }
  | { kind: 'lifted'; reason: IgnoredReason }
  | { kind: 'excluded'; reason: IgnoredReason };

/** Elements whose text and children the page does not show as content: replaced by their value or a popup. */
const OPAQUE = new Set(
  'script style template noscript title head textarea select option input img br wbr iframe object embed video audio canvas svg'.split(
    ' '
  )
);

/** Sectioning elements, inside which `header` and `footer` are no landmarks. */
const SECTIONING = 'article, aside, main, nav, section';

/** The first token of `role` that is a role, or null. */
function explicitRole(el: Element): string | null {
  const value = el.getAttribute('role')?.trim();
  return value ? (value.split(/\s+/)[0] ?? null) : null;
}

/** Whether an element takes keyboard focus: in the tab order or focusable by script. */
export function isFocusable(el: Element): boolean {
  if (el.matches(':disabled')) return false;
  if (el.hasAttribute('tabindex')) return true;
  if (isHtml(el, 'a') || isHtml(el, 'area')) return el.hasAttribute('href');
  if (isHtml(el, 'input')) return el.type !== 'hidden';
  if (isHtmlElement(el) && el.isContentEditable) return true;
  return (
    isHtml(el, 'button') || isHtml(el, 'select') || isHtml(el, 'textarea') || isHtml(el, 'option') || isSummary(el)
  );
}

/** A details element's summary: Chrome's DisclosureTriangle. */
const isSummary = (el: Element) =>
  el.localName === 'summary' &&
  el.parentElement?.localName === 'details' &&
  el.parentElement.querySelector(':scope > summary') === el;

/** The role Chrome gives an element: an ARIA role, or one of INTERNAL_ROLES. */
export function roleOf(el: Element): string {
  const explicit = explicitRole(el);
  if (explicit === 'img') return 'image';
  if (explicit && explicit !== 'none' && explicit !== 'presentation') return explicit;
  switch (el.localName) {
    case 'dl':
      return 'DescriptionList';
    case 'legend':
      return 'Legend';
    case 'figcaption':
      return 'Figcaption';
    case 'blockquote':
      return 'blockquote';
    case 'caption':
      return 'caption';
    case 'th': {
      const scope = el.getAttribute('scope');
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      return el.parentElement?.querySelector(':scope > td') ? 'rowheader' : 'columnheader';
    }
    case 'input':
      // dom-accessibility-api has no role for a password field; Chrome makes it a text box.
      if (isHtml(el, 'input') && el.type === 'password') return 'textbox';
      break;
    case 'label':
      return 'LabelText';
    case 'summary':
      return isSummary(el) ? 'DisclosureTriangle' : 'generic';
    case 'details':
      return 'group';
    case 'section':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title')
        ? 'region'
        : 'generic';
    case 'header':
    case 'footer': {
      const inSection = el.parentElement?.closest(SECTIONING);
      if (inSection) return el.localName === 'header' ? 'sectionheader' : 'sectionfooter';
      return el.localName === 'header' ? 'banner' : 'contentinfo';
    }
    case 'p':
      return 'paragraph';
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'svg':
      return 'image';
    case 'select':
      if (isHtml(el, 'select')) return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
  }
  const role = getRole(el);
  if (role === 'img') return 'image';
  return role && role !== 'presentation' && role !== 'none' ? role : 'generic';
}

/**
 * Why an element is not shown, if it is not: `display: none` on it or an ancestor (no box), or
 * `visibility: hidden` (a box, not painted).
 */
function hiddenReason(el: Element): IgnoredReason | null {
  if (!el.isConnected) return 'notRendered';
  for (let n: Node | null = el; n && isElement(n); n = domParent(n))
    if (styleOf(n).display === 'none') return 'notRendered';
  const visibility = styleOf(el).visibility;
  return visibility === 'hidden' || visibility === 'collapse' ? 'notVisible' : null;
}

/** The children of a node as the tree sees them: shadow trees and slots flattened. */
export function domChildren(node: Node): Node[] {
  if (isElement(node)) {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (isHtml(node, 'slot')) {
      const assigned = node.assignedNodes();
      if (assigned.length) return assigned;
    }
  }
  return [...node.childNodes];
}

/** The parent of a node as the tree sees it: the slot it is assigned to, the host of a shadow root. */
export function domParent(node: Node): Node | null {
  if (isElement(node) || isText(node)) {
    const slot = node.assignedSlot;
    if (slot) return slot;
  }
  const parent = node.parentNode;
  return isShadowRoot(parent) ? parent.host : parent;
}

/** The element a text node's rendering depends on. */
const displayOf = (node: Node | null) => (node && isElement(node) ? styleOf(node).display : '');

/**
 * Whether a whitespace-only text node shows: Chrome keeps it as StaticText " " between two inline
 * boxes, as it shows as a space there.
 */
function isRenderedSpace(text: Text, inTree: (node: Node) => boolean): boolean {
  let prev = text.previousSibling;
  while (prev && isText(prev) && !prev.data.trim()) prev = prev.previousSibling;
  let next = text.nextSibling;
  while (next && isText(next) && !next.data.trim()) next = next.nextSibling;
  // Not next to an inline-block (a button, a field), nor to an element left out of the tree:
  // Chrome drops the space there.
  const inline = (node: Node | null) => !!node && (isText(node) || (displayOf(node) === 'inline' && inTree(node)));
  return inline(prev) && inline(next);
}

/** A text node's text as rendered: white space collapsed, and trimmed at the edges of its block. */
export function renderedText(text: Text): string {
  let value = text.data.replace(/[ \t\n\r\f]+/g, ' ');
  if (!value.trim()) return ' ';
  const inline = (node: Node | null) =>
    !!node && (isText(node) ? !!node.data.trim() : displayOf(node).startsWith('inline'));
  if (!inline(text.previousSibling)) value = value.replace(/^ /, '');
  if (!inline(text.nextSibling)) value = value.replace(/ $/, '');
  return value;
}

/** The tree's structure over one document, with aria-owns resolved. */
export class TreeShape {
  /** Elements moved by aria-owns, to their owner. */
  private owner = new Map<Element, Element>();
  private owned = new Map<Element, Element[]>();
  readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    for (const el of doc.querySelectorAll('[aria-owns]')) {
      const ids = el.getAttribute('aria-owns')?.trim().split(/\s+/) ?? [];
      const list: Element[] = [];
      for (const id of ids) {
        const target = doc.getElementById(id);
        // An element owned twice stays with its first owner; one cannot own its ancestor.
        if (!target || this.owner.has(target) || target.contains(el)) continue;
        this.owner.set(target, el);
        list.push(target);
      }
      if (list.length) this.owned.set(el, list);
    }
  }

  /** How a node takes part in the tree (Inclusion). */
  inclusion(node: Node): Inclusion {
    if (node === this.doc) return { kind: 'included' };
    if (isText(node)) {
      const parent = domParent(node);
      if (!parent || (isElement(parent) && (OPAQUE.has(parent.localName) || hiddenReason(parent))))
        return { kind: 'excluded', reason: 'notRendered' };
      if (!node.data.trim() && !isRenderedSpace(node, n => this.inTree(n)))
        return { kind: 'excluded', reason: 'uninteresting' };
      const hidden = this.hiddenRoot(node);
      return hidden ? { kind: 'ignored', reason: 'ariaHiddenSubtree', hiddenRoot: hidden } : { kind: 'included' };
    }
    if (!isElement(node)) return { kind: 'excluded', reason: 'uninteresting' };
    if (node.closest('[data-devtools-anywhere]')) return { kind: 'excluded', reason: 'notRendered' };
    const hiddenBy = hiddenReason(node);
    if (hiddenBy) return { kind: 'excluded', reason: hiddenBy };
    const hidden = this.hiddenRoot(node);
    // Chrome leaves the aria-hidden element out and keeps what it hides, ignored.
    if (hidden === node) return { kind: 'lifted', reason: 'ariaHiddenElement' };
    if (hidden) return { kind: 'ignored', reason: 'ariaHiddenSubtree', hiddenRoot: hidden };
    if (node === this.doc.documentElement || node === this.doc.body)
      return { kind: 'ignored', reason: 'uninteresting' };
    // An implicit or plain tbody; thead and tfoot are row groups.
    if (node.localName === 'tbody' && !node.hasAttribute('role')) return { kind: 'ignored', reason: 'uninteresting' };
    const explicit = explicitRole(node);
    if (node.localName === 'img' && node.getAttribute('alt') === '' && !explicit)
      return { kind: 'lifted', reason: 'emptyAlt' };
    if ((explicit === 'none' || explicit === 'presentation') && !isFocusable(node))
      return { kind: 'lifted', reason: 'presentationalRole' };
    return { kind: 'included' };
  }

  /** The element with aria-hidden="true" that hides a node, if any. */
  private hiddenRoot(node: Node): Element | null {
    for (let n: Node | null = node; n && n !== this.doc; n = domParent(n))
      if (isElement(n) && n.getAttribute('aria-hidden') === 'true') return n;
    return null;
  }

  /** Whether a node is in the tree (included or ignored). */
  inTree(node: Node): boolean {
    const kind = this.inclusion(node).kind;
    return kind === 'included' || kind === 'ignored';
  }

  /** The nodes in the tree under a node, in order: lifted nodes give their own. */
  children(node: Node): Node[] {
    const out: Node[] = [];
    const visit = (child: Node) => {
      if (isElement(child) && this.owner.has(child)) return;
      const inclusion = this.inclusion(child);
      if (inclusion.kind === 'excluded') return;
      if (inclusion.kind === 'lifted') {
        for (const c of this.ownChildren(child)) visit(c);
        return;
      }
      out.push(child);
    };
    for (const child of this.ownChildren(node)) visit(child);
    if (isElement(node))
      for (const el of this.owned.get(node) ?? []) if (this.inclusion(el).kind !== 'excluded') out.push(el);
    return out;
  }

  /** A node's DOM children, none for the elements whose content the tree replaces. */
  private ownChildren(node: Node): Node[] {
    if (isElement(node) && OPAQUE.has(node.localName)) return [];
    if (
      isElement(node) &&
      /^(checkbox|radio|slider|image|img|progressbar|separator|scrollbar|textbox)$/.test(roleOf(node)) &&
      node.localName !== 'div'
    )
      return [];
    return domChildren(node);
  }

  /** The closest node in the tree above a node: its aria-owns owner, or its DOM ancestor. */
  parent(node: Node): Node | null {
    if (node === this.doc) return null;
    let n: Node | null = isElement(node) ? (this.owner.get(node) ?? domParent(node)) : domParent(node);
    while (n && n !== this.doc && !this.inTree(n))
      n = isElement(n) ? (this.owner.get(n) ?? domParent(n)) : domParent(n);
    return n;
  }
}
