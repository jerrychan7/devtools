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
  return isElement(node) && node.namespaceURI === 'http://www.w3.org/1999/xhtml';
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
