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

/** An element that holds a frame: `<iframe>` or `<frame>`. */
export type FrameOwner = HTMLIFrameElement | HTMLFrameElement;

export function isFrameOwner(node: Node | null | undefined): node is FrameOwner {
  return isHtml(node, 'iframe') || (isHtmlElement(node) && node.localName === 'frame');
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
  | 'CSSLayerStatementRule';

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
