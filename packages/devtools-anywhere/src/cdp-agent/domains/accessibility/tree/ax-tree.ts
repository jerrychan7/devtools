// The shape of the accessibility tree: which DOM nodes are in it, with which role, and in which
// order. Part of accessibility.js, loaded on demand (ax-node.ts).
//
// Blink builds its tree from the layout tree (third_party/blink/renderer/modules/accessibility/),
// which a page cannot read: these rules redo the common cases from the DOM and computed styles,
// checked against Chrome's getFullAXTree (accessibility.conformance.test.ts). The role mapping is
// Chrome's: ARIA roles where it gives them, its own (capitalized) roles elsewhere.
import { isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../../core/realm';
import { spaceShows } from '../name/ax-text';
import { HiddenKeeper } from './ax-hidden';
import { isVirtual, selectOf, virtualChildrenOf, type AXRef, type VirtualNode } from './ax-virtual';
import {
  attr,
  attrNames,
  closedDetailsOf,
  closest,
  domChildren,
  domParent,
  hasAttr,
  hiddenReason,
  isMenuList,
  rootOf,
  scopeOf,
} from '../ax-dom';
import { excluded, hidden, ignored, INCLUDED, type Inclusion, lifted, NOT_RENDERED, OPAQUE } from './ax-ignored';
import {
  areasOf,
  explicitRole,
  generatesMarker,
  hasAuthorName,
  imageOf,
  inSvg,
  isRedundantLabel,
  roleOf,
  SVG_NS,
  svgInclusion,
} from '../ax-role';
import {
  bodyKept,
  genericInclusion,
  inPopup,
  isInteresting,
  isPlainGeneric,
  layoutContent,
  meterOf,
  NAME_FROM_CONTENTS,
} from './ax-generic';
import { ownersOf } from './ax-owns';

/** The tree's structure over one document, with aria-owns resolved. */
export class TreeShape {
  /** Elements moved by aria-owns, to their owner. */
  private owner: Map<Element, Element>;
  private owned = new Map<Element, Element[]>();
  /** Inclusions computed already: a shape serves one request. */
  private inclusions = new WeakMap<Node, Inclusion>();
  /** VirtualNodes by host, by host and key, and the VirtualNode a DOM node is placed under. */
  private virtuals = new Map<Element, VirtualNode[] | null>();
  private keyed = new Map<Element, Map<string, VirtualNode>>();
  private placed = new Map<Node, VirtualNode>();
  readonly doc: Document;
  /** What is kept of hidden subtrees. */
  private hidden: HiddenKeeper;
  /** The text a text field or input button shows, for its VirtualNodes. */
  private fieldText: (el: Element) => string;

  constructor(doc: Document, fieldText: (el: Element) => string = () => '') {
    this.doc = doc;
    this.fieldText = fieldText;
    this.owner = ownersOf(doc);
    this.hidden = new HiddenKeeper(doc, el => {
      const scope = scopeOf(el);
      return scope ? ownersOf(scope).get(el) : undefined;
    });
    for (const [target, el] of this.owner) this.owned.set(el, [...(this.owned.get(el) ?? []), target]);
  }

  /**
   * How a node takes part in the tree (Inclusion). An element aria-owns moves stays in the tree
   * when presentational or aria-hidden, ignored, as in Chrome; so does a list item with a marker,
   * and one with visibility: hidden, which keeps its marker.
   */
  inclusion(node: AXRef): Inclusion {
    if (isVirtual(node)) return node.inclusion;
    let inclusion = this.inclusions.get(node);
    if (!inclusion) {
      inclusion = this.ownInclusion(node);
      if (inclusion.kind === 'lifted' || inclusion.kind === 'excluded') {
        const raised = inclusion.kind === 'lifted';
        const unseen = inclusion.reason === 'notVisible';
        // What aria-owns moves stays too (its owner shows), hidden or not.
        if (
          (this.owner.has(node as Element) && (raised || !!this.hidden.hiding(node as Element))) ||
          ((raised || unseen) && isElement(node) && generatesMarker(node)) ||
          (raised && inclusion.reason === 'uninteresting' && this.inNameSource(node))
        )
          inclusion = ignored(inclusion.reason);
      }
      this.inclusions.set(node, inclusion);
    }
    return inclusion;
  }

  /** Whether a hidden element is kept in the tree without its subtree (ax-hidden.ts). */
  keptAlone(el: Element): boolean {
    return this.hidden.keepsAlone(el);
  }

  /**
   * Whether a display: contents element (a slot, by default) is where Chrome keeps it, ignored, as
   * part of a name's source: in a label or an aria-labelledby or aria-describedby target, or under
   * an element named from its content, with only ignored or lifted nodes between them.
   */
  private inNameSource(node: Node): boolean {
    if (!isElement(node) || styleOf(node).display !== 'contents') return false;
    // A slot with nothing to show is never kept.
    if (isHtml(node, 'slot') && !domChildren(node).length) return false;
    for (let p = domParent(node); p && isElement(p); p = domParent(p)) {
      if (isHtml(p, 'label') || this.hidden.isReferenced(p)) return true;
      if (this.inclusion(p).kind === 'included') return NAME_FROM_CONTENTS.has(roleOf(p));
    }
    return false;
  }

  /** How a node takes part in the tree, wherever aria-owns puts it. */
  private ownInclusion(node: Node): Inclusion {
    if (node === this.doc) return INCLUDED;
    if (closedDetailsOf(node)) return excluded('notRendered');
    // A meter's content is not rendered: its bar (ax-virtual.ts) stands in for it.
    if (meterOf(node)) return excluded('notRendered');
    if (isText(node)) {
      const parent = domParent(node);
      // A drop-down select shows the text it holds in its popup, but for white space.
      if (isMenuList(parent as Element | null) && !node.data.trim()) return excluded('uninteresting');
      if (!parent || (isElement(parent) && OPAQUE.has(parent.localName) && !isMenuList(parent)))
        return excluded('notRendered');
      // In an svg, only its text elements draw text.
      if (isElement(parent) && parent.namespaceURI === SVG_NS && !/^(text|tspan|textPath)$/.test(parent.localName))
        return excluded('notRendered');
      const hiding = this.hidden.hiding(node);
      if (hiding) {
        // What aria-hidden hides in an svg is left out of the tree.
        if (hiding.mode !== 'none' && (parent as Element).namespaceURI === SVG_NS) return excluded(hiding.reason);
        if (!this.hidden.isKept(node)) return excluded(hiding.reason);
      }
      if (!node.data.trim() && !spaceShows(node)) return excluded('uninteresting');
      if (hiding) return hidden('ignored', hiding);
      return isElement(parent) && isRedundantLabel(parent) ? ignored('presentationalRole') : INCLUDED;
    }
    if (!isElement(node)) return excluded('uninteresting');
    if (closest(node, '[data-devtools-anywhere]')) return excluded('notRendered');
    // An image map's area is shown through its image, whatever its own box.
    let hiddenBy = isHtml(node, 'area') && imageOf(node) ? null : hiddenReason(node);
    // A hidden option is still in a drop-down's popup, and ignored in a list box.
    const select = hiddenBy === 'notRendered' && selectOf(node);
    if (select && !hiddenReason(select)) {
      if (!isMenuList(select)) return ignored('notRendered');
      hiddenBy = null;
    }
    // A hidden element is left out with its subtree, but for those Chrome keeps (ax-hidden.ts),
    // ignored, and the hidden elements around them.
    const hiding = hiddenBy === null && (select || isHtml(node, 'area')) ? null : this.hidden.hiding(node);
    if (hiding) {
      if (hiding.mode !== 'none' && node.namespaceURI === SVG_NS) return excluded('ariaHiddenSubtree');
      if (this.hidden.isKept(node) || isMenuList(domParent(node) as Element | null)) return hidden('ignored', hiding);
      return hidden(this.hidden.holdsKept(node) ? 'lifted' : 'excluded', hiding);
    }
    if (
      isHtmlElement(node) &&
      (NOT_RENDERED.has(node.localName) ||
        (node.localName === 'embed' && !hasAttr(node, 'src') && !hasAttr(node, 'type')))
    )
      return excluded('notRendered');
    if (node === this.doc.documentElement) return ignored('uninteresting');
    // The body is ignored unless something makes it worth a node: a role or ARIA attribute, a
    // title, an id, contenteditable, or a click, mousedown or mouseup handler (on* properties only: listeners
    // added with addEventListener are not seen here). A tabindex or scrolling does not keep it.
    if (node === this.doc.body && !bodyKept(node)) return ignored('uninteresting');
    // A tbody without a role, ARIA attribute, title, id (a possible link target) or tabindex is ignored;
    // thead and tfoot are kept.
    if (
      node.localName === 'tbody' &&
      !attrNames(node).some(n => n.startsWith('aria-') || n === 'role') &&
      !attr(node, 'title') &&
      !(node.id && !isShadowRoot(rootOf(node))) &&
      !hasAttr(node, 'tabindex')
    )
      return ignored('uninteresting');
    // Chrome gives a ruby's annotation as its description only.
    if (node.localName === 'rt' && node.parentElement?.localName === 'ruby')
      return { kind: 'ignored', reason: 'uninteresting', noReason: true };
    const explicit = explicitRole(node);
    if (node.namespaceURI === SVG_NS && !explicit && inSvg(node)) return svgInclusion(node);
    // An empty root svg without a name is no image.
    if (
      node.localName === 'svg' &&
      node.namespaceURI === SVG_NS &&
      !node.firstElementChild &&
      !explicit &&
      !hasAuthorName(node) &&
      (node.parentNode as Element | null)?.namespaceURI !== SVG_NS
    )
      return ignored('uninteresting');
    // A list item in a native list given another role is presentational, whatever its attributes.
    if (
      node.localName === 'li' &&
      !explicit &&
      /^(ul|ol|menu)$/.test(node.parentElement?.localName ?? '') &&
      // Chrome compares the role attribute as written: only "list" and "directory" keep the item.
      !/^(|list|directory)$/.test((node.parentElement && attr(node.parentElement, 'role')) ?? '')
    )
      return lifted('presentationalRole');
    if (
      node.localName === 'img' &&
      attr(node, 'alt') === '' &&
      !explicit &&
      !hasAttr(node, 'aria-label') &&
      !hasAttr(node, 'aria-labelledby') &&
      !attr(node, 'title')
    )
      return lifted('emptyAlt');
    // A presentational label stays in the tree, ignored, with what it holds.
    if (explicit === 'none')
      return isHtml(node, 'label') ? ignored('presentationalRole') : lifted('presentationalRole');
    if (isRedundantLabel(node)) return ignored('labelFor');
    if (!explicit && isPlainGeneric(node)) {
      // In a drop-down's popup, which is not laid out, a container is kept whatever its box; in
      // a list box, one Chrome would lift is ignored in place.
      if (inPopup(node)) return INCLUDED;
      const inclusion = genericInclusion(node);
      return inclusion.kind === 'lifted' && isHtml(domParent(node), 'select') ? ignored(inclusion.reason) : inclusion;
    }
    // An empty paragraph is ignored too.
    if (!explicit && isHtml(node, 'p') && !isInteresting(node) && layoutContent(node) === 'none')
      return ignored('uninteresting');
    return INCLUDED;
  }

  /** Whether a node is in the tree (included or ignored). */
  inTree(node: AXRef): boolean {
    const kind = this.inclusion(node).kind;
    return kind === 'included' || kind === 'ignored';
  }

  /** The nodes in the tree under a node, in order: lifted nodes give their own. */
  children(node: AXRef): AXRef[] {
    const out: AXRef[] = [];
    // Elements moved here (`moved`) by aria-owns or as an image's areas, the others where they are.
    const visit = (child: AXRef, moved?: boolean) => {
      if (isVirtual(child)) {
        out.push(child);
        return;
      }
      if (!moved && isElement(child) && (this.owner.has(child) || (isHtml(child, 'area') && imageOf(child)))) return;
      const inclusion = this.inclusion(child);
      if (inclusion.kind === 'excluded') return;
      if (inclusion.kind === 'lifted') {
        for (const c of this.ownChildren(child)) visit(c);
        return;
      }
      out.push(child);
    };
    // What aria-owns took from a VirtualNode (a details' summary) is under its owner instead.
    if (isVirtual(node)) {
      for (const child of node.raw)
        if (isVirtual(child) || !(isElement(child) && this.owner.has(child))) visit(child, true);
      return out;
    }
    // A hidden select Chrome keeps holds its options, not a popup; a hidden field nothing.
    if ((isHtml(node, 'select') || isHtml(node, 'input') || isHtml(node, 'textarea')) && this.hidden.hiding(node)) {
      if (isHtml(node, 'select')) for (const child of domChildren(node)) visit(child);
      return out;
    }
    const virtuals = isElement(node) && this.virtualChildren(node);
    // A host's aria-owns puts the elements it owns after its VirtualNodes, as in Chrome.
    if (virtuals) {
      out.push(...virtuals);
      if (isElement(node)) for (const el of this.owned.get(node) ?? []) visit(el, true);
      return out;
    }
    for (const child of this.ownChildren(node)) visit(child);
    if (isHtml(node, 'img')) for (const area of areasOf(node)) visit(area, true);
    if (isElement(node)) for (const el of this.owned.get(node) ?? []) visit(el, true);
    return out;
  }

  /** A node's DOM children, none for the elements whose content the tree replaces. */
  private ownChildren(node: Node): Node[] {
    if (isElement(node) && OPAQUE.has(node.localName)) return [];
    if (
      isElement(node) &&
      /^(checkbox|radio|slider|image|img|progressbar|separator|scrollbar|textbox)$/.test(roleOf(node)) &&
      node.localName !== 'div'
    )
      return [];
    return domChildren(node);
  }

  /** The elements aria-owns moves to an element, in its aria-owns order. */
  ownedBy(el: Element): Element[] {
    return this.owned.get(el) ?? [];
  }

  /** A host's VirtualNodes (ax-virtual.ts), built once: null for an element without. */
  virtualChildren(el: Element): VirtualNode[] | null {
    let top = this.virtuals.get(el);
    if (top === undefined) {
      top = virtualChildrenOf(el, this.fieldText);
      this.virtuals.set(el, top);
      const keys = new Map<string, VirtualNode>();
      this.keyed.set(el, keys);
      const register = (v: VirtualNode) => {
        keys.set(v.key, v);
        for (const child of v.raw)
          if (isVirtual(child)) {
            child.parent = v;
            register(child);
          } else this.placed.set(child, v);
      };
      for (const v of top ?? []) register(v);
    }
    return top;
  }

  /** The VirtualNode of a host by its key, if the host has one. */
  virtual(host: Element, key: string): VirtualNode | null {
    this.virtualChildren(host);
    return this.keyed.get(host)?.get(key) ?? null;
  }

  /** The closest node in the tree above a node: its aria-owns owner, or its DOM ancestor. */
  parent(node: AXRef): AXRef | null {
    if (isVirtual(node)) return node.parent;
    if (node === this.doc) return null;
    // A meter's content has no parent in the tree, as in Chrome.
    if (meterOf(node)) return null;
    // A closed details' content is under its content slot, which does not list it.
    const details = closedDetailsOf(node);
    if (details) return this.virtual(details, 'content-slot');
    const host = domParent(node);
    const placed =
      isElement(host) &&
      this.virtualChildren(host) &&
      !(isElement(node) && this.owner.has(node)) &&
      this.placed.get(node);
    if (placed) return placed;
    let n: Node | null = isElement(node)
      ? (this.owner.get(node) ?? (isHtml(node, 'area') ? imageOf(node) : null) ?? domParent(node))
      : domParent(node);
    while (n && n !== this.doc && !this.inTree(n))
      n = isElement(n) ? (this.owner.get(n) ?? domParent(n)) : domParent(n);
    return n;
  }
}
