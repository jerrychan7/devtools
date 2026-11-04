/**
 * Node checks that hold across realms. A node of a same-origin iframe is not an instance of the
 * top page's `Element`, `Document`, …, and its document is not the global `document`: the agent
 * checks node types and uses the node's own window instead (docs/roadmap.md, "iframes";
 * scripts/check-realms.ts keeps new code from doing otherwise).
 */

export function isDocument(node: Node): node is Document {
  return node.nodeType === Node.DOCUMENT_NODE;
}

export function isElement(node: Node | null | undefined): node is Element {
  return node?.nodeType === Node.ELEMENT_NODE;
}

export function isHtmlElement(node: Node | null | undefined): node is HTMLElement {
  return isElement(node) && node.namespaceURI === HTML_NS;
}

export function isText(node: Node | null | undefined): node is Text {
  return node?.nodeType === Node.TEXT_NODE;
}

export function isShadowRoot(node: Node | null | undefined): node is ShadowRoot {
  return node?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in node;
}

/** The document a node is in, or the node itself if it is one. */
export function documentOf(node: Node): Document {
  return isDocument(node) ? node : (node.ownerDocument ?? document);
}

/** The window of a node's document: its realm's globals (`getComputedStyle`, `Element`, …). */
export function realmOf(node: Node): Window & typeof globalThis {
  return documentOf(node).defaultView ?? window;
}

/** An element's computed style, from its own realm (the top page's `getComputedStyle` is not). */
export function styleOf(el: Element, pseudo?: string): CSSStyleDeclaration {
  return realmOf(el).getComputedStyle(el, pseudo);
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Whether `node` is the HTML element `<name>`, e.g. `isHtml(node, 'template')`. */
export function isHtml<K extends keyof HTMLElementTagNameMap>(
  node: Node | null | undefined,
  name: K
): node is HTMLElementTagNameMap[K] {
  return isElement(node) && node.namespaceURI === HTML_NS && node.localName === name;
}

const nodeTypeGetter = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType')?.get;

/**
 * Whether `value` is a DOM node of any realm. The top page's `Node.prototype.nodeType` getter
 * accepts nodes of every window (Web IDL checks the interface, not the realm).
 */
export function isNode(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null || !nodeTypeGetter) return false;
  try {
    nodeTypeGetter.call(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * An element that can hold a frame: `<iframe>`, `<frame>`, and, like Chrome, which gives the
 * document of an `<object>` or `<embed>` a frame too, those (not one showing an image or plugin).
 */
export type FrameOwner = HTMLIFrameElement | HTMLFrameElement | HTMLObjectElement | HTMLEmbedElement;

const FRAME_OWNERS = new Set(['iframe', 'frame', 'object', 'embed']);

export function isFrameOwner(node: Node | null | undefined): node is FrameOwner {
  return isHtmlElement(node) && FRAME_OWNERS.has(node.localName);
}

/** The attribute naming the document a frame owner loads: `data` for `<object>`, else `src`. */
export const sourceAttribute = (owner: FrameOwner) => (isHtml(owner, 'object') ? 'data' : 'src');

/**
 * The window of the frame an owner holds, if any. `<embed>` has no `contentWindow`: its window is
 * the one among its document's child windows whose `frameElement` it is.
 */
export function contentWindowOf(owner: FrameOwner): Window | null {
  if (!isHtml(owner, 'embed')) return owner.contentWindow;
  const parent = owner.ownerDocument.defaultView;
  for (let i = 0; parent && i < parent.length; i++) {
    try {
      if (parent[i]?.frameElement === owner) return parent[i] ?? null;
    } catch {
      // A cross-origin window: not this one's, which is out of reach anyway.
    }
  }
  return null;
}

/** The document in a frame owner, null for a cross-origin one (out of reach) or none. */
export function contentDocumentOf(owner: FrameOwner): Document | null {
  try {
    return isHtml(owner, 'embed') ? (contentWindowOf(owner)?.document ?? null) : owner.contentDocument;
  } catch {
    return null;
  }
}

export function isDocumentType(node: Node | null | undefined): node is DocumentType {
  return node?.nodeType === Node.DOCUMENT_TYPE_NODE;
}

export function isDocumentFragment(node: Node | null | undefined): node is DocumentFragment {
  return node?.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

export function isSvgElement(node: Node | null | undefined): node is SVGElement {
  return isElement(node) && node.namespaceURI === SVG_NS;
}

/** Whether `node` is the SVG element `<name>`, e.g. `isSvg(node, 'svg')`. */
export function isSvg<K extends keyof SVGElementTagNameMap>(
  node: Node | null | undefined,
  name: K
): node is SVGElementTagNameMap[K] {
  return isSvgElement(node) && node.localName === name;
}

export function isMathMlElement(node: Node | null | undefined): node is MathMLElement {
  return isElement(node) && node.namespaceURI === MATHML_NS;
}

/** CSSOM interfaces {@link isCssom} tells apart. */
type CssomName =
  | 'CSSStyleSheet'
  | 'CSSGroupingRule'
  | 'CSSStyleRule'
  | 'CSSNestedDeclarations'
  | 'CSSImportRule'
  | 'CSSMediaRule'
  | 'CSSSupportsRule'
  | 'CSSContainerRule'
  | 'CSSScopeRule'
  | 'CSSStartingStyleRule'
  | 'CSSLayerBlockRule'
  | 'CSSLayerStatementRule'
  | 'CSSKeyframesRule'
  | 'CSSStyleDeclaration';

/**
 * Whether `value` implements the CSSOM interface `name` (or one inheriting from it) in any realm:
 * the rules of an iframe's style sheets are not instances of the top page's `CSSStyleRule`, …
 * Each interface prototype carries its name as `Symbol.toStringTag`, so the prototype chain
 * names the interfaces an object implements.
 */
export function isCssom<K extends CssomName>(value: unknown, name: K): value is InstanceType<(typeof globalThis)[K]> {
  if (typeof value !== 'object' || value === null) return false;
  for (let proto: unknown = Object.getPrototypeOf(value); typeof proto === 'object' && proto !== null;) {
    if (Object.getOwnPropertyDescriptor(proto, Symbol.toStringTag)?.value === name) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
