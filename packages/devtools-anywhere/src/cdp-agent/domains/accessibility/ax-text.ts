// The layout facts accessible names depend on, read from computed styles: whether a node has a
// box, which block it flows in, and a text node's text as rendered (Blink's LayoutText::PlainText).
// Part of accessibility.js (ax-name.ts).
import { isElement, isHtml, isText, styleOf } from '../../core/realm';
import { attr, domChildren, domParent } from './ax-tree';

/** Elements laid out as one box that text cannot flow into. */
const REPLACED = new Set(
  'img input select textarea button video audio canvas iframe object embed svg meter progress'.split(' ')
);

const SPACE_END = /[ \t\n\f\r]$/;
const isBlank = (text: string) => !/[^ \t\n\f\r]/.test(text);

/** Whether an element has no box: display: none on it or an ancestor, or not slotted into a shadow tree. */
export function inDisplayNone(el: Element): boolean {
  if (!el.isConnected) return true;
  for (let n: Node | null = el; n && isElement(n); n = domParent(n)) {
    if (styleOf(n).display === 'none') return true;
    const parent = n.parentNode;
    if (isElement(parent) && parent.shadowRoot && !n.assignedSlot) return true;
  }
  return false;
}

/** Whether an element's box flows in a line, as text does, rather than its content: inline, contents. */
const isInlineBox = (el: Element) => {
  const display = styleOf(el).display;
  return (display === 'inline' || display === 'contents' || display === 'ruby') && !REPLACED.has(el.localName);
};

/** Whether an element is laid out inline: in a line of its block (LayoutObject::IsInline). */
export function isInlineLevel(el: Element): boolean {
  const display = styleOf(el).display;
  return display.startsWith('inline') || display === 'ruby';
}

/** Whether an inline element is one box in its line (an inline-block, a form control, an image). */
export function isAtomicInline(el: Element): boolean {
  return (
    isInlineLevel(el) &&
    (REPLACED.has(el.localName) || !(styleOf(el).display === 'inline' || styleOf(el).display === 'ruby'))
  );
}

/** The block a node's line boxes belong to: the nearest ancestor (or `node` itself, if `self`) that is not inline. */
export function nearestBlock(node: Node, self: boolean): Element | null {
  for (let n: Node | null = self ? node : domParent(node); n; n = domParent(n))
    if (isElement(n) && !isInlineBox(n)) return n;
  return null;
}

const outOfFlow = (el: Element) => {
  const style = styleOf(el);
  return style.position === 'absolute' || style.position === 'fixed' || style.float !== 'none';
};

/** Whether a node has a box: an element not hidden by display, a text node that Blink lays out. */
export function hasLayout(node: Node): boolean {
  if (isElement(node)) return !inDisplayNone(node) && styleOf(node).display !== 'contents';
  if (!isText(node) || !node.data) return false;
  const parent = domParent(node);
  if (!isElement(parent) || inDisplayNone(parent)) return false;
  return !isBlank(node.data) || whitespaceHasBox(node, parent);
}

/** Whether a white space only text node gets a box (Text::TextLayoutObjectIsNeeded). */
function whitespaceHasBox(text: Text, parent: Element): boolean {
  const style = styleOf(parent);
  if (/flex|grid|table/.test(style.display) && !/table-cell|table-caption/.test(style.display)) return false;
  if (/preserve/.test(style.getPropertyValue('white-space-collapse'))) return true;
  const siblings = domChildren(parent);
  for (let i = siblings.indexOf(text) - 1; i >= 0; i--) {
    const prev = siblings[i];
    if (isText(prev)) {
      if (!hasLayout(prev)) continue;
      return !SPACE_END.test(prev.data);
    }
    if (!isElement(prev) || inDisplayNone(prev) || outOfFlow(prev)) continue;
    return isInlineLevel(prev) || styleOf(prev).display === 'contents' ? !isHtml(prev, 'br') : false;
  }
  return isInlineBox(parent);
}

/** What comes before or after a point in its line: nothing (the line starts or ends), a space, or content. */
type Neighbour = 'edge' | 'space' | 'content';

/** The first answer `inside` gives for an inline box's children, from its end (`back`) or its start. */
function firstInside<T>(el: Element, back: boolean, inside: (n: Node) => T | undefined): T | undefined {
  const children = domChildren(el);
  if (back) children.reverse();
  for (const child of children) {
    const found = inside(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Walks the line from a node, before it (`back`) or after it, out of the inline boxes it is in:
 * the first answer `inside` gives for a node met, or `edge` where the line starts or ends.
 */
function walkLine<T>(node: Node, back: boolean, inside: (n: Node) => T | undefined, edge: T): T {
  for (let current = node; ;) {
    const parent = domParent(current);
    if (!parent) return edge;
    const siblings = domChildren(parent);
    const index = siblings.indexOf(current as ChildNode);
    if (index < 0) return edge;
    for (let i = index + (back ? -1 : 1); i >= 0 && i < siblings.length; i += back ? -1 : 1) {
      const found = inside(siblings[i] as Node);
      if (found !== undefined) return found;
    }
    if (!isElement(parent) || !isInlineBox(parent)) return edge;
    current = parent;
  }
}

/** The neighbour a node gives, looking at it from after it (`back`) or before it; undefined if it gives none. */
function neighbourIn(node: Node, back: boolean): Neighbour | undefined {
  if (isText(node)) {
    if (!node.data) return undefined;
    if (isBlank(node.data)) return back ? 'space' : undefined;
    return back && SPACE_END.test(node.data) ? 'space' : 'content';
  }
  if (!isElement(node)) return undefined;
  if (styleOf(node).display === 'none' || outOfFlow(node)) return undefined;
  if (isHtml(node, 'br')) return 'edge';
  if (isInlineBox(node)) return firstInside(node, back, n => neighbourIn(n, back));
  return isInlineLevel(node) ? 'content' : 'edge';
}

/** What comes before (`back`) or after a node in its line. */
const neighbour = (node: Node, back: boolean): Neighbour => walkLine(node, back, n => neighbourIn(n, back), 'edge');

/** The node next to a node in its line, before it (`back`) or after it, white space left out; null at an edge. */
function lineNode(node: Node, back: boolean): Node | null {
  const inside = (n: Node): Node | null | undefined => {
    if (isText(n)) return isBlank(n.data) ? undefined : n;
    if (!isElement(n)) return undefined;
    if (styleOf(n).display === 'none' || outOfFlow(n)) return undefined;
    if (isHtml(n, 'br')) return null;
    if (attr(n, 'aria-hidden') === 'true') return n;
    if (isInlineBox(n)) return firstInside(n, back, inside);
    return isInlineLevel(n) ? n : null;
  };
  return walkLine<Node | null>(node, back, inside, null);
}

/**
 * Whether a white space only text node is left out of the tree: Chrome drops it next to a box
 * that is not an inline box (an inline-block, a field; an image is one), or after an aria-hidden element.
 */
export function droppedSpace(text: Text): boolean {
  return [true, false].some(back => {
    const n = lineNode(text, back);
    return isElement(n) && ((back && attr(n, 'aria-hidden') === 'true') || styleOf(n).display !== 'inline');
  });
}

/** Whether an element's start (`back`) or end is at the edge of its line: not inside a line of text. */
export function lineEdge(el: Element, back: boolean): boolean {
  return !isInlineBox(el) || neighbour(el, back) !== 'content';
}

/** Text as text-transform shows it. */
function transform(text: string, value: string): string {
  switch (value) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(
        /(^|[^\p{L}\p{N}'’])(\p{L})/gu,
        (_, before: string, letter: string) => before + letter.toUpperCase()
      );
  }
  return text;
}

/**
 * A laid out text node's text as rendered: white space collapsed as its style says, the space at
 * the start or the end of a line left out, text-transform applied.
 */
export function layoutText(text: Text): string {
  const parent = domParent(text);
  if (!isElement(parent)) return text.data;
  const style = styleOf(parent);
  const collapse = style.getPropertyValue('white-space-collapse');
  if (collapse === 'preserve' || collapse === 'break-spaces') return transform(text.data, style.textTransform);
  let value =
    collapse === 'preserve-breaks'
      ? text.data.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]+/g, ' ')
      : text.data.replace(/[ \t\n\f\r]+/g, ' ');
  value = transform(value, style.textTransform);
  if (value.startsWith(' ') && neighbour(text, true) !== 'content') value = value.slice(1);
  if (value.endsWith(' ') && neighbour(text, false) !== 'content') value = value.slice(0, -1);
  return value;
}
