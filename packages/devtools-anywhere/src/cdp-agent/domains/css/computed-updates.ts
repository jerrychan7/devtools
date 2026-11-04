import type { Protocol } from 'devtools-protocol';
import { documentOf, isElement, realmOf } from '../../core/realm';
import { type Inspectable, type NodeRegistry, PseudoElement, isOwn } from '../../core/nodes';
import { CdpError } from '../../core/session';

/** What may change a computed style: the DOM, in the documents and shadow trees. */
const OBSERVED: MutationObserverInit = { attributes: true, childList: true, subtree: true, characterData: true };

/** Like Chrome, `CSS.computedStyleUpdated` is sent at most once per this many milliseconds. */
const THROTTLE = 100;

/**
 * The computed style updates of CSS.trackComputedStyleUpdatesForNode (one node, reported with
 * `CSS.computedStyleUpdated`) and CSS.trackComputedStyleUpdates (some properties of the nodes the
 * client knows, collected by CSS.takeComputedStyleUpdates).
 *
 * The page does not tell when styles are recalculated: the computed styles are compared after
 * each DOM mutation and after the agent's own style edits ({@link check}). A change by the CSSOM
 * from a script, or by an animation or a transition, is seen with the next mutation only.
 */
export class ComputedStyleUpdates {
  private observer: MutationObserver | null = null;
  /** The node of trackComputedStyleUpdatesForNode, its id and its last computed style. */
  private node: { target: Inspectable; nodeId: number; style: string } | null = null;
  private lastSent = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The properties of trackComputedStyleUpdates, their values per known element, and the changed ones. */
  private properties: string[] = [];
  private values = new WeakMap<Element, string>();
  private updated = new Set<number>();
  private waiting: ((nodeIds: number[]) => void) | null = null;

  private readonly nodes: NodeRegistry;
  /** The trees to watch: the frames' documents and the shadow roots in them. */
  private readonly trees: () => (Document | ShadowRoot)[];
  private readonly emit: (nodeId: number) => void;

  constructor(nodes: NodeRegistry, trees: () => (Document | ShadowRoot)[], emit: (nodeId: number) => void) {
    this.nodes = nodes;
    this.trees = trees;
    this.emit = emit;
  }

  /** trackComputedStyleUpdatesForNode: without a node (or with an unknown one), tracking stops. */
  trackNode(nodeId: number | undefined) {
    const target = nodeId === undefined ? undefined : this.nodes.get(nodeId);
    const el = target instanceof PseudoElement ? target.host : target;
    this.node = nodeId !== undefined && target && isElement(el) ? { target, nodeId, style: styleOf(target) } : null;
    this.watch();
  }

  /** trackComputedStyleUpdates: an empty list stops tracking, answering a waiting take with none. */
  trackProperties(properties: Protocol.CSS.CSSComputedStyleProperty[]) {
    this.properties = properties.map(p => p.name);
    this.values = new WeakMap();
    this.updated.clear();
    if (this.properties.length) this.scan();
    else this.resolve([]);
    this.watch();
  }

  /** takeComputedStyleUpdates: the nodes changed since the last call, waiting for one if none. */
  take(): Promise<Protocol.CSS.TakeComputedStyleUpdatesResponse> {
    if (!this.properties.length) throw new CdpError('No computed styles are being tracked right now.');
    // Like Chrome, a take still waiting is answered with none.
    this.resolve([]);
    return new Promise(resolve => {
      this.waiting = nodeIds => resolve({ nodeIds });
      this.flush();
    });
  }

  /** Compares the tracked computed styles now, e.g. after a style edit that made no DOM mutation. */
  check = () => {
    if (this.properties.length) {
      this.scan();
      this.flush();
    }
    if (!this.node) return;
    const style = styleOf(this.node.target);
    if (style === this.node.style) return;
    this.node.style = style;
    this.schedule();
  };

  stop() {
    this.node = null;
    this.trackProperties([]);
  }

  /** Observes the trees while anything is tracked. */
  private watch() {
    if (!this.node && !this.properties.length) {
      this.observer?.disconnect();
      this.observer = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.observer ??= new MutationObserver(records => {
      // A shadow root may have come with the new elements: observe it too.
      if (records.some(r => r.addedNodes.length)) this.observe();
      this.check();
    });
    this.observe();
  }

  private observe() {
    for (const tree of this.trees()) this.observer?.observe(tree, OBSERVED);
  }

  /** Sends the event now or, within the throttle, once it is over. */
  private schedule() {
    if (this.timer) return;
    const wait = this.lastSent + THROTTLE - Date.now();
    const send = () => {
      this.timer = null;
      this.lastSent = Date.now();
      if (this.node) this.emit(this.node.nodeId);
    };
    if (wait <= 0) send();
    else this.timer = setTimeout(send, wait);
  }

  /** Records the elements the client knows whose tracked properties changed. */
  private scan() {
    for (const tree of this.trees()) {
      const walker = documentOf(tree).createTreeWalker(tree, NodeFilter.SHOW_ELEMENT);
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (!isElement(el) || isOwn(el)) continue;
        const nodeId = this.nodes.knownId(el);
        if (nodeId === undefined) continue;
        const style = realmOf(el).getComputedStyle(el);
        const value = this.properties.map(name => style.getPropertyValue(name)).join('\n');
        const old = this.values.get(el);
        this.values.set(el, value);
        // Like Chrome, a node first seen is not a change.
        if (old !== undefined && old !== value) this.updated.add(nodeId);
      }
    }
  }

  private flush() {
    if (!this.waiting || !this.updated.size) return;
    const nodeIds = Array.from(this.updated);
    this.updated.clear();
    this.resolve(nodeIds);
  }

  private resolve(nodeIds: number[]) {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(nodeIds);
  }
}

/** The whole computed style of an element or a pseudo-element, to compare. */
function styleOf(target: Inspectable): string {
  const el = target instanceof PseudoElement ? target.host : target;
  if (!isElement(el)) return '';
  const style = realmOf(el).getComputedStyle(el, target instanceof PseudoElement ? `::${target.pseudoType}` : null);
  return Array.from(style, name => style.getPropertyValue(name)).join('\n');
}
