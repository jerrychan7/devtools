import type { Protocol } from 'devtools-protocol';
import { CdpError } from '../../core/session';
import type { Context } from '../../core/context';
import { documentOf } from '../../core/realm';
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
    async getPartialAXTree(
      params: Protocol.Accessibility.GetPartialAXTreeRequest
    ): Promise<Protocol.Accessibility.GetPartialAXTreeResponse> {
      const node = resolveNode(ctx, params);
      const ax = await tree(documentOf(node));
      const out = [ax.node(node)];
      if (params.fetchRelatives ?? true) {
        // Like Chrome: the node's children, through ignored ones down to those not ignored, then
        // its ancestors up to the root.
        const addChildren = (parent: Node) => {
          for (const child of ax.children(parent)) {
            const axChild = ax.node(child);
            out.push(axChild);
            if (axChild.ignored) addChildren(child);
          }
        };
        if (ax.inTree(node)) addChildren(node);
        for (let p = ax.parent(node); p; p = ax.parent(p)) out.push(ax.node(p));
      }
      return { nodes: out };
    },
  });
}
