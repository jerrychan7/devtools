// Entry of accessibility.js, which the Accessibility domain loads on first use (accessibility.ts):
// it turns the DOM into CDP AXNodes. Kept out of the bundle like snapDOM, for its size.
import type { Protocol } from 'devtools-protocol';
import { documentNameOf, nameOf, textNameOf, type IdOf } from './ax-name';
import { INTERNAL_ROLES, TreeShape, isFocusable, roleOf } from './ax-tree';
import { isDocument, isElement, isHtml, isHtmlElement, isShadowRoot, isText } from '../../core/realm';

type AXNode = Protocol.Accessibility.AXNode;
type AXProperty = Protocol.Accessibility.AXProperty;
type AXValue = Protocol.Accessibility.AXValue;
type AXPropertyName = Protocol.Accessibility.AXPropertyName;

/** The accessibility tree of a document, as CDP AXNodes. */
export interface AXTree {
  /** The AXNode of a DOM node: in the tree, or one ignored with why not. */
  node(node: Node): AXNode;
  /** The closest node in the tree above a DOM node. */
  parent(node: Node): Node | null;
  /** The DOM nodes of a node's children in the tree. */
  children(node: Node): Node[];
  /** Whether a DOM node has a node in the tree. */
  inTree(node: Node): boolean;
}

/** What accessibility.js exports. */
export interface AccessibilityModule {
  createAXTree(doc: Document, idOf: IdOf, frameId: string): AXTree;
}

const bool = (name: AXPropertyName, value: boolean, type: AXValue['type'] = 'booleanOrUndefined'): AXProperty => ({
  name,
  value: { type, value },
});
const prop = (name: AXPropertyName, type: AXValue['type'], value: unknown): AXProperty => ({
  name,
  value: { type, value },
});

/** A tristate ARIA attribute ("true", "false", "mixed"), if set. */
const tristate = (value: string | null) => (value === 'true' || value === 'false' || value === 'mixed' ? value : null);

const isNativeControl = (el: Element) =>
  isHtml(el, 'input') || isHtml(el, 'button') || isHtml(el, 'select') || isHtml(el, 'textarea');

/** The idrefs of an attribute, with the nodes they name. */
function idrefList(el: Element, name: AXPropertyName, idOf: IdOf): AXProperty | null {
  const value = el.getAttribute(`aria-${name}`);
  if (value === null) return null;
  const root = el.getRootNode();
  const relatedNodes: Protocol.Accessibility.AXRelatedNode[] = [];
  for (const idref of value.trim().split(/\s+/).filter(Boolean)) {
    const target = isDocument(root) || isShadowRoot(root) ? root.getElementById(idref) : null;
    if (target) relatedNodes.push({ backendDOMNodeId: idOf(target), idref });
  }
  return { name, value: { type: 'idrefList', value, relatedNodes } };
}

/** The nesting level of a list item: how many lists hold it. */
function listLevel(el: Element): number {
  let level = 0;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === 'ul' || p.localName === 'ol') level++;
  return Math.max(level, 1);
}

/** An element's value (`AXNode.value`), for the roles Chrome gives one. */
function valueOf(el: Element, role: string): AXValue | undefined {
  if (isHtml(el, 'input') && (el.type === 'range' || el.type === 'number'))
    return Number.isNaN(el.valueAsNumber) ? undefined : { type: 'number', value: el.valueAsNumber };
  if (isHtml(el, 'progress') && el.hasAttribute('value')) return { type: 'number', value: el.value };
  if ((isHtml(el, 'input') || isHtml(el, 'textarea')) && /^(textbox|searchbox)$/.test(role) && el.value)
    return { type: 'string', value: el.value };
  if (isHtml(el, 'select') && role === 'combobox') {
    const option = el.selectedOptions[0];
    return { type: 'string', value: option ? option.text.trim() : '' };
  }
  if (isEditingHost(el) && el.textContent) return { type: 'string', value: el.textContent };
  return undefined;
}

/** An element with contenteditable on it (not inherited). */
const isEditingHost = (el: Element) =>
  isHtmlElement(el) && el.isContentEditable && !(el.parentElement?.isContentEditable ?? false);

/** aria-haspopup's popup, `true` meaning a menu. */
function hasPopup(el: Element): string | null {
  const value = el.getAttribute('aria-haspopup');
  if (value === 'true') return 'menu';
  return value && /^(menu|listbox|tree|grid|dialog)$/.test(value) ? value : null;
}

/** An element's properties, in Chrome's order. */
function propertiesOf(el: Element, role: string, idOf: IdOf, nameSources: AXValue['sources']): AXProperty[] {
  const out: AXProperty[] = [];
  const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
  if (disabled) out.push(bool('disabled', true, 'boolean'));
  const invalid = el.getAttribute('aria-invalid');
  if (isNativeControl(el) || isHtml(el, 'fieldset') || invalid !== null)
    out.push(prop('invalid', 'token', invalid && invalid !== 'false' ? invalid : 'false'));
  if (isFocusable(el)) out.push(bool('focusable', true));
  if (el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus()) out.push(bool('focused', true));
  const field = (isHtml(el, 'input') || isHtml(el, 'textarea')) && /^(textbox|searchbox|spinbutton)$/.test(role);
  const readOnly = field && el.readOnly;
  if (field) out.push(prop('editable', 'token', 'plaintext'));
  else if (isEditingHost(el)) out.push(prop('editable', 'token', 'richtext'));
  if ((field && !readOnly && !disabled) || (isHtml(el, 'input') && el.type === 'range') || isHtml(el, 'hr'))
    out.push(bool('settable', true));
  if (isHtml(el, 'select') && role === 'combobox') {
    out.push(prop('hasPopup', 'token', 'menu'));
    out.push(bool('expanded', false));
  } else {
    const popup = hasPopup(el);
    if (popup) out.push(prop('hasPopup', 'token', popup));
  }
  if (role === 'DisclosureTriangle' && isHtml(el.parentElement, 'details'))
    out.push(bool('expanded', el.parentElement.open));
  else if (!isHtml(el, 'select')) {
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true' || expanded === 'false') out.push(bool('expanded', expanded === 'true'));
  }
  if (field && role === 'textbox') {
    out.push(bool('multiline', isHtml(el, 'textarea'), 'boolean'));
    out.push(bool('readonly', readOnly, 'boolean'));
  }
  if (field && role !== 'searchbox') out.push(bool('required', el.required, 'boolean'));
  if (role === 'columnheader' || role === 'rowheader') {
    out.push(bool('readonly', false, 'boolean'));
    out.push(bool('required', false, 'boolean'));
  }
  if (role === 'tablist' || role === 'listbox' || role === 'grid' || role === 'tree')
    out.push(bool('multiselectable', el.getAttribute('aria-multiselectable') === 'true', 'boolean'));
  if (role === 'tablist' || role === 'separator' || (isHtml(el, 'input') && el.type === 'range'))
    out.push(prop('orientation', 'token', el.getAttribute('aria-orientation') ?? 'horizontal'));
  if (isHtml(el, 'input') && (el.type === 'range' || el.type === 'number')) {
    const max = el.type === 'range' ? 100 : 0;
    out.push(prop('valuemin', 'number', Number(el.min || 0)));
    out.push(prop('valuemax', 'number', Number(el.max || max)));
    out.push(prop('valuetext', 'string', el.value));
  }
  if (isHtml(el, 'progress')) {
    out.push(prop('valuemin', 'number', 0));
    out.push(prop('valuemax', 'number', el.max));
    out.push(prop('valuetext', 'string', ''));
  }
  if (isHtml(el, 'input') && (el.type === 'checkbox' || el.type === 'radio'))
    out.push(prop('checked', 'tristate', el.indeterminate ? 'mixed' : String(el.checked)));
  else if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role))
    out.push(prop('checked', 'tristate', tristate(el.getAttribute('aria-checked')) ?? 'false'));
  if (isHtml(el, 'option')) out.push(bool('selected', el.selected));
  else if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-selected') === 'false')
    out.push(bool('selected', el.getAttribute('aria-selected') === 'true'));
  // A heading without a level is at level 2, as in Chrome.
  const level = /^h[1-6]$/.test(el.localName)
    ? Number(el.localName[1])
    : role === 'heading'
      ? 2
      : role === 'listitem'
        ? listLevel(el)
        : null;
  const ariaLevel = Number(el.getAttribute('aria-level'));
  if (ariaLevel > 0) out.push(prop('level', 'integer', ariaLevel));
  else if (level !== null) out.push(prop('level', 'integer', level));
  if (role === 'link' && (isHtml(el, 'a') || isHtml(el, 'area'))) out.push(prop('url', 'string', el.href));
  if (role === 'image' && isHtml(el, 'img') && el.src) out.push(prop('url', 'string', el.src));
  for (const name of ['describedby', 'owns', 'controls', 'flowto', 'details'] as const) {
    const list = idrefList(el, name, idOf);
    if (list) out.push(list);
  }
  // labelledby: the nodes of the source that named it, aria-labelledby's or the labels'.
  const named = nameSources?.find(s => s.value && !s.superseded);
  const related = named?.attributeValue?.relatedNodes ?? named?.nativeSourceValue?.relatedNodes;
  if (related) out.push({ name: 'labelledby', value: { type: 'nodeList', relatedNodes: related } });
  return out;
}

/** A role as CDP gives it: ARIA roles as `role`, Chrome's own as `internalRole`. */
const roleValue = (role: string): AXValue => ({
  type: INTERNAL_ROLES.has(role) ? 'internalRole' : 'role',
  value: role,
});

export function createAXTree(doc: Document, idOf: IdOf, frameId: string): AXTree {
  const shape = new TreeShape(doc);
  const id = (node: Node) => String(idOf(node));
  const links = (node: Node, base: AXNode): AXNode => {
    const parent = shape.parent(node);
    return {
      ...base,
      ...(parent && { parentId: id(parent) }),
      childIds: shape.children(node).map(id),
      backendDOMNodeId: idOf(node),
    };
  };
  return {
    parent: node => shape.parent(node),
    children: node => shape.children(node),
    inTree: node => shape.inTree(node),
    node(node) {
      const inclusion = shape.inclusion(node);
      if (inclusion.kind !== 'included') {
        const relatedNodes =
          inclusion.kind === 'ignored' && inclusion.hiddenRoot && inclusion.reason === 'ariaHiddenSubtree'
            ? [
                {
                  backendDOMNodeId: idOf(inclusion.hiddenRoot),
                  ...(inclusion.hiddenRoot.id && { idref: inclusion.hiddenRoot.id }),
                },
              ]
            : undefined;
        const reason: AXProperty = {
          name: inclusion.reason,
          value: relatedNodes ? { type: 'idref', relatedNodes } : { type: 'boolean', value: true },
        };
        return links(node, {
          nodeId: id(node),
          ignored: true,
          ignoredReasons: [reason],
          role: { type: 'role', value: 'none' },
        });
      }
      if (node === doc) {
        const properties = [bool('focusable', true)];
        const active = doc.activeElement;
        if (doc.hasFocus() && (!active || active === doc.body)) properties.push(bool('focused', true));
        properties.push(prop('url', 'string', doc.URL));
        return {
          ...links(node, {
            nodeId: id(node),
            ignored: false,
            role: roleValue('RootWebArea'),
            name: documentNameOf(doc),
            properties,
          }),
          frameId,
        };
      }
      if (isText(node))
        return links(node, {
          nodeId: id(node),
          ignored: false,
          role: roleValue('StaticText'),
          name: textNameOf(node),
          properties: [],
        });
      if (!isElement(node)) throw new Error('not an element');
      const role = roleOf(node);
      const { name, description } = nameOf(node, role, idOf);
      const value = valueOf(node, role);
      return links(node, {
        nodeId: id(node),
        ignored: false,
        role: roleValue(role),
        name,
        ...(description && { description }),
        ...(value && { value }),
        properties: propertiesOf(node, role, idOf, name.sources),
      });
    },
  };
}
