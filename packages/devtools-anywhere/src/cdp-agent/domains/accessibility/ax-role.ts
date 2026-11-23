// The role Chrome gives an element: its role attribute checked in context, or the implicit role
// of its tag, type and place (tables, sections, svg). Part of accessibility.js (ax-node.ts).
import { isElement, isHtml, isHtmlElement, isText, styleOf } from '../../core/realm';
import { nativeGet } from '../../core/natives';
import { inDisplayNone } from './ax-text';
import {
  attr,
  attrNames,
  byId,
  closest,
  domChildren,
  domParent,
  groupTable,
  hasAttr,
  hiddenReason,
  isMenuList,
  matches,
  query,
  queryAll,
  rectOf,
  scopeOf,
  textOf,
  words,
} from './ax-dom';
import { excluded, ignored, INCLUDED, type Inclusion, lifted } from './ax-ignored';
import { ownersOf } from './ax-owns';

/** Whether a role is one of Chrome's own, not an ARIA role (reported as `internalRole`). */
export const isInternalRole = (role: string) => /^[A-Z]/.test(role);

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
export const inSvg = (el: Element) => (el.parentNode as Element | null)?.namespaceURI === SVG_NS;

/**
 * How an element in an svg without a role takes part, as in Chrome: text and links are kept; a
 * shape, image, use, group or inner svg only when it names or describes itself (aria, a title or
 * desc child) or takes focus, its children in its place otherwise; foreignObject is presentational;
 * the other elements give their children.
 */
export function svgInclusion(el: Element): Inclusion {
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
export function hasAuthorName(el: Element): boolean {
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
export function explicitRole(el: Element): string | null {
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
export function implicitRole(el: Element): string {
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
export function areasOf(img: Element): Element[] {
  const name = attr(img, 'usemap')?.replace(/^#/, '');
  const root = scopeOf(img);
  if (!name || !root) return [];
  const map = queryAll(root, 'map').find(m => (attr(m, 'name') || m.id) === name);
  return map ? queryAll(map, 'area').filter(area => imageOf(area) === img) : [];
}
