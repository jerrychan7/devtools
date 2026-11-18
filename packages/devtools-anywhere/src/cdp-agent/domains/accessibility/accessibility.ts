import type { Protocol } from 'devtools-protocol';
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

/**
 * The Accessibility domain: the tree computed in the page from the DOM, ARIA attributes and the
 * implicit roles (ax-tree.ts, ax-name.ts), as Chrome's getPartialAXTree gives it to the
 * Accessibility pane. Chrome's inline text boxes and the nodes of user-agent shadow trees (a
 * text field's inner editor, a select's popup) are not in it: the page cannot see them.
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
    const m = await (module ??= load().catch((e: unknown) => {
      module = null;
      throw e;
    }));
    return m.createAXTree(doc, node => nodes.backendIdOf(node), frames.ofNode(doc).id);
  };

  session.register('Accessibility', {
    // Nothing to stop: the tree is computed per command (enable is a no-op in stubs.ts).
    disable: () => ({}),

    async getPartialAXTree(
      params: Protocol.Accessibility.GetPartialAXTreeRequest
    ): Promise<Protocol.Accessibility.GetPartialAXTreeResponse> {
      const node = resolveNode(ctx, params);
      const ax = await tree(documentOf(node));
      const out = [ax.node(node)];
      if (params.fetchRelatives ?? true) {
        // Like Chrome: the node's children, then its ancestors up to the root.
        if (ax.inTree(node)) out.push(...childrenOf(ax, node));
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
      return { nodes: childrenOf(ax, node) };
    },

    async getAXNodeAndAncestors(
      params: Protocol.Accessibility.GetAXNodeAndAncestorsRequest
    ): Promise<Protocol.Accessibility.GetAXNodeAndAncestorsResponse> {
      const node = resolveNode(ctx, params);
      const ax = await tree(documentOf(node));
      const out = [ax.node(node)];
      for (let p = ax.parent(node); p; p = ax.parent(p)) out.push(ax.node(p));
      return { nodes: out };
    },

    async queryAXTree(
      params: Protocol.Accessibility.QueryAXTreeRequest
    ): Promise<Protocol.Accessibility.QueryAXTreeResponse> {
      const root = resolveNode(ctx, params);
      const ax = await tree(documentOf(root));
      // The nodes in the root's subtree that match, in tree order: ignored ones too, as in Chrome.
      const out: Protocol.Accessibility.AXNode[] = [];
      const visit = (node: Node) => {
        const axNode = ax.node(node);
        // An ignored element's role is none here, not the role Chrome matches against.
        const roleKnown = !axNode.ignored || axNode.role?.value !== 'none';
        if (
          roleKnown &&
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
  function childrenOf(ax: AXTree, parent: Node): Protocol.Accessibility.AXNode[] {
    const out: Protocol.Accessibility.AXNode[] = [];
    for (const child of ax.children(parent)) {
      const axChild = ax.node(child);
      out.push(axChild);
      if (axChild.ignored) out.push(...childrenOf(ax, child));
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
