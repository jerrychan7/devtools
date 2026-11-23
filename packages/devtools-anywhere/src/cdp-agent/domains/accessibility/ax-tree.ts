// The shape of the accessibility tree: which DOM nodes are in it, with which role, and in which
// order. Part of accessibility.js, loaded on demand (ax-node.ts).
//
// Blink builds its tree from the layout tree (third_party/blink/renderer/modules/accessibility/),
// which a page cannot read: these rules redo the common cases from the DOM and computed styles,
// checked against Chrome's getFullAXTree (accessibility.conformance.test.ts). The role mapping is
// Chrome's: ARIA roles where it gives them, its own (capitalized) roles elsewhere.
import { isDocument, isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';
import { nativeCall, nativeGet } from '../../core/natives';
import { inDisplayNone, spaceShows } from './ax-text';
import { HiddenKeeper, type Hiding } from './ax-hidden';
import { generatedContent } from './ax-generated';
import { isVirtual, selectOf, virtualChildrenOf, type AXRef, type VirtualNode } from './ax-virtual';

// The DOM is read through the browser's own functions (core/natives.ts), not those on the page's
// prototypes: a page that replaced `getAttribute` or `querySelectorAll` would otherwise see the
// tree being built, could change what it finds, or make it throw.

/** An element's attribute, or null (`getAttribute`). */
export const attr = (el: Element, name: string) => nativeCall<string | null>(el, 'getAttribute', name);

/** Whether an element has an attribute (`hasAttribute`). */
export const hasAttr = (el: Element, name: string) => nativeCall<boolean>(el, 'hasAttribute', name);

/** The names of an element's attributes (`getAttributeNames`). */
export const attrNames = (el: Element) => nativeCall<string[]>(el, 'getAttributeNames');

/** The first element under `scope` that matches `selector` (`querySelector`). */
export const query = (scope: ParentNode, selector: string) =>
  nativeCall<Element | null>(scope, 'querySelector', selector);

/** The elements under `scope` that match `selector` (`querySelectorAll`). */
export const queryAll = (scope: ParentNode, selector: string): Element[] => [
  ...nativeCall<NodeListOf<Element>>(scope, 'querySelectorAll', selector),
];

/** The closest inclusive ancestor of `el` that matches `selector` (`closest`). */
export const closest = (el: Element, selector: string) => nativeCall<Element | null>(el, 'closest', selector);

/** Whether `el` matches `selector` (`matches`). */
export const matches = (el: Element, selector: string) => nativeCall<boolean>(el, 'matches', selector);

/** The element of a document or shadow root with an id (`getElementById`). */
export const byId = (root: Document | DocumentFragment, id: string) =>
  nativeCall<HTMLElement | null>(root, 'getElementById', id);

/** A node's root (`getRootNode`). */
export const rootOf = (node: Node) => nativeCall<Node>(node, 'getRootNode');

/** An element's border box (`getBoundingClientRect`). */
export const rectOf = (el: Element) => nativeCall<DOMRect>(el, 'getBoundingClientRect');

/** A node's `textContent`. */
export const textOf = (node: Node) => nativeGet<string | null>(node, 'textContent');

/** An HTML element's `innerText`. */
export const innerTextOf = (el: HTMLElement) => nativeGet<string>(el, 'innerText');

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
  | 'emptyAlt'
  | 'inertElement'
  | 'labelFor';

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
  | { kind: 'lifted'; reason: IgnoredReason; hiddenRoot?: Element }
  | { kind: 'excluded'; reason: IgnoredReason; hiddenRoot?: Element };

/** Elements whose text and children the page does not show as content: replaced by their value or a popup. */
export const OPAQUE = new Set(
  'script style template noscript title head textarea select option input img br wbr iframe object embed video audio canvas'.split(
    ' '
  )
);

/** Elements Chrome has no layout object for, ignored as not rendered. */
const NOT_RENDERED = new Set('col colgroup map noscript source track wbr'.split(' '));

/** SVG shapes: graphics-symbol in Chrome. */
const SVG_SHAPES = new Set('circle ellipse line path polygon polyline rect'.split(' '));

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG elements that draw nothing themselves, left out with what they hold. */
const SVG_UNDRAWN = new Set(
  'clipPath desc filter linearGradient marker mask metadata pattern radialGradient script style symbol title'.split(' ')
);

/** An svg link. */
export const isSvgLink = (el: Element) => el.namespaceURI === SVG_NS && el.localName === 'a';

/** Whether an element is in an svg, under its root. */
const inSvg = (el: Element) => (el.parentNode as Element | null)?.namespaceURI === SVG_NS;

/**
 * How an element in an svg without a role takes part, as in Chrome: text and links are kept; a
 * shape, image, use, group or inner svg only when it names or describes itself (aria, a title or
 * desc child) or takes focus, its children in its place otherwise; foreignObject is presentational;
 * the other elements give their children.
 */
function svgInclusion(el: Element): Inclusion {
  if (SVG_UNDRAWN.has(el.localName)) return excluded('notRendered');
  if (el.localName === 'foreignObject') return ignored('presentationalRole');
  if (el.localName === 'text' || el.localName === 'a') return INCLUDED;
  if (!/^(circle|ellipse|line|path|polygon|polyline|rect|image|use|g|svg)$/.test(el.localName))
    return lifted('uninteresting');
  const interesting =
    hasAuthorName(el) ||
    hasAttr(el, 'aria-describedby') ||
    hasAttr(el, 'tabindex') ||
    !!query(el, ':scope > title, :scope > desc');
  return interesting ? INCLUDED : lifted('uninteresting');
}

/** Whether a root svg holds anything Chrome keeps: it is then an SvgRoot, an image otherwise. */
function hasSvgContent(svg: Element): boolean {
  return queryAll(svg, '*').some(el => {
    for (let p: Element | null = el; p && p !== svg; p = p.parentElement)
      if (SVG_UNDRAWN.has(p.localName)) return false;
    if (el.namespaceURI !== SVG_NS) return true;
    return !!explicitRole(el) || svgInclusion(el).kind !== 'lifted';
  });
}

/** The document or shadow root a node is in, where its ids resolve; null when detached. */
export function scopeOf(node: Node): Document | ShadowRoot | null {
  const root = rootOf(node);
  return isDocument(root) || isShadowRoot(root) ? root : null;
}

/** A select shown as a drop-down (Chrome's MenuListSelect), not as a list box. */
export const isMenuList = (el: Element | null): boolean => isHtml(el, 'select') && !el.multiple && el.size <= 1;

/** Whether an element has focus, in a document that has it. */
export const isFocused = (el: Element) => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus();

/**
 * Whether an aside, header or footer is inside a section of the page, which makes an aside without
 * a name no landmark, and a header or footer a section's (as in Chrome): an ancestor whose role is
 * article, complementary or navigation (by tag or role attribute), or a section without a role
 * attribute; for a header or footer (`main`), one whose role is main too. A region by role does
 * not count, nor what a role attribute makes something else or presentational.
 */
function inSectionOf(el: Element, main: boolean): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const explicit = explicitRole(p);
    if (explicit === 'none') continue;
    const role = explicit ?? implicitRole(p);
    if (role === 'article' || role === 'complementary' || role === 'navigation') return true;
    if (main && role === 'main') return true;
    if (p.localName === 'section' && !explicit) return true;
  }
  return false;
}

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
  return (attr(el, 'aria-labelledby') ?? '').split(/[ \t\n\r\f]+/).some(id => {
    const target = id && root ? byId(root, id) : null;
    return !!target && !!textOf(target)?.trim();
  });
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
      return isFocusable(el) || attrNames(el).some(n => GLOBAL_ARIA.test(n)) ? null : 'none';
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
  const scope = el.id && scopeOf(el);
  const owner = scope && ownersOf(scope).get(el);
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
  // An option stays focusable in a disabled select, not when it or its group is disabled.
  if (isHtml(el, 'option'))
    return !hasAttr(el, 'disabled') && !(isHtml(el.parentElement, 'optgroup') && hasAttr(el.parentElement, 'disabled'));
  if (matches(el, ':disabled')) return false;
  // Without a box (display: contents), Chrome does not focus it.
  if (styleOf(el).display === 'contents') return false;
  if (hasAttr(el, 'tabindex')) return true;
  if (isHtml(el, 'a') || isHtml(el, 'area') || isSvgLink(el)) return hasAttr(el, 'href');
  if (isHtml(el, 'input')) return el.type !== 'hidden';
  // The editing host, not the elements in it.
  if (isHtmlElement(el) && el.isContentEditable && !(el.parentElement?.isContentEditable ?? false)) return true;
  return (isHtmlElement(el) && /^(button|select|textarea|option)$/.test(el.localName)) || isSummary(el);
}

/** A details element's summary: Chrome's DisclosureTriangle. */
const isSummary = (el: Element) =>
  el.localName === 'summary' &&
  el.parentElement?.localName === 'details' &&
  query(el.parentElement, ':scope > summary') === el;

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
  if (query(table, ':scope > col, :scope > colgroup')) return true;
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
      const box = rectOf(cell);
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
  if (el.namespaceURI === SVG_NS) {
    if (SVG_SHAPES.has(el.localName)) return 'graphics-symbol';
    if (el.localName === 'g' || el.localName === 'foreignObject' || (el.localName === 'svg' && inSvg(el)))
      return 'group';
    if (el.localName === 'svg') return hasSvgContent(el) ? 'SvgRoot' : 'image';
  }
  switch (el.localName) {
    case 'th':
    case 'td':
      // The cells of a presentational table are plain containers.
      const table = closest(el, 'table');
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
      return el.parentElement && query(el.parentElement, ':scope > td') ? 'rowheader' : 'columnheader';
    }
    case 'td':
      const grid = closest(el, 'table');
      return grid && /^(grid|treegrid)$/.test(explicitRole(grid) ?? '') ? 'gridcell' : 'cell';
    case 'input':
      if (isHtml(el, 'input')) return inputRole(el);
      break;
    case 'summary':
      // Any summary child of a details, as in Chrome's tree; only the first opens it (isSummary).
      return el.parentElement?.localName === 'details' ? 'DisclosureTriangle' : 'generic';
    case 'section':
      return hasAuthorName(el) ? 'region' : 'generic';
    case 'aside':
      return inSectionOf(el, false) && !hasAuthorName(el) ? 'generic' : 'complementary';
    case 'header':
    case 'footer': {
      const inSection = inSectionOf(el, true);
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
  // So is one shown as a list item a list item, marker or not.
  if (isListItemBox(el)) return 'listitem';
  return hasAttr(el, 'draggable') || hasAttr(el, 'autofocus') ? 'group' : 'generic';
}

/** Whether an element is shown as a list item (`display: list-item`, inline or not). */
export const isListItemBox = (el: Element) => /\blist-item\b/.test(styleOf(el).display);

/**
 * Whether an element shows a list marker (ax-marker.ts): a list item whose ::marker has content,
 * its own or that of list-style-type; list-style-image alone makes none in the tree.
 */
export function generatesMarker(el: Element): boolean {
  if (!isListItemBox(el)) return false;
  const content = styleOf(el, '::marker').content;
  return content !== 'none' && (content !== 'normal' || styleOf(el).listStyleType !== 'none');
}

/** The role Chrome gives an element: an ARIA role, or one of its own (isInternalRole). */
export function roleOf(el: Element): string {
  const explicit = explicitRole(el);
  return explicit && explicit !== 'none' ? explicit : implicitRole(el);
}

/**
 * The outermost closed details a node is in the content of (not in its summary): Chrome makes no
 * node for it, as the content is not slotted while closed. Its first summary child is shown.
 */
export function closedDetailsOf(node: Node): HTMLDetailsElement | null {
  let found: HTMLDetailsElement | null = null;
  for (let child = node, p = domParent(node); p; child = p, p = domParent(p))
    if (
      isHtml(p, 'details') &&
      !nativeGet<boolean>(p, 'open') &&
      child !== domChildren(p).find(c => isHtml(c, 'summary'))
    )
      found = p;
  return found;
}

/**
 * Why an element is not shown, if it is not: `display: none` on it or an ancestor (no box), or
 * `visibility: hidden` (a box, not painted).
 */
export function hiddenReason(el: Element): IgnoredReason | null {
  if (!el.isConnected) return 'notRendered';
  for (let n: Node | null = el; n && isElement(n); n = domParent(n))
    if (styleOf(n).display === 'none') return 'notRendered';
  const visibility = styleOf(el).visibility;
  return visibility === 'hidden' || visibility === 'collapse' ? 'notVisible' : null;
}

/**
 * Whether a label only repeats the name of the checkbox or radio it labels, which Chrome ignores
 * (labelFor) with its text: the input is rendered and visible, named by its labels (no aria-label
 * or aria-labelledby), and the label holds only text besides the input (comments do not count), with no role, name of its
 * own or click handler attribute. A handler added by addEventListener cannot be seen. The text of
 * its ::before and ::after is ignored too (ax-node.ts).
 */
export function isRedundantLabel(el: Element): boolean {
  if (!isHtml(el, 'label') || explicitRole(el)) return false;
  const control = nativeGet<HTMLElement | null>(el, 'control');
  if (
    !isHtml(control, 'input') ||
    !/^(checkbox|radio)$/.test(nativeGet<string>(control, 'type')) ||
    hiddenReason(control)
  )
    return false;
  if (hasAttr(control, 'aria-label') || hasAttr(control, 'aria-labelledby')) return false;
  if (['aria-label', 'aria-labelledby', 'title', 'onclick'].some(n => hasAttr(el, n))) return false;
  // Comments and other nodes that are neither text nor elements show nothing, so they do not count.
  return domChildren(el).every(c => isText(c) || c === control || !isElement(c));
}

/**
 * The image an area belongs to: the first rendered img whose usemap names the area's map. Chrome
 * puts the areas under that image, though the map itself is not rendered.
 */
export function imageOf(area: Element): Element | null {
  const map = closest(area, 'map');
  const name = (map && attr(map, 'name')) || map?.id;
  if (!map || !name) return null;
  const root = scopeOf(map);
  if (!root) return null;
  for (const img of queryAll(root, 'img[usemap]'))
    if (attr(img, 'usemap') === `#${name}`) return hiddenReason(img) === 'notRendered' ? null : img;
  return null;
}

/** An image's map areas, in order. */
function areasOf(img: Element): Element[] {
  const name = attr(img, 'usemap')?.replace(/^#/, '');
  const root = scopeOf(img);
  if (!name || !root) return [];
  const map = queryAll(root, 'map').find(m => (attr(m, 'name') || m.id) === name);
  return map ? queryAll(map, 'area').filter(area => imageOf(area) === img) : [];
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

/** Whether an element is inert: it or one of its ancestors in the tree has the inert attribute. */
export function inInert(el: Element): boolean {
  for (let n: Node | null = el; n && isElement(n); n = domParent(n)) if (hasAttr(n, 'inert')) return true;
  return false;
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

/** Whether Chrome keeps the body as a generic node rather than ignoring it. */
function bodyKept(body: Element): boolean {
  return (
    attrNames(body).some(n => n.startsWith('aria-') || n === 'role' || n === 'id' || n === 'contenteditable') ||
    !!attr(body, 'title') ||
    ['onclick', 'onmousedown', 'onmouseup'].some(name => !!nativeGet<unknown>(body, name))
  );
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

/** Whether an element is a child of a drop-down select, in its popup, which is not laid out. */
const inPopup = (el: Node | null): boolean => !!el && isMenuList(domParent(el) as Element | null);

/** Generic elements Chrome keeps whatever their box: the table parts, sections and the like. */
const KEPT_GENERIC = new Set('section summary aside header footer th td thead tbody tfoot tr area'.split(' '));

/** Whether an element is a plain generic container (div, span, b, a custom element…) without a role. */
function isPlainGeneric(el: Element): boolean {
  return isHtmlElement(el) && !KEPT_GENERIC.has(el.localName) && implicitRole(el) === 'generic';
}

/**
 * What a block holds in its flow (Blink's ChildrenInline and FirstChild): nothing, only inline
 * content (it is laid out in lines), or a block. Floated and positioned children are out of the
 * flow but still content; display: contents children give their own.
 */
function layoutContent(el: Element): 'none' | 'inline' | 'block' {
  let some = false;
  const visit = (node: Node): boolean => {
    for (const child of domChildren(node)) {
      if (isText(child)) {
        if (child.data.trim()) some = true;
        continue;
      }
      if (!isElement(child)) continue;
      const style = styleOf(child);
      if (style.display === 'none') continue;
      if (style.display === 'contents') {
        if (!visit(child)) return false;
        continue;
      }
      some = true;
      if (style.float !== 'none' || style.position === 'absolute' || style.position === 'fixed') continue;
      if (!style.display.startsWith('inline') && style.display !== 'ruby') return false;
    }
    return true;
  };
  return !visit(el) ? 'block' : some ? 'inline' : 'none';
}

/** Whether an element scrolls: its overflow lets it, and its content overflows it. */
function isScrollable(el: Element): boolean {
  const style = styleOf(el);
  const scrolls = (v: string) => v === 'auto' || v === 'scroll';
  return (
    (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight) ||
    (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth)
  );
}

/** Whether an id makes an element a possible link target: not in a shadow tree. */
const hasDocumentId = (el: Element) => !!el.id && !isShadowRoot(rootOf(el));

/**
 * Whether an element is of interest whatever its box: an ARIA attribute (any), a title, an id
 * outside a shadow tree, focus, a click handler or contenteditable.
 */
function isInteresting(el: Element): boolean {
  return (
    attrNames(el).some(n => n.startsWith('aria-')) ||
    hasAttr(el, 'title') ||
    hasDocumentId(el) ||
    isFocusable(el) ||
    hasAttr(el, 'onclick') ||
    hasAttr(el, 'onmousedown') ||
    hasAttr(el, 'onmouseup') ||
    hasAttr(el, 'contenteditable')
  );
}

/**
 * How a plain generic container takes part, as in Chrome (AXNodeObject::ComputeIsIgnored): kept
 * when of interest (isInteresting), as an inline-block, and, but for a span, as an inline flex or
 * grid, when positioned or scrolling, or as a block laid out in lines. Otherwise it is ignored:
 * kept in the tree when it is a block (a box of its own), has lang or an id in a shadow tree, its
 * children in its place when inline or display: contents.
 */
function genericInclusion(el: Element): Inclusion {
  // A body that gets here was kept by bodyKept, which also counts its click handler properties,
  // which isInteresting (attributes only) does not see.
  if (isInteresting(el) || el === el.ownerDocument.body) return INCLUDED;
  const style = styleOf(el);
  const display = style.display;
  if (display === 'inline-block' || display === 'inline flow-root') return INCLUDED;
  if (el.localName !== 'span') {
    if (display === 'inline-flex' || display === 'inline-grid') return INCLUDED;
    if (style.position !== 'static' || isScrollable(el)) return INCLUDED;
    if (/^(block|flow-root|list-item|table-cell|table-caption)$/.test(display) && layoutContent(el) === 'inline')
      return INCLUDED;
  }
  const inline = display === 'contents' || display.startsWith('inline');
  // An inline element with a ::before or ::after in the tree keeps an ignored node over it.
  const generated =
    display !== 'contents' && (generatedContent(el, '::before', false) || generatedContent(el, '::after', false));
  return !inline || generated || hasAttr(el, 'lang') || (el.id && !hasDocumentId(el))
    ? ignored('uninteresting')
    : lifted('uninteresting');
}

/** The inclusions, built once (included) or by kind. */
const INCLUDED: Inclusion = { kind: 'included' };
const ignored = (reason: IgnoredReason): Inclusion => ({ kind: 'ignored', reason });
const lifted = (reason: IgnoredReason): Inclusion => ({ kind: 'lifted', reason });
const excluded = (reason: IgnoredReason): Inclusion => ({ kind: 'excluded', reason });
/** A hidden node's inclusion, with the aria-hidden root that hides it, if any. */
const hidden = (kind: 'ignored' | 'lifted' | 'excluded', hiding: Hiding): Inclusion => ({
  kind,
  reason: hiding.reason,
  ...(hiding.hiddenRoot && { hiddenRoot: hiding.hiddenRoot }),
});

/** Owner tables, kept for one synchronous pass over the tree like dataTables. */
let owners: WeakMap<Document | ShadowRoot, Map<Element, Element>> | null = null;

/** The ownerTable of a document or shadow root, built once in the current pass. */
export function ownersOf(scope: Document | ShadowRoot): Map<Element, Element> {
  if (!owners) {
    owners = new WeakMap();
    queueMicrotask(() => (owners = null));
  }
  let table = owners.get(scope);
  if (!table) owners.set(scope, (table = ownerTable(scope)));
  return table;
}

/**
 * The elements aria-owns moves in a document or shadow root, each to its owner, in the owners'
 * order. Like Chrome, first come first served: an element owned twice stays with its first owner,
 * and an aria-owns that would make a cycle (an element owning its ancestor in the tree, or one
 * that owns it already) is dropped.
 */
function ownerTable(scope: Document | ShadowRoot): Map<Element, Element> {
  const owner = new Map<Element, Element>();
  // As in Chrome, a hidden owner owns nothing but where inert alone hides it, and nothing owns an
  // element without a box (display: none) or aria-hidden itself; their DOM ancestors are read here.
  const hidden = new HiddenKeeper(isDocument(scope) ? scope : scope.ownerDocument);
  for (const el of queryAll(scope, '[aria-owns]')) {
    const mode = hidden.hiding(el)?.mode;
    if (mode && mode !== 'inert') continue;
    for (const id of attr(el, 'aria-owns')?.trim().split(/\s+/) ?? []) {
      const target = byId(scope, id);
      if (
        !target ||
        owner.has(target) ||
        hidden.hiding(target)?.mode === 'none' ||
        attr(target, 'aria-hidden') === 'true'
      )
        continue;
      let n: Node | null = el;
      while (n && n !== target) n = (isElement(n) && owner.get(n)) || domParent(n);
      if (!n) owner.set(target, el);
    }
  }
  return owner;
}

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
          ((raised || unseen) && isElement(node) && generatesMarker(node))
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

  /** How a node takes part in the tree, wherever aria-owns puts it. */
  private ownInclusion(node: Node): Inclusion {
    if (node === this.doc) return INCLUDED;
    if (closedDetailsOf(node)) return excluded('notRendered');
    if (isText(node)) {
      const parent = domParent(node);
      // A drop-down select shows the text it holds in its popup, but for white space.
      if (isMenuList(parent as Element | null) && !node.data.trim()) return excluded('uninteresting');
      if (!parent || (isElement(parent) && OPAQUE.has(parent.localName) && !isMenuList(parent)))
        return excluded('notRendered');
      // In an svg, only its text elements draw text.
      if (isElement(parent) && parent.namespaceURI === SVG_NS && !/^(text|tspan|textPath)$/.test(parent.localName))
        return excluded('notRendered');
      let hiding = this.hidden.hiding(node);
      // The popup is not laid out: display: none on an element in it hides nothing.
      if (hiding?.mode === 'none' && inPopup(parent)) hiding = null;
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
    if (explicit === 'none') return lifted('presentationalRole');
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
    if (isVirtual(node)) {
      for (const child of node.raw) visit(child, true);
      return out;
    }
    // A hidden select Chrome keeps holds its options, not a popup; a hidden field nothing.
    if ((isHtml(node, 'select') || isHtml(node, 'input') || isHtml(node, 'textarea')) && this.hidden.hiding(node)) {
      if (isHtml(node, 'select')) for (const child of domChildren(node)) visit(child);
      return out;
    }
    const virtuals = isElement(node) && this.virtualChildren(node);
    if (virtuals) return virtuals;
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
    // A closed details' content is under its content slot, which does not list it.
    const details = closedDetailsOf(node);
    if (details) return this.virtual(details, 'content-slot');
    const host = domParent(node);
    const placed = isElement(host) && this.virtualChildren(host) && this.placed.get(node);
    if (placed) return placed;
    let n: Node | null = isElement(node)
      ? (this.owner.get(node) ?? (isHtml(node, 'area') ? imageOf(node) : null) ?? domParent(node))
      : domParent(node);
    while (n && n !== this.doc && !this.inTree(n))
      n = isElement(n) ? (this.owner.get(n) ?? domParent(n)) : domParent(n);
    return n;
  }
}
