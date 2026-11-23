// The nodes Chrome's tree has under a control without a DOM node the page can see: those of the
// user-agent shadow tree (a select's popup, the slot of a list box or an optgroup, a text field's
// placeholder and inner editor with its text, an input button's text, a color well's swatch, a
// details element's slots). Each is a
// VirtualNode, found again by its host element and a key unique in that host: the Accessibility
// domain gives it an id of its own (accessibility.ts), apart from the DOM nodes' backend ids.
// A list marker and its text children are VirtualNodes too, keys `marker` and `marker:<n>`, built
// in ax-node.ts (ax-marker.ts); the marker has its ::marker's backend id.
// So are generated content, keys `before`, `after` and `before:<n>`… (ax-generated.ts), the
// pseudo-element nodes with their ::before and ::after backend ids.
import { domChildren, hasAttr, isMenuList, matches, type Inclusion } from './ax-tree';
import { isElement, isHtml, styleOf } from '../../core/realm';

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
const NO_REASON: Inclusion = { kind: 'ignored', reason: 'uninteresting', noReason: true };

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
 * a drop-down select's MenuListPopup and a list box's slot over the options, an optgroup's slot,
 * a text field's nodes, an input button's text, a color well's swatch, a details element's slots. `fieldText`: the text a field or button shows.
 */
export function virtualChildrenOf(el: Element, fieldText: (el: Element) => string): VirtualNode[] | null {
  if (!isElement(el)) return null;
  if (isHtml(el, 'select'))
    return [
      isMenuList(el)
        ? new VirtualNode(el, 'popup', 'MenuListPopup', INCLUDED, optionsOf(el))
        : new VirtualNode(el, 'slot', 'generic', UNINTERESTING, optionsOf(el)),
    ];
  if (isHtml(el, 'details')) return detailsChildren(el);
  if (isHtml(el, 'optgroup') && selectOf(el))
    return [new VirtualNode(el, 'slot', 'generic', UNINTERESTING, optionsOf(el))];
  if (isHtml(el, 'textarea') || (isHtml(el, 'input') && TEXT_FIELD.test(el.type)))
    return textFieldChildren(el, fieldText(el));
  if (isHtml(el, 'input') && /^(submit|reset|button)$/.test(el.type)) {
    const text = fieldText(el);
    return text ? [textNode(el, 'text', 'StaticText', text, false)] : [];
  }
  // A color well's swatch, in its wrapper.
  if (isHtml(el, 'input') && el.type === 'color')
    return [
      new VirtualNode(el, 'wrapper', 'generic', UNINTERESTING, [
        new VirtualNode(el, 'swatch', 'generic', UNINTERESTING),
      ]),
    ];
  return null;
}

/**
 * A details element's two slots, ignored: the first holds its first summary child, the other the
 * rest of its children, none while it is closed (its content is not rendered then). A summary is
 * not made when the details has none: Chrome's default one has the browser's localized "Details"
 * as its text, which the page cannot know. In an open flex details, the content slot is a generic.
 */
function detailsChildren(el: HTMLDetailsElement): VirtualNode[] {
  const children = domChildren(el);
  const summary = children.find(c => isHtml(c, 'summary'));
  const flex = el.open && /\bflex\b/.test(styleOf(el).display);
  return [
    new VirtualNode(el, 'summary-slot', 'generic', UNINTERESTING, summary ? [summary] : []),
    new VirtualNode(
      el,
      'content-slot',
      'generic',
      flex ? INCLUDED : UNINTERESTING,
      el.open ? children.filter(c => c !== summary) : []
    ),
  ];
}

/** The inputs that edit text in an inner editor. */
const TEXT_FIELD = /^(text|search|email|url|tel|password|number)$/;

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
