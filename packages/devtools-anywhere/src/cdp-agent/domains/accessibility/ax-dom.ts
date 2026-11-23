// The DOM as the accessibility tree reads it: attributes, queries and the flattened tree, read
// through the browser's own functions. Part of accessibility.js (ax-node.ts).
//
// The DOM is read through the browser's own functions (core/natives.ts), not those on the page's
// prototypes: a page that replaced `getAttribute` or `querySelectorAll` would otherwise see the
// tree being built, could change what it finds, or make it throw.
import { isDocument, isElement, isHtml, isShadowRoot, isText, styleOf } from '../../core/realm';
import { nativeCall, nativeGet } from '../../core/natives';
import { type IgnoredReason } from './tree/ax-ignored';

/** An element's attribute, or null (`getAttribute`). */
export const attr = (el: Element, name: string) => nativeCall<string | null>(el, 'getAttribute', name);

/** Whether an element has an attribute (`hasAttribute`). */
export const hasAttr = (el: Element, name: string) => nativeCall<boolean>(el, 'hasAttribute', name);

/** The names of an element's attributes (`getAttributeNames`). */
export const attrNames = (el: Element) => nativeCall<string[]>(el, 'getAttributeNames');

/** The first element under `scope` that matches `selector` (`querySelector`). */
export const query = (scope: ParentNode, selector: string) =>
  nativeCall<Element | null>(scope, 'querySelector', selector);

/** The elements under `scope` that match `selector` (`querySelectorAll`). */
export const queryAll = (scope: ParentNode, selector: string): Element[] => [
  ...nativeCall<NodeListOf<Element>>(scope, 'querySelectorAll', selector),
];

/** The closest inclusive ancestor of `el` that matches `selector` (`closest`). */
export const closest = (el: Element, selector: string) => nativeCall<Element | null>(el, 'closest', selector);

/** Whether `el` matches `selector` (`matches`). */
export const matches = (el: Element, selector: string) => nativeCall<boolean>(el, 'matches', selector);

/** The element of a document or shadow root with an id (`getElementById`). */
export const byId = (root: Document | DocumentFragment, id: string) =>
  nativeCall<HTMLElement | null>(root, 'getElementById', id);

/** A node's root (`getRootNode`). */
export const rootOf = (node: Node) => nativeCall<Node>(node, 'getRootNode');

/** An element's border box (`getBoundingClientRect`). */
export const rectOf = (el: Element) => nativeCall<DOMRect>(el, 'getBoundingClientRect');

/** A node's `textContent`. */
export const textOf = (node: Node) => nativeGet<string | null>(node, 'textContent');

/** An HTML element's `innerText`. */
export const innerTextOf = (el: HTMLElement) => nativeGet<string>(el, 'innerText');

/** The document or shadow root a node is in, where its ids resolve; null when detached. */
export function scopeOf(node: Node): Document | ShadowRoot | null {
  const root = rootOf(node);
  return isDocument(root) || isShadowRoot(root) ? root : null;
}

/** A select shown as a drop-down (Chrome's MenuListSelect), not as a list box. */
export const isMenuList = (el: Element | null): boolean => isHtml(el, 'select') && !el.multiple && el.size <= 1;

/** Whether an element has focus, in a document that has it. */
export const isFocused = (el: Element) => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus();

/** The words of a space-separated list. */
export const words = (list: string) => list.split(' ');

/** A space-separated list as a set. */
export const wordSet = (list: string) => new Set(words(list));

/** A table from groups of words, "value key key …": each key to its group's value. */
export function groupTable(groups: string[]): Record<string, string> {
  const table: Record<string, string> = {};
  for (const group of groups) {
    const [value = '', ...keys] = words(group);
    for (const key of keys) table[key] = value;
  }
  return table;
}

/**
 * The outermost closed details a node is in the content of (not in its summary): Chrome makes no
 * node for it, as the content is not slotted while closed. Its first summary child is shown.
 */
export function closedDetailsOf(node: Node): HTMLDetailsElement | null {
  let found: HTMLDetailsElement | null = null;
  for (let child = node, p = domParent(node); p; child = p, p = domParent(p))
    if (
      isHtml(p, 'details') &&
      !nativeGet<boolean>(p, 'open') &&
      child !== domChildren(p).find(c => isHtml(c, 'summary'))
    )
      found = p;
  return found;
}

/**
 * Why an element is not shown, if it is not: `display: none` on it or an ancestor (no box), or
 * `visibility: hidden` (a box, not painted).
 */
export function hiddenReason(el: Element): IgnoredReason | null {
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

/** Whether an element is inert: it or one of its ancestors in the tree has the inert attribute. */
export function inInert(el: Element): boolean {
  for (let n: Node | null = el; n && isElement(n); n = domParent(n)) if (hasAttr(n, 'inert')) return true;
  return false;
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
