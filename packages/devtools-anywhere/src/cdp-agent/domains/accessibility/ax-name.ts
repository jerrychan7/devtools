// An element's accessible name with the list of where it could come from (`AXValue.sources`), which
// the Accessibility pane shows, and its description. Part of accessibility.js (ax-node.ts).
//
// The computation follows Chrome's (AXNodeObject::TextAlternative and TextFromDescendants in
// Blink): the text of each source is kept as Chrome builds it, with its white space, and only the
// name is simplified at the end (AXObject::SimplifyName). The text of a text node is its rendered
// text (ax-text.ts).
import type { Protocol } from 'devtools-protocol';
import { isElement, isHtml, isHtmlElement, isNode, isText, styleOf } from '../../core/realm';
import { contentText } from './ax-counter';
import {
  attr,
  attrNames,
  byId,
  closest,
  domChildren,
  domParent,
  hasAttr,
  isFocusable,
  isMenuList,
  innerTextOf,
  ownersOf,
  query,
  queryAll,
  roleOf,
  scopeOf,
  SVG_NS,
  textOf,
  wordSet,
} from './ax-tree';
import {
  droppedSpace,
  hasLayout,
  inDisplayNone,
  isAtomicInline,
  isInlineLevel,
  layoutText,
  lineEdge,
  nearestBlock,
} from './ax-text';

type AXValueSource = Protocol.Accessibility.AXValueSource;
type AXRelatedNode = Protocol.Accessibility.AXRelatedNode;

/** The backend node id of a DOM node, from the agent. */
export type IdOf = (node: Node) => number;

/** Where a text alternative came from (Blink's NameFrom), as far as joining texts depends on it. */
type From = 'none' | 'contents' | 'attribute' | 'relatedElement' | 'value' | 'title' | 'placeholder' | 'caption';

/** ARIA roles whose name can come from their content. */
const NAME_FROM_CONTENTS = wordSet(
  'button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox menuitemradio option radio ' +
    'rowheader switch tab tooltip treeitem ' +
    // Chrome's own roles that take their name from their content.
    'DisclosureTriangle LineBreak ListMarker LayoutTableCell term math'
);

/**
 * Roles that usually have no name of their own, but whose content counts towards an ancestor's
 * name (and their own name when focused).
 */
const CONTENTS_FOR_ANCESTORS = wordSet(
  'generic Abbr Canvas caption code deletion insertion definition Details emphasis Figcaption sectionfooter ' +
    'LabelText LayoutTable LayoutTableRow Legend listitem mark none paragraph region Ruby section strong subscript ' +
    'superscript time'
);

/** Roles that list no `title` source in Chrome: an element that is only a container of text. */
const NO_TITLE = wordSet(
  'generic paragraph term definition caption code deletion insertion emphasis mark strong subscript superscript time'
);

const computed = (value: string): Protocol.Accessibility.AXValue => ({
  type: 'computedString',
  value,
});

const HTML_SPACE = /[ \t\n\f\r]/;
const isHtmlSpace = (c: string | undefined) => !!c && HTML_SPACE.test(c);

/** HTML white space collapsed and trimmed (String::SimplifyWhiteSpace with IsHTMLSpace). */
const simplify = (text: string) => text.replace(/[ \t\n\f\r]+/g, ' ').replace(/^ | $/g, '');

/** A name as Chrome gives it: simplified, but keeping one space at either end if there was some. */
function simplifyName(text: string): string {
  if (!text) return '';
  return `${isHtmlSpace(text[0]) ? ' ' : ''}${simplify(text)}${isHtmlSpace(text[text.length - 1]) ? ' ' : ''}`;
}

/** Whether a text is empty or only white space (String::ContainsOnlyWhitespaceOrEmpty). */
const isBlank = (text: string | null | undefined) => !text || !text.trim();

/**
 * One name computation: the nodes visited already (Blink's `visited`, shared by all of an
 * element's sources) and the element it is for.
 */
interface Computation {
  visited: Set<Node>;
  /** The element being named: a label of its own leaves it out. */
  naming: Element | null;
}

/** The element whose aria-labelledby or aria-describedby target is being walked, if any. */
type Root = Element | null;

/** Whether an element is hidden by CSS: no box (display: none on it or above), or not visible. */
function hiddenViaStyle(el: Element): boolean {
  if (inDisplayNone(el)) return true;
  const visibility = styleOf(el).visibility;
  return visibility === 'hidden' || visibility === 'collapse';
}

/** Whether an element or one of its ancestors has aria-hidden="true". */
function inAriaHidden(el: Element): boolean {
  for (let n: Node | null = el; n && isElement(n); n = domParent(n)) if (attr(n, 'aria-hidden') === 'true') return true;
  return false;
}

/** Whether an element shows: Blink's IsVisible. */
const isVisible = (el: Element) => !hiddenViaStyle(el) && !inAriaHidden(el);

/** Whether an element is left out of a text alternative (Blink's IsHiddenForTextAlternativeCalculation). */
function hiddenForText(el: Element, root: Root): boolean {
  if (isHtml(el, 'noscript')) return true;
  if (el.namespaceURI === SVG_NS && (el.localName === 'title' || el.localName === 'desc')) return false;
  // An option builds its text even inside a collapsed select.
  if (attr(el, 'aria-hidden') !== 'true' && isMenuListOption(closest(el, 'option'))) return false;
  // The children of a hidden aria-labelledby or aria-describedby target all count.
  if (root && !isVisible(root)) return false;
  if (attr(el, 'aria-hidden') === 'true') return true;
  return hiddenViaStyle(el);
}

/** The elements an idref list attribute names, in order. */
export function targetsOf(el: Element, attribute: string): Element[] {
  const root = scopeOf(el);
  if (!root) return [];
  const out: Element[] = [];
  for (const idref of (attr(el, attribute) ?? '').split(/\s+/)) {
    const target = idref && byId(root, idref);
    if (target) out.push(target);
  }
  return out;
}

/** Global ARIA attributes: role none or presentation does not apply to an element with one. */
const GLOBAL_ARIA =
  /^aria-(label|labelledby|describedby|description|details|live|owns|controls|keyshortcuts|roledescription|busy|atomic|relevant|errormessage|flowto|haspopup|invalid|current)$/;

/** An element that only presents its content: role none or presentation (Blink's IsPresentational). */
const isPresentational = (el: Element) =>
  /^\s*(none|presentation)(\s|$)/.test(attr(el, 'role') ?? '') &&
  !isFocusable(el) &&
  !attrNames(el).some(n => GLOBAL_ARIA.test(n));

/** The text field roles (Blink's IsTextField). */
const isTextFieldRole = (role: string) => role === 'textbox' || role === 'searchbox';

export const isNativeTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  isHtml(el, 'textarea') || (isHtml(el, 'input') && /^(text|search|email|url|tel|password|number|)$/.test(el.type));

/** Whether an element's content can name it, or an ancestor when `recursive` (SupportsNameFromContents). */
function supportsNameFromContents(el: Element, role: string, recursive: boolean): boolean {
  if (role === 'row') {
    // Only rows of a grid or treegrid.
    for (let p = domParent(el); p && isElement(p); p = domParent(p)) {
      const r = roleOf(p);
      if (r === 'grid' || r === 'treegrid') return true;
      if (r !== 'generic' && r !== 'none' && r !== 'group' && r !== 'rowgroup') return false;
    }
    return false;
  }
  if (isHtml(el, 'option') && isMenuListOption(el)) return !hasOneTextChild(el);
  if (NAME_FROM_CONTENTS.has(role)) return true;
  if (role === 'list' || role === 'DescriptionList') return recursive;
  if (role === 'group' && el.localName !== 'address' && el.namespaceURI !== SVG_NS) return false;
  if (role === 'group' || CONTENTS_FOR_ANCESTORS.has(role)) {
    if (role === 'generic' && (isHtml(el, 'body') || el === el.ownerDocument.documentElement)) return false;
    if (recursive) return true;
    if (isHtmlElement(el) && el.isContentEditable) return false;
    if (hasAttr(el, 'aria-activedescendant')) return false;
    return el === el.ownerDocument.activeElement;
  }
  if (role === 'RubyAnnotation') return !recursive;
  return false;
}

/** An option of a select shown as a drop-down (Blink's MenuListOption). */
const isMenuListOption = (el: Element | null) => isHtml(el, 'option') && isMenuList(closest(el, 'select'));

const hasOneTextChild = (el: Element) => el.childNodes.length === 1 && isText(el.firstChild);

/** The text of the selected options of a select or an ARIA listbox or combobox. */
function selectedText(el: Element, c: Computation): string {
  if (isHtml(el, 'select')) return [...el.selectedOptions].map(o => simplify(o.text)).join(' ');
  return queryAll(el, '[role=option][aria-selected=true]')
    .map(o => textAlternative(o, null, c)[0])
    .join(' ');
}

/** The value an embedded control gives the text around it (accname step 2C), or null. */
function embeddedValue(el: Element, role: string, c: Computation): string | null {
  switch (role) {
    case 'textbox':
    case 'searchbox':
      return isHtml(el, 'input') || isHtml(el, 'textarea') ? el.value : (textOf(el) ?? '');
    case 'combobox':
      return isHtml(el, 'input') ? el.value : selectedText(el, c);
    case 'listbox':
      return selectedText(el, c);
    case 'slider':
    case 'spinbutton':
    case 'progressbar':
    case 'meter':
    case 'scrollbar': {
      const text = attr(el, 'aria-valuetext') ?? attr(el, 'aria-valuenow');
      if (text !== null) return text;
      return isHtml(el, 'input') ? el.value : null;
    }
  }
  return null;
}

/** A table's first caption that is not hidden (FirstUnhiddenTableCaption). */
function captionOf(table: HTMLTableElement): Element | null {
  for (const child of table.children) if (isHtml(child, 'caption') && !hiddenViaStyle(child)) return child;
  return null;
}

/** A form control, which labels name. */
const isLabelable = (el: Element): el is HTMLElement & { labels: NodeListOf<HTMLLabelElement> } =>
  (isHtml(el, 'input') && el.type !== 'hidden') ||
  (isHtmlElement(el) && /^(button|select|textarea|meter|progress|output)$/.test(el.localName));

const isInputButton = (el: Element): el is HTMLInputElement =>
  isHtml(el, 'input') && /^(submit|reset|button)$/.test(el.type);

/** The default label of an input button, which Chrome gives in the browser's language. */
const BUTTON_LABELS: Record<string, string> = {
  submit: 'Submit',
  reset: 'Reset',
};

/** The text an input button shows: its value, or its default label. */
export const inputButtonText = (el: HTMLInputElement) => attr(el, 'value') ?? (BUTTON_LABELS[el.type] || '');

/** The texts of elements (TextFromElements), with each one's text; null when none exists. */
function textFromElements(
  elements: Element[],
  asRoot: boolean,
  c: Computation
): { text: string; related: { el: Element; text: string }[] } | null {
  if (!elements.length) return null;
  const related: { el: Element; text: string }[] = [];
  let text = '';
  for (const el of elements) {
    const result = recursiveTextAlternative(el, asRoot ? el : null, c)[0];
    c.visited.add(el);
    related.push({ el, text: result });
    if (result) text += (text ? ' ' : '') + result;
  }
  return { text, related };
}

/** A text alternative inside a computation (RecursiveTextAlternative). */
function recursiveTextAlternative(node: Node, root: Root, c: Computation): [string, From] {
  if (c.visited.has(node) && !root) return ['', 'none'];
  return isText(node) ? [textOfTextNode(node, c), 'contents'] : textAlternative(node as Element, root, c);
}

/** A text node's text: as rendered, or as written when it has no box. */
function textOfTextNode(text: Text, c: Computation): string {
  c.visited.add(text);
  return hasLayout(text) ? layoutText(text) : text.data;
}

/** The text of an element's title, unless it repeats its content (TextAlternativeFromTitleAttribute). */
function titleText(el: Element): string | null {
  const title = attr(el, 'title');
  if (title === null) return null;
  const inner = isHtmlElement(el) ? innerTextOf(el) : (textOf(el) ?? '');
  return title.trim() !== inner.trim() ? title : null;
}

/** Whether an element's name cannot come from its title: a container of text. */
const titleProhibited = (el: Element, role: string) =>
  NO_TITLE.has(role) && el.localName !== 'section' && el.localName !== 'aside' && !isFocusable(el);

/**
 * An element's text alternative inside a name computation (TextAlternative with `recursive`):
 * its text, and where it came from.
 */
function textAlternative(el: Element, root: Root, c: Computation): [string, From] {
  if (isHtml(el, 'br')) return ['\n', 'contents'];
  const role = roleOf(el);
  if (!c.visited.has(el) && el !== c.naming) {
    const value = embeddedValue(el, role, c);
    if (value !== null) return [value, 'value'];
  }
  const already = c.visited.has(el);
  c.visited.add(el);
  // A slot cannot be named: its content is its text.
  if (!isHtml(el, 'slot')) {
    if (hiddenForText(el, root)) return ['', 'none'];
    if (!root && !already) {
      const attribute = hasAttr(el, 'aria-labelledby') ? 'aria-labelledby' : 'aria-labeledby';
      const fromElements = textFromElements(targetsOf(el, attribute), true, c);
      if (fromElements && !isBlank(fromElements.text)) return [fromElements.text, 'relatedElement'];
    }
    const label = attr(el, 'aria-label');
    if (!isBlank(label)) return [label ?? '', 'attribute'];
  }
  const native = nativeText(el, c);
  if (native) return native;
  const emptyAlt = (isHtml(el, 'img') || isHtml(el, 'area')) && attr(el, 'alt') === '';
  if (includesContents(el, role, root, true)) {
    const text = textFromDescendants(el, root, c);
    if (text) return [text, 'contents'];
  }
  if ((root || !titleProhibited(el, role)) && !emptyAlt) {
    const title = titleText(el);
    if (title) return [title, 'title'];
  }
  return ['', 'none'];
}

/** Whether an element's content counts in its text (ShouldIncludeContentInTextAlternative). */
function includesContents(el: Element, role: string, root: Root, recursive: boolean): boolean {
  if (!root && !supportsNameFromContents(el, role, recursive)) return false;
  if (isHtml(el, 'select')) return false;
  return !(isNativeTextField(el) || isTextFieldRole(role)) || root === el;
}

/** What the host language names an element with, when it does (NativeTextAlternative, briefly). */
function nativeText(el: Element, c: Computation): [string, From] | null {
  if (isHtml(el, 'option') && hasOneTextChild(el) && el.label) return [el.label, 'contents'];
  if (isHtml(el, 'optgroup') && el.label) return [el.label, 'attribute'];
  if (isLabelable(el) && el.labels.length) {
    const fromElements = textFromElements(labelsOf(el, c), false, c);
    if (fromElements) {
      const text = stripHtmlSpace(fromElements.text);
      if (text) return [text, 'relatedElement'];
    }
  }
  if (isInputButton(el)) {
    const value = inputButtonText(el);
    return value ? [value, 'value'] : null;
  }
  if (isHtml(el, 'input') && el.type === 'image') {
    const alt = attr(el, 'alt');
    if (alt) return [alt, 'attribute'];
  }
  if (isHtml(el, 'img') || isHtml(el, 'area')) {
    const alt = attr(el, 'alt');
    return alt ? [alt, 'attribute'] : null;
  }
  const caption = isHtml(el, 'table') ? captionOf(el) : null;
  if (caption) {
    const text = recursiveTextAlternative(caption, null, c)[0];
    if (text) return [text, 'caption'];
  }
  const legend = isHtml(el, 'fieldset') ? query(el, ':scope > legend') : null;
  if (legend && !c.visited.has(legend)) {
    const text = recursiveTextAlternative(legend, null, c)[0];
    if (text) return [text, 'relatedElement'];
  }
  if (el.namespaceURI === SVG_NS) {
    const title = query(el, ':scope > title');
    const titleText = title && textOf(title);
    if (titleText) return [titleText, 'relatedElement'];
  }
  return null;
}

const stripHtmlSpace = (text: string) => text.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');

/** A control's labels; the control leaves itself out of their text. */
function labelsOf(el: Element & { labels: NodeListOf<HTMLLabelElement> }, c: Computation): HTMLLabelElement[] {
  c.visited.add(el);
  return [...el.labels];
}

/**
 * A ::before or ::after pseudo-element's generated text: as rendered, or its alternative text as
 * written (`content: "text" / "alternative"`). Chrome resolves attr() in the computed value;
 * counters and quotes are worked out in ax-counter.ts.
 */
function generatedText(el: Element, pseudo: '::before' | '::after'): string {
  const style = styleOf(el, pseudo);
  const parts = style.content.split(/\s\/\s/);
  if (parts.length > 1) return contentText(parts[parts.length - 1] ?? '', el, pseudo, true);
  let text = contentText(parts[0] ?? '', el, pseudo, false).replace(/[ \t\n\f\r]+/g, ' ');
  // Its space at the start or the end of a line does not show.
  const inline = style.display.startsWith('inline');
  if (text.startsWith(' ') && (!inline || (pseudo === '::before' && lineEdge(el, true)))) text = text.slice(1);
  if (text.endsWith(' ') && (!inline || (pseudo === '::after' && lineEdge(el, false)))) text = text.slice(0, -1);
  return text.replace(/\0/g, '');
}

/** A child of an element, as the text of its content walks it: a node, or a generated pseudo-element. */
type Piece = Node | { pseudo: string; text: string; alt?: boolean };

/** Whether a pseudo-element is laid out inline. */
const pseudoInline = (el: Element, pseudo: string) => styleOf(el, pseudo).display.startsWith('inline');

/** Whether an element's aria-owns moves elements: Chrome ignores it on hidden elements. */
const owns = (el: Element) => hasAttr(el, 'aria-owns') && !inDisplayNone(el) && !inAriaHidden(el);

/**
 * The children of an element as the tree has them: without those aria-owns moved elsewhere, with
 * those it owns after its own.
 */
function childrenOf(el: Element): Node[] {
  const children = domChildren(el).filter(child => !(isElement(child) && ownerOf(child)));
  if (owns(el))
    for (const owned of targetsOf(el, 'aria-owns'))
      if (ownerOf(owned) === el && !children.includes(owned)) children.push(owned);
  return children;
}

/** The element whose aria-owns moves an element, if any: its owner in the tree (ownersOf). */
function ownerOf(el: Element): Element | null {
  const root = el.id && scopeOf(el);
  const owner = root && ownersOf(root).get(el);
  return owner && owns(owner) ? owner : null;
}

/** Whether Chrome puts a space between two consecutive pieces of a text (ShouldInsertSpaceBetweenObjectsIfNeeded). */
function separates(el: Element, prev: Piece, next: Piece, prevFrom: From, nextFrom: From): boolean {
  const box = (p: Piece): { inline: boolean; atomic: boolean; block: Element | null } | null => {
    if (!isNode(p)) {
      if (styleOf(el, p.pseudo).display === 'none') return null;
      const inline = pseudoInline(el, p.pseudo);
      return {
        inline,
        atomic: inline && styleOf(el, p.pseudo).display !== 'inline',
        block: inline ? nearestBlock(el, true) : null,
      };
    }
    if (!hasLayout(p)) return null;
    if (isText(p)) return { inline: true, atomic: false, block: nearestBlock(p, false) };
    if (!isElement(p)) return null;
    const inline = isInlineLevel(p);
    return {
      inline,
      atomic: isAtomicInline(p),
      block: inline ? nearestBlock(p, false) : null,
    };
  };
  const a = box(prev);
  const b = box(next);
  if (!a || !b || !a.inline || !b.inline || !a.block || a.block !== b.block) return true;
  if (a.atomic || b.atomic) return true;
  const fromText = (from: From) => from !== 'none' && from !== 'contents';
  return fromText(prevFrom) || fromText(nextFrom);
}

/** The text of an element's content (TextFromDescendants). */
function textFromDescendants(el: Element, root: Root, c: Computation): string {
  const pieces: Piece[] = [];
  const before = generatedText(el, '::before');
  const hasAlt = (pseudo: string) => /\s\/\s/.test(styleOf(el, pseudo).content);
  if (before) pieces.push({ pseudo: '::before', text: before, alt: hasAlt('::before') });
  pieces.push(...childrenOf(el));
  const after = generatedText(el, '::after');
  if (after) pieces.push({ pseudo: '::after', text: after, alt: hasAlt('::after') });

  const actions = targetsOf(el, 'aria-actions');
  // The white space between a row's cells is not in the tree.
  const role = roleOf(el);
  let out = '';
  let prev: Piece | null = null;
  let lastFrom: From = 'none';
  let skipped = false;
  // Whether the text so far ends with a ::before's alternative text.
  let altEnd = false;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as Piece;
    // Not the element being named, which its own label's text passes over keeping both spaces.
    const wasVisited = isNode(piece) && c.visited.has(piece) && piece !== c.visited.values().next().value;
    let text: string;
    let from: From = 'contents';
    if (!isNode(piece)) text = piece.text;
    else if (isText(piece)) {
      // White space with no box has no node in the tree.
      if (isBlank(piece.data) && (!hasLayout(piece) || droppedSpace(piece) || role === 'row')) continue;
      if (c.visited.has(piece) && !root) text = '';
      else text = textOfTextNode(piece, c);
    } else if (isElement(piece)) {
      if (actions.includes(piece)) continue;
      // An svg element's title and desc name and describe it, not its contents.
      if (piece.namespaceURI === SVG_NS && (piece.localName === 'title' || piece.localName === 'desc')) continue;
      if (hiddenForText(piece, root)) {
        // An element hidden by visibility only is left out of the tree, and its elements that
        // are visible again take its place.
        if (!inDisplayNone(piece) && attr(piece, 'aria-hidden') !== 'true')
          pieces.splice(i + 1, 0, ...childrenOf(piece).filter(isElement));
        continue;
      }
      if (isPresentational(piece) && !isHtml(piece, 'br')) {
        text = textFromDescendants(piece, root, c);
        from = 'none';
      } else [text, from] = recursiveTextAlternative(piece, root, c);
    } else continue;
    if (
      text &&
      prev &&
      out &&
      !isHtmlSpace(out[out.length - 1]) &&
      !isHtmlSpace(text[0]) &&
      // Chrome sets alternative text apart from the text beside it with a space.
      (altEnd || (!isNode(piece) && piece.alt) || separates(el, prev, piece, lastFrom, from))
    )
      out += ' ';
    // An element already taken in this computation gives nothing and leaves its two sides' white space as one.
    else if (skipped && text && isHtmlSpace(text[0]) && isHtmlSpace(out[out.length - 1])) text = text.slice(1);
    out += text;
    prev = piece;
    if (text) {
      lastFrom = from;
      altEnd = !isNode(piece) && !!piece.alt;
    }
    skipped = !text && wasVisited ? true : text ? false : skipped;
  }
  return out;
}

/** One source, with its text when it has one (not null). */
function source(fields: AXValueSource, text: string | null): AXValueSource {
  return text === null ? fields : { ...fields, value: computed(text) };
}

/** A related element as name sources list it: its id, and its text. */
function relatedNode(el: Element, text: string, idOf: IdOf, idref = el.id): AXRelatedNode {
  return { backendDOMNodeId: idOf(el), ...(idref && { idref }), text };
}

/** A source and whether a text alternative was found by it. */
interface Found {
  source: AXValueSource;
  /** Whether it counts as found: the sources after it are superseded. */
  found: boolean;
}

/** The sources of an element's name, in Chrome's order for its role. */
function sourcesOf(el: Element, role: string, idOf: IdOf, c: Computation): Found[] {
  const out: Found[] = [];
  const push = (s: AXValueSource, found: boolean) => out.push({ source: s, found });

  // A line break is named by its content, a new line.
  if (isHtml(el, 'br')) {
    push(source({ type: 'contents' }, '\n'), true);
    return out;
  }
  c.visited.add(el);

  // aria-labelledby (or the misspelled aria-labeledby): the named elements' texts, in order.
  const attribute =
    hasAttr(el, 'aria-labelledby') || !hasAttr(el, 'aria-labeledby') ? 'aria-labelledby' : 'aria-labeledby';
  const idrefs = attr(el, attribute);
  if (idrefs === null) push({ type: 'relatedElement', attribute }, false);
  else {
    const fromElements = textFromElements(targetsOf(el, attribute), true, c);
    if (fromElements && !isBlank(fromElements.text)) {
      const relatedNodes = fromElements.related.map(r => relatedNode(r.el, r.text, idOf));
      push(
        source(
          {
            type: 'relatedElement',
            attribute,
            attributeValue: { type: 'idrefList', value: idrefs, relatedNodes },
          },
          fromElements.text
        ),
        true
      );
    } else
      push(
        {
          type: 'relatedElement',
          attribute,
          attributeValue: { type: 'string', value: idrefs },
          invalid: true,
        },
        false
      );
  }

  const label = attr(el, 'aria-label');
  const labelled = !isBlank(label);
  push(stringSource('aria-label', labelled ? label : null), labelled);

  nativeSources(el, role, idOf, c, push);

  // An image map's area always lists its (empty) contents, before the alt="" rule below.
  const area = isHtml(el, 'area');
  const contents = area || (includesContents(el, role, null, false) && !isInputButton(el));
  // An svg element with contents (a link) takes its title child first, then its title attribute.
  const svgTitleFirst = contents && el.namespaceURI === SVG_NS;
  if (svgTitleFirst) {
    push(...svgTitleSource(el));
    if (!titleProhibited(el, role)) push(...titleSource(el));
  }
  if (contents) {
    const text = textFromDescendants(el, null, c);
    push(source({ type: 'contents' }, text || null), !!text);
  }
  // An image with alt="" has no title source: its title describes it.
  if ((isHtml(el, 'img') || area) && attr(el, 'alt') === '') return out;
  // An editing host, not the elements in it.
  if (
    isHtmlElement(el) &&
    el.isContentEditable &&
    !(el.parentElement?.isContentEditable ?? false) &&
    !isNativeTextField(el) &&
    !isTextFieldRole(role)
  )
    push(placeholderSource(el, 'aria-placeholder'), false);
  if (el.namespaceURI === SVG_NS && !svgTitleFirst) push(...svgTitleSource(el));
  if (!titleProhibited(el, role)) push(...titleSource(el));
  return out;
}

/** An svg element's title child as a source: its text when it has one. */
function svgTitleSource(el: Element): [AXValueSource, boolean] {
  const title = query(el, ':scope > title');
  const text = (title && textOf(title)) ?? '';
  return [source({ type: 'relatedElement', nativeSource: 'title' }, text || null), !!text];
}

/** The title source: its text when the title is used (TextAlternativeFromTitleAttribute). */
function titleSource(el: Element): [AXValueSource, boolean] {
  const title = titleText(el);
  return [stringSource('title', title), title !== null];
}

/** An attribute's source, with the attribute's value and its text when there is one (not null). */
function stringSource(
  attribute: string,
  value: string | null,
  type: AXValueSource['type'] = 'attribute'
): AXValueSource {
  return value === null
    ? { type, attribute }
    : source({ type, attribute, attributeValue: { type: 'string', value } }, value);
}

/** A placeholder source read from an attribute, with the attribute's value when not empty. */
const placeholderSource = (el: Element, attribute: string) =>
  stringSource(attribute, attr(el, attribute) || null, 'placeholder');

/** A native source naming related elements, with their nodes and its text when it has one (not null). */
const nodeListSource = (
  nativeSource: NonNullable<AXValueSource['nativeSource']>,
  relatedNodes: AXRelatedNode[],
  text: string | null
) => source({ type: 'relatedElement', nativeSource, nativeSourceValue: { type: 'nodeList', relatedNodes } }, text);

/** The sources the host language gives an element (NativeTextAlternative). */
function nativeSources(
  el: Element,
  role: string,
  idOf: IdOf,
  c: Computation,
  push: (s: AXValueSource, found: boolean) => void
): void {
  if (isHtml(el, 'option') && hasOneTextChild(el)) {
    const text = el.label;
    if (text) push(source({ type: 'contents' }, text), true);
  }
  if (isHtml(el, 'optgroup')) {
    const text = el.label;
    if (text) push(source({ type: 'attribute' }, text), true);
  }
  if (isLabelable(el)) {
    const labels = [...el.labels];
    if (!labels.length) push({ type: 'relatedElement', nativeSource: 'label' }, false);
    else {
      // Chrome names the source after the last label.
      const last = labels[labels.length - 1];
      const explicit = !!last?.htmlFor && last.htmlFor === el.id;
      const nativeSource = explicit ? 'labelfor' : 'labelwrapped';
      c.naming = el;
      const fromElements = textFromElements(labels, false, c);
      c.naming = null;
      const relatedNodes = (fromElements?.related ?? []).map(r => relatedNode(r.el, r.text, idOf));
      const text = stripHtmlSpace(fromElements?.text ?? '');
      push(nodeListSource(nativeSource, relatedNodes, text), true);
    }
  }
  if (isInputButton(el)) {
    const value = attr(el, 'value');
    push(source({ type: 'attribute', attribute: 'value' }, value), value !== null);
    // Its content: the value, or the default label without one (an empty value shows nothing).
    const text = inputButtonText(el);
    push(source({ type: 'contents' }, text || null), !!text);
    return;
  }
  if (isNativeTextField(el)) {
    push(...titleSource(el));
    push(placeholderSource(el, 'placeholder'), !!attr(el, 'placeholder'));
  }
  if (isNativeTextField(el) || isTextFieldRole(role)) {
    push(placeholderSource(el, 'aria-placeholder'), !!attr(el, 'aria-placeholder'));
    return;
  }
  if (isHtml(el, 'img') || isHtml(el, 'area')) {
    const alt = attr(el, 'alt');
    push(stringSource('alt', alt), alt !== null);
    return;
  }
  if (isHtml(el, 'table')) {
    const caption = captionOf(el);
    if (!caption) push({ type: 'relatedElement', nativeSource: 'tablecaption' }, false);
    else {
      const text = recursiveTextAlternative(caption, null, c)[0];
      push(nodeListSource('tablecaption', [relatedNode(caption, text, idOf)], text), true);
    }
    const summary = attr(el, 'summary');
    push(stringSource('summary', summary), summary !== null);
  }
  if (isHtml(el, 'fieldset')) {
    // The first legend, even hidden: it then names nothing, but counts as found.
    const legend = query(el, ':scope > legend');
    if (!legend || c.visited.has(legend)) push({ type: 'relatedElement', nativeSource: 'legend' }, false);
    else {
      const text = recursiveTextAlternative(legend, null, c)[0];
      push(nodeListSource('legend', [relatedNode(legend, text, idOf)], text || null), true);
    }
  }
}

/** Marks the sources after the first one found as superseded; returns the name's text. */
function settle(sources: Found[]): string {
  let found = false;
  let text = '';
  for (const s of sources) {
    if (found) s.source.superseded = true;
    else if (!text && typeof s.source.value?.value === 'string' && s.source.value.value) text = s.source.value.value;
    if (s.found) found = true;
  }
  return text;
}

/** The text of a description's related elements (aria-describedby), joined. */
function describedByText(el: Element): string {
  const c: Computation = { visited: new Set([el]), naming: null };
  return textFromElements(targetsOf(el, 'aria-describedby'), true, c)?.text ?? '';
}

/** An element's content text, outside a name computation. */
export function contentsText(el: Element): string {
  return simplify(textFromDescendants(el, null, { visited: new Set([el]), naming: null }));
}

/**
 * An element's description, in Chrome's order: aria-describedby's targets, aria-description, then
 * the first of what did not name it: an input button's value, a table's caption, a summary's
 * content, a ruby's annotations, an svg element's desc child, the title.
 */
function descriptionOf(el: Element, name: string): string {
  const own = simplify(describedByText(el)) || simplify(attr(el, 'aria-description') ?? '');
  if (own) return own;
  const caption = isHtml(el, 'table') ? captionOf(el) : null;
  const fallbacks = [
    isInputButton(el) ? simplify(el.value) : '',
    caption ? contentsText(caption) : '',
    el.localName === 'summary' ? contentsText(el) : '',
    el.localName === 'ruby' ? queryAll(el, 'rt').map(contentsText).join(' ') : '',
    simplify(svgDescText(el)),
    simplify(titleText(el) ?? ''),
  ];
  const simplifiedName = simplify(name);
  return fallbacks.find(text => text && text !== simplifiedName) ?? '';
}

/** The text of an svg element's desc child. */
function svgDescText(el: Element): string {
  const desc = el.namespaceURI === SVG_NS ? query(el, ':scope > desc') : null;
  return (desc && textOf(desc)) ?? '';
}

/** An element's name and description (absent when empty). */
export function nameOf(
  el: Element,
  role: string,
  idOf: IdOf
): {
  name: Protocol.Accessibility.AXValue;
  description?: Protocol.Accessibility.AXValue;
} {
  const found = sourcesOf(el, role, idOf, { visited: new Set(), naming: null });
  const text = settle(found);
  const sources = found.map(f => f.source);
  // A line break's name is its text as is.
  const name = isHtml(el, 'br') ? text : simplifyName(text);
  const description = descriptionOf(el, name);
  return {
    // A slot lists no sources: it cannot be named.
    name: { ...computed(name), ...(!isHtml(el, 'slot') && { sources }) },
    ...(description && description !== name && { description: computed(description) }),
  };
}

/** The document's name: aria-label on the root element, or the title. */
export function documentNameOf(doc: Document): Protocol.Accessibility.AXValue {
  const title = simplify(doc.title);
  const sources: AXValueSource[] = [
    { type: 'relatedElement', attribute: 'aria-labelledby' },
    { type: 'attribute', attribute: 'aria-label' },
    // Chrome lists aria-label a second time, always superseded.
    { type: 'attribute', attribute: 'aria-label', superseded: true },
    source({ type: 'relatedElement', nativeSource: 'title' }, title || null),
  ];
  return { ...computed(title), sources };
}

/** A text node's name, its rendered text. */
export function textNameOf(text: Text): Protocol.Accessibility.AXValue {
  const value = hasLayout(text) ? layoutText(text) : text.data;
  // Text in a drop-down's popup, which is not laid out, lists the sources an element would.
  const unlaid = text.parentElement && isMenuList(closest(text.parentElement, 'select'));
  return {
    ...computed(value),
    sources: [
      ...(unlaid
        ? [
            { type: 'relatedElement' as const, attribute: 'aria-labelledby' },
            { type: 'attribute' as const, attribute: 'aria-label' },
          ]
        : []),
      { type: 'contents', value: computed(value) },
    ],
  };
}
