// The nodes Chrome's tree has under a control without a DOM node the page can see: those of the
// user-agent shadow tree (a select's popup, the slot of a list box or an optgroup). Each is a
// VirtualNode, found again by its host element and a key unique in that host: the Accessibility
// domain gives it an id of its own (accessibility.ts), apart from the DOM nodes' backend ids.
import { domChildren, type Inclusion } from './ax-tree';
import { isElement, isHtml } from '../../core/realm';

/** A node of the tree or its DOM node. */
export type AXRef = Node | VirtualNode;

export class VirtualNode {
  readonly host: Element;
  /** Unique among the host's VirtualNodes. */
  readonly key: string;
  readonly role: string;
  readonly inclusion: Inclusion;
  /** Its children before the tree filters them: VirtualNodes, or DOM nodes it holds. */
  readonly raw: AXRef[];
  /** Set when the host's nodes are built: the host, or the VirtualNode above. */
  parent: AXRef;
  constructor(host: Element, key: string, role: string, inclusion: Inclusion, raw: AXRef[] = []) {
    this.host = host;
    this.key = key;
    this.role = role;
    this.inclusion = inclusion;
    this.raw = raw;
    this.parent = host;
  }
}

export const isVirtual = (ref: AXRef): ref is VirtualNode => ref instanceof VirtualNode;

const INCLUDED: Inclusion = { kind: 'included' };
const UNINTERESTING: Inclusion = { kind: 'ignored', reason: 'uninteresting' };

/** The options and groups of a select or an optgroup, as Chrome lists them. */
const optionsOf = (el: Element): Node[] =>
  domChildren(el).filter(c => isHtml(c, 'option') || (isHtml(c, 'optgroup') && isHtml(el, 'select')));

/** The select an option or optgroup is in, if any. */
export function selectOf(el: Element): HTMLSelectElement | null {
  let p = el.parentElement;
  if (isHtml(p, 'optgroup')) p = p.parentElement;
  return isHtml(p, 'select') ? p : null;
}

/**
 * The VirtualNodes Chrome puts between a host and its children, null for an element without:
 * a drop-down select's MenuListPopup and a list box's slot over the options, an optgroup's slot.
 */
export function virtualChildrenOf(el: Element, menuList: (select: Element) => boolean): VirtualNode[] | null {
  if (!isElement(el)) return null;
  if (isHtml(el, 'select'))
    return [
      menuList(el)
        ? new VirtualNode(el, 'popup', 'MenuListPopup', INCLUDED, optionsOf(el))
        : new VirtualNode(el, 'slot', 'generic', UNINTERESTING, optionsOf(el)),
    ];
  if (isHtml(el, 'optgroup') && selectOf(el))
    return [new VirtualNode(el, 'slot', 'generic', UNINTERESTING, optionsOf(el))];
  return null;
}
