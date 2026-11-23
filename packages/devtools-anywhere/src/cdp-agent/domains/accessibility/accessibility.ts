import type { Protocol } from 'devtools-protocol';
import { disconnect, nativesInUse, newObserver, observe } from '../../core/natives';
import { afterFrames } from '../../core/turn';
import { CdpError } from '../../core/session';
import type { Context } from '../../core/context';
import { documentOf, isNode } from '../../core/realm';
import { resolveNode } from '../dom/dom';
import { PseudoElement } from '../../core/nodes/nodes';
import type { AccessibilityModule, AXTree } from './ax-node';
import type { AXRef } from './tree/ax-virtual';

/**
 * Loads accessibility.js (ax-node.ts), which computes the tree: it is large, and only the
 * Accessibility pane and scripts reading the tree need it. @internal
 */
export type AccessibilityLoader = () => Promise<AccessibilityModule>;

/** What may change the tree: the DOM, its attributes (class and style too) and its text. */
const OBSERVED: MutationObserverInit = {
  attributes: true,
  childList: true,
  subtree: true,
  characterData: true,
};

/**
 * The Accessibility domain: the tree computed in the page from the DOM, ARIA attributes and the
 * implicit roles (ax-role.ts, ax-name.ts), as Chrome's getPartialAXTree gives it to the
 * Accessibility pane. Chrome's inline text boxes are not in it. The nodes of user-agent shadow
 * trees (a select's popup), which the page cannot see, are redone without a DOM node
 * (ax-virtual.ts): each gets a negative id, kept for the session, apart from the backend ids. So
 * are list markers (ax-marker.ts), but a marker has its ::marker pseudo-element's backend id, as in
 * Chrome; its text children get negative ids.
 *
 * Events, as Chrome 158 sends them: `nodesUpdated` only while enabled, and only for the nodes the
 * client was given by getChildAXNodes or getAXNodeAndAncestors (the Accessibility pane's
 * commands; getPartialAXTree, getFullAXTree, getRootAXNode and queryAXTree mark none), each as a
 * whole AXNode, those changed in one frame in one event. `loadComplete` comes when a document
 * finishes loading, which the agent, started in a loaded page, never sees: it is not sent, and
 * not on enable either, as Chrome does not. A node without a DOM node is not watched.
 */
export function registerAccessibility(ctx: Context, load: AccessibilityLoader | undefined) {
  const { session, nodes, frames } = ctx;
  let module: Promise<AccessibilityModule> | null = null;
  /** The ids of the nodes without a DOM node, by their host's backend id and key, and back. */
  const virtualIds = new Map<string, number>();
  const virtualKeys = new Map<number, { hostId: number; key: string }>();
  const virtualIdOf = (hostId: number, key: string) => {
    let id = virtualIds.get(`${hostId}:${key}`);
    if (id === undefined) {
      id = -1 - virtualIds.size;
      virtualIds.set(`${hostId}:${key}`, id);
      virtualKeys.set(id, { hostId, key });
    }
    return id;
  };
  /**
   * The tree of a frame's document (the page's or a same-origin iframe's), over its current DOM:
   * computed again by each command, as the DOM changes between them.
   */
  const tree = async (doc: Document): Promise<AXTree> => {
    if (!load) throw new CdpError('Not supported in the page: the accessibility tree is not configured');
    // A failed load is not kept, so that the next command loads again.
    const m = await (module ??= load().then(
      loaded => {
        loaded.useNatives(nativesInUse());
        return loaded;
      },
      (e: unknown) => {
        module = null;
        throw e;
      }
    ));
    return m.createAXTree(
      doc,
      node => nodes.backendIdOf(node),
      frames.ofNode(doc).id,
      virtualIdOf,
      (host, type) => nodes.backendIdOf(nodes.pseudoOf(host, type))
    );
  };

  /**
   * While enabled, the nodes the client was given that nodesUpdated reports, with the AXNode last
   * given for each (as JSON): a node is sent again when its AXNode differs.
   */
  let enabled = false;
  const known = new Map<Node, string>();
  let observer: MutationObserver | null = null;
  /** A frame is awaited for changes; the flush of earlier ones may still be computing. */
  let scheduled = false;

  /** Records the nodes given to the client, and watches the trees they are in. */
  function remember(given: [AXRef, Protocol.Accessibility.AXNode][]) {
    if (!enabled) return;
    for (const [node, axNode] of given) {
      // A node without a DOM node is built again with each tree: it is not watched.
      if (!isNode(node)) continue;
      known.set(node, JSON.stringify(axNode));
      // The document, or the shadow root the node is in: a document's observer does not see into
      // shadow trees. A change in a shadow tree whose own nodes the client was not given (a
      // slotted element's host's tree) is seen with the next change in an observed one.
      observer ??= newObserver(changed);
      observe(observer, node.getRootNode(), OBSERVED);
    }
  }

  /**
   * After a change, the next frame computes the tree again and sends the known nodes whose AXNode
   * differs, in one event, as Chrome sends the nodes changed in a frame. Chrome sends those its
   * tree marks dirty, which may include a node's parent whose AXNode is the same (when a child's
   * role changes, say); this sends only those that differ.
   *
   * The observer sees the DOM only: a style change from an attribute (a class, `style`) or a
   * stylesheet added or edited as text is seen, but not one from the CSSOM (insertRule, a
   * declaration set on a sheet's rule), :hover, :focus and other states, media queries
   * (resizing), animations or transitions, nor an image loading. Those are sent with the next DOM
   * change; the commands always compute the tree from the current DOM and styles.
   */
  function changed() {
    if (scheduled) return;
    scheduled = true;
    afterFrames(1, () => {
      scheduled = false;
      void flush();
    });
  }

  async function flush() {
    try {
      const byDoc = new Map<Document, Node[]>();
      for (const node of known.keys()) {
        // A node gone from its document is not sent: its parent's children tell it.
        if (!node.isConnected) {
          known.delete(node);
          continue;
        }
        const doc = documentOf(node);
        byDoc.set(doc, [...(byDoc.get(doc) ?? []), node]);
      }
      const out: Protocol.Accessibility.AXNode[] = [];
      for (const [doc, list] of byDoc) {
        const ax = await tree(doc);
        if (!enabled) return;
        for (const node of list) {
          // A node now left out of the tree (display: none) is not sent, as in Chrome; it is sent
          // again when it comes back.
          if (!ax.inTree(node) || !known.has(node)) continue;
          const axNode = ax.node(node);
          const json = JSON.stringify(axNode);
          if (json === known.get(node)) continue;
          known.set(node, json);
          out.push(axNode);
        }
      }
      if (out.length && enabled)
        session.emit('Accessibility.nodesUpdated', {
          nodes: out,
        } satisfies Protocol.Accessibility.NodesUpdatedEvent);
    } catch {
      // The tree could not be loaded: the commands report it.
    }
  }

  function stop() {
    enabled = false;
    known.clear();
    if (observer) disconnect(observer);
    observer = null;
  }

  session.onReset(stop);

  session.register('Accessibility', {
    // Events start with the nodes the client is given from now on.
    enable: () => {
      enabled = true;
      return {};
    },
    disable: () => {
      stop();
      return {};
    },

    async getPartialAXTree(
      params: Protocol.Accessibility.GetPartialAXTreeRequest
    ): Promise<Protocol.Accessibility.GetPartialAXTreeResponse> {
      const { node, ax } = await target(params);
      const out = [ax.node(node)];
      if (params.fetchRelatives ?? true) {
        // Like Chrome: the node's children, then its ancestors up to the root.
        if (ax.inTree(node)) out.push(...childrenOf(ax, node).map(([, axNode]) => axNode));
        const first = out.length;
        for (let p = ax.parent(node); p; p = ax.parent(p)) out.push(ax.node(p));
        // A node out of the tree is listed among its parent's children here, as Chrome does.
        const up = out[first];
        const self = out[0] as Protocol.Accessibility.AXNode;
        if (up && !up.childIds?.includes(self.nodeId)) up.childIds = [...(up.childIds ?? []), self.nodeId];
      }
      return { nodes: out };
    },

    async getFullAXTree(
      params: Protocol.Accessibility.GetFullAXTreeRequest
    ): Promise<Protocol.Accessibility.GetFullAXTreeResponse> {
      const doc = documentOfFrame(params.frameId);
      const ax = await tree(doc);
      // In Chrome's order (WalkAXNodesToDepth in inspector_accessibility_agent.cc): breadth first
      // over the nodes that are not ignored, from the root; each one's children are listed depth
      // first, going down through the ignored ones, before the next node of the queue is taken.
      // Chrome also goes down through a node without a DOM node; ours (a control's shadow parts)
      // have one in Chrome, and its own (a marker's text in a roled list) have no children here.
      // `depth` counts the nodes that are not ignored, the root at 1: those below the last level
      // are not taken from the queue, but the ignored nodes under its nodes are still listed.
      const max = params.depth ?? -1;
      const out: Protocol.Accessibility.AXNode[] = [ax.node(doc)];
      const queue: { node: AXRef; depth: number }[] = [{ node: doc, depth: 1 }];
      for (const { node, depth } of queue) {
        const stack = [...ax.children(node)].reverse();
        for (let child = stack.pop(); child; child = stack.pop()) {
          const axNode = ax.node(child);
          out.push(axNode);
          if (axNode.ignored) stack.push(...[...ax.children(child)].reverse());
          else if (max === -1 || depth < max) queue.push({ node: child, depth: depth + 1 });
        }
      }
      return { nodes: out };
    },

    async getRootAXNode(
      params: Protocol.Accessibility.GetRootAXNodeRequest
    ): Promise<Protocol.Accessibility.GetRootAXNodeResponse> {
      const doc = documentOfFrame(params.frameId);
      return { node: (await tree(doc)).node(doc) };
    },

    async getChildAXNodes(
      params: Protocol.Accessibility.GetChildAXNodesRequest
    ): Promise<Protocol.Accessibility.GetChildAXNodesResponse> {
      // A node without a DOM node by its id below 0, a list marker or generated content by its
      // pseudo-element's backend id.
      const id = Number(params.id);
      const virtual = virtualKeys.get(id);
      const found = nodes.getByBackendId(virtual ? virtual.hostId : id);
      const pseudo = pseudoKey(found);
      const host = pseudo && found instanceof PseudoElement ? found.host : found;
      if (!isNode(host)) throw new CdpError('Invalid ID');
      const ax = await tree(documentOf(host));
      const node = virtual || pseudo ? ax.virtual(host, virtual ? virtual.key : (pseudo ?? '')) : host;
      // A pseudo-element the tree has no node for has no children, as Chrome's ignored node.
      if (!node) {
        if (pseudo) return { nodes: [] };
        throw new CdpError('Invalid ID');
      }
      const given: [AXRef, Protocol.Accessibility.AXNode][] = [];
      childrenOf(ax, node, given);
      remember(given);
      return { nodes: given.map(([, axNode]) => axNode) };
    },

    async getAXNodeAndAncestors(
      params: Protocol.Accessibility.GetAXNodeAndAncestorsRequest
    ): Promise<Protocol.Accessibility.GetAXNodeAndAncestorsResponse> {
      const { node, ax } = await target(params);
      const given: [AXRef, Protocol.Accessibility.AXNode][] = [[node, ax.node(node)]];
      // A node Chrome has no parent for (a closed details' content) comes alone.
      if (given[0]?.[1].parentId !== undefined)
        for (let p = ax.parent(node); p; p = ax.parent(p)) given.push([p, ax.node(p)]);
      remember(given);
      return { nodes: given.map(([, axNode]) => axNode) };
    },

    async queryAXTree(
      params: Protocol.Accessibility.QueryAXTreeRequest
    ): Promise<Protocol.Accessibility.QueryAXTreeResponse> {
      const root = resolveNode(ctx, params);
      const ax = await tree(documentOf(root));
      // The nodes in the root's subtree that match, in tree order: ignored ones too, with their own
      // role and name, as in Chrome.
      const out: Protocol.Accessibility.AXNode[] = [];
      const visit = (node: AXRef) => {
        const axNode = ax.node(node, true);
        if (
          (params.role === undefined || axNode.role?.value === params.role) &&
          (params.accessibleName === undefined || axNode.name?.value === params.accessibleName)
        )
          out.push(axNode);
        for (const child of ax.children(node)) visit(child);
      };
      if (ax.inTree(root)) visit(root);
      else for (const child of ax.children(root)) visit(child);
      return { nodes: out };
    },
  });

  /** A node's children as Chrome lists them: through ignored ones, down to those not ignored. */
  function childrenOf(
    ax: AXTree,
    parent: AXRef,
    out: [AXRef, Protocol.Accessibility.AXNode][] = []
  ): [AXRef, Protocol.Accessibility.AXNode][] {
    for (const child of ax.children(parent)) {
      const axChild = ax.node(child);
      out.push([child, axChild]);
      if (axChild.ignored) childrenOf(ax, child, out);
    }
    return out;
  }

  /**
   * The node a command refers to and its tree: a DOM node, or a ::marker pseudo-element for its list
   * marker's node (its host's when the tree has no marker for it, where Chrome has an ignored node).
   */
  async function target(params: {
    nodeId?: number;
    backendNodeId?: number;
    objectId?: string;
  }): Promise<{ node: AXRef; ax: AXTree }> {
    const { nodeId, backendNodeId } = params;
    const ref = nodeId ? nodes.get(nodeId) : backendNodeId ? nodes.getByBackendId(backendNodeId) : null;
    const pseudo = pseudoKey(ref);
    if (pseudo && ref instanceof PseudoElement) {
      const ax = await tree(documentOf(ref.host));
      return { node: ax.virtual(ref.host, pseudo) ?? ref.host, ax };
    }
    const node = resolveNode(ctx, params);
    return { node, ax: await tree(documentOf(node)) };
  }

  /** The key of a pseudo-element's node in the tree: a ::marker, ::before or ::after. */
  function pseudoKey(ref: unknown): 'marker' | 'before' | 'after' | null {
    if (!(ref instanceof PseudoElement)) return null;
    const type = ref.pseudoType;
    return type === 'marker' || type === 'before' || type === 'after' ? type : null;
  }

  /** The document of a frame, the top one by default. */
  function documentOfFrame(frameId: string | undefined): Document {
    const frame = frameId === undefined ? frames.top : frames.byId(frameId);
    if (!frame) throw new CdpError(`No frame for given id found`);
    return frame.document;
  }
}
