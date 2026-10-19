import type { Protocol } from 'devtools-protocol'
import { FRAME_ID, type Context } from '../core/context'
import { FORCE_ATTRIBUTE, PseudoElement, truncateNodeValue, visibleAttributes } from '../core/nodes'
import { CdpError } from '../core/server'

type NodeRef = { nodeId?: number; backendNodeId?: number; objectId?: string }

/** Finds the node a command refers to by node id, backend node id or object id. */
export function resolveNode({ nodes, objects }: Context, ref: NodeRef): Node {
  let node: unknown
  if (ref.nodeId) node = nodes.get(ref.nodeId)
  else if (ref.backendNodeId) node = nodes.getByBackendId(ref.backendNodeId)
  else if (ref.objectId) node = objects.get(ref.objectId)
  if (node instanceof PseudoElement) throw new CdpError('Not supported for pseudo-elements')
  if (!(node instanceof Node)) throw new CdpError('Could not find node with given id')
  return node
}

const quad = (r: { left: number; top: number; right: number; bottom: number }) => [
  r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom,
]

/** Content, padding, border and margin boxes of an element, in viewport coordinates. */
export function boxModel(el: Element): Protocol.DOM.BoxModel {
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0
  const side = (prefix: string, suffix = '') => ({
    top: px(`${prefix}-top${suffix}`),
    right: px(`${prefix}-right${suffix}`),
    bottom: px(`${prefix}-bottom${suffix}`),
    left: px(`${prefix}-left${suffix}`),
  })
  const margin = side('margin')
  const border = side('border', '-width')
  const padding = side('padding')
  const borderBox = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  const paddingBox = {
    left: borderBox.left + border.left,
    top: borderBox.top + border.top,
    right: borderBox.right - border.right,
    bottom: borderBox.bottom - border.bottom,
  }
  const contentBox = {
    left: paddingBox.left + padding.left,
    top: paddingBox.top + padding.top,
    right: paddingBox.right - padding.right,
    bottom: paddingBox.bottom - padding.bottom,
  }
  const marginBox = {
    left: borderBox.left - margin.left,
    top: borderBox.top - margin.top,
    right: borderBox.right + margin.right,
    bottom: borderBox.bottom + margin.bottom,
  }
  return {
    content: quad(contentBox),
    padding: quad(paddingBox),
    border: quad(borderBox),
    margin: quad(marginBox),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/** Text matched by DOM.performSearch: tag names, attributes and text, case-insensitively. */
function searchNodes(root: Node, query: string, isVisible: (n: Node) => boolean): Node[] {
  const found = new Set<Node>()
  try {
    document.querySelectorAll(query).forEach(el => isVisible(el) && found.add(el))
  } catch {
    // Not a selector.
  }
  try {
    const result = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
    for (let i = 0; i < result.snapshotLength; i++) {
      const node = result.snapshotItem(i)
      if (node && isVisible(node)) found.add(node)
    }
  } catch {
    // Not an XPath expression.
  }
  const needle = query.toLowerCase().replace(/^<|>$/g, '')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, {
    acceptNode: n => (isVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Element) {
      if (node.localName.includes(needle)) found.add(node)
      else if (Array.from(node.attributes).some(a => `${a.name}="${a.value}"`.toLowerCase().includes(needle))) found.add(node)
    } else if (node.nodeValue?.toLowerCase().includes(needle)) {
      found.add(node)
    }
  }
  return Array.from(found)
}

export function registerDom(ctx: Context) {
  const { server, nodes, objects } = ctx
  let observer: MutationObserver | null = null
  const searches = new Map<string, Node[]>()
  let searchSeq = 0

  function emitChildren(parent: Node, depth = 1, pierce = false) {
    const children = nodes.children(parent).map(child => nodes.serialize(child, depth - 1, pierce))
    nodes.childrenSent.add(parent)
    server.emit('DOM.setChildNodes', { parentId: nodes.idOf(parent), nodes: children } satisfies Protocol.DOM.SetChildNodesEvent)
  }

  function previousVisibleSibling(node: Node): Node | null {
    for (let n = node.previousSibling; n; n = n.previousSibling) if (nodes.isVisible(n)) return n
    return null
  }

  /** Reports pseudo-elements that appeared or disappeared on hosts within `roots`. */
  function refreshPseudoElements(roots?: Node[]) {
    for (const [host, sent] of nodes.pseudoSent) {
      if (!host.isConnected) {
        nodes.pseudoSent.delete(host)
        continue
      }
      if (roots && !roots.some(root => root === host || root.contains(host))) continue
      const hostId = nodes.knownId(host)
      if (hostId === undefined) continue
      const current = new Set(nodes.activePseudoTypes(host))
      for (const type of current) {
        if (sent.has(type)) continue
        server.emit('DOM.pseudoElementAdded', {
          parentId: hostId,
          pseudoElement: nodes.serializePseudo(nodes.pseudoOf(host, type)),
        } satisfies Protocol.DOM.PseudoElementAddedEvent)
      }
      for (const type of sent) {
        if (current.has(type)) continue
        server.emit('DOM.pseudoElementRemoved', {
          parentId: hostId,
          pseudoElementId: nodes.idOf(nodes.pseudoOf(host, type)),
        } satisfies Protocol.DOM.PseudoElementRemovedEvent)
      }
      nodes.pseudoSent.set(host, current)
    }
  }
  ctx.refreshPseudoElements = refreshPseudoElements

  /** Reports DOM changes for the parts of the tree the client has received. */
  function onMutations(records: MutationRecord[]) {
    reportMutations(records)
    // Attribute and tree changes can make selectors such as `.x::before` start or stop matching.
    refreshPseudoElements(records.map(r => r.target))
  }

  function reportMutations(records: MutationRecord[]) {
    for (const record of records) {
      const target = record.target
      const targetId = nodes.knownId(target)
      if (record.type === 'childList') {
        if (targetId === undefined) continue
        if (!nodes.childrenSent.has(target)) {
          server.emit('DOM.childNodeCountUpdated', { nodeId: targetId, childNodeCount: nodes.children(target).length })
          continue
        }
        record.removedNodes.forEach(node => {
          const nodeId = nodes.knownId(node)
          if (nodeId !== undefined) server.emit('DOM.childNodeRemoved', { parentNodeId: targetId, nodeId })
        })
        record.addedNodes.forEach(node => {
          if (!nodes.isVisible(node) || node.parentNode !== target) return
          const previous = previousVisibleSibling(node)
          server.emit('DOM.childNodeInserted', {
            parentNodeId: targetId,
            previousNodeId: previous ? nodes.idOf(previous) : 0,
            node: nodes.serialize(node, 0),
          } satisfies Protocol.DOM.ChildNodeInsertedEvent)
        })
      } else if (record.type === 'attributes' && targetId !== undefined && target instanceof Element) {
        const name = record.attributeName!
        if (name === FORCE_ATTRIBUTE) continue
        const value = target.getAttribute(name)
        if (value === null) server.emit('DOM.attributeRemoved', { nodeId: targetId, name })
        else server.emit('DOM.attributeModified', { nodeId: targetId, name, value })
      } else if (record.type === 'characterData' && targetId !== undefined) {
        server.emit('DOM.characterDataModified', { nodeId: targetId, characterData: truncateNodeValue(target.nodeValue ?? '') })
      }
    }
  }

  const OBSERVE: MutationObserverInit = { subtree: true, childList: true, attributes: true, characterData: true }

  function observe() {
    observer?.disconnect()
    observer = new MutationObserver(onMutations)
    observer.observe(document, OBSERVE)
  }
  // Observing the document does not reach into shadow trees: observe each one sent.
  nodes.onShadowRoot = root => observer?.observe(root, OBSERVE)

  // Shadow roots attached to hosts the client already knows are pushed to it.
  const attachShadow = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attachShadow.call(this, init)
    const hostId = observer ? nodes.knownId(this) : undefined
    if (hostId !== undefined) {
      const serialized = nodes.serialize(root, 0)
      serialized.shadowRootType = root.mode === 'open' ? 'open' : 'closed'
      nodes.onShadowRoot?.(root)
      server.emit('DOM.shadowRootPushed', { hostId, root: serialized } satisfies Protocol.DOM.ShadowRootPushedEvent)
    }
    return root
  }

  const element = (ref: NodeRef) => {
    const node = resolveNode(ctx, ref)
    if (!(node instanceof Element)) throw new CdpError('Node is not an Element')
    return node
  }

  server.register('DOM', {
    enable: () => {},
    disable() {
      observer?.disconnect()
      observer = null
    },

    getDocument(params: Protocol.DOM.GetDocumentRequest): Protocol.DOM.GetDocumentResponse {
      nodes.reset()
      observe()
      return { root: nodes.serialize(document, params.depth ?? 2, params.pierce) }
    },

    requestChildNodes(params: Protocol.DOM.RequestChildNodesRequest) {
      const depth = params.depth ?? 1
      emitChildren(resolveNode(ctx, params), depth === -1 ? -1 : depth, params.pierce)
    },

    describeNode(params: Protocol.DOM.DescribeNodeRequest): Protocol.DOM.DescribeNodeResponse {
      const node = resolveNode(ctx, params)
      const described = nodes.serialize(node, params.depth ?? 0, params.pierce)
      // describeNode does not push the node: report a 0 node id unless the client knows it.
      return { node: { ...described, nodeId: nodes.knownId(node) ?? 0, frameId: FRAME_ID } }
    },

    resolveNode(params: Protocol.DOM.ResolveNodeRequest): Protocol.DOM.ResolveNodeResponse {
      return { object: objects.wrap(resolveNode(ctx, params), { group: params.objectGroup }) }
    },

    requestNode(params: Protocol.DOM.RequestNodeRequest): Protocol.DOM.RequestNodeResponse {
      return { nodeId: nodes.push(resolveNode(ctx, params), parent => emitChildren(parent)) }
    },

    pushNodesByBackendIdsToFrontend(params: Protocol.DOM.PushNodesByBackendIdsToFrontendRequest) {
      return {
        nodeIds: params.backendNodeIds.map(id => {
          const node = nodes.getByBackendId(id)
          return node ? nodes.push(node, parent => emitChildren(parent)) : 0
        }),
      }
    },

    getAttributes: (params: Protocol.DOM.GetAttributesRequest): Protocol.DOM.GetAttributesResponse => ({
      attributes: visibleAttributes(element(params)),
    }),

    setAttributeValue(params: Protocol.DOM.SetAttributeValueRequest) {
      element(params).setAttribute(params.name, params.value)
    },

    setAttributesAsText(params: Protocol.DOM.SetAttributesAsTextRequest) {
      const el = element(params)
      const parsed = document.createElement('template')
      parsed.innerHTML = `<div ${params.text}></div>`
      const source = parsed.content.firstElementChild!
      if (params.name) el.removeAttribute(params.name)
      for (const attr of Array.from(source.attributes)) el.setAttribute(attr.name, attr.value)
    },

    removeAttribute(params: Protocol.DOM.RemoveAttributeRequest) {
      element(params).removeAttribute(params.name)
    },

    setNodeValue(params: Protocol.DOM.SetNodeValueRequest) {
      resolveNode(ctx, params).nodeValue = params.value
    },

    getOuterHTML(params: Protocol.DOM.GetOuterHTMLRequest): Protocol.DOM.GetOuterHTMLResponse {
      const node = resolveNode(ctx, params)
      if (node instanceof Element) {
        if (!node.matches(`[${FORCE_ATTRIBUTE}]`) && !node.querySelector(`[${FORCE_ATTRIBUTE}]`)) return { outerHTML: node.outerHTML }
        // Leave out forced pseudo-class markers.
        const copy = node.cloneNode(true) as Element
        for (const el of [copy, ...Array.from(copy.querySelectorAll(`[${FORCE_ATTRIBUTE}]`))]) el.removeAttribute(FORCE_ATTRIBUTE)
        return { outerHTML: copy.outerHTML }
      }
      if (node instanceof Document) return { outerHTML: node.documentElement.outerHTML }
      return { outerHTML: new XMLSerializer().serializeToString(node) }
    },

    setOuterHTML(params: Protocol.DOM.SetOuterHTMLRequest) {
      element(params).outerHTML = params.outerHTML
    },

    setNodeName(params: Protocol.DOM.SetNodeNameRequest): Protocol.DOM.SetNodeNameResponse {
      const el = element(params)
      const renamed = document.createElement(params.name)
      for (const attr of Array.from(el.attributes)) renamed.setAttribute(attr.name, attr.value)
      while (el.firstChild) renamed.appendChild(el.firstChild)
      el.replaceWith(renamed)
      return { nodeId: nodes.idOf(renamed) }
    },

    removeNode(params: Protocol.DOM.RemoveNodeRequest) {
      const node = resolveNode(ctx, params)
      node.parentNode?.removeChild(node)
    },

    moveTo(params: Protocol.DOM.MoveToRequest): Protocol.DOM.MoveToResponse {
      const node = resolveNode(ctx, params)
      const target = resolveNode(ctx, { nodeId: params.targetNodeId })
      const before = params.insertBeforeNodeId ? resolveNode(ctx, { nodeId: params.insertBeforeNodeId }) : null
      target.insertBefore(node, before)
      return { nodeId: nodes.idOf(node) }
    },

    copyTo(params: Protocol.DOM.CopyToRequest): Protocol.DOM.CopyToResponse {
      const copy = resolveNode(ctx, params).cloneNode(true)
      const target = resolveNode(ctx, { nodeId: params.targetNodeId })
      const before = params.insertBeforeNodeId ? resolveNode(ctx, { nodeId: params.insertBeforeNodeId }) : null
      target.insertBefore(copy, before)
      return { nodeId: nodes.idOf(copy) }
    },

    querySelector(params: Protocol.DOM.QuerySelectorRequest): Protocol.DOM.QuerySelectorResponse {
      const found = (resolveNode(ctx, params) as ParentNode).querySelector(params.selector)
      return { nodeId: found ? nodes.push(found, parent => emitChildren(parent)) : 0 }
    },

    querySelectorAll(params: Protocol.DOM.QuerySelectorAllRequest): Protocol.DOM.QuerySelectorAllResponse {
      const found = Array.from((resolveNode(ctx, params) as ParentNode).querySelectorAll(params.selector))
      return { nodeIds: found.map(node => nodes.push(node, parent => emitChildren(parent))) }
    },

    performSearch(params: Protocol.DOM.PerformSearchRequest): Protocol.DOM.PerformSearchResponse {
      const searchId = String(++searchSeq)
      const results = searchNodes(document, params.query, n => nodes.isVisible(n))
      searches.set(searchId, results)
      return { searchId, resultCount: results.length }
    },

    getSearchResults(params: Protocol.DOM.GetSearchResultsRequest): Protocol.DOM.GetSearchResultsResponse {
      const results = searches.get(params.searchId) ?? []
      return {
        nodeIds: results.slice(params.fromIndex, params.toIndex).map(node => nodes.push(node, parent => emitChildren(parent))),
      }
    },

    discardSearchResults(params: Protocol.DOM.DiscardSearchResultsRequest) {
      searches.delete(params.searchId)
    },

    getBoxModel: (params: Protocol.DOM.GetBoxModelRequest): Protocol.DOM.GetBoxModelResponse => ({
      model: boxModel(element(params)),
    }),

    getContentQuads: (params: Protocol.DOM.GetContentQuadsRequest): Protocol.DOM.GetContentQuadsResponse => ({
      quads: Array.from(element(params).getClientRects()).map(quad),
    }),

    getNodeForLocation(params: Protocol.DOM.GetNodeForLocationRequest): Protocol.DOM.GetNodeForLocationResponse {
      const el = document.elementFromPoint(params.x, params.y)
      if (!el || !nodes.isVisible(el)) throw new CdpError('No node found at given location')
      return { backendNodeId: nodes.backendIdOf(el), frameId: FRAME_ID, nodeId: nodes.knownId(el) }
    },

    collectClassNamesFromSubtree(params: Protocol.DOM.CollectClassNamesFromSubtreeRequest) {
      const root = element(params)
      const names = new Set<string>()
      for (const el of [root, ...Array.from(root.querySelectorAll('[class]'))]) el.classList.forEach(c => names.add(c))
      return { classNames: Array.from(names) }
    },

    setInspectedNode(params: Protocol.DOM.SetInspectedNodeRequest) {
      const node = resolveNode(ctx, params)
      nodes.inspected = [node, ...nodes.inspected.filter(n => n !== node)].slice(0, 5)
    },

    focus(params: Protocol.DOM.FocusRequest) {
      ;(resolveNode(ctx, params) as HTMLElement).focus?.()
    },

    scrollIntoViewIfNeeded(params: Protocol.DOM.ScrollIntoViewIfNeededRequest) {
      element(params).scrollIntoView({ block: 'nearest', inline: 'nearest' })
    },

    getTopLayerElements: () => ({ nodeIds: [] }),
    markUndoableState: () => {},
    undo: () => {},
    redo: () => {},
    hideHighlight: () => server.call('Overlay.hideHighlight'),
    highlightNode: (params: unknown) => server.call('Overlay.highlightNode', params),
  })
}
