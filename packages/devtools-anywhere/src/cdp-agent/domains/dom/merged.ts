import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import type { ChildLink } from '../../core/child-targets';
import { FAN_OUT_TIMEOUT, mergedFrames, ownerOfId } from '../../core/merged-frames';
import { mapPoints, ownerContentToTop, pointInOwnerContent } from '../../core/geometry';
import { type FrameOwner, isDocument, isFrameOwner, isShadowRoot } from '../../core/realm';
import { CdpError } from '../../core/session';
import { historyOf } from '../../core/history';

/**
 * The DOM of sandboxed iframes merged into the page's agent (core/merged-frames.ts): Chrome keeps
 * such a frame in the page's target, its document grafted under the iframe like a same-origin
 * one's. The frame's agent has the nodes (ids in its namespace): commands for them go there by
 * the routes below, and what the page's agent reports (an iframe's `contentDocument`, a search, a
 * point, a box) asks it for its part.
 */

type DomNode = Protocol.DOM.Node;
type NodeRef = { nodeId?: number; backendNodeId?: number; objectId?: string };

/** Commands that act on the node they name, and on nothing else: its frame's agent answers them. */
const BY_NODE = [
  'requestChildNodes',
  'describeNode',
  'resolveNode',
  'getAttributes',
  'setAttributeValue',
  'setAttributesAsText',
  'removeAttribute',
  'setNodeValue',
  'getOuterHTML',
  'setOuterHTML',
  'setNodeName',
  'removeNode',
  'querySelector',
  'querySelectorAll',
  'collectClassNamesFromSubtree',
  'setInspectedNode',
  'focus',
  'scrollIntoViewIfNeeded',
  'getNodesForSubtreeByStyle',
  'requestNode',
];

/**
 * The routed commands a frame's agent records in its history (DOM.undo), the domains sharing it
 * included, as Chrome's InspectorHistory; DOM.moveTo and DOM.copyTo go there by domains/dom/dom.ts.
 */
const EDITS = new Set([
  'DOM.setAttributeValue',
  'DOM.setAttributesAsText',
  'DOM.removeAttribute',
  'DOM.setNodeValue',
  'DOM.setOuterHTML',
  'DOM.setNodeName',
  'DOM.removeNode',
  'CSS.setStyleSheetText',
  'CSS.setStyleTexts',
  'CSS.setRuleSelector',
  'CSS.addRule',
  'CSS.setEffectivePropertyValueForNode',
]);

mergedFrames.registerRoutes('DOM', {
  routeBy: Object.fromEntries(BY_NODE.map(name => [`DOM.${name}`, ['nodeId', 'backendNodeId', 'objectId']])),
  fanOut: ['DOM.enable', 'DOM.disable'],
});

/** The node under `key` of a frame agent's result, if any. */
function nodeIn(result: unknown, key: string): DomNode | undefined {
  const node: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, key) : undefined;
  return typeof node === 'object' && node !== null && typeof Reflect.get(node, 'nodeId') === 'number'
    ? (node as DomNode)
    : undefined;
}

/** The numbers under `key` of a frame agent's result ([] if none). */
function numbersIn(result: unknown, key: string): number[] {
  const value: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, key) : undefined;
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

/** A node without its children: what later serializations of its iframe send again. */
function shallow(node: DomNode): DomNode {
  const copy = { ...node };
  delete copy.children;
  return copy;
}

/** A frame's part of a DOM.performSearch: the search its agent keeps. */
export interface SearchPart {
  readonly ns: number;
  readonly searchId: string;
  readonly count: number;
}

export interface MergedDom {
  /** The merged frame (namespace) a node reference is of, if linked; undefined for the page's own. */
  nsOf(ref: NodeRef): number | undefined;
  /** The merged frame the nodes are all of (undefined: the page's); -32000 when they are not of one. */
  oneFrame(ids: (number | undefined)[]): number | undefined;
  ask(ns: number, method: string, params: object): Promise<unknown>;
  /**
   * `serialize()`'s result with the documents of the merged iframes it reaches as their agents
   * send them for its depth: DOM.getDocument's (`reset`: every frame's agent starts a new tree too,
   * as the page's does), or else DOM.describeNode's of the document they sent before.
   */
  graft<T>(serialize: () => T, pierce: boolean, reset: boolean): Promise<T>;
  /** After `node`'s children were pushed for requestChildNodes: the merged iframes' documents within, deeper. */
  pushInside(node: Node, depth: number, pierce: boolean): Promise<void>;
  /** The node at a point of the top viewport in the document of `owner`'s merged frame; undefined if none. */
  nodeAt(owner: Element, x: number, y: number, params: object): Promise<unknown>;
  /**
   * A command of frame `ns`'s agent answering quads (`quads` of its result, or `content`,
   * `padding`, `border` and `margin` of its `model`), with them placed in the top viewport.
   */
  quadsIn(ns: number, method: string, params: object): Promise<unknown>;
  search(params: Protocol.DOM.PerformSearchRequest): Promise<SearchPart[]>;
  /** The node at `path` (pairs, DOM.pushNodeByPathToFrontend's) in `owner`'s merged frame; undefined if not merged. */
  pushPath(owner: Element, path: string[]): Promise<unknown> | undefined;
  /** Follows the frames' (re)loads while the client follows the tree: `resend` the iframe. */
  follow(resend: (owner: FrameOwner) => void): void;
  /** Records in the page's history an edit frame `ns`'s agent made and recorded in its own (see {@link EDITS}). */
  recordEdit(ns: number): void;
  /** Once the frames' agents have done the undo / redo that the page's last replay asked of them. */
  replayed(): Promise<void>;
  unfollow(): void;
}

export function mergedDom(ctx: Context): MergedDom {
  const { session, nodes } = ctx;
  const client = () => mergedFrames.forSession(session);
  const linkOfNs = (ns: number): ChildLink | undefined => {
    for (const [n, link] of mergedFrames.frames()) if (n === ns) return link;
    return undefined;
  };
  // A frame that does not answer in time (its thread blocked by an alert, a long task) is as one
  // that answered an error: the page's own answer goes on without its part.
  const ask = (ns: number, method: string, params: object) => client().ask(ns, method, params, FAN_OUT_TIMEOUT);
  /** Each merged frame's document as last sent to the client, without children. */
  const roots = new Map<number, DomNode>();
  /** While a first pass looks for the iframes reached: the depth each one's document wants. */
  let wanted: Map<number, number> | null = null;
  /** While the second pass serializes: the documents fetched for it. */
  let grafted: Map<number, DomNode> | null = null;
  let stopLinked: (() => void) | null = null;
  /** The links whose closing drops their frame's root (a namespace is not used again). */
  const watched = new WeakSet<ChildLink>();
  function keepRoot(ns: number, root: DomNode) {
    const link = linkOfNs(ns);
    if (!link) return;
    roots.set(ns, root);
    if (watched.has(link)) return;
    watched.add(link);
    link.onClose(() => roots.delete(ns));
  }
  /** The frames' undo / redo asked by the page's last replay. */
  let replays: Promise<unknown>[] = [];
  const replay = (ns: number, method: string) => replays.push(ask(ns, method, {}).catch(() => {}));

  // One history, in edit order, as Chrome's (one InspectorHistory per target): each edit of a
  // frame's is a step of its own in its agent's history, an action of the page's that undoes or
  // redoes that step there.
  function recordEdit(ns: number) {
    ask(ns, 'DOM.markUndoableState', {}).catch(() => {});
    historyOf(ctx).record({ undo: () => replay(ns, 'DOM.undo'), redo: () => replay(ns, 'DOM.redo') });
  }
  mergedFrames.onRouted((routed, ns, method) => {
    if (routed === session && EDITS.has(method)) recordEdit(ns);
  });

  nodes.mergedDocument = (owner, depth) => {
    const merged = mergedFrames.linkOf(owner);
    if (!merged) return undefined;
    if (wanted) {
      const was = wanted.get(merged.ns);
      wanted.set(merged.ns, was === undefined ? depth : was === -1 || depth === -1 ? -1 : Math.max(was, depth));
      return undefined;
    }
    return grafted?.get(merged.ns) ?? roots.get(merged.ns);
  };

  async function fetchDocument(ns: number, depth: number, pierce: boolean, reset: boolean) {
    if (reset) return nodeIn(await ask(ns, 'DOM.getDocument', { depth, pierce }), 'root');
    const root = roots.get(ns);
    if (!root || depth === 0) return root;
    const node = nodeIn(await ask(ns, 'DOM.describeNode', { nodeId: root.nodeId, depth, pierce: true }), 'node');
    // The frame agent names the frame a node is in; a contentDocument does not, in Chrome.
    if (node) delete node.frameId;
    return node && { ...node, nodeId: root.nodeId };
  }

  return {
    nsOf(ref) {
      const ns = ownerOfId(ref.nodeId) ?? ownerOfId(ref.backendNodeId) ?? ownerOfId(ref.objectId);
      return ns !== undefined && linkOfNs(ns) ? ns : undefined;
    },

    oneFrame(ids) {
      const owners = new Set(ids.filter(id => id).map(id => ownerOfId(id) ?? 0));
      if (owners.size > 1)
        throw new CdpError('Not supported in the page: moving a node into or out of a sandboxed iframe');
      const [ns] = owners;
      return ns ? ns : undefined;
    },

    ask,

    async graft(serialize, pierce, reset) {
      const want = (wanted = new Map());
      try {
        serialize();
      } finally {
        wanted = null;
      }
      if (reset) for (const [ns] of mergedFrames.frames()) if (!want.has(ns)) want.set(ns, 0);
      const fetched = new Map<number, DomNode>();
      await Promise.all(
        [...want].map(async ([ns, depth]) => {
          const doc = await fetchDocument(ns, depth, pierce, reset).catch(() => undefined);
          if (doc) {
            fetched.set(ns, doc);
            keepRoot(ns, shallow(doc));
          } else if (reset) roots.delete(ns);
        })
      );
      grafted = fetched;
      try {
        return serialize();
      } finally {
        grafted = null;
      }
    },

    async pushInside(node, depth, pierce) {
      if (!pierce || depth === 0) return;
      const asked: Promise<unknown>[] = [];
      for (const [ns, link] of mergedFrames.frames()) {
        const root = roots.get(ns);
        if (!root || nodes.knownId(link.owner) === undefined) continue;
        // How many levels below `node` the iframe is: shadow roots and documents are on their host's.
        let steps = 0;
        let n: Node | null = link.owner;
        while (n && n !== node) {
          if (isShadowRoot(n)) n = n.host;
          else if (isDocument(n)) n = ctx.frames.ofDocument(n)?.owner ?? null;
          else {
            n = n.parentNode;
            steps++;
          }
        }
        if (!n) continue;
        const left = depth === -1 ? -1 : depth - steps;
        if (left === 0 || left < -1) continue;
        asked.push(ask(ns, 'DOM.requestChildNodes', { nodeId: root.nodeId, depth: left, pierce }).catch(() => {}));
      }
      await Promise.all(asked);
    },

    async nodeAt(owner, x, y, params) {
      const merged = mergedFrames.linkOf(owner);
      if (!merged) return undefined;
      const inner = pointInOwnerContent(owner, x, y);
      try {
        // The frame's agent takes a point of its document, as the client gives one of the top's.
        const scroll = await ask(merged.ns, 'Runtime.evaluate', {
          expression: '[scrollX, scrollY]',
          returnByValue: true,
        });
        const result: unknown =
          typeof scroll === 'object' && scroll !== null ? Reflect.get(scroll, 'result') : undefined;
        const [sx = 0, sy = 0] = numbersIn(result, 'value');
        return await ask(merged.ns, 'DOM.getNodeForLocation', { ...params, x: inner.x + sx, y: inner.y + sy });
      } catch {
        // Its border or padding, or a frame that does not answer: the iframe, as Chrome finds.
        return undefined;
      }
    },

    async quadsIn(ns, method, params) {
      const owner = linkOfNs(ns)?.owner;
      const result = await ask(ns, method, params);
      if (!owner || typeof result !== 'object' || result === null) return result;
      // Like Chrome, a node in an iframe is placed where the iframe shows it.
      const m = ownerContentToTop(owner);
      const model: unknown = Reflect.get(result, 'model');
      if (typeof model === 'object' && model !== null) {
        const mapped: Record<string, unknown> = { ...model };
        for (const key of ['content', 'padding', 'border', 'margin']) mapped[key] = mapPoints(m, numbersIn(model, key));
        return { ...result, model: mapped };
      }
      const quads: unknown = Reflect.get(result, 'quads');
      return Array.isArray(quads)
        ? {
            ...result,
            quads: quads.map(q => mapPoints(m, Array.isArray(q) ? q.filter(v => typeof v === 'number') : [])),
          }
        : result;
    },

    async search(params) {
      const parts = await Promise.all(
        [...mergedFrames.frames()].map(async ([ns]) => {
          try {
            const result = await ask(ns, 'DOM.performSearch', params);
            const searchId: unknown =
              typeof result === 'object' && result !== null ? Reflect.get(result, 'searchId') : '';
            const count: unknown =
              typeof result === 'object' && result !== null ? Reflect.get(result, 'resultCount') : 0;
            return typeof searchId === 'string' && typeof count === 'number' ? [{ ns, searchId, count }] : [];
          } catch {
            return [];
          }
        })
      );
      return parts.flat();
    },

    pushPath(owner, path) {
      const merged = mergedFrames.linkOf(owner);
      const root = merged && roots.get(merged.ns);
      if (!merged || !root) return undefined;
      if (!path.length) return Promise.resolve({ nodeId: root.nodeId });
      return ask(merged.ns, 'DOM.pushNodeByPathToFrontend', { path: path.join(',') });
    },

    follow(resend) {
      stopLinked ??= mergedFrames.onLinked((ns, link) => {
        roots.delete(ns);
        // Like Chrome, a reloaded frame's iframe is removed and inserted again, with its new document.
        ask(ns, 'DOM.getDocument', { depth: 0 }).then(
          result => {
            const root = nodeIn(result, 'root');
            if (!root || !stopLinked || mergedFrames.linkOf(link.owner)?.link !== link) return;
            keepRoot(ns, root);
            if (isFrameOwner(link.owner) && nodes.knownId(link.owner) !== undefined) resend(link.owner);
          },
          () => {}
        );
      });
    },

    recordEdit,

    async replayed() {
      const asked = replays;
      replays = [];
      await Promise.all(asked);
    },

    unfollow() {
      stopLinked?.();
      stopLinked = null;
      roots.clear();
    },
  };
}
