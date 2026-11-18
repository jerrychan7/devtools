// The shape of the accessibility tree: which DOM nodes are in it, with which role, and in which
// order. Part of accessibility.js, loaded on demand (ax-node.ts).
//
// Blink builds its tree from the layout tree (third_party/blink/renderer/modules/accessibility/),
// which a page cannot read: these rules redo the common cases from the DOM and computed styles,
// checked against Chrome's getFullAXTree (accessibility.conformance.test.ts). The role mapping is
// Chrome's: ARIA roles where it gives them, its own (capitalized) roles elsewhere.
import { isDocument, isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';
import { inDisplayNone } from './ax-text';

/** An element's attribute, or null (`getAttribute`, which minification cannot shorten). */
export const attr = (el: Element, name: string) => el.getAttribute(name);

/** Whether an element has an attribute (`hasAttribute`). */
export const hasAttr = (el: Element, name: string) => el.hasAttribute(name);

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
 * children taking its place (`lifted`), or left out with its subtree (`excluded`). An ignored node
 * with `noReason` is one Chrome ignores without giving a reason (a ruby annotation).
 */
export type Inclusion =
  | { kind: 'included' }
  | {
      kind: 'ignored';
      reason: IgnoredReason;
      hiddenRoot?: Element;
      noReason?: true;
    }
  | { kind: 'lifted'; reason: IgnoredReason }
  | { kind: 'excluded'; reason: IgnoredReason };

/** Elements whose text and children the page does not show as content: replaced by their value or a popup. */
const OPAQUE = new Set(
  'script style template noscript title head textarea select option input img br wbr iframe object embed video audio canvas svg'.split(
    ' '
  )
);

/** Elements Chrome has no layout object for, ignored as not rendered. */
const NOT_RENDERED = new Set('col colgroup map noscript source track wbr'.split(' '));

/** SVG shapes: graphics-symbol in Chrome. */
const SVG_SHAPES = new Set('circle ellipse line path polygon polyline rect'.split(' '));

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** The document or shadow root a node is in, where its ids resolve; null when detached. */
export function scopeOf(node: Node): Document | ShadowRoot | null {
  const root = node.getRootNode();
  return isDocument(root) || isShadowRoot(root) ? root : null;
}

/** A select shown as a drop-down (Chrome's MenuListSelect), not as a list box. */
export const isMenuList = (el: Element | null): boolean => isHtml(el, 'select') && !el.multiple && el.size <= 1;

/** Whether an element has focus, in a document that has it. */
export const isFocused = (el: Element) => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus();

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

/**
 * Whether an element has a name from its author: aria-labelledby (to some text), aria-label, or a
 * title attribute, even an empty one (Chrome's IsNameFromAuthorAttribute).
 */
function hasAuthorName(el: Element): boolean {
  if (attr(el, 'aria-label')?.trim() || hasAttr(el, 'title')) return true;
  const root = scopeOf(el);
  return (attr(el, 'aria-labelledby') ?? '')
    .split(/[ \t\n\r\f]+/)
    .some(id => !!id && !!root?.getElementById(id)?.textContent?.trim());
}

/**
 * The role from the role attribute: its first token that is a role Chrome knows (in any case),
 * with region and form only when named; `none` for both presentational roles, unless the element
 * is focusable or has a global ARIA attribute. Null when no token applies.
 */
function explicitRole(el: Element): string | null {
  for (const token of roleTokens(el)) {
    if ((token === 'region' || token === 'form') && !hasAuthorName(el)) continue;
    if (isOrphaned(el, token)) continue;
    if (token === 'none' || token === 'presentation')
      return isFocusable(el) || [...el.attributes].some(a => GLOBAL_ARIA.test(a.name)) ? null : 'none';
    return token === 'img' ? 'image' : token === 'directory' ? 'list' : token;
  }
  return null;
}

/** The tokens of an element's role attribute that are roles Chrome knows (in any case), in order. */
const roleTokens = (el: Element) =>
  (attr(el, 'role') ?? '')
    .toLowerCase()
    .split(/[ \t\n\r\f]+/)
    .filter(token => ARIA_ROLES.has(token) || DOC_ROLE.test(token));

/** The first role Chrome knows in an element's role attribute, without context checks. */
const rawRole = (el: Element): string | null => roleTokens(el)[0] ?? null;

/** For the roles that need one, the container roles (and tags) that give them their context. */
const REQUIRED_CONTEXT: Record<string, { roles: string[]; tags: string[] }> = {
  listitem: {
    roles: ['list', 'directory', 'group'],
    tags: ['ul', 'ol', 'menu'],
  },
  option: { roles: ['listbox', 'group'], tags: ['select'] },
  treeitem: { roles: ['tree', 'group'], tags: [] },
};

/**
 * Whether an ARIA role that needs a container lacks one (Chrome's HasRequiredParentContext): up the
 * tree, past presentational elements and plain div/span/slot/custom elements (and, for a treeitem,
 * other treeitems), the first other element must be a container for it. An aria-owns owner counts
 * when it is one.
 */
function isOrphaned(el: Element, role: string): boolean {
  const context = REQUIRED_CONTEXT[role];
  if (!context) return false;
  const isContainer = (parent: Element, parentRole: string | null) =>
    context.tags.includes(parent.localName) || (!!parentRole && context.roles.includes(parentRole));
  const owner = el.id ? el.ownerDocument.querySelector(`[aria-owns~="${CSS.escape(el.id)}"]`) : null;
  if (owner && isContainer(owner, roleOf(owner))) return false;
  for (let n = domParent(el); n; n = domParent(n)) {
    if (!isElement(n)) continue;
    const parentRole = rawRole(n);
    if (isContainer(n, parentRole)) return false;
    if (role === 'treeitem' && parentRole === 'treeitem') continue;
    if (parentRole === 'none' || parentRole === 'presentation') continue;
    const generic = /^(div|span|slot)$/.test(n.localName) || n.localName.includes('-');
    if (!attr(n, 'role') && generic) continue;
    break;
  }
  return true;
}

/** Whether an element takes keyboard focus: in the tab order or focusable by script. */
export function isFocusable(el: Element): boolean {
  if (el.matches(':disabled')) return false;
  // Without a box (display: contents), Chrome does not focus it.
  if (styleOf(el).display === 'contents') return false;
  if (hasAttr(el, 'tabindex')) return true;
  if (isHtml(el, 'a') || isHtml(el, 'area')) return hasAttr(el, 'href');
  if (isHtml(el, 'input')) return el.type !== 'hidden';
  if (isHtmlElement(el) && el.isContentEditable) return true;
  return (isHtmlElement(el) && /^(button|select|textarea|option)$/.test(el.localName)) || isSummary(el);
}

/** A details element's summary: Chrome's DisclosureTriangle. */
const isSummary = (el: Element) =>
  el.localName === 'summary' &&
  el.parentElement?.localName === 'details' &&
  el.parentElement.querySelector(':scope > summary') === el;

/** The words of a space-separated list. */
export const words = (list: string) => list.split(' ');

/** A space-separated list as a set. */
export const wordSet = (list: string) => new Set(words(list));

/** A table from groups of words, "value key key …": each key to its group's value. */
export function groupTable(groups: string[]): Record<string, string> {
  const table: Record<string, string> = {};
  for (const group of groups) {
    const [value = '', ...keys] = words(group);
    for (const key of keys) table[key] = value;
  }
  return table;
}

/**
 * Roles that only depend on the tag name (Blink's AXNodeObject::NativeRoleIgnoringAria), as
 * "role tag tag …".
 */
const TAG_ROLES = groupTable([
  'group address details fieldset hgroup optgroup',
  'LineBreak br',
  'listbox datalist',
  'definition dd',
  'deletion del s',
  'term dfn dt',
  'list dir menu ol ul',
  'DescriptionList dl',
  'emphasis em',
  'EmbeddedObject embed',
  'heading h1 h2 h3 h4 h5 h6',
  'separator hr',
  'image img svg',
  'insertion ins',
  'LabelText label',
  'listitem li',
  'MathMLMath math',
  'navigation nav',
  'PluginObject object',
  'status output',
  'paragraph p',
  'progressbar progress',
  'subscript sub',
  'superscript sup',
  'textbox textarea',
]);
// Tags whose role is named after them: ARIA roles, and Chrome's own roles, capitalized.
for (const tag of words(
  'article blockquote button caption code dialog figure form main mark meter option search strong table time'
))
  TAG_ROLES[tag] = tag;
for (const tag of words('abbr audio canvas figcaption iframe legend ruby video'))
  TAG_ROLES[tag] = tag[0]?.toUpperCase() + tag.slice(1);

/** The roles of inputs by their type, as "role type type …"; other types are text fields. */
const INPUT_ROLES = groupTable([
  'button button submit reset image file',
  'checkbox checkbox',
  'radio radio',
  'slider range',
  'spinbutton number',
  'ColorWell color',
  'Date date',
  'DateTime datetime-local month week',
  'InputTime time',
]);

/** An input's role, by its type. */
const inputRole = (el: HTMLInputElement): string =>
  INPUT_ROLES[el.type] ?? (el.list ? 'combobox' : el.type === 'search' ? 'searchbox' : 'textbox');

const TABLE_LIKE = /^(table|grid|treegrid|LayoutTable)$/;

/**
 * The closest ancestor that counts within a table (Chrome's GetDOMTableAXAncestor): group,
 * generic and rowgroup ones are passed over.
 */
function tableAncestor(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (!/^(group|generic|rowgroup)$/.test(roleOf(p))) return p;
  return null;
}

/** Data table answers, kept for one synchronous pass over the tree. */
let dataTables: WeakMap<Element, boolean> | null = null;

/** Whether a table holds data rather than layout (Chrome's IsDataTable), cached for the current pass. */
function isDataTable(table: Element): boolean {
  if (!dataTables) {
    dataTables = new WeakMap();
    queueMicrotask(() => (dataTables = null));
  }
  let data = dataTables.get(table);
  if (data === undefined) dataTables.set(table, (data = decideDataTable(table)));
  return data;
}

/**
 * Chrome's heuristic: a table is for data with a role, in editable content, with a caption, summary,
 * thead, tfoot, rules or col, with 20 rows or more, with a th or a cell with headers, abbr, axis or
 * scope, with empty-cells: hide, or when half its sized cells have borders, or backgrounds of their
 * own with cell spacing, or its first rows alternate colours.
 */
function decideDataTable(table: Element): boolean {
  if (!isHtml(table, 'table')) return false;
  if (inDisplayNone(table)) return true;
  if (hasAttr(table, 'role') || table.isContentEditable) return true;
  if (attr(table, 'summary') || table.tHead || table.tFoot || table.caption || attr(table, 'rules')) return true;
  if (table.querySelector(':scope > col, :scope > colgroup')) return true;
  const rows = table.rows;
  if (rows.length >= 20) return true;
  if (!rows.length) return false;
  if (rows.length === 1 && rows[0]?.cells.length === 1) return false;
  const tableStyle = styleOf(table);
  const tableBackground = tableStyle.backgroundColor;
  const [h = '0', v = h] = tableStyle.borderSpacing.split(' ');
  const spacing = parseFloat(h) > 0 && parseFloat(v) > 0;
  let valid = 0;
  let bordered = 0;
  let backgrounds = 0;
  const sides = [0, 0, 0, 0];
  const rowColors: string[] = [];
  for (const [r, row] of [...rows].entries()) {
    for (const cell of row.cells) {
      if (cell.localName === 'th') return true;
      if (['headers', 'abbr', 'axis', 'scope'].some(a => attr(cell, a))) return true;
      const style = styleOf(cell);
      if (inDisplayNone(cell) || !/^(table-cell|block|flow-root|inline-block|list-item|flex|grid)$/.test(style.display))
        continue;
      const box = cell.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      valid++;
      if (style.emptyCells === 'hide') return true;
      const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(
        w => parseFloat(w) > 0
      );
      if ((widths[0] && widths[2]) || (widths[1] && widths[3])) bordered++;
      widths.forEach((w, i) => w && (sides[i] = (sides[i] ?? 0) + 1));
      const color = style.backgroundColor;
      if (spacing && color !== tableBackground && !isTransparent(color)) backgrounds++;
      if (bordered >= 10 || backgrounds >= 10) return true;
      if (r < 5 && r === rowColors.length && styleOf(row).display === 'table-row')
        rowColors.push(styleOf(row).backgroundColor);
    }
  }
  if (valid <= 1) return false;
  const needed = Math.floor(valid / 2);
  if (bordered >= needed || sides.some(n => n >= needed) || backgrounds >= needed) return true;
  if (rowColors.length > 2) return rowColors.every((c, k) => (k % 2 ? c !== rowColors[0] : c === rowColors[0]));
  return false;
}

/** A computed colour with no alpha. */
const isTransparent = (color: string) => color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color);

/** The role an element has without a role attribute. */
function implicitRole(el: Element): string {
  if (el.namespaceURI === SVG_NS && SVG_SHAPES.has(el.localName)) return 'graphics-symbol';
  switch (el.localName) {
    case 'th':
    case 'td':
      // The cells of a presentational table are plain containers.
      const table = el.closest('table');
      if (table && explicitRole(table) === 'none') return 'generic';
  }
  switch (el.localName) {
    case 'table':
      return isDataTable(el) ? 'table' : 'LayoutTable';
    case 'thead':
    case 'tbody':
    case 'tfoot': {
      const table = tableAncestor(el);
      const role = table ? roleOf(table) : '';
      return TABLE_LIKE.test(role) && role !== 'LayoutTable' ? 'rowgroup' : 'generic';
    }
    case 'tr': {
      const table = tableAncestor(el);
      const role = table ? roleOf(table) : '';
      if (!TABLE_LIKE.test(role)) return 'generic';
      return role === 'LayoutTable' ? 'LayoutTableRow' : 'row';
    }
  }
  if (el.localName === 'th' || el.localName === 'td') {
    const row = tableAncestor(el);
    const rowRole = row ? roleOf(row) : '';
    const table = row && tableAncestor(row);
    if (!/^(row|LayoutTableRow)$/.test(rowRole) || !table || !TABLE_LIKE.test(roleOf(table))) return 'generic';
    if (rowRole === 'LayoutTableRow') return 'LayoutTableCell';
  }
  switch (el.localName) {
    case 'th': {
      const scope = attr(el, 'scope');
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
      return hasAttr(el, 'href') ? 'link' : 'generic';
    case 'area':
      // An image map's area without a link is text in Chrome.
      return hasAttr(el, 'href') ? 'link' : imageOf(el) ? 'StaticText' : 'generic';
    case 'select':
      if (isHtml(el, 'select')) return isMenuList(el) ? 'combobox' : 'listbox';
  }
  const role = TAG_ROLES[el.localName];
  if (role) return role;
  // A generic element that can be dragged or takes autofocus is a group in Chrome.
  // Not with a role attribute, even one with no role Chrome knows.
  if (attr(el, 'role')?.trim()) return 'generic';
  return hasAttr(el, 'draggable') || hasAttr(el, 'autofocus') ? 'group' : 'generic';
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

/**
 * The image an area belongs to: the first rendered img whose usemap names the area's map. Chrome
 * puts the areas under that image, though the map itself is not rendered.
 */
export function imageOf(area: Element): Element | null {
  const map = area.closest('map');
  const name = map?.getAttribute('name') || map?.id;
  if (!map || !name) return null;
  const root = scopeOf(map);
  if (!root) return null;
  for (const img of root.querySelectorAll('img[usemap]'))
    if (attr(img, 'usemap') === `#${name}`) return hiddenReason(img) === 'notRendered' ? null : img;
  return null;
}

/** An image's map areas, in order. */
function areasOf(img: Element): Element[] {
  const name = attr(img, 'usemap')?.replace(/^#/, '');
  const root = scopeOf(img);
  if (!name || !root) return [];
  const map = [...root.querySelectorAll('map')].find(m => (attr(m, 'name') || m.id) === name);
  return map ? [...map.querySelectorAll('area')].filter(area => imageOf(area) === img) : [];
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

/** The inclusions, built once (included) or by kind. */
const INCLUDED: Inclusion = { kind: 'included' };
const ignored = (reason: IgnoredReason): Inclusion => ({ kind: 'ignored', reason });
const lifted = (reason: IgnoredReason): Inclusion => ({ kind: 'lifted', reason });
const excluded = (reason: IgnoredReason): Inclusion => ({ kind: 'excluded', reason });

/** The tree's structure over one document, with aria-owns resolved. */
export class TreeShape {
  /** Elements moved by aria-owns, to their owner. */
  private owner = new Map<Element, Element>();
  private owned = new Map<Element, Element[]>();
  readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    for (const el of doc.querySelectorAll('[aria-owns]')) {
      const ids = attr(el, 'aria-owns')?.trim().split(/\s+/) ?? [];
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
    if (node === this.doc) return INCLUDED;
    if (isText(node)) {
      const parent = domParent(node);
      if (!parent || (isElement(parent) && (OPAQUE.has(parent.localName) || hiddenReason(parent))))
        return excluded('notRendered');
      if (!node.data.trim() && !isRenderedSpace(node, n => this.inTree(n))) return excluded('uninteresting');
      const hidden = this.hiddenRoot(node);
      return hidden ? { kind: 'ignored', reason: 'ariaHiddenSubtree', hiddenRoot: hidden } : INCLUDED;
    }
    if (!isElement(node)) return excluded('uninteresting');
    if (node.closest('[data-devtools-anywhere]')) return excluded('notRendered');
    // An image map's area is shown through its image, whatever its own box.
    const hiddenBy = isHtml(node, 'area') && imageOf(node) ? null : hiddenReason(node);
    if (hiddenBy) return excluded(hiddenBy);
    if (
      isHtmlElement(node) &&
      (NOT_RENDERED.has(node.localName) ||
        (node.localName === 'embed' && !hasAttr(node, 'src') && !hasAttr(node, 'type')))
    )
      return excluded('notRendered');
    const hidden = this.hiddenRoot(node);
    // Chrome leaves the aria-hidden element out and keeps what it hides, ignored.
    if (hidden === node) return lifted('ariaHiddenElement');
    if (hidden)
      return {
        kind: 'ignored',
        reason: 'ariaHiddenSubtree',
        hiddenRoot: hidden,
      };
    if (node === this.doc.documentElement || node === this.doc.body) return ignored('uninteresting');
    // A tbody without a role, ARIA attribute, title, id (a possible link target) or tabindex is ignored;
    // thead and tfoot are kept.
    if (
      node.localName === 'tbody' &&
      ![...node.attributes].some(a => a.name.startsWith('aria-') || a.name === 'role') &&
      !attr(node, 'title') &&
      !(node.id && !isShadowRoot(node.getRootNode())) &&
      !hasAttr(node, 'tabindex')
    )
      return ignored('uninteresting');
    // Chrome gives a ruby's annotation as its description only.
    if (node.localName === 'rt' && node.parentElement?.localName === 'ruby')
      return { kind: 'ignored', reason: 'uninteresting', noReason: true };
    const explicit = explicitRole(node);
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
      !/^(|list|directory)$/.test(node.parentElement?.getAttribute('role') ?? '')
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
    if (explicit === 'none') return lifted('presentationalRole');
    return INCLUDED;
  }

  /** The element with aria-hidden="true" that hides a node, if any. */
  private hiddenRoot(node: Node): Element | null {
    for (let n: Node | null = node; n && n !== this.doc; n = domParent(n))
      if (isElement(n) && attr(n, 'aria-hidden') === 'true') return n;
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
      if (isElement(child) && (this.owner.has(child) || (isHtml(child, 'area') && imageOf(child)))) return;
      const inclusion = this.inclusion(child);
      if (inclusion.kind === 'excluded') return;
      if (inclusion.kind === 'lifted') {
        for (const c of this.ownChildren(child)) visit(c);
        return;
      }
      out.push(child);
    };
    for (const child of this.ownChildren(node)) visit(child);
    if (isHtml(node, 'img'))
      for (const area of areasOf(node)) if (this.inclusion(area).kind !== 'excluded') out.push(area);
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
    let n: Node | null = isElement(node)
      ? (this.owner.get(node) ?? (isHtml(node, 'area') ? imageOf(node) : null) ?? domParent(node))
      : domParent(node);
    while (n && n !== this.doc && !this.inTree(n))
      n = isElement(n) ? (this.owner.get(n) ?? domParent(n)) : domParent(n);
    return n;
  }
}
