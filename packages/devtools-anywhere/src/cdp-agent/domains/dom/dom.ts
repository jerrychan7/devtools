import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import {
  FORCE_ATTRIBUTE,
  PseudoElement,
  closestOwn,
  isOwn,
  truncateNodeValue,
  visibleAttributes,
} from '../../core/nodes';
import {
  editAttributes,
  editNodeValue,
  editPosition,
  editReplace,
  historyOf,
  patchOuterHTML,
} from '../../core/history';
import {
  type FrameOwner,
  isDocument,
  isDocumentFragment,
  documentOf,
  isDocumentType,
  isElement,
  isFrameOwner,
  isHtmlElement,
  isMathMlElement,
  isNode,
  isSvg,
  isSvgElement,
  isText,
  realmOf,
} from '../../core/realm';
import { CdpError } from '../../core/session';
import { type FrameChange, touchesFrames } from '../../core/frames';
import {
  type Box,
  type Quad,
  hasTransformedAncestor,
  frameToTop,
  isInlineBox,
  lineContentBoxes,
  localToViewport,
  mapPoints,
  mapQuad,
  scrollIntoViewIfNeeded,
  svgLayout,
  svgRootLayout,
  unmapRects,
  untransformedBoxes,
} from '../../core/geometry';

type NodeRef = { nodeId?: number; backendNodeId?: number; objectId?: string };

/** Finds the node a command refers to by node id, backend node id or object id. */
export function resolveNode({ nodes, objects }: Context, ref: NodeRef): Node {
  let node: unknown;
  if (ref.nodeId) node = nodes.get(ref.nodeId);
  else if (ref.backendNodeId) node = nodes.getByBackendId(ref.backendNodeId);
  else if (ref.objectId) node = objects.get(ref.objectId);
  if (node instanceof PseudoElement) throw new CdpError('Not supported for pseudo-elements');
  if (!isNode(node)) throw new CdpError('Could not find node with given id');
  return node;
}

/** The element a command refers to. */
export function resolveElement(ctx: Context, ref: NodeRef): Element {
  const node = resolveNode(ctx, ref);
  if (!isElement(node)) throw new CdpError('Node is not an Element');
  return node;
}

/** The node a command refers to, which must be able to have children (querySelector, …). */
function resolveContainer(ctx: Context, ref: NodeRef): ParentNode {
  const node = resolveNode(ctx, ref);
  if (!(isElement(node) || isDocument(node) || isDocumentFragment(node))) {
    throw new CdpError('Not a container node');
  }
  return node;
}

const quad = (r: { left: number; top: number; right: number; bottom: number }) => [
  r.left,
  r.top,
  r.right,
  r.top,
  r.right,
  r.bottom,
  r.left,
  r.bottom,
];

/**
 * Viewport mapping of an element's untransformed border box, when it or an ancestor is transformed;
 * null for plain layouts, where the bounding rectangle is exact.
 */
function transformedLayout(el: Element, rect: DOMRect): { m: DOMMatrix; width: number; height: number } | null {
  if (isSvg(el, 'svg') && hasTransformedAncestor(el)) return svgRootLayout(el);
  if (!isHtmlElement(el) || !hasTransformedAncestor(el)) return null;
  const m = localToViewport(el);
  if (!m || (m.is2D && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1)) return null;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  // Trust the mapping only if it lands where the browser put the element.
  const xs: number[] = [];
  const ys: number[] = [];
  mapQuad(m, { left: 0, top: 0, right: width, bottom: height }).forEach((v, i) => (i % 2 ? ys : xs).push(v));
  // The line boxes of an inline element can fall short of its bounds, when transformed.
  const inline = realmOf(el).getComputedStyle(el).display === 'inline';
  const near = (a: number, b: number, inside: number) => (inline ? (b - a) * inside >= -1 : Math.abs(a - b) <= 1);
  const ok =
    near(Math.min(...xs), rect.left, 1) &&
    near(Math.max(...xs), rect.right, -1) &&
    near(Math.min(...ys), rect.top, 1) &&
    near(Math.max(...ys), rect.bottom, -1);
  return ok ? { m, width, height } : null;
}

/**
 * Content, padding, border and margin boxes of an element, in the top viewport: transformed quads
 * like Chrome's, with the untransformed layout size as width and height. Like Chrome, those of a
 * node in an iframe are placed where the iframe shows it.
 */
export function boxModel(el: Element): Protocol.DOM.BoxModel {
  const model = boxModelInFrame(el);
  const m = frameToTop(el.ownerDocument);
  if (!m) return model;
  const { content, padding, border, margin } = model;
  return {
    ...model,
    content: mapPoints(m, content),
    padding: mapPoints(m, padding),
    border: mapPoints(m, border),
    margin: mapPoints(m, margin),
  };
}

/** {@link boxModel} in the viewport of the element's own document. */
function boxModelInFrame(el: Element): Protocol.DOM.BoxModel {
  const svg = svgLayout(el);
  if (svg) {
    const { quad: q, width, height } = svg;
    return { content: q, padding: q, border: q, margin: q, width, height };
  }
  const rect = el.getBoundingClientRect();
  const style = realmOf(el).getComputedStyle(el);
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const side = (prefix: string, suffix = '') => ({
    top: px(`${prefix}-top${suffix}`),
    right: px(`${prefix}-right${suffix}`),
    bottom: px(`${prefix}-bottom${suffix}`),
    left: px(`${prefix}-left${suffix}`),
  });
  const margin = side('margin');
  const border = side('border', '-width');
  const padding = side('padding');
  const layout = transformedLayout(el, rect);
  const borderBox = layout
    ? { left: 0, top: 0, right: layout.width, bottom: layout.height }
    : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  const paddingBox = {
    left: borderBox.left + border.left,
    top: borderBox.top + border.top,
    right: borderBox.right - border.right,
    bottom: borderBox.bottom - border.bottom,
  };
  const contentBox = {
    left: paddingBox.left + padding.left,
    top: paddingBox.top + padding.top,
    right: paddingBox.right - padding.right,
    bottom: paddingBox.bottom - padding.bottom,
  };
  const marginBox = {
    left: borderBox.left - margin.left,
    top: borderBox.top - margin.top,
    right: borderBox.right + margin.right,
    bottom: borderBox.bottom + margin.bottom,
  };
  const toQuad = layout ? (b: Box) => mapQuad(layout.m, b) : quad;
  return {
    content: toQuad(contentBox),
    padding: toQuad(paddingBox),
    border: toQuad(borderBox),
    margin: toQuad(marginBox),
    width: layout ? layout.width : Math.round(rect.width),
    height: layout ? layout.height : Math.round(rect.height),
  };
}

/**
 * Quads of a node for DOM.getContentQuads, in the top viewport (through the iframes holding it):
 * an element's border box or line boxes, transformed when it is, or a text node's line boxes.
 */
function contentQuads(node: Element | Text): Quad[] {
  let quads: Quad[];
  if (isText(node)) {
    const range = documentOf(node).createRange();
    range.selectNodeContents(node);
    quads = Array.from(range.getClientRects()).map(quad);
  } else quads = elementQuads(node);
  const m = frameToTop(documentOf(node));
  return m ? quads.map(q => mapPoints(m, q)) : quads;
}

/** Quads of an element in its document's viewport: its border box, or its line boxes; transformed when it is. */
function elementQuads(el: Element): Quad[] {
  const svg = svgLayout(el);
  if (svg) return [svg.quad];
  const rects = Array.from(el.getClientRects());
  const inline = isInlineBox(el);
  let boxes: Box[] = rects.map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
  let m: DOMMatrix | null = null;
  if (rects.length === 1 && rects[0] && !inline) {
    const layout = transformedLayout(el, rects[0]);
    if (layout) {
      m = layout.m;
      boxes = [{ left: 0, top: 0, right: layout.width, bottom: layout.height }];
    }
  } else if (rects.length) {
    const layout = transformedLayout(el, el.getBoundingClientRect());
    // When the bounds do not tell the line boxes apart, they are measured untransformed.
    const local = layout && (unmapRects(layout.m, rects) ?? (inline ? untransformedBoxes(el) : null));
    if (layout && local) {
      m = layout.m;
      boxes = local;
    }
  }
  if (inline) boxes = lineContentBoxes(el, boxes);
  return boxes.map(b => (m ? mapQuad(m, b) : quad(b)));
}

/**
 * Nodes matched by DOM.performSearch, in the order Chrome collects them: tag names, attributes
 * and text (case-insensitively) in tree order, a shadow tree right after its host (`shadowRootOf`
 * also finds closed ones), then XPath and selector matches. Like Chrome, each step goes through
 * the documents of all frames, the top one first.
 */
function searchNodes(
  documents: Document[],
  query: string,
  isVisible: (n: Node) => boolean,
  shadowRootOf: (host: Element) => ShadowRoot | null
): Node[] {
  const found = new Set<Node>();
  const needle = query.toLowerCase().replace(/^<|>$/g, '');
  const walk = (root: Document | ShadowRoot) => {
    const walker = (isDocument(root) ? root : root.ownerDocument).createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
      {
        acceptNode: n => (isVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      }
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (isElement(node)) {
        if (node.localName.includes(needle)) found.add(node);
        else if (Array.from(node.attributes).some(a => `${a.name}="${a.value}"`.toLowerCase().includes(needle)))
          found.add(node);
        const shadowRoot = shadowRootOf(node);
        if (shadowRoot) walk(shadowRoot);
      } else if (node.nodeValue?.toLowerCase().includes(needle)) {
        found.add(node);
      }
    }
  };
  documents.forEach(walk);
  for (const doc of documents) {
    try {
      const result = doc.evaluate(query, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node && isVisible(node)) found.add(node);
      }
    } catch {
      // Not an XPath expression.
    }
  }
  for (const doc of documents) {
    try {
      doc.querySelectorAll(query).forEach(el => isVisible(el) && found.add(el));
    } catch {
      // Not a selector.
    }
  }
  return Array.from(found);
}

/** Markup of `node` as DOM.getOuterHTML returns it: without forced pseudo-class markers. */
function outerHTML(node: Node): string {
  if (isElement(node)) {
    if (!node.matches(`[${FORCE_ATTRIBUTE}]`) && !node.querySelector(`[${FORCE_ATTRIBUTE}]`)) return node.outerHTML;
    // Leave out forced pseudo-class markers.
    const copy = node.cloneNode(true);
    if (!isElement(copy)) return node.outerHTML;
    for (const el of [copy, ...Array.from(copy.querySelectorAll(`[${FORCE_ATTRIBUTE}]`))])
      el.removeAttribute(FORCE_ATTRIBUTE);
    return copy.outerHTML;
  }
  // The whole document, doctype included, like Chrome.
  if (isDocument(node) || isDocumentFragment(node)) return Array.from(node.childNodes, outerHTML).join('');
  if (isDocumentType(node)) {
    const ids = node.publicId
      ? ` PUBLIC "${node.publicId}"${node.systemId ? ` "${node.systemId}"` : ''}`
      : node.systemId
        ? ` SYSTEM "${node.systemId}"`
        : '';
    return `<!DOCTYPE ${node.name}${ids}>`;
  }
  return new XMLSerializer().serializeToString(node);
}

/**
 * Whether an iframe still shows its initial empty document while it loads the one of its `src`
 * or `srcdoc`, which replaces it at its load.
 */
function loadsAnotherDocument(owner: FrameOwner, doc: Document): boolean {
  if (doc.URL !== 'about:blank') return false;
  if (owner.hasAttribute('srcdoc')) return true;
  const src = owner.getAttribute('src')?.trim();
  return !!src && new URL(src, owner.baseURI).href !== 'about:blank';
}

export function registerDom(ctx: Context) {
  const { session, nodes, objects } = ctx;
  let observer: MutationObserver | null = null;
  const searches = new Map<string, Node[]>();
  let searchSeq = 0;

  function emitChildren(parent: Node, depth = 1, pierce = false) {
    const children = nodes.children(parent).map(child => nodes.serialize(child, depth - 1, pierce));
    nodes.childrenSent.add(parent);
    session.emit('DOM.setChildNodes', {
      parentId: nodes.idOf(parent),
      nodes: children,
    } satisfies Protocol.DOM.SetChildNodesEvent);
  }

  /** The previous visible sibling the client already has: `pending` are not reported yet. */
  function previousVisibleSibling(node: Node, pending: Set<Node>): Node | null {
    for (let n = node.previousSibling; n; n = n.previousSibling) if (nodes.isVisible(n) && !pending.has(n)) return n;
    return null;
  }

  /** Reports pseudo-elements that appeared or disappeared on hosts within `roots`. */
  function refreshPseudoElements(roots?: Node[]) {
    for (const [host, sent] of nodes.pseudoSent) {
      if (!host.isConnected) {
        nodes.pseudoSent.delete(host);
        continue;
      }
      if (roots && !roots.some(root => root === host || root.contains(host))) continue;
      const hostId = nodes.knownId(host);
      if (hostId === undefined) continue;
      const current = new Set(nodes.activePseudoTypes(host));
      for (const type of current) {
        if (sent.has(type)) continue;
        session.emit('DOM.pseudoElementAdded', {
          parentId: hostId,
          pseudoElement: nodes.serializePseudo(nodes.pseudoOf(host, type)),
        } satisfies Protocol.DOM.PseudoElementAddedEvent);
      }
      for (const type of sent) {
        if (current.has(type)) continue;
        session.emit('DOM.pseudoElementRemoved', {
          parentId: hostId,
          pseudoElementId: nodes.idOf(nodes.pseudoOf(host, type)),
        } satisfies Protocol.DOM.PseudoElementRemovedEvent);
      }
      nodes.pseudoSent.set(host, current);
    }
  }
  ctx.refreshPseudoElements = refreshPseudoElements;

  /**
   * Sends an iframe the client knows again if its frame changed since it was sent: Chrome removes
   * and inserts it, with its new document (or none, once it is gone or out of reach). An initial
   * empty document about to be replaced by the iframe's `src` is not sent: the one loaded is.
   */
  function resendFrameOwner(owner: FrameOwner) {
    const doc = ctx.frames.ofOwner(owner)?.document;
    if (doc === nodes.contentDocumentOf(owner) || (doc && loadsAnotherDocument(owner, doc))) return;
    const parent = owner.parentNode;
    const ownerId = nodes.knownId(owner);
    const parentId = parent ? nodes.knownId(parent) : undefined;
    if (!parent || ownerId === undefined || parentId === undefined || !nodes.childrenSent.has(parent)) return;
    session.emit('DOM.childNodeRemoved', { parentNodeId: parentId, nodeId: ownerId });
    nodes.forget(owner);
    let previous = owner.previousSibling;
    while (previous && (!nodes.isVisible(previous) || nodes.knownId(previous) === undefined))
      previous = previous.previousSibling;
    session.emit('DOM.childNodeInserted', {
      parentNodeId: parentId,
      previousNodeId: previous ? nodes.idOf(previous) : 0,
      node: nodes.serialize(owner, 0),
    } satisfies Protocol.DOM.ChildNodeInsertedEvent);
  }

  /**
   * Iframes whose frame changed, sent again together in a microtask: after the mutations being
   * reported, and once for a frame replaced by another (an iframe loads synchronously when it
   * is inserted or moved, before its mutation is reported).
   */
  let changedFrames: Set<FrameOwner> | null = null;
  function onFrameChange({ frame }: FrameChange) {
    if (!observer || !frame.owner) return;
    if (!changedFrames) {
      const changed = (changedFrames = new Set());
      queueMicrotask(() => {
        changedFrames = null;
        // Pending mutations first, so that the client has the iframe's current place.
        flushMutations();
        changed.forEach(resendFrameOwner);
      });
    }
    changedFrames.add(frame.owner);
  }
  let stopFrames: (() => void) | null = null;

  /** Reports DOM changes for the parts of the tree the client has received. */
  function onMutations(records: MutationRecord[]) {
    // Iframes added or removed are registered now, so that they are sent with their frame.
    if (touchesFrames(records)) ctx.frames.sync();
    reportMutations(records);
    // Attribute and tree changes can make selectors such as `.x::before` start or stop matching.
    // devtools-anywhere's own elements (the highlight layer, …) change nothing on the page.
    const roots = records.filter(r => !isOwnChange(r)).map(r => r.target);
    if (roots.length) refreshPseudoElements(roots);
  }

  /** Whether a record only concerns devtools-anywhere's own elements. */
  function isOwnChange(record: MutationRecord): boolean {
    if (closestOwn(record.target)) return true;
    if (record.type !== 'childList') return false;
    const changed = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    return changed.length > 0 && changed.every(n => isElement(n) && isOwn(n));
  }

  function reportMutations(records: MutationRecord[]) {
    // The records describe the DOM step by step, but siblings are read from its final state:
    // nodes inserted by a later record must not serve as the position of an earlier one.
    const pending = new Set<Node>();
    for (const record of records) record.addedNodes.forEach(node => pending.add(node));
    // Like Chrome, each attribute change is reported with the value it set: the old value of the
    // next change to the attribute, or its current value.
    const valueAfter = new Map<MutationRecord, string | null>();
    const later = new Map<Node, Map<string, string | null>>();
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      const name = record?.attributeName;
      if (!record || record.type !== 'attributes' || !name || !isElement(record.target)) continue;
      const values = later.get(record.target) ?? new Map<string, string | null>();
      later.set(record.target, values);
      valueAfter.set(record, values.has(name) ? (values.get(name) ?? null) : record.target.getAttribute(name));
      values.set(name, record.oldValue);
    }
    for (const record of records) {
      const target = record.target;
      const targetId = nodes.knownId(target);
      if (record.type === 'childList') {
        if (targetId === undefined) {
          record.addedNodes.forEach(node => pending.delete(node));
          continue;
        }
        if (!nodes.childrenSent.has(target)) {
          record.addedNodes.forEach(node => pending.delete(node));
          session.emit('DOM.childNodeCountUpdated', {
            nodeId: targetId,
            childNodeCount: nodes.children(target).length,
          });
          continue;
        }
        record.removedNodes.forEach(node => {
          const nodeId = nodes.knownId(node);
          if (nodeId === undefined) return;
          session.emit('DOM.childNodeRemoved', { parentNodeId: targetId, nodeId });
          nodes.forget(node);
        });
        record.addedNodes.forEach((node, k) => {
          pending.delete(node);
          if (!nodes.isVisible(node) || node.parentNode !== target) return;
          // The sibling it was inserted after, as Chrome reports it right away, if the client has it.
          let previous = k ? (record.addedNodes[k - 1] ?? null) : record.previousSibling;
          if (previous && (!nodes.isVisible(previous) || nodes.knownId(previous) === undefined))
            previous = previousVisibleSibling(node, pending);
          // Like Chrome, an inserted iframe comes without its frame, which does not exist yet when
          // Chrome reports it; the iframe is sent again with its document once that is loaded.
          const owner = isFrameOwner(node) ? node : null;
          session.emit('DOM.childNodeInserted', {
            parentNodeId: targetId,
            previousNodeId: previous ? nodes.idOf(previous) : 0,
            node: nodes.serialize(node, 0, false, !!owner),
          } satisfies Protocol.DOM.ChildNodeInsertedEvent);
          if (owner) resendFrameOwner(owner);
        });
      } else if (record.type === 'attributes' && targetId !== undefined && isElement(target)) {
        const name = record.attributeName;
        if (name === null || name === FORCE_ATTRIBUTE) continue;
        const value = valueAfter.has(record) ? (valueAfter.get(record) ?? null) : target.getAttribute(name);
        if (value === null) session.emit('DOM.attributeRemoved', { nodeId: targetId, name });
        else session.emit('DOM.attributeModified', { nodeId: targetId, name, value });
      } else if (record.type === 'characterData' && targetId !== undefined) {
        session.emit('DOM.characterDataModified', {
          nodeId: targetId,
          characterData: truncateNodeValue(target.nodeValue ?? ''),
        });
      }
    }
  }

  /** Reports pending mutations now, so the client knows the nodes a command returns. */
  function flushMutations() {
    if (observer) onMutations(observer.takeRecords());
  }

  const OBSERVE: MutationObserverInit = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  };

  function observe() {
    observer?.disconnect();
    observer = new MutationObserver(onMutations);
    observer.observe(ctx.frames.top.document, OBSERVE);
    stopFrames ??= ctx.frames.onChange(onFrameChange);
  }
  // Like shadow roots, the document of each iframe sent is observed (by the same observer, which
  // keeps the order of changes across documents).
  nodes.onContentDocument = doc => observer?.observe(doc, OBSERVE);
  // Observing the document does not reach into shadow trees: observe each one sent.
  nodes.onShadowRoot = root => observer?.observe(root, OBSERVE);
  nodes.pushToClient = node => (observer ? nodes.push(node, parent => emitChildren(parent)) : undefined);

  // Shadow roots attached to hosts the client already knows are pushed to it. The prototype is
  // only patched while the client follows the tree (getDocument until disable).
  let nativeAttachShadow: typeof Element.prototype.attachShadow | null = null;
  function pushingAttachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
    const root = (nativeAttachShadow ?? attachShadowFallback).call(this, init);
    const hostId = observer ? nodes.knownId(this) : undefined;
    if (hostId !== undefined) {
      const serialized = nodes.serialize(root, 0);
      serialized.shadowRootType = root.mode === 'open' ? 'open' : 'closed';
      nodes.onShadowRoot?.(root);
      session.emit('DOM.shadowRootPushed', { hostId, root: serialized } satisfies Protocol.DOM.ShadowRootPushedEvent);
    }
    return root;
  }
  // Kept for a page that grabbed the wrapper before it was removed.
  const attachShadowFallback = Element.prototype.attachShadow;
  function patchAttachShadow() {
    if (nativeAttachShadow) return;
    nativeAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = pushingAttachShadow;
  }
  function unpatchAttachShadow() {
    if (!nativeAttachShadow) return;
    // A wrapper installed on top of ours stays, and ours with it: it no longer pushes once the
    // observer is gone.
    if (Element.prototype.attachShadow !== pushingAttachShadow) return;
    Element.prototype.attachShadow = nativeAttachShadow;
    nativeAttachShadow = null;
  }

  const element = (ref: NodeRef) => resolveElement(ctx, ref);
  const history = historyOf(ctx);

  session.register('DOM', {
    enable: () => {},
    disable() {
      observer?.disconnect();
      observer = null;
      stopFrames?.();
      stopFrames = null;
      unpatchAttachShadow();
      searches.clear();
      history.reset();
    },

    getDocument(params: Protocol.DOM.GetDocumentRequest): Protocol.DOM.GetDocumentResponse {
      nodes.reset();
      searches.clear();
      // Chrome's DiscardFrontendBindings: edits on the old node ids can no longer be undone.
      history.reset();
      observe();
      patchAttachShadow();
      ctx.frames.sync();
      return { root: nodes.serialize(ctx.frames.top.document, params.depth ?? 2, params.pierce) };
    },

    requestChildNodes(params: Protocol.DOM.RequestChildNodesRequest) {
      const depth = params.depth ?? 1;
      emitChildren(resolveNode(ctx, params), depth === -1 ? -1 : depth, params.pierce);
    },

    describeNode(params: Protocol.DOM.DescribeNodeRequest): Protocol.DOM.DescribeNodeResponse {
      const node = resolveNode(ctx, params);
      const described = nodes.serialize(node, params.depth ?? 0, params.pierce);
      // describeNode does not push the node: report a 0 node id unless the client knows it.
      return { node: { ...described, nodeId: nodes.knownId(node) ?? 0, frameId: ctx.frames.ofNode(node).id } };
    },

    resolveNode(params: Protocol.DOM.ResolveNodeRequest): Protocol.DOM.ResolveNodeResponse {
      return { object: objects.wrap(resolveNode(ctx, params), { group: params.objectGroup }) };
    },

    requestNode(params: Protocol.DOM.RequestNodeRequest): Protocol.DOM.RequestNodeResponse {
      return { nodeId: nodes.push(resolveNode(ctx, params), parent => emitChildren(parent)) };
    },

    pushNodesByBackendIdsToFrontend(params: Protocol.DOM.PushNodesByBackendIdsToFrontendRequest) {
      return {
        nodeIds: params.backendNodeIds.map(id => {
          const node = nodes.getByBackendId(id);
          return node ? nodes.push(node, parent => emitChildren(parent)) : 0;
        }),
      };
    },

    getAttributes: (params: Protocol.DOM.GetAttributesRequest): Protocol.DOM.GetAttributesResponse => ({
      attributes: visibleAttributes(element(params)),
    }),

    setAttributeValue(params: Protocol.DOM.SetAttributeValueRequest) {
      const el = element(params);
      history.record(editAttributes(el, () => el.setAttribute(params.name, params.value)));
    },

    setAttributesAsText(params: Protocol.DOM.SetAttributesAsTextRequest) {
      const el = element(params);
      const parsed = el.ownerDocument.createElement('template');
      // Parse in the element's namespace, where e.g. SVG's `viewBox` keeps its case.
      const context = isSvgElement(el) ? 'svg' : isMathMlElement(el) ? 'math' : null;
      parsed.innerHTML = context
        ? `<${context}><${context} ${params.text}></${context}></${context}>`
        : `<div ${params.text}></div>`;
      const outer = parsed.content.firstElementChild;
      const source = context ? outer?.firstElementChild : outer;
      const attrs = Array.from(source?.attributes ?? []);
      // Like Chrome, an attribute that is set again keeps its place and is only reported as modified.
      history.record(
        editAttributes(el, () => {
          if (params.name && !attrs.some(attr => attr.name === params.name)) el.removeAttribute(params.name);
          for (const attr of attrs) el.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
        })
      );
    },

    removeAttribute(params: Protocol.DOM.RemoveAttributeRequest) {
      const el = element(params);
      history.record(editAttributes(el, () => el.removeAttribute(params.name)));
    },

    setNodeValue(params: Protocol.DOM.SetNodeValueRequest) {
      const node = resolveNode(ctx, params);
      history.record(
        editNodeValue(node, () => {
          node.nodeValue = params.value;
        })
      );
    },

    getOuterHTML(params: Protocol.DOM.GetOuterHTMLRequest): Protocol.DOM.GetOuterHTMLResponse {
      return { outerHTML: outerHTML(resolveNode(ctx, params)) };
    },

    setOuterHTML(params: Protocol.DOM.SetOuterHTMLRequest) {
      const el = element(params);
      history.record(patchOuterHTML(el, params.outerHTML));
    },

    setNodeName(params: Protocol.DOM.SetNodeNameRequest): Protocol.DOM.SetNodeNameResponse {
      const el = element(params);
      const renamed = el.ownerDocument.createElement(params.name);
      for (const attr of Array.from(el.attributes))
        if (attr.name !== FORCE_ATTRIBUTE) renamed.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      history.record(
        editReplace(
          el,
          () => {
            while (el.firstChild) renamed.appendChild(el.firstChild);
            el.replaceWith(renamed);
          },
          true
        )
      );
      flushMutations();
      return { nodeId: nodes.idOf(renamed) };
    },

    removeNode(params: Protocol.DOM.RemoveNodeRequest) {
      const node = resolveNode(ctx, params);
      history.record(editPosition(node, () => node.parentNode?.removeChild(node)));
    },

    moveTo(params: Protocol.DOM.MoveToRequest): Protocol.DOM.MoveToResponse {
      const node = resolveNode(ctx, params);
      const target = resolveNode(ctx, { nodeId: params.targetNodeId });
      const before = params.insertBeforeNodeId ? resolveNode(ctx, { nodeId: params.insertBeforeNodeId }) : null;
      history.record(editPosition(node, () => target.insertBefore(node, before)));
      flushMutations();
      return { nodeId: nodes.idOf(node) };
    },

    copyTo(params: Protocol.DOM.CopyToRequest): Protocol.DOM.CopyToResponse {
      const copy = resolveNode(ctx, params).cloneNode(true);
      // The copy is not forced into any pseudo-class state.
      if (isElement(copy))
        for (const el of [copy, ...Array.from(copy.querySelectorAll(`[${FORCE_ATTRIBUTE}]`))])
          el.removeAttribute(FORCE_ATTRIBUTE);
      const target = resolveNode(ctx, { nodeId: params.targetNodeId });
      const before = params.insertBeforeNodeId ? resolveNode(ctx, { nodeId: params.insertBeforeNodeId }) : null;
      history.record(editPosition(copy, () => target.insertBefore(copy, before)));
      flushMutations();
      return { nodeId: nodes.idOf(copy) };
    },

    querySelector(params: Protocol.DOM.QuerySelectorRequest): Protocol.DOM.QuerySelectorResponse {
      const found = resolveContainer(ctx, params).querySelector(params.selector);
      return { nodeId: found ? nodes.push(found, parent => emitChildren(parent)) : 0 };
    },

    querySelectorAll(params: Protocol.DOM.QuerySelectorAllRequest): Protocol.DOM.QuerySelectorAllResponse {
      const found = Array.from(resolveContainer(ctx, params).querySelectorAll(params.selector));
      return { nodeIds: found.map(node => nodes.push(node, parent => emitChildren(parent))) };
    },

    performSearch(params: Protocol.DOM.PerformSearchRequest): Protocol.DOM.PerformSearchResponse {
      const searchId = String(++searchSeq);
      ctx.frames.sync();
      const results = searchNodes(
        Array.from(ctx.frames, frame => frame.document),
        params.query,
        n => nodes.isVisible(n),
        host => nodes.shadowRootOf(host)
      );
      searches.set(searchId, results);
      return { searchId, resultCount: results.length };
    },

    getSearchResults(params: Protocol.DOM.GetSearchResultsRequest): Protocol.DOM.GetSearchResultsResponse {
      const results = searches.get(params.searchId);
      if (!results) throw new CdpError('No search session with given id found');
      if (params.fromIndex < 0 || params.toIndex > results.length || params.fromIndex >= params.toIndex)
        throw new CdpError('Invalid search result range');
      return {
        nodeIds: results
          .slice(params.fromIndex, params.toIndex)
          .map(node => nodes.push(node, parent => emitChildren(parent))),
      };
    },

    discardSearchResults(params: Protocol.DOM.DiscardSearchResultsRequest) {
      searches.delete(params.searchId);
    },

    getBoxModel: (params: Protocol.DOM.GetBoxModelRequest): Protocol.DOM.GetBoxModelResponse => ({
      model: boxModel(element(params)),
    }),

    getContentQuads(params: Protocol.DOM.GetContentQuadsRequest): Protocol.DOM.GetContentQuadsResponse {
      const node = resolveNode(ctx, params);
      // Chrome also reports the line boxes of a text node.
      return { quads: contentQuads(isText(node) ? node : element(params)) };
    },

    getNodeForLocation(params: Protocol.DOM.GetNodeForLocationRequest): Protocol.DOM.GetNodeForLocationResponse {
      // The page's element under devtools-anywhere's own UI, which the page tree does not have.
      // Coordinates are the top page's (iframes are Overlay and geometry's to come).
      const el = ctx.frames.top.document.elementsFromPoint(params.x, params.y).find(e => !closestOwn(e));
      if (!el) throw new CdpError('No node found at given location');
      const nodeId = nodes.knownId(el);
      return {
        backendNodeId: nodes.backendIdOf(el),
        frameId: ctx.frames.ofNode(el).id,
        ...(nodeId !== undefined && { nodeId }),
      };
    },

    collectClassNamesFromSubtree(params: Protocol.DOM.CollectClassNamesFromSubtreeRequest) {
      const root = element(params);
      const names = new Set<string>();
      for (const el of [root, ...Array.from(root.querySelectorAll('[class]'))]) el.classList.forEach(c => names.add(c));
      return { classNames: Array.from(names) };
    },

    setInspectedNode(params: Protocol.DOM.SetInspectedNodeRequest) {
      const node = resolveNode(ctx, params);
      nodes.inspected = [node, ...nodes.inspected.filter(n => n !== node)].slice(0, 5);
    },

    focus(params: Protocol.DOM.FocusRequest) {
      (resolveNode(ctx, params) as HTMLElement).focus?.();
    },

    scrollIntoViewIfNeeded(params: Protocol.DOM.ScrollIntoViewIfNeededRequest) {
      scrollIntoViewIfNeeded(element(params));
    },

    /** Elements whose computed style matches any of the given ones (e.g. the Layout pane's grids). */
    getNodesForSubtreeByStyle(
      params: Protocol.DOM.GetNodesForSubtreeByStyleRequest
    ): Protocol.DOM.GetNodesForSubtreeByStyleResponse {
      const found: Element[] = [];
      const visit = (root: ParentNode) => {
        for (const el of root.querySelectorAll('*')) {
          if (!nodes.isVisible(el) || closestOwn(el)) continue;
          const style = realmOf(el).getComputedStyle(el);
          if (params.computedStyles.some(({ name, value }) => style.getPropertyValue(name) === value)) found.push(el);
          const shadowRoot = params.pierce && nodes.shadowRootOf(el);
          if (shadowRoot) visit(shadowRoot);
        }
      };
      visit(resolveContainer(ctx, params));
      return { nodeIds: found.map(el => nodes.push(el, parent => emitChildren(parent))) };
    },

    /**
     * Finds a node by the path the frontend keeps to select it again after a reload: pairs of
     * the index among the parent's children (`u`/`a` for a shadow root, `d` for an iframe's
     * document) and the node name.
     */
    pushNodeByPathToFrontend(
      params: Protocol.DOM.PushNodeByPathToFrontendRequest
    ): Protocol.DOM.PushNodeByPathToFrontendResponse {
      const parts = params.path.split(',');
      ctx.frames.sync();
      let node: Node = ctx.frames.top.document;
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const [key = '', name = ''] = [parts[i], parts[i + 1]];
        const next: Node | null | undefined =
          key === 'u' || key === 'a'
            ? isElement(node)
              ? nodes.shadowRootOf(node)
              : null
            : key === 'd'
              ? isFrameOwner(node)
                ? ctx.frames.ofOwner(node)?.document
                : null
              : nodes.children(node)[Number(key)];
        if (!next || next.nodeName !== name) throw new CdpError('No node with given path found');
        node = next;
      }
      return { nodeId: nodes.push(node, parent => emitChildren(parent)) };
    },

    getTopLayerElements: () => ({ nodeIds: [] }),
    markUndoableState: () => history.markUndoableState(),
    undo: () => history.undo(),
    redo: () => history.redo(),
    hideHighlight: () => session.call('Overlay.hideHighlight'),
    highlightNode: (params: Protocol.Overlay.HighlightNodeRequest) => session.call('Overlay.highlightNode', params),
  });
}
