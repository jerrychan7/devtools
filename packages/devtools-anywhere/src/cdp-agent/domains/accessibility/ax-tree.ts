// The shape of the accessibility tree: which DOM nodes are in it, with which role, and in which
// order. Part of accessibility.js, loaded on demand (ax-node.ts).
//
// Blink builds its tree from the layout tree (third_party/blink/renderer/modules/accessibility/),
// which a page cannot read: these rules redo the common cases from the DOM and computed styles,
// checked against Chrome's getFullAXTree (accessibility.conformance.test.ts). The role mapping is
// Chrome's: ARIA roles where it gives them, its own (capitalized) roles elsewhere.
import { isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';

/** Whether a role is one of Chrome's own, not an ARIA role (reported as `internalRole`). */
export const isInternalRole = (role: string) => /^[A-Z]/.test(role);

/** Why a node in the tree is ignored (CDP `AXPropertyName`). */
export type IgnoredReason =
  | 'uninteresting'
  | 'ariaHiddenElement'
  | 'ariaHiddenSubtree'
  | 'notRendered'
  | 'notVisible'
  | 'presentationalRole'
  | 'emptyAlt';

/**
 * How a DOM node takes part in the tree: `included`, ignored but kept (`reason`), left out with its
 * children taking its place (`lifted`), or left out with its subtree (`excluded`).
 */
export type Inclusion =
  | { kind: 'included' }
  | { kind: 'ignored'; reason: IgnoredReason; hiddenRoot?: Element }
  | { kind: 'lifted'; reason: IgnoredReason }
  | { kind: 'excluded'; reason: IgnoredReason };

/** Elements whose text and children the page does not show as content: replaced by their value or a popup. */
const OPAQUE = new Set(
  'script style template noscript title head textarea select option input img br wbr iframe object embed video audio canvas svg'.split(
    ' '
  )
);

/** Sectioning elements, inside which `header` and `footer` are no landmarks. */
const SECTIONING = 'article, aside, main, nav, section';

/** The ARIA roles Chrome knows (abstract roles are not among them). */
const ARIA_ROLES = new Set(
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic graphics-document graphics-object graphics-symbol grid gridcell group heading image img insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox sectionfooter sectionheader separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(
    ' '
  )
);
const DOC_ROLE =
  /^doc-(abstract|acknowledgments|afterword|appendix|backlink|biblioentry|bibliography|biblioref|chapter|colophon|conclusion|cover|credit|credits|dedication|endnotes?|epigraph|epilogue|errata|example|footnote|foreword|glossary|glossref|index|introduction|noteref|notice|pagebreak|pagefooter|pageheader|pagelist|part|preface|prologue|pullquote|qna|subtitle|tip|toc)$/;

/** ARIA attributes any element takes: with one, Chrome keeps the element's role over none. */
const GLOBAL_ARIA =
  /^aria-(atomic|busy|controls|current|describedby|description|details|dropeffect|flowto|grabbed|keyshortcuts|label|labelledby|live|owns|relevant|roledescription)$/;

/** Whether an element has a name from its author: aria-labelledby (to some text), aria-label or title. */
function hasAuthorName(el: Element): boolean {
  if (el.getAttribute('aria-label')?.trim() || el.getAttribute('title')?.trim()) return true;
  const root = el.getRootNode() as Document | ShadowRoot;
  return (el.getAttribute('aria-labelledby') ?? '')
    .split(/[ \t\n\r\f]+/)
    .some(id => !!id && !!root.getElementById?.(id)?.textContent?.trim());
}

/**
 * The role from the role attribute: its first token that is a role Chrome knows (in any case),
 * with region and form only when named; `none` for both presentational roles, unless the element
 * is focusable or has a global ARIA attribute. Null when no token applies.
 */
function explicitRole(el: Element): string | null {
  for (const token of (el.getAttribute('role') ?? '').toLowerCase().split(/[ \t\n\r\f]+/)) {
    if (!ARIA_ROLES.has(token) && !DOC_ROLE.test(token)) continue;
    if ((token === 'region' || token === 'form') && !hasAuthorName(el)) continue;
    if (token === 'none' || token === 'presentation')
      return isFocusable(el) || [...el.attributes].some(a => GLOBAL_ARIA.test(a.name)) ? null : 'none';
    return token === 'img' ? 'image' : token === 'directory' ? 'list' : token;
  }
  return null;
}

/** Whether an element takes keyboard focus: in the tab order or focusable by script. */
export function isFocusable(el: Element): boolean {
  if (el.matches(':disabled')) return false;
  if (el.hasAttribute('tabindex')) return true;
  if (isHtml(el, 'a') || isHtml(el, 'area')) return el.hasAttribute('href');
  if (isHtml(el, 'input')) return el.type !== 'hidden';
  if (isHtmlElement(el) && el.isContentEditable) return true;
  return (
    isHtml(el, 'button') || isHtml(el, 'select') || isHtml(el, 'textarea') || isHtml(el, 'option') || isSummary(el)
  );
}

/** A details element's summary: Chrome's DisclosureTriangle. */
const isSummary = (el: Element) =>
  el.localName === 'summary' &&
  el.parentElement?.localName === 'details' &&
  el.parentElement.querySelector(':scope > summary') === el;

/** Roles that only depend on the tag name. */
const TAG_ROLES: Record<string, string> = {
  abbr: 'Abbr',
  address: 'group',
  article: 'article',
  audio: 'Audio',
  blockquote: 'blockquote',
  br: 'LineBreak',
  button: 'button',
  canvas: 'Canvas',
  caption: 'caption',
  code: 'code',
  datalist: 'listbox',
  dd: 'definition',
  del: 'deletion',
  s: 'deletion',
  details: 'group',
  dfn: 'term',
  dt: 'term',
  dialog: 'dialog',
  dir: 'list',
  menu: 'list',
  ol: 'list',
  ul: 'list',
  dl: 'DescriptionList',
  em: 'emphasis',
  embed: 'EmbeddedObject',
  fieldset: 'group',
  figure: 'figure',
  figcaption: 'Figcaption',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  hgroup: 'group',
  optgroup: 'group',
  hr: 'separator',
  iframe: 'Iframe',
  img: 'image',
  svg: 'image',
  ins: 'insertion',
  label: 'LabelText',
  legend: 'Legend',
  li: 'listitem',
  main: 'main',
  mark: 'mark',
  math: 'MathMLMath',
  meter: 'meter',
  nav: 'navigation',
  object: 'PluginObject',
  option: 'option',
  output: 'status',
  p: 'paragraph',
  progress: 'progressbar',
  ruby: 'Ruby',
  search: 'search',
  strong: 'strong',
  sub: 'subscript',
  sup: 'superscript',
  table: 'table',
  textarea: 'textbox',
  time: 'time',
  tr: 'row',
  thead: 'rowgroup',
  tbody: 'rowgroup',
  tfoot: 'rowgroup',
  video: 'Video',
};

/** An input's role, by its type. */
function inputRole(el: HTMLInputElement): string {
  switch (el.type) {
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
    case 'file':
      return 'button';
    case 'checkbox':
    case 'radio':
      return el.type;
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'color':
      return 'ColorWell';
    case 'date':
      return 'Date';
    case 'datetime-local':
    case 'month':
    case 'week':
      return 'DateTime';
    case 'time':
      return 'InputTime';
  }
  if (el.list) return 'combobox';
  return el.type === 'search' ? 'searchbox' : 'textbox';
}

/** The role an element has without a role attribute. */
function implicitRole(el: Element): string {
  switch (el.localName) {
    case 'th': {
      const scope = el.getAttribute('scope');
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      return el.parentElement?.querySelector(':scope > td') ? 'rowheader' : 'columnheader';
    }
    case 'td':
      return /^(grid|treegrid)$/.test(el.closest('table')?.getAttribute('role') ?? '') ? 'gridcell' : 'cell';
    case 'input':
      if (isHtml(el, 'input')) return inputRole(el);
      break;
    case 'summary':
      return isSummary(el) ? 'DisclosureTriangle' : 'generic';
    case 'section':
      return hasAuthorName(el) ? 'region' : 'generic';
    case 'aside':
      return el.parentElement?.closest(SECTIONING) && !hasAuthorName(el) ? 'generic' : 'complementary';
    case 'header':
    case 'footer': {
      const inSection = el.parentElement?.closest(SECTIONING);
      if (inSection) return el.localName === 'header' ? 'sectionheader' : 'sectionfooter';
      return el.localName === 'header' ? 'banner' : 'contentinfo';
    }
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'select':
      if (isHtml(el, 'select')) return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
  }
  const role = TAG_ROLES[el.localName];
  if (role) return role;
  // A generic element that can be dragged or takes autofocus is a group in Chrome.
  return el.hasAttribute('draggable') || el.hasAttribute('autofocus') ? 'group' : 'generic';
}

/** The role Chrome gives an element: an ARIA role, or one of its own (isInternalRole). */
export function roleOf(el: Element): string {
  const explicit = explicitRole(el);
  return explicit && explicit !== 'none' ? explicit : implicitRole(el);
}

/**
 * Why an element is not shown, if it is not: `display: none` on it or an ancestor (no box), or
 * `visibility: hidden` (a box, not painted).
 */
function hiddenReason(el: Element): IgnoredReason | null {
  if (!el.isConnected) return 'notRendered';
  for (let n: Node | null = el; n && isElement(n); n = domParent(n))
    if (styleOf(n).display === 'none') return 'notRendered';
  const visibility = styleOf(el).visibility;
  return visibility === 'hidden' || visibility === 'collapse' ? 'notVisible' : null;
}

/** The children of a node as the tree sees them: shadow trees and slots flattened. */
export function domChildren(node: Node): Node[] {
  if (isElement(node)) {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (isHtml(node, 'slot')) {
      const assigned = node.assignedNodes();
      if (assigned.length) return assigned;
    }
  }
  return [...node.childNodes];
}

/** The parent of a node as the tree sees it: the slot it is assigned to, the host of a shadow root. */
export function domParent(node: Node): Node | null {
  if (isElement(node) || isText(node)) {
    const slot = node.assignedSlot;
    if (slot) return slot;
  }
  const parent = node.parentNode;
  return isShadowRoot(parent) ? parent.host : parent;
}

/** The element a text node's rendering depends on. */
const displayOf = (node: Node | null) => (node && isElement(node) ? styleOf(node).display : '');

/**
 * Whether a whitespace-only text node shows: Chrome keeps it as StaticText " " between two inline
 * boxes, as it shows as a space there.
 */
function isRenderedSpace(text: Text, inTree: (node: Node) => boolean): boolean {
  let prev = text.previousSibling;
  while (prev && isText(prev) && !prev.data.trim()) prev = prev.previousSibling;
  let next = text.nextSibling;
  while (next && isText(next) && !next.data.trim()) next = next.nextSibling;
  // Not next to an inline-block (a button, a field), nor to an element left out of the tree:
  // Chrome drops the space there.
  const inline = (node: Node | null) => !!node && (isText(node) || (displayOf(node) === 'inline' && inTree(node)));
  return inline(prev) && inline(next);
}

/** A text node's text as rendered: white space collapsed, and trimmed at the edges of its block. */
export function renderedText(text: Text): string {
  let value = text.data.replace(/[ \t\n\r\f]+/g, ' ');
  if (!value.trim()) return ' ';
  const inline = (node: Node | null) =>
    !!node && (isText(node) ? !!node.data.trim() : displayOf(node).startsWith('inline'));
  if (!inline(text.previousSibling)) value = value.replace(/^ /, '');
  if (!inline(text.nextSibling)) value = value.replace(/ $/, '');
  return value;
}

/** The tree's structure over one document, with aria-owns resolved. */
export class TreeShape {
  /** Elements moved by aria-owns, to their owner. */
  private owner = new Map<Element, Element>();
  private owned = new Map<Element, Element[]>();
  readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    for (const el of doc.querySelectorAll('[aria-owns]')) {
      const ids = el.getAttribute('aria-owns')?.trim().split(/\s+/) ?? [];
      const list: Element[] = [];
      for (const id of ids) {
        const target = doc.getElementById(id);
        // An element owned twice stays with its first owner; one cannot own its ancestor.
        if (!target || this.owner.has(target) || target.contains(el)) continue;
        this.owner.set(target, el);
        list.push(target);
      }
      if (list.length) this.owned.set(el, list);
    }
  }

  /** How a node takes part in the tree (Inclusion). */
  inclusion(node: Node): Inclusion {
    if (node === this.doc) return { kind: 'included' };
    if (isText(node)) {
      const parent = domParent(node);
      if (!parent || (isElement(parent) && (OPAQUE.has(parent.localName) || hiddenReason(parent))))
        return { kind: 'excluded', reason: 'notRendered' };
      if (!node.data.trim() && !isRenderedSpace(node, n => this.inTree(n)))
        return { kind: 'excluded', reason: 'uninteresting' };
      const hidden = this.hiddenRoot(node);
      return hidden ? { kind: 'ignored', reason: 'ariaHiddenSubtree', hiddenRoot: hidden } : { kind: 'included' };
    }
    if (!isElement(node)) return { kind: 'excluded', reason: 'uninteresting' };
    if (node.closest('[data-devtools-anywhere]')) return { kind: 'excluded', reason: 'notRendered' };
    const hiddenBy = hiddenReason(node);
    if (hiddenBy) return { kind: 'excluded', reason: hiddenBy };
    const hidden = this.hiddenRoot(node);
    // Chrome leaves the aria-hidden element out and keeps what it hides, ignored.
    if (hidden === node) return { kind: 'lifted', reason: 'ariaHiddenElement' };
    if (hidden) return { kind: 'ignored', reason: 'ariaHiddenSubtree', hiddenRoot: hidden };
    if (node === this.doc.documentElement || node === this.doc.body)
      return { kind: 'ignored', reason: 'uninteresting' };
    // An implicit or plain tbody; thead and tfoot are row groups.
    if (node.localName === 'tbody' && !node.hasAttribute('role')) return { kind: 'ignored', reason: 'uninteresting' };
    const explicit = explicitRole(node);
    if (
      node.localName === 'img' &&
      node.getAttribute('alt') === '' &&
      !explicit &&
      !node.hasAttribute('aria-label') &&
      !node.hasAttribute('aria-labelledby') &&
      !node.getAttribute('title')
    )
      return { kind: 'lifted', reason: 'emptyAlt' };
    if (explicit === 'none') return { kind: 'lifted', reason: 'presentationalRole' };
    return { kind: 'included' };
  }

  /** The element with aria-hidden="true" that hides a node, if any. */
  private hiddenRoot(node: Node): Element | null {
    for (let n: Node | null = node; n && n !== this.doc; n = domParent(n))
      if (isElement(n) && n.getAttribute('aria-hidden') === 'true') return n;
    return null;
  }

  /** Whether a node is in the tree (included or ignored). */
  inTree(node: Node): boolean {
    const kind = this.inclusion(node).kind;
    return kind === 'included' || kind === 'ignored';
  }

  /** The nodes in the tree under a node, in order: lifted nodes give their own. */
  children(node: Node): Node[] {
    const out: Node[] = [];
    const visit = (child: Node) => {
      if (isElement(child) && this.owner.has(child)) return;
      const inclusion = this.inclusion(child);
      if (inclusion.kind === 'excluded') return;
      if (inclusion.kind === 'lifted') {
        for (const c of this.ownChildren(child)) visit(c);
        return;
      }
      out.push(child);
    };
    for (const child of this.ownChildren(node)) visit(child);
    if (isElement(node))
      for (const el of this.owned.get(node) ?? []) if (this.inclusion(el).kind !== 'excluded') out.push(el);
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

  /** The closest node in the tree above a node: its aria-owns owner, or its DOM ancestor. */
  parent(node: Node): Node | null {
    if (node === this.doc) return null;
    let n: Node | null = isElement(node) ? (this.owner.get(node) ?? domParent(node)) : domParent(node);
    while (n && n !== this.doc && !this.inTree(n))
      n = isElement(n) ? (this.owner.get(n) ?? domParent(n)) : domParent(n);
    return n;
  }
}
