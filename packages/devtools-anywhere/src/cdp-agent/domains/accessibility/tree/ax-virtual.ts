// The nodes Chrome's tree has under a control without a DOM node the page can see: those of the
// user-agent shadow tree (a select's popup, the slot of a list box or an optgroup, a text field's
// placeholder and inner editor with its text, an input button's text, a meter's bar, a color well's swatch, a
// details element's slots). Each is a
// VirtualNode, found again by its host element and a key unique in that host: the Accessibility
// domain gives it an id of its own (accessibility.ts), apart from the DOM nodes' backend ids.
// A list marker and its text children are VirtualNodes too, keys `marker` and `marker:<n>`, built
// in ax-node.ts (ax-marker.ts); the marker has its ::marker's backend id.
// So are generated content, keys `before`, `after` and `before:<n>`… (ax-generated.ts), the
// pseudo-element nodes with their ::before and ::after backend ids.
import {
  attr,
  byId,
  domChildren,
  domParent,
  hasAttr,
  hiddenReason,
  queryAll,
  scopeOf,
  isMenuList,
  matches,
} from '../ax-dom';
import { type Inclusion } from './ax-ignored';
import { roleOf } from '../ax-role';
import { layoutOf } from './ax-generic';
import { isElement, isHtml, isText, styleOf } from '../../../core/realm';

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
  /** The text of a StaticText or LineBreak. */
  text = '';
  /** Its name, where it is not its text: a generated text whose white space is preserved. */
  name?: string;
  /** Whether it is in a text field the user can edit (`editable` plaintext). */
  editable = false;
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
/** Ignored without a reason given, as Chrome does a text field's wrappers. */
const NO_REASON: Inclusion = {
  kind: 'ignored',
  reason: 'uninteresting',
  noReason: true,
};

/** The options and groups of a select or an optgroup, as Chrome lists them. */
const optionsOf = (el: Element): Node[] =>
  domChildren(el).filter(c => isHtml(c, 'option') || (isHtml(c, 'optgroup') && isHtml(el, 'select')));

/**
 * The slot over the options of an optgroup, or over the elements of a list box (its text is not
 * shown), none while it has none.
 */
function slotOf(el: Element, options: Node[]): VirtualNode[] {
  return options.length ? [new VirtualNode(el, 'slot', 'generic', UNINTERESTING, options)] : [];
}

/** The select an option or optgroup is in, if any. */
export function selectOf(el: Element): HTMLSelectElement | null {
  let p = el.parentElement;
  if (isHtml(p, 'optgroup')) p = p.parentElement;
  return isHtml(p, 'select') ? p : null;
}

/**
 * The VirtualNodes Chrome puts between a host and its children, null for an element without:
 * a drop-down select's MenuListPopup and a list box's slot over the options, an optgroup's slot,
 * a text field's nodes, an input button's text, a meter's bar, a color well's swatch, a details element's slots. `fieldText`: the text a field or button shows.
 */
export function virtualChildrenOf(el: Element, fieldText: (el: Element) => string): VirtualNode[] | null {
  if (!isElement(el)) return null;
  if (isHtml(el, 'select')) return isMenuList(el) ? [menuListPopup(el)] : slotOf(el, domChildren(el).filter(isElement));
  if (isHtml(el, 'details')) return detailsChildren(el);
  if (isHtml(el, 'optgroup') && selectOf(el)) return slotOf(el, optionsOf(el));
  if (isHtml(el, 'textarea') || (isHtml(el, 'input') && TEXT_FIELD.test(el.type)))
    return textFieldChildren(el, fieldText(el));
  if (isHtml(el, 'input') && /^(submit|reset|button)$/.test(el.type)) {
    const text = fieldText(el);
    return text ? [textNode(el, 'text', 'StaticText', text, false)] : [];
  }
  // A meter's bar, in its two wrappers: its own content is not rendered. None while the meter
  // has no box shown, or is hidden from the tree by aria-hidden.
  if (isHtml(el, 'meter'))
    return !shown(el)
      ? []
      : [
          new VirtualNode(el, 'inner', 'generic', INCLUDED, [
            new VirtualNode(el, 'bar', 'generic', INCLUDED, [new VirtualNode(el, 'value', 'generic', UNINTERESTING)]),
          ]),
        ];
  // A color well's swatch, in its wrapper.
  if (isHtml(el, 'input') && el.type === 'color')
    return [
      new VirtualNode(el, 'wrapper', 'generic', UNINTERESTING, [
        new VirtualNode(el, 'swatch', 'generic', UNINTERESTING),
      ]),
    ];
  return null;
}

/** Whether an element has a box that is painted, outside any aria-hidden subtree. */
function shown(el: Element): boolean {
  if (hiddenReason(el) || styleOf(el).display === 'contents') return false;
  for (let n: Node | null = el; n && isElement(n); n = domParent(n))
    if (attr(n, 'aria-hidden') === 'true') return false;
  return true;
}

/**
 * A drop-down select's popup: a MenuListPopup while the select is a combobox, ignored under any
 * other ARIA role (a menu, a listbox, a button). Its slot over the options shows, ignored, once a
 * name computation reads the select: Chrome only makes the slot's node then.
 */
function menuListPopup(el: HTMLSelectElement): VirtualNode {
  // Its text and other elements show in the popup too, beside the options.
  const options = domChildren(el);
  const raw = nameReads(el) ? [new VirtualNode(el, 'popup-slot', 'generic', UNINTERESTING, options)] : options;
  return roleOf(el) === 'combobox'
    ? new VirtualNode(el, 'popup', 'MenuListPopup', INCLUDED, raw)
    : new VirtualNode(el, 'popup', 'generic', { kind: 'ignored', reason: 'notRendered' }, raw);
}

/** Roles whose name Chrome computes from their content (ax-name.ts NAME_FROM_CONTENTS). */
const NAMED_FROM_CONTENTS = new Set(
  (
    'button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox menuitemradio option radio ' +
    'rowheader switch tab tooltip treeitem LayoutTableCell term math'
  ).split(' ')
);

/** The targets of aria-labelledby and aria-describedby by scope, kept for one synchronous pass like ownersOf. */
let referenced: WeakMap<Document | ShadowRoot, Set<Element>> | null = null;

/** The targets of aria-labelledby and aria-describedby in a document or shadow root, found once a pass. */
function referencedIn(scope: Document | ShadowRoot): Set<Element> {
  if (!referenced) {
    referenced = new WeakMap();
    queueMicrotask(() => (referenced = null));
  }
  let read = referenced.get(scope);
  if (!read) {
    referenced.set(scope, (read = new Set()));
    for (const from of queryAll(scope, '[aria-labelledby], [aria-describedby]'))
      for (const attribute of ['aria-labelledby', 'aria-describedby'])
        for (const idref of (attr(from, attribute) ?? '').split(/\s+/)) {
          const target = idref && byId(scope, idref);
          if (target) read.add(target);
        }
  }
  return read;
}

/**
 * Whether a name computation reads an element: it or an ancestor is a label, takes its name from
 * its content, or is named or described by another element through aria-labelledby or
 * aria-describedby (each name is computed, with every source, aria-label or not).
 */
function nameReads(el: Element): boolean {
  const scope = scopeOf(el);
  const read = scope ? referencedIn(scope) : new Set<Element>();
  for (let n: Node | null = el; n && isElement(n); n = domParent(n))
    if (isHtml(n, 'label') || NAMED_FROM_CONTENTS.has(roleOf(n)) || read.has(n)) return true;
  return false;
}

/**
 * A details element's two slots, ignored: the first holds its first summary child, the other the
 * rest of its children, none while it is closed (its content is not rendered then). A summary is
 * not made when the details has none: Chrome's default one has the browser's localized "Details"
 * as its text, which the page cannot know. The content slot is a generic when its content is laid
 * out in lines, as a block's. It is not made when nothing is assigned to it: no element or text but
 * the summary (a comment is not assigned), as Chrome leaves an empty slot out.
 */
function detailsChildren(el: HTMLDetailsElement): VirtualNode[] {
  const children = domChildren(el);
  const summary = children.find(c => isHtml(c, 'summary'));
  const content = children.filter(c => c !== summary && (isElement(c) || isText(c)));
  const summarySlot = new VirtualNode(el, 'summary-slot', 'generic', UNINTERESTING, summary ? [summary] : []);
  if (!content.length) return [summarySlot];
  const shown = el.open ? content : [];
  // Like a block, the content slot is a generic when it holds only inline content.
  const lines = layoutOf(shown) === 'inline';
  return [summarySlot, new VirtualNode(el, 'content-slot', 'generic', lines ? INCLUDED : UNINTERESTING, shown)];
}

/** The inputs that edit text in an inner editor. */
const TEXT_FIELD = /^(text|search|email|url|tel|password|number)$/;

/** Whether an element is a text field: a textarea, or an input Chrome shows as one. */
export function isTextFieldHost(el: Element): boolean {
  return isHtml(el, 'textarea') || (isHtml(el, 'input') && TEXT_FIELD.test(el.type));
}

function textNode(host: Element, key: string, role: string, text: string, editable: boolean): VirtualNode {
  const node = new VirtualNode(host, key, role, INCLUDED);
  node.text = text;
  node.editable = editable;
  return node;
}

/**
 * A text field's nodes: its placeholder (ignored, not rendered once there is a value), then its
 * inner editor (generic), in the wrappers of a search, number or datalist field, holding the text
 * shown, a textarea's lines apart with a LineBreak for each line feed.
 */
function textFieldChildren(el: HTMLInputElement | HTMLTextAreaElement, text: string): VirtualNode[] {
  const editable = !matches(el, ':disabled') && !el.readOnly;
  const texts: VirtualNode[] = [];
  if (isHtml(el, 'textarea')) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (i) texts.push(textNode(el, `br${i}`, 'LineBreak', '\n', editable));
      if (line) texts.push(textNode(el, `text${i}`, 'StaticText', line, editable));
    });
    // A last line feed shows an empty line, which Chrome ends with one more break.
    if (lines.length > 1 && !lines[lines.length - 1]) texts.push(textNode(el, 'br', 'LineBreak', '\n', editable));
  } else if (text) texts.push(textNode(el, 'text0', 'StaticText', text, editable));
  let inner = new VirtualNode(el, 'editor', 'generic', INCLUDED, texts);
  inner.editable = editable;
  const search = isHtml(el, 'input') && el.type === 'search';
  const wrappers = isHtml(el, 'input') ? (search || el.type === 'number' ? 1 : el.list ? 2 : 0) : 0;
  for (let i = 0; i < wrappers; i++) inner = new VirtualNode(el, `wrapper${i}`, 'generic', NO_REASON, [inner]);
  if (!hasAttr(el, 'placeholder')) return [inner];
  const shown: Inclusion = el.value ? { kind: 'ignored', reason: 'notRendered' } : NO_REASON;
  const placeholder = new VirtualNode(el, 'placeholder', 'generic', shown);
  return [placeholder, inner];
}
