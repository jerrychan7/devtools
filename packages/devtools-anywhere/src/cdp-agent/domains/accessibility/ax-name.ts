// An element's accessible name with the list of where it could come from (`AXValue.sources`), which
// the Accessibility pane shows, and its description. Part of accessibility.js (ax-node.ts).
//
// The name and the description themselves are dom-accessibility-api's (accname 1.2); the sources,
// which only Chrome lists, follow the order and the fields Chrome gives each role.
import type { Protocol } from 'devtools-protocol';
import { computeAccessibleDescription, computeAccessibleName } from 'dom-accessibility-api';
import { isDocument, isElement, isHtml, isHtmlElement, isShadowRoot, isText, styleOf } from '../../core/realm';
import { isFocusable, renderedText } from './ax-tree';

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
const NO_TITLE = new Set(['generic', 'paragraph', 'term', 'definition', 'caption']);

const computed = (value: string): Protocol.Accessibility.AXValue => ({ type: 'computedString', value });

/** White space collapsed and trimmed, as names are. */
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The text of a related element (a label, an aria-labelledby target): its name from content. */
function textOf(el: Element): string {
  return flat(computeAccessibleName(el, { hidden: true })) || collapsedContentsOf(el);
}

/** The text of an element's content, for the `contents` source. */
export function contentsOf(el: Element): string {
  return flat(collapsedContentsOf(el));
}

/** An element's content text with white space collapsed but not trimmed, as Chrome gives a label's text. */
function collapsedContentsOf(el: Element): string {
  let out = '';
  for (const child of el.childNodes) {
    if (isText(child)) out += renderedText(child);
    else if (isElement(child)) {
      const style = styleOf(child);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const label = child.getAttribute('aria-label')?.trim();
      const text = label || (isHtml(child, 'img') ? (child.alt ?? '') : contentsOf(child));
      out += style.display.startsWith('inline') ? text : ` ${text} `;
    }
  }
  return out.replace(/\s+/g, ' ').replace(/^ /, '');
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
function relatedNode(el: Element, idOf: IdOf): AXRelatedNode {
  return { backendDOMNodeId: idOf(el), ...(el.id && { idref: el.id }), text: textOf(el) };
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
      if (target) related.push({ backendDOMNodeId: idOf(target), idref, text: textOf(target) });
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
      const related = labels.map(label => relatedNode(label, idOf));
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

/** An element's name and description (absent when empty). */
export function nameOf(
  el: Element,
  role: string,
  idOf: IdOf
): { name: Protocol.Accessibility.AXValue; description?: Protocol.Accessibility.AXValue } {
  const sources = sourcesOf(el, role, idOf);
  const winner = settle(sources);
  const name = winner;
  const description = flat(computeAccessibleDescription(el));
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
