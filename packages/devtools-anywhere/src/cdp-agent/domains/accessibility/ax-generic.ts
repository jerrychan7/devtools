// Whether Chrome keeps a generic element (genericInclusion) and the layout and text helpers that
// decide it. Part of accessibility.js (ax-node.ts).
import { isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';
import { nativeGet } from '../../core/natives';
import { generatedContent } from './ax-generated';
import { attr, attrNames, domChildren, domParent, hasAttr, isMenuList, rootOf, wordSet } from './ax-dom';
import { ignored, INCLUDED, type Inclusion, lifted } from './ax-ignored';
import { implicitRole, isFocusable } from './ax-role';

/** The element a text node's rendering depends on. */
const displayOf = (node: Node | null) => (node && isElement(node) ? styleOf(node).display : '');

/** Whether Chrome keeps the body as a generic node rather than ignoring it. */
export function bodyKept(body: Element): boolean {
  return (
    attrNames(body).some(n => n.startsWith('aria-') || n === 'role' || n === 'id' || n === 'contenteditable') ||
    !!attr(body, 'title') ||
    ['onclick', 'onmousedown', 'onmouseup'].some(name => !!nativeGet<unknown>(body, name))
  );
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

/** The meter a node is in, at any depth, if any. */
export function meterOf(node: Node): Element | null {
  for (let p = domParent(node); p && isElement(p); p = domParent(p)) if (isHtml(p, 'meter')) return p;
  return null;
}

/** Whether a node is under a drop-down select, at any depth: in its popup, which is not laid out. */
export function inPopup(node: Node | null): boolean {
  for (let p = node && domParent(node); p && isElement(p); p = domParent(p)) if (isMenuList(p)) return true;
  return false;
}

/** The roles named from their content (ax-name.ts), whose display: contents descendants Chrome keeps. */
export const NAME_FROM_CONTENTS = wordSet(
  'button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox menuitemradio option radio ' +
    'rowheader switch tab tooltip treeitem DisclosureTriangle LayoutTableCell term'
);

/** Generic elements Chrome keeps whatever their box: the table parts, sections and the like. */
const KEPT_GENERIC = new Set('section summary aside header footer th td thead tbody tfoot tr area'.split(' '));

/** Whether an element is a plain generic container (div, span, b, a custom element…) without a role. */
export function isPlainGeneric(el: Element): boolean {
  return isHtmlElement(el) && !KEPT_GENERIC.has(el.localName) && implicitRole(el) === 'generic';
}

/**
 * What a block holds in its flow (Blink's ChildrenInline and FirstChild): nothing, only inline
 * content (it is laid out in lines), or a block. Floated and positioned children are out of the
 * flow but still content; display: contents children give their own.
 */
export function layoutContent(el: Element): 'none' | 'inline' | 'block' {
  return layoutOf(domChildren(el));
}

/** What a list of nodes laid out in one box holds in its flow, as layoutContent. */
export function layoutOf(nodes: Node[]): 'none' | 'inline' | 'block' {
  let some = false;
  const visit = (children: Node[]): boolean => {
    for (const child of children) {
      if (isText(child)) {
        if (child.data.trim()) some = true;
        continue;
      }
      if (!isElement(child)) continue;
      const style = styleOf(child);
      if (style.display === 'none') continue;
      if (style.display === 'contents') {
        if (!visit(domChildren(child))) return false;
        continue;
      }
      some = true;
      if (style.float !== 'none' || style.position === 'absolute' || style.position === 'fixed') continue;
      if (!style.display.startsWith('inline') && style.display !== 'ruby') return false;
    }
    return true;
  };
  return !visit(nodes) ? 'block' : some ? 'inline' : 'none';
}

/** Whether an element scrolls: its overflow lets it, and its content overflows it. */
function isScrollable(el: Element): boolean {
  const style = styleOf(el);
  const scrolls = (v: string) => v === 'auto' || v === 'scroll';
  return (
    (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight) ||
    (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth)
  );
}

/** Whether an id makes an element a possible link target: not in a shadow tree. */
const hasDocumentId = (el: Element) => !!el.id && !isShadowRoot(rootOf(el));

/**
 * Whether an element is of interest whatever its box: an ARIA attribute (any), a title, an id
 * outside a shadow tree, focus, a click handler or contenteditable.
 */
export function isInteresting(el: Element): boolean {
  return (
    attrNames(el).some(n => n.startsWith('aria-')) ||
    hasAttr(el, 'title') ||
    hasDocumentId(el) ||
    isFocusable(el) ||
    hasAttr(el, 'onclick') ||
    hasAttr(el, 'onmousedown') ||
    hasAttr(el, 'onmouseup') ||
    hasAttr(el, 'contenteditable')
  );
}

/**
 * How a plain generic container takes part, as in Chrome (AXNodeObject::ComputeIsIgnored): kept
 * when of interest (isInteresting), as an inline-block, and, but for a span, as an inline flex or
 * grid, when positioned or scrolling, or as a block laid out in lines. Otherwise it is ignored:
 * kept in the tree when it is a block (a box of its own), has lang or an id in a shadow tree, its
 * children in its place when inline or display: contents.
 */
export function genericInclusion(el: Element): Inclusion {
  // A body that gets here was kept by bodyKept, which also counts its click handler properties,
  // which isInteresting (attributes only) does not see.
  if (isInteresting(el) || el === el.ownerDocument.body) return INCLUDED;
  const style = styleOf(el);
  const display = style.display;
  if (display === 'inline-block' || display === 'inline flow-root') return INCLUDED;
  if (el.localName !== 'span') {
    if (display === 'inline-flex' || display === 'inline-grid') return INCLUDED;
    if (style.position !== 'static' || isScrollable(el)) return INCLUDED;
    if (/^(block|flow-root|list-item|table-cell|table-caption)$/.test(display) && layoutContent(el) === 'inline')
      return INCLUDED;
  }
  const inline = display === 'contents' || display.startsWith('inline');
  // An inline element with a ::before or ::after in the tree keeps an ignored node over it.
  const generated =
    display !== 'contents' && (generatedContent(el, '::before', false) || generatedContent(el, '::after', false));
  if (!inline || generated || hasAttr(el, 'lang') || (el.id && !hasDocumentId(el))) return ignored('uninteresting');
  // An element whose parent in the tree is not its DOM parent is kept: one assigned to a slot (a
  // details' children are, to its user-agent slots), and one at the top of a shadow tree, but for
  // a slot with neither assigned nodes nor fallback content.
  if (isHtml(el, 'slot') && !domChildren(el).length) return lifted('uninteresting');
  if (isHtml(el.parentNode, 'details') || el.assignedSlot || isShadowRoot(el.parentNode))
    return ignored('uninteresting');
  // An inline element but a span right in a label is kept too.
  if (display !== 'contents' && el.localName !== 'span' && isHtml(domParent(el), 'label'))
    return ignored('uninteresting');
  return lifted('uninteresting');
}
