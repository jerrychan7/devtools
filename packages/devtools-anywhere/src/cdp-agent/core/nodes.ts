import type { Protocol } from 'devtools-protocol';
import type { FrameRegistry } from './frames';
import {
  isDocument,
  isDocumentFragment,
  isDocumentType,
  isElement,
  isFrameOwner,
  isHtml,
  isShadowRoot,
  realmOf,
} from './realm';

type DomNode = Protocol.DOM.Node;

/**
 * Marks devtools-anywhere's own elements for CSS isolation only. Which nodes are ours is
 * decided by {@link markOwn}, since the page can set this attribute on its own elements.
 *
 * @internal
 */
export const OWN_ATTRIBUTE = 'data-devtools-anywhere';

/** Nodes devtools-anywhere created itself (the element, overlays, …); the page cannot add to it. */
const ownNodes = new WeakSet<Node>();

/** Registers a node as devtools-anywhere's own, hiding it and its subtree from the client. @internal */
export function markOwn(node: Node): void {
  ownNodes.add(node);
}

/** Whether `node` itself was registered with {@link markOwn}. */
export const isOwn = (node: Node) => ownNodes.has(node);

/** Whether `node` is one of ours or inside one, through shadow roots too. */
export function closestOwn(node: Node): boolean {
  for (let n: Node | null = node; n; n = isShadowRoot(n) ? n.host : n.parentNode) if (ownNodes.has(n)) return true;
  return false;
}
/** Pseudo-classes forced on an element (CSS.forcePseudoState); hidden from the client. */
export const FORCE_ATTRIBUTE = 'data-devtools-anywhere-force';

/** An element's attributes as sent to the client, without devtools-anywhere's own. */
export const visibleAttributes = (el: Element) =>
  Array.from(el.attributes)
    .filter(a => a.name !== FORCE_ATTRIBUTE)
    .flatMap(a => [a.name, a.value]);

/** Text children up to this length are sent along with their element, like Chrome does. */
const MAX_INLINE_TEXT = 500;
/** Longer node values are cut, like Chrome does. */
const MAX_NODE_VALUE = 10000;

export const truncateNodeValue = (value: string) =>
  value.length > MAX_NODE_VALUE ? value.slice(0, MAX_NODE_VALUE) + '…' : value;

export type PseudoType = 'marker' | 'before' | 'after';
/** Pseudo-elements shown in the DOM tree, in Chrome's order. */
export const PSEUDO_TYPES: PseudoType[] = ['marker', 'before', 'after'];

/** A generated pseudo-element of `host`. Not a DOM node, but the client treats it as one. */
export class PseudoElement {
  readonly host: Element;
  readonly pseudoType: PseudoType;

  constructor(host: Element, pseudoType: PseudoType) {
    this.host = host;
    this.pseudoType = pseudoType;
  }
}

/** Anything that has a node id: DOM nodes and pseudo-elements. */
export type Inspectable = Node | PseudoElement;

/** Whether `host` currently generates the pseudo-element. */
export function hasPseudoElement(host: Element, type: PseudoType): boolean {
  if (type === 'marker') return realmOf(host).getComputedStyle(host).display.includes('list-item');
  const content = realmOf(host).getComputedStyle(host, `::${type}`).content;
  return content !== 'none' && content !== 'normal' && content !== '';
}

/**
 * Maps page nodes to CDP node ids and serializes them.
 *
 * Node ids are only valid within one `DOM.getDocument` session, like in Chrome; backend node
 * ids are stable for the node's lifetime. The registry also remembers whose children the
 * client has received, which decides how DOM mutations are reported.
 */
export class NodeRegistry {
  private ids = new Map<Inspectable, number>();
  private nodes = new Map<number, Inspectable>();
  private seq = 0;
  private backendIds = new WeakMap<Inspectable, number>();
  private byBackendId = new Map<number, WeakRef<Inspectable>>();
  /** Drops the entries of collected nodes from `byBackendId`. */
  private collected = new FinalizationRegistry<number>(id => {
    if (!this.byBackendId.get(id)?.deref()) this.byBackendId.delete(id);
  });
  private pseudos = new WeakMap<Element, Map<PseudoType, PseudoElement>>();
  /** Pseudo-elements sent to the client, per host, to report later additions and removals. */
  pseudoSent = new Map<Element, Set<PseudoType>>();
  private backendSeq = 0;
  /** Nodes whose children the client has received. */
  childrenSent = new WeakSet<Node>();
  /** Nodes selected in the Elements panel, most recent first ($0, $1, …). */
  inspected: Node[] = [];
  /** The `<template>` of each template content fragment sent to the client. */
  private templateOf = new WeakMap<DocumentFragment, HTMLTemplateElement>();
  /** The document sent as each frame owner's `contentDocument`, to forget it with the owner. */
  private contentDocuments = new WeakMap<Element, Document>();
  /** Called for every iframe document sent to the client, e.g. to observe its mutations. */
  onContentDocument: ((doc: Document) => void) | null = null;
  /** Called for every shadow root sent to the client, e.g. to observe its mutations. */
  onShadowRoot: ((root: ShadowRoot) => void) | null = null;
  /**
   * Sends a node and its ancestors to the client while the DOM domain is enabled, returning its
   * node id (undefined while disabled). Set by the DOM domain.
   */
  pushToClient: ((node: Inspectable) => number | undefined) | null = null;

  /** Also finds closed shadow roots (recorded by the probe). */
  readonly shadowRootOf: (host: Element) => ShadowRoot | null;

  /** The page's frames, for the documents of iframes; without it, iframes are sent without. */
  readonly frames: FrameRegistry | null;

  constructor(
    shadowRootOf: (host: Element) => ShadowRoot | null = host => host.shadowRoot,
    frames: FrameRegistry | null = null
  ) {
    this.shadowRootOf = shadowRootOf;
    this.frames = frames;
  }

  /** Starts a new session: previously sent node ids become invalid. */
  reset() {
    this.ids.clear();
    this.nodes.clear();
    // Children sent in the old session must be sent again.
    this.childrenSent = new WeakSet();
    this.pseudoSent.clear();
  }

  idOf(node: Inspectable): number {
    let id = this.ids.get(node);
    if (!id) {
      id = ++this.seq;
      this.ids.set(node, id);
      this.nodes.set(id, node);
    }
    return id;
  }

  /** The node id if the client knows the node, else undefined. */
  knownId(node: Inspectable): number | undefined {
    return this.ids.get(node);
  }

  get(nodeId: number): Inspectable | undefined {
    return this.nodes.get(nodeId);
  }

  backendIdOf(node: Inspectable): number {
    let id = this.backendIds.get(node);
    if (!id) {
      id = ++this.backendSeq;
      this.backendIds.set(node, id);
      this.byBackendId.set(id, new WeakRef(node));
      this.collected.register(node, id);
    }
    return id;
  }

  getByBackendId(backendNodeId: number): Inspectable | undefined {
    return this.byBackendId.get(backendNodeId)?.deref();
  }

  /**
   * After the client was told `node` was removed: like Chrome, the node ids of the removed
   * subtree become invalid, and its children are sent again if it comes back. Only the
   * descendants the client received are visited.
   */
  forget(node: Node) {
    const visit = (n: Node) => {
      const id = this.ids.get(n);
      if (id === undefined) return;
      this.ids.delete(n);
      this.nodes.delete(id);
      if (isElement(n)) {
        for (const type of this.pseudoSent.get(n) ?? []) {
          const pseudo = this.pseudoOf(n, type);
          const pseudoId = this.ids.get(pseudo);
          this.ids.delete(pseudo);
          if (pseudoId !== undefined) this.nodes.delete(pseudoId);
        }
        this.pseudoSent.delete(n);
        const shadowRoot = this.shadowRootOf(n);
        if (shadowRoot) visit(shadowRoot);
        if (isHtml(n, 'template')) visit(n.content);
        const contentDocument = this.contentDocuments.get(n);
        if (contentDocument) visit(contentDocument);
      }
      if (!this.childrenSent.has(n)) return;
      this.childrenSent.delete(n);
      n.childNodes.forEach(visit);
    };
    visit(node);
  }

  /** The (cached) pseudo-element object of `host`. */
  pseudoOf(host: Element, type: PseudoType): PseudoElement {
    let byType = this.pseudos.get(host);
    if (!byType) this.pseudos.set(host, (byType = new Map()));
    let pseudo = byType.get(type);
    if (!pseudo) byType.set(type, (pseudo = new PseudoElement(host, type)));
    return pseudo;
  }

  /** Pseudo-elements `host` currently generates. */
  activePseudoTypes(host: Element): PseudoType[] {
    return PSEUDO_TYPES.filter(type => hasPseudoElement(host, type));
  }

  serializePseudo(pseudo: PseudoElement): DomNode {
    const name = `::${pseudo.pseudoType}`;
    return {
      nodeId: this.idOf(pseudo),
      backendNodeId: this.backendIdOf(pseudo),
      nodeType: Node.ELEMENT_NODE,
      nodeName: name,
      localName: name,
      nodeValue: '',
      childNodeCount: 0,
      attributes: [],
      pseudoType: pseudo.pseudoType,
    };
  }

  /** Whether a node is shown to the client at all. */
  isVisible(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) return !!node.nodeValue?.trim();
    if (isElement(node)) return !isOwn(node);
    return true;
  }

  /** Visible children (shadow roots are serialized separately, with their host). */
  children(node: Node): Node[] {
    return Array.from(node.childNodes).filter(child => this.isVisible(child));
  }

  /**
   * Serializes `node`, including children down to `depth` (-1: the whole subtree). Like
   * Chrome, shadow roots and iframe documents are listed but their children only follow with
   * `pierce`. A `frameless` iframe is sent without its frame, as Chrome first reports an
   * inserted one (see the DOM domain).
   */
  serialize(node: Node, depth = 0, pierce = false, frameless = false): DomNode {
    const children = this.children(node);
    const result: DomNode = {
      nodeId: this.idOf(node),
      backendNodeId: this.backendIdOf(node),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: isElement(node) ? node.localName : '',
      nodeValue:
        node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE
          ? truncateNodeValue(node.nodeValue ?? '')
          : '',
    };
    if (node.parentNode) result.parentId = this.idOf(node.parentNode);

    if (isElement(node)) {
      result.attributes = visibleAttributes(node);
      const shadowRoot = this.shadowRootOf(node);
      if (shadowRoot) result.shadowRoots = [this.serializeShadowRoot(shadowRoot, pierce ? depth : 0, pierce)];
      const pseudoTypes = this.activePseudoTypes(node);
      if (pseudoTypes.length) {
        result.pseudoElements = pseudoTypes.map(type => this.serializePseudo(this.pseudoOf(node, type)));
      }
      this.pseudoSent.set(node, new Set(pseudoTypes));
      const frame = this.frames?.ofDocument(node.ownerDocument);
      // Like Chrome, the document element of each frame names it.
      if (frame && node === node.ownerDocument.documentElement) result.frameId = frame.id;
      if (isFrameOwner(node)) {
        this.contentDocuments.delete(node);
        if (!frameless) this.serializeFrame(node, result, depth, pierce);
      }
      // Like Chrome, a template's content is listed (without children) apart from its children.
      if (isHtml(node, 'template')) {
        this.templateOf.set(node.content, node);
        result.templateContent = this.serialize(node.content, 0, pierce);
      }
    } else if (isDocument(node)) {
      result.documentURL = node.URL;
      result.baseURL = node.baseURI;
      result.xmlVersion = '';
      result.compatibilityMode = node.compatMode === 'BackCompat' ? 'QuirksMode' : 'NoQuirksMode';
    } else if (isDocumentType(node)) {
      result.publicId = node.publicId;
      result.systemId = node.systemId;
    }

    if (
      node.nodeType === Node.ELEMENT_NODE ||
      node.nodeType === Node.DOCUMENT_NODE ||
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ) {
      result.childNodeCount = children.length;
      const [only] = children;
      const inlineText =
        children.length === 1 &&
        only !== undefined &&
        only.nodeType === Node.TEXT_NODE &&
        (only.nodeValue?.length ?? 0) <= MAX_INLINE_TEXT;
      if (depth !== 0 || inlineText) {
        result.children = children.map(child => this.serialize(child, depth > 0 ? depth - 1 : depth, pierce));
        this.childrenSent.add(node);
      }
    }
    return result;
  }

  /** The document last sent as an iframe's `contentDocument`, if it was sent with one. */
  contentDocumentOf(owner: Element): Document | undefined {
    return this.contentDocuments.get(owner);
  }

  /**
   * Adds an iframe's frame id and document. Like Chrome, the document is not one of the
   * iframe's children (`childNodeCount` counts its fallback content) and has no parent id.
   */
  private serializeFrame(owner: Element, result: DomNode, depth: number, pierce: boolean) {
    const frame = this.frames?.ofOwner(owner);
    if (!frame) return;
    result.frameId = frame.id;
    result.contentDocument = this.serialize(frame.document, pierce ? depth : 0, pierce);
    this.contentDocuments.set(owner, frame.document);
    this.onContentDocument?.(frame.document);
  }

  /** The parent, or the host of a shadow root, template content or iframe document. */
  private hostOf(node: Node): Node | null {
    if (node.parentNode) return node.parentNode;
    if (isShadowRoot(node)) return node.host;
    // The document of an iframe is under the iframe, like in Chrome.
    if (isDocument(node)) return this.frames?.ofDocument(node)?.owner ?? null;
    return isDocumentFragment(node) ? (this.templateOf.get(node) ?? null) : null;
  }

  private serializeShadowRoot(root: ShadowRoot, depth: number, pierce: boolean): DomNode {
    const node = this.serialize(root, depth, pierce);
    node.shadowRootType = root.mode === 'open' ? 'open' : 'closed';
    this.onShadowRoot?.(root);
    return node;
  }

  /**
   * Makes sure the client knows `node`: sends the children of every ancestor it has not
   * received yet, from the top down, via `emitChildren`. Returns the node id.
   */
  push(node: Inspectable, emitChildren: (parent: Node) => void): number {
    // A pseudo-element is sent along with its host.
    if (node instanceof PseudoElement) {
      this.push(node.host, emitChildren);
      return this.idOf(node);
    }
    const path: Node[] = [];
    for (let n: Node | null = node; n; n = this.hostOf(n)) path.unshift(n);
    for (const ancestor of path.slice(0, -1)) {
      if (!this.childrenSent.has(ancestor)) emitChildren(ancestor);
    }
    return this.idOf(node);
  }
}
