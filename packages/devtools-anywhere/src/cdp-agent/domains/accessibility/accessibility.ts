import type { Protocol } from 'devtools-protocol';
import { disconnect, nativesInUse, newObserver, observe } from '../../core/natives';
import { afterFrames } from '../../core/turn';
import { CdpError } from '../../core/session';
import type { Context } from '../../core/context';
import { documentOf, isNode } from '../../core/realm';
import { resolveNode } from '../dom/dom';
import type { AccessibilityModule, AXTree } from './ax-node';

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
 * implicit roles (ax-tree.ts, ax-name.ts), as Chrome's getPartialAXTree gives it to the
 * Accessibility pane. Chrome's inline text boxes and the nodes of user-agent shadow trees (a
 * text field's inner editor, a select's popup) are not in it: the page cannot see them.
 *
 * Events, as Chrome 158 sends them: `nodesUpdated` only while enabled, and only for the nodes the
 * client was given by getChildAXNodes or getAXNodeAndAncestors (the Accessibility pane's
 * commands; getPartialAXTree, getFullAXTree, getRootAXNode and queryAXTree mark none), each as a
 * whole AXNode, those changed in one frame in one event. `loadComplete` comes when a document
 * finishes loading, which the agent, started in a loaded page, never sees: it is not sent, and
 * not on enable either, as Chrome does not.
 */
export function registerAccessibility(ctx: Context, load: AccessibilityLoader | undefined) {
  const { session, nodes, frames } = ctx;
  let module: Promise<AccessibilityModule> | null = null;
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
    return m.createAXTree(doc, node => nodes.backendIdOf(node), frames.ofNode(doc).id);
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
  function remember(given: [Node, Protocol.Accessibility.AXNode][]) {
    if (!enabled) return;
    for (const [node, axNode] of given) {
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
      const node = resolveNode(ctx, params);
      const ax = await tree(documentOf(node));
      const out = [ax.node(node)];
      if (params.fetchRelatives ?? true) {
        // Like Chrome: the node's children, then its ancestors up to the root.
        if (ax.inTree(node)) out.push(...childrenOf(ax, node).map(([, axNode]) => axNode));
        for (let p = ax.parent(node); p; p = ax.parent(p)) out.push(ax.node(p));
      }
      return { nodes: out };
    },

    async getFullAXTree(
      params: Protocol.Accessibility.GetFullAXTreeRequest
    ): Promise<Protocol.Accessibility.GetFullAXTreeResponse> {
      const doc = documentOfFrame(params.frameId);
      const ax = await tree(doc);
      // Breadth first, as Chrome lists them. `depth` counts the nodes that are not ignored above a
      // node, as in Chrome: the root's children are at 1, and so are those of an ignored body.
      const max = params.depth ?? Infinity;
      const out: Protocol.Accessibility.AXNode[] = [];
      let level: { node: Node; depth: number }[] = [{ node: doc, depth: 0 }];
      while (level.length) {
        const next: typeof level = [];
        for (const { node, depth } of level) {
          const axNode = ax.node(node);
          out.push(axNode);
          const childDepth = axNode.ignored ? depth : depth + 1;
          if (childDepth <= max) for (const child of ax.children(node)) next.push({ node: child, depth: childDepth });
        }
        level = next;
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
      const node = nodes.getByBackendId(Number(params.id));
      if (!isNode(node)) throw new CdpError('Invalid ID');
      const ax = await tree(documentOf(node));
      const given: [Node, Protocol.Accessibility.AXNode][] = [];
      childrenOf(ax, node, given);
      remember(given);
      return { nodes: given.map(([, axNode]) => axNode) };
    },

    async getAXNodeAndAncestors(
      params: Protocol.Accessibility.GetAXNodeAndAncestorsRequest
    ): Promise<Protocol.Accessibility.GetAXNodeAndAncestorsResponse> {
      const node = resolveNode(ctx, params);
      const ax = await tree(documentOf(node));
      const given: [Node, Protocol.Accessibility.AXNode][] = [[node, ax.node(node)]];
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
      const visit = (node: Node) => {
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
    parent: Node,
    out: [Node, Protocol.Accessibility.AXNode][] = []
  ): [Node, Protocol.Accessibility.AXNode][] {
    for (const child of ax.children(parent)) {
      const axChild = ax.node(child);
      out.push([child, axChild]);
      if (axChild.ignored) childrenOf(ax, child, out);
    }
    return out;
  }

  /** The document of a frame, the top one by default. */
  function documentOfFrame(frameId: string | undefined): Document {
    const frame = frameId === undefined ? frames.top : frames.byId(frameId);
    if (!frame) throw new CdpError(`No frame for given id found`);
    return frame.document;
  }
}
