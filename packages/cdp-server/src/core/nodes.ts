import type { Protocol } from 'devtools-protocol'

type DomNode = Protocol.DOM.Node

/** Elements of devtools-anywhere itself (the element, overlays) are hidden from the page's DOM. */
export const OWN_ATTRIBUTE = 'data-devtools-anywhere'

/** Text children up to this length are sent along with their element, like Chrome does. */
const MAX_INLINE_TEXT = 500
/** Longer node values are cut, like Chrome does. */
const MAX_NODE_VALUE = 10000

export const truncateNodeValue = (value: string) =>
  value.length > MAX_NODE_VALUE ? value.slice(0, MAX_NODE_VALUE) + '…' : value

/**
 * Maps page nodes to CDP node ids and serializes them.
 *
 * Node ids are only valid within one `DOM.getDocument` session, like in Chrome; backend node
 * ids are stable for the node's lifetime. The registry also remembers whose children the
 * client has received, which decides how DOM mutations are reported.
 */
export class NodeRegistry {
  private ids = new Map<Node, number>()
  private nodes = new Map<number, Node>()
  private seq = 0
  private backendIds = new WeakMap<Node, number>()
  private byBackendId = new Map<number, WeakRef<Node>>()
  private backendSeq = 0
  /** Nodes whose children the client has received. */
  childrenSent = new WeakSet<Node>()
  /** Nodes selected in the Elements panel, most recent first ($0, $1, …). */
  inspected: Node[] = []

  /** Starts a new session: previously sent node ids become invalid. */
  reset() {
    this.ids.clear()
    this.nodes.clear()
    // Children sent in the old session must be sent again.
    this.childrenSent = new WeakSet()
  }

  idOf(node: Node): number {
    let id = this.ids.get(node)
    if (!id) {
      id = ++this.seq
      this.ids.set(node, id)
      this.nodes.set(id, node)
    }
    return id
  }

  /** The node id if the client knows the node, else undefined. */
  knownId(node: Node): number | undefined {
    return this.ids.get(node)
  }

  get(nodeId: number): Node | undefined {
    return this.nodes.get(nodeId)
  }

  backendIdOf(node: Node): number {
    let id = this.backendIds.get(node)
    if (!id) {
      id = ++this.backendSeq
      this.backendIds.set(node, id)
      this.byBackendId.set(id, new WeakRef(node))
    }
    return id
  }

  getByBackendId(backendNodeId: number): Node | undefined {
    return this.byBackendId.get(backendNodeId)?.deref()
  }

  /** Whether a node is shown to the client at all. */
  isVisible(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) return !!node.nodeValue?.trim()
    if (node instanceof Element) return !node.hasAttribute(OWN_ATTRIBUTE)
    return true
  }

  /** Visible children (shadow roots are serialized separately, with their host). */
  children(node: Node): Node[] {
    return Array.from(node.childNodes).filter(child => this.isVisible(child))
  }

  /** Serializes `node`, including children down to `depth` (-1: the whole subtree). */
  serialize(node: Node, depth = 0): DomNode {
    const children = this.children(node)
    const result: DomNode = {
      nodeId: this.idOf(node),
      backendNodeId: this.backendIdOf(node),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: node instanceof Element ? node.localName : '',
      nodeValue:
        node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE ? truncateNodeValue(node.nodeValue ?? '') : '',
    }
    if (node.parentNode) result.parentId = this.idOf(node.parentNode)

    if (node instanceof Element) {
      result.attributes = Array.from(node.attributes).flatMap(a => [a.name, a.value])
      if (node.shadowRoot) result.shadowRoots = [this.serializeShadowRoot(node.shadowRoot, depth)]
    } else if (node instanceof Document) {
      result.documentURL = node.URL
      result.baseURL = node.baseURI
      result.xmlVersion = ''
      result.compatibilityMode = node.compatMode === 'BackCompat' ? 'QuirksMode' : 'NoQuirksMode'
    } else if (node instanceof DocumentType) {
      result.publicId = node.publicId
      result.systemId = node.systemId
    }

    if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      result.childNodeCount = children.length
      const inlineText =
        children.length === 1 &&
        children[0].nodeType === Node.TEXT_NODE &&
        (children[0].nodeValue?.length ?? 0) <= MAX_INLINE_TEXT
      if (depth !== 0 || inlineText) {
        result.children = children.map(child => this.serialize(child, depth > 0 ? depth - 1 : depth))
        this.childrenSent.add(node)
      }
    }
    return result
  }

  private serializeShadowRoot(root: ShadowRoot, depth: number): DomNode {
    const node = this.serialize(root, depth)
    node.shadowRootType = root.mode === 'open' ? 'open' : 'closed'
    return node
  }

  /**
   * Makes sure the client knows `node`: sends the children of every ancestor it has not
   * received yet, from the top down, via `emitChildren`. Returns the node id.
   */
  push(node: Node, emitChildren: (parent: Node) => void): number {
    const path: Node[] = []
    for (let n: Node | null = node; n; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) path.unshift(n)
    for (const ancestor of path.slice(0, -1)) {
      if (!this.childrenSent.has(ancestor)) emitChildren(ancestor)
    }
    return this.idOf(node)
  }
}
