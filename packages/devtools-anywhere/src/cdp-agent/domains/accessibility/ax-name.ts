// An element's accessible name with the list of where it could come from (`AXValue.sources`), which
// the Accessibility pane shows, and its description. Part of accessibility.js (ax-node.ts).
//
// The text of related elements (labels, aria-labelledby and aria-describedby targets) follows
// accname 1.2 as Chrome computes it; the sources, which only Chrome lists, follow the order and the
// fields Chrome gives each role.
import type { Protocol } from 'devtools-protocol';
import { isDocument, isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';
import { domChildren, isFocusable, renderedText, roleOf } from './ax-tree';

type AXValueSource = Protocol.Accessibility.AXValueSource;
type AXRelatedNode = Protocol.Accessibility.AXRelatedNode;

/** The backend node id of a DOM node, from the agent. */
export type IdOf = (node: Node) => number;

/** Roles whose name can come from their content (accname 1.2, plus Chrome's). */
const NAME_FROM_CONTENTS = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
  'DisclosureTriangle',
  'term',
]);

/** Roles that list no `title` source in Chrome: an element that is only a container of text. */
const NO_TITLE = new Set(
  'generic paragraph term definition caption code deletion insertion emphasis mark strong subscript superscript time'.split(
    ' '
  )
);

const computed = (value: string): Protocol.Accessibility.AXValue => ({ type: 'computedString', value });

/** White space collapsed and trimmed, as names are. */
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/** How the text of an element is being computed. */
interface Walk {
  /** Whether hidden content counts: inside a hidden element that was referenced. */
  hidden: boolean;
  /** Whether an aria-labelledby or aria-describedby reference was followed already. */
  referenced: boolean;
}

/** The control whose labels' text is being computed: it leaves itself out of it. */
let naming: Element | null = null;

/** The elements whose text is being computed, so that a loop of references ends. */
const visiting = new Set<Element>();

/** Whether an element is hidden from the name: not rendered, not visible or aria-hidden. */
function isHidden(el: Element): boolean {
  const style = styleOf(el);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

/** The elements an idref list attribute names, in order. */
function targetsOf(el: Element, attribute: string): Element[] {
  const root = el.getRootNode();
  if (!isDocument(root) && !isShadowRoot(root)) return [];
  const out: Element[] = [];
  for (const idref of (el.getAttribute(attribute) ?? '').split(/\s+/)) {
    const target = idref && root.getElementById(idref);
    if (target) out.push(target);
  }
  return out;
}

/** The texts of the elements an idref list names, joined (accname step 2B). */
function referencedText(el: Element, attribute: string, w: Walk): string {
  return flat(
    targetsOf(el, attribute)
      .map(target => textAlternative(target, { hidden: w.hidden || isHidden(target), referenced: true }))
      .join(' ')
  );
}

/** The text of the selected options of a select or an ARIA listbox or combobox. */
function selectedText(el: Element): string {
  if (isHtml(el, 'select')) return [...el.selectedOptions].map(o => flat(o.text)).join(' ');
  return [...el.querySelectorAll('[role=option][aria-selected=true]')].map(o => contentsOf(o)).join(' ');
}

/** The value an embedded control gives the text around it (accname step 2C), or null. */
function embeddedValue(el: Element, role: string): string | null {
  switch (role) {
    case 'textbox':
    case 'searchbox':
      return isHtml(el, 'input') || isHtml(el, 'textarea') ? el.value : (el.textContent ?? '');
    case 'combobox':
      return isHtml(el, 'input') ? el.value : selectedText(el);
    case 'listbox':
      return selectedText(el);
    case 'slider':
    case 'spinbutton':
    case 'progressbar':
    case 'meter':
    case 'scrollbar': {
      const text = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow');
      if (text !== null) return text;
      return isHtml(el, 'input') ? el.value : null;
    }
  }
  return null;
}

/** What the host language names an element with (accname step 2E): alt, an input button's value. */
function nativeText(el: Element): string {
  if (isHtml(el, 'img') || isHtml(el, 'area') || (isHtml(el, 'input') && el.type === 'image'))
    return el.getAttribute('alt') ?? '';
  if (isHtml(el, 'input') && /^(submit|reset|button)$/.test(el.type)) return el.value || BUTTON_LABELS[el.type] || '';
  if (isLabelable(el)) return flat([...el.labels].map(label => textOf(label)).join(' '));
  return '';
}

/** A ::before or ::after pseudo-element's generated text. */
function generatedText(el: Element, pseudo: string): string {
  // `content: "text" / "alternative"` names the pseudo-element with its alternative.
  const content =
    styleOf(el, pseudo)
      .content.split(/\s\/\s/)
      .pop() ?? '';
  let out = '';
  for (const m of content.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out += (m[1] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

/**
 * An element's text alternative inside a name computation (accname 2B to 2I); an embedded control
 * gives its value, unless it is the `root` the computation starts from.
 */
function textAlternative(el: Element, w: Walk, root = false): string {
  if (el === naming || visiting.has(el) || (!w.hidden && isHidden(el))) return '';
  visiting.add(el);
  try {
    if (!w.referenced) {
      const text = referencedText(el, 'aria-labelledby', w);
      if (text) return text;
    }
    const value = root ? null : embeddedValue(el, roleOf(el));
    if (value !== null) return value;
    const label = el.getAttribute('aria-label')?.trim();
    if (label) return label;
    const native = nativeText(el);
    if (native) return native;
    const contents = collapsedContentsOf(el, w);
    return contents.trim() ? contents : flat(el.getAttribute('title') ?? '');
  } finally {
    visiting.delete(el);
  }
}

/**
 * The text of a related element (a label, an aria-labelledby target), trimmed unless `raw`: Chrome
 * gives a label's text with white space collapsed only. A control gives its value unless it is the
 * `root`: a label, the element referencing itself.
 */
function textOf(el: Element, raw = false, root = true): string {
  const text = textAlternative(el, { hidden: isHidden(el), referenced: true }, root) || collapsedContentsOf(el);
  return raw ? text : flat(text);
}

/** The text of an element's content, for the `contents` source. */
export function contentsOf(el: Element): string {
  return flat(collapsedContentsOf(el));
}

/**
 * An element's content text with white space collapsed but not trimmed, as Chrome gives a label's
 * text: its children's text alternatives, generated content around them.
 */
function collapsedContentsOf(el: Element, w: Walk = { hidden: false, referenced: false }): string {
  // White space that only separates (around blocks, white space only text) is marked U+E000: Chrome
  // drops it at the ends, where the white space of the text itself stays.
  let out = generatedText(el, '::before');
  for (const child of domChildren(el)) {
    if (isText(child)) out += child.data.trim() ? renderedText(child) : '\uE000';
    else if (isElement(child)) {
      const text = textAlternative(child, w);
      out += styleOf(child).display.startsWith('inline') ? text : `\uE000${text}\uE000`;
    }
  }
  out += generatedText(el, '::after');
  return out
    .replace(/^[\s\uE000]+/, '')
    .replace(/\s*\uE000[\s\uE000]*$/, '')
    .replace(/[\s\uE000]+/g, ' ');
}

/** A form control, which labels name. */
const isLabelable = (el: Element): el is HTMLElement & { labels: NodeListOf<HTMLLabelElement> } =>
  (isHtml(el, 'input') && el.type !== 'hidden') ||
  isHtml(el, 'button') ||
  isHtml(el, 'select') ||
  isHtml(el, 'textarea') ||
  isHtml(el, 'meter') ||
  isHtml(el, 'progress') ||
  isHtml(el, 'output');

const isTextField = (el: Element) =>
  isHtml(el, 'textarea') || (isHtml(el, 'input') && /^(text|search|email|url|tel|password|number|)$/.test(el.type));

/** One source, with its value when it has a non-empty one. */
function source(fields: AXValueSource, value: string): AXValueSource {
  return value ? { ...fields, value: computed(value) } : fields;
}

/** A source read from an attribute, with the attribute's value when present. */
function attributeSource(el: Element, attribute: string, type: AXValueSource['type'] = 'attribute'): AXValueSource {
  const raw = el.getAttribute(attribute);
  if (raw === null) return { type, attribute };
  return source({ type, attribute, attributeValue: { type: 'string', value: raw } }, flat(raw));
}

/** A related element as name sources list it: its id, and its text. */
function relatedNode(el: Element, idOf: IdOf, raw = false): AXRelatedNode {
  return { backendDOMNodeId: idOf(el), ...(el.id && { idref: el.id }), text: textOf(el, raw) };
}

/** A source naming the element after a related element of its own (a caption, a legend). */
function nativeSource(
  nativeSource: Protocol.Accessibility.AXValueNativeSourceType,
  el: Element | null,
  idOf: IdOf
): AXValueSource {
  if (!el) return { type: 'relatedElement', nativeSource };
  const related = relatedNode(el, idOf);
  return source(
    { type: 'relatedElement', nativeSource, nativeSourceValue: { type: 'nodeList', relatedNodes: [related] } },
    flat(related.text ?? '')
  );
}

/** The default label of an input button, which Chrome gives in the browser's language. */
const BUTTON_LABELS: Record<string, string> = { submit: 'Submit', reset: 'Reset' };

/** The sources of an element's name, in Chrome's order for its role. */
function sourcesOf(el: Element, role: string, idOf: IdOf): AXValueSource[] {
  const sources: AXValueSource[] = [];
  // aria-labelledby: the named elements' texts, in order.
  const idrefs = el.getAttribute('aria-labelledby');
  if (idrefs === null) sources.push({ type: 'relatedElement', attribute: 'aria-labelledby' });
  else {
    const related: AXRelatedNode[] = [];
    const root = el.getRootNode();
    for (const idref of idrefs.trim().split(/\s+/).filter(Boolean)) {
      const target = isDocument(root) || isShadowRoot(root) ? root.getElementById(idref) : null;
      if (target) related.push({ backendDOMNodeId: idOf(target), idref, text: textOf(target, false, target === el) });
    }
    sources.push(
      source(
        {
          type: 'relatedElement',
          attribute: 'aria-labelledby',
          attributeValue: { type: 'idrefList', value: idrefs, relatedNodes: related },
        },
        flat(related.map(r => r.text).join(' '))
      )
    );
  }
  sources.push(attributeSource(el, 'aria-label'));
  if (isLabelable(el)) {
    const labels = [...el.labels];
    if (!labels.length) sources.push({ type: 'relatedElement', nativeSource: 'label' });
    else {
      naming = el;
      const related = labels.map(label => relatedNode(label, idOf, true));
      naming = null;
      const explicit = labels.some(label => label.htmlFor);
      sources.push(
        source(
          {
            type: 'relatedElement',
            nativeSource: explicit ? 'labelfor' : 'labelwrapped',
            nativeSourceValue: { type: 'nodeList', relatedNodes: related },
          },
          flat(related.map(r => r.text).join(' '))
        )
      );
    }
  }
  if (isHtml(el, 'img') || isHtml(el, 'area')) sources.push(attributeSource(el, 'alt'));
  if (isHtml(el, 'table')) {
    sources.push(nativeSource('tablecaption', el.caption, idOf));
    sources.push(attributeSource(el, 'summary'));
  }
  if (isHtml(el, 'fieldset')) sources.push(nativeSource('legend', el.querySelector(':scope > legend'), idOf));
  const inputButton = isHtml(el, 'input') && /^(submit|reset|button)$/.test(el.type);
  if (inputButton) sources.push(attributeSource(el, 'value'));
  if (inputButton) sources.push(source({ type: 'contents' }, el.value || BUTTON_LABELS[el.type] || ''));
  else if (NAME_FROM_CONTENTS.has(role)) sources.push(source({ type: 'contents' }, contentsOf(el)));
  if (isHtmlElement(el) && el.isContentEditable && !isTextField(el))
    sources.push(attributeSource(el, 'aria-placeholder', 'placeholder'));
  if (isTextField(el)) {
    sources.push(attributeSource(el, 'title'));
    sources.push(attributeSource(el, 'placeholder', 'placeholder'));
    sources.push(attributeSource(el, 'aria-placeholder', 'placeholder'));
  }
  if (el.localName === 'svg' && el.namespaceURI === 'http://www.w3.org/2000/svg') {
    const title = el.querySelector(':scope > title');
    sources.push(source({ type: 'relatedElement', nativeSource: 'title' }, title ? flat(title.textContent ?? '') : ''));
  }
  if (!NO_TITLE.has(role) || el.localName === 'section' || isFocusable(el)) sources.push(attributeSource(el, 'title'));
  return sources;
}

/** Marks the sources after the first with a value as superseded; returns that value. */
function settle(sources: AXValueSource[]): string {
  let found = '';
  for (const s of sources) {
    if (found) s.superseded = true;
    else if (typeof s.value?.value === 'string' && s.value.value) found = s.value.value;
  }
  return found;
}

/** An element's description: aria-describedby's targets, aria-description, or its title. */
function descriptionOf(el: Element): string {
  return (
    referencedText(el, 'aria-describedby', { hidden: false, referenced: false }) ||
    flat(el.getAttribute('aria-description') ?? '') ||
    flat(el.getAttribute('title') ?? '')
  );
}

/** An element's name and description (absent when empty). */
export function nameOf(
  el: Element,
  role: string,
  idOf: IdOf
): { name: Protocol.Accessibility.AXValue; description?: Protocol.Accessibility.AXValue } {
  const sources = sourcesOf(el, role, idOf);
  const name = settle(sources);
  const description = descriptionOf(el);
  return {
    name: { ...computed(name), sources },
    ...(description && description !== name && { description: computed(description) }),
  };
}

/** The document's name: aria-label on the root element, or the title. */
export function documentNameOf(doc: Document): Protocol.Accessibility.AXValue {
  const sources: AXValueSource[] = [
    { type: 'relatedElement', attribute: 'aria-labelledby' },
    { type: 'attribute', attribute: 'aria-label' },
    // Chrome lists aria-label a second time, always superseded.
    { type: 'attribute', attribute: 'aria-label', superseded: true },
    source({ type: 'relatedElement', nativeSource: 'title' }, flat(doc.title)),
  ];
  return { ...computed(flat(doc.title)), sources };
}

/** A text node's name, its rendered text. */
export function textNameOf(text: Text): Protocol.Accessibility.AXValue {
  const value = renderedText(text);
  return { ...computed(value), sources: [{ type: 'contents', value: computed(value) }] };
}
