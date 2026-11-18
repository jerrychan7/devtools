// Entry of accessibility.js, which the Accessibility domain loads on first use (accessibility.ts):
// it turns the DOM into CDP AXNodes. Kept out of the bundle like snapDOM, for its size.
import type { Protocol } from 'devtools-protocol';
import { contentsOf, documentNameOf, nameOf, textNameOf, type IdOf } from './ax-name';
import { TreeShape, isFocusable, isInternalRole, roleOf } from './ax-tree';
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

/** A tristate ARIA attribute ("true", "false", "mixed"), if set. */
const tristate = (value: string | null) => (value === 'true' || value === 'false' || value === 'mixed' ? value : null);

/** A true/false ARIA attribute, if set to either. */
const ariaBool = (el: Element, name: string) => {
  const value = el.getAttribute(name)?.trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
};

/** A number ARIA attribute, if set to one. */
const ariaNumber = (el: Element, name: string) => {
  const value = el.getAttribute(name);
  if (value === null || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Form-associated (listed) elements: those Chrome checks the validity of. */
const isListed = (el: Element) =>
  isHtml(el, 'input') ||
  isHtml(el, 'button') ||
  isHtml(el, 'select') ||
  isHtml(el, 'textarea') ||
  isHtml(el, 'fieldset') ||
  isHtml(el, 'output') ||
  isHtml(el, 'object');

/** Input types whose control is a text field (Chrome's atomic text field). */
const TEXT_INPUT = /^(text|search|email|url|tel|password)$/;

/** An input or textarea that edits text. */
const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  isHtml(el, 'textarea') || (isHtml(el, 'input') && TEXT_INPUT.test(el.type));

/** A select shown as a drop-down (Chrome's ComboBoxSelect), not as a list box. */
const isMenuList = (el: Element): boolean => isHtml(el, 'select') && !el.multiple && el.size <= 1;

/** The kind of combobox, as Chrome tells them apart: a select, a text field, or anything else. */
function comboboxKind(el: Element, role: string): 'select' | 'textField' | 'button' | null {
  if (role !== 'combobox') return null;
  if (isMenuList(el)) return 'select';
  return isTextField(el) ? 'textField' : 'button';
}

/** The roles Chrome gives a range (valuemin, valuemax, valuetext and a number value). */
function isRange(el: Element, role: string): boolean {
  if (/^(meter|progressbar|scrollbar|slider|spinbutton)$/.test(role)) return true;
  // A separator is a splitter, with a range, only when focusable (not by contenteditable).
  return role === 'separator' && isFocusable(el) && !(isHtmlElement(el) && el.isContentEditable);
}

/** Whether an input is Chrome's native slider or spin button, whose range comes from the input. */
const isNativeRange = (el: Element): el is HTMLInputElement =>
  isHtml(el, 'input') && (el.type === 'range' || el.type === 'number');

/** A range's minimum and maximum, as Chrome gives them (0 when it has none). */
function rangeBounds(el: Element, role: string): { min: number | null; max: number | null } {
  const implicit = role === 'spinbutton' ? null : 0;
  const min = ariaNumber(el, 'aria-valuemin');
  const max = ariaNumber(el, 'aria-valuemax');
  if (isHtml(el, 'meter')) return { min: min ?? el.min, max: max ?? el.max };
  return { min: min ?? implicit, max: max ?? (implicit === null ? null : 100) };
}

/** An ARIA range's current value, aria-valuenow or the default ARIA gives its role. */
function rangeValue(el: Element, role: string): number | null {
  const { min, max } = rangeBounds(el, role);
  const now = ariaNumber(el, 'aria-valuenow');
  if (now !== null) {
    if (min !== null && now < min) return min;
    if (max !== null && now > max) return max;
    return now;
  }
  if (isHtml(el, 'meter')) return el.value;
  switch (role) {
    case 'scrollbar':
    case 'slider':
      return min !== null && max !== null ? (min + max) / 2 : 50;
    case 'separator':
      return 50;
    case 'meter':
      return min ?? 0;
    case 'spinbutton':
      return 0;
    default:
      return null;
  }
}

/** A password's value masked as Chrome shows it, with the field's -webkit-text-security. */
function masked(el: HTMLInputElement, value: string): string {
  const security = (getComputedStyle(el) as CSSStyleDeclaration & { webkitTextSecurity?: string }).webkitTextSecurity;
  const mask = security === 'circle' ? '◦' : security === 'square' ? '■' : security === 'none' ? '' : '•';
  return mask ? mask.repeat(value.length) : value;
}

/** Input types whose value Chrome does not give (it would be "on" or the button's label). */
const VALUELESS_INPUT = /^(button|checkbox|image|radio|reset|submit|file|hidden)$/;

/** An element's value (`AXNode.value`), for the roles Chrome gives one. */
function valueOf(el: Element, role: string): AXValue | undefined {
  if (isNativeRange(el))
    return Number.isNaN(el.valueAsNumber) ? undefined : { type: 'number', value: el.valueAsNumber };
  if (isHtml(el, 'progress')) return el.hasAttribute('value') ? { type: 'number', value: el.value } : undefined;
  if (isRange(el, role)) {
    const value = rangeValue(el, role);
    return value === null ? undefined : { type: 'number', value };
  }
  const text = textValueOf(el, role);
  return text ? { type: 'string', value: text } : undefined;
}

/** The text value of a control (Chrome's GetValueForControl), or of an editable element. */
function textValueOf(el: Element, role: string): string {
  if (isHtml(el, 'select')) {
    if (!isMenuList(el)) return '';
    const option = el.selectedOptions[0];
    return option ? (option.getAttribute('aria-label') ?? option.text.trim()) : '';
  }
  if (isHtml(el, 'textarea')) return el.value;
  if (isHtml(el, 'input')) {
    if (VALUELESS_INPUT.test(el.type)) return '';
    return el.type === 'password' ? masked(el, el.value) : el.value;
  }
  // A focusable ARIA combobox (Chrome's ComboBoxMenuButton) shows its content as its value.
  if (comboboxKind(el, role) === 'button') return isFocusable(el) ? contentsOf(el) : '';
  if (role === 'textbox' || role === 'searchbox' || isEditingHost(el)) return el.textContent ?? '';
  return '';
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

/** Whether a native control's value is valid, as Chrome tells (AXNodeObject::IsValidFormControl). */
function isValidControl(el: Element): boolean {
  const control = el as HTMLInputElement;
  if (!control.validity) return true;
  if (control.validity.customError) return false;
  if (!control.willValidate || control.validity.valid) return true;
  // An empty required text field is not reported invalid: it is already said to be required.
  return isTextField(el) && el.required && !el.value;
}

/** Roles that take aria-orientation, with the orientation ARIA gives them by default. */
const ORIENTATION: Record<string, string | null> = {
  listbox: 'vertical',
  menu: 'vertical',
  menubar: 'horizontal',
  scrollbar: 'vertical',
  separator: 'horizontal',
  slider: 'horizontal',
  tablist: 'horizontal',
  toolbar: 'horizontal',
  tree: 'vertical',
  radiogroup: null,
  treegrid: null,
};

/** An element's orientation, explicit or the role's default. */
function orientationOf(el: Element, role: string): string | null {
  const explicit = el.getAttribute('aria-orientation')?.trim().toLowerCase();
  const valid = explicit === 'horizontal' || explicit === 'vertical' ? explicit : null;
  if (role === 'combobox') return valid;
  if (!(role in ORIENTATION)) return null;
  return valid ?? ORIENTATION[role] ?? null;
}

/** Roles whose items Chrome says are selected or not even without aria-selected. */
const SELECT_ITEM = /^(option|tab|treeitem)$/;
/** The widgets that hold such items. */
const CONTAINER_WIDGET = /^(listbox|tablist|tree|treegrid|grid|combobox|menu|menubar)$/;

/** The selected state Chrome gives an option, tab or tree item, if any. */
function selectedOf(el: Element, role: string): boolean | null {
  const explicit = ariaBool(el, 'aria-selected');
  if (explicit !== null) return explicit;
  if (isHtml(el, 'option')) return el.selected;
  if (!SELECT_ITEM.test(role)) return null;
  if (el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus()) return true;
  let container: Element | null = el.parentElement;
  while (container && !CONTAINER_WIDGET.test(roleOf(container))) container = container.parentElement;
  if (container) {
    const multiple = ariaBool(container, 'aria-multiselectable') ?? (isHtml(container, 'select') && container.multiple);
    if (multiple || container.querySelector('[aria-checked]')) return null;
  }
  return false;
}

/** The nesting level Chrome gives an element (aria-level, or counted for some roles). */
function levelOf(el: Element, role: string): number | null {
  const ariaLevel = Number(el.getAttribute('aria-level'));
  if (Number.isInteger(ariaLevel) && ariaLevel > 0) return ariaLevel;
  // A heading without a level is at level 2, as in Chrome.
  if (/^h[1-6]$/.test(el.localName)) return Number(el.localName[1]);
  if (role === 'heading') return 2;
  if (role === 'listitem') return listLevel(el);
  if (role === 'treeitem') {
    let level = 1;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const r = roleOf(p);
      if (r === 'group') level++;
      else if (r === 'tree') break;
    }
    return level;
  }
  return null;
}

/** Roles with a readonly state (Chrome's RoleAllowsReadonly). */
const READONLY_ROLE = /^(grid|gridcell|textbox|columnheader|rowheader|treegrid)$/;
/** Roles with a required state (Chrome's RoleAllowsRequired; combobox but not select). */
const REQUIRED_ROLE = /^(gridcell|listbox|radiogroup|spinbutton|textbox|tree|columnheader|rowheader|treegrid)$/;
/** Roles whose readonly comes from aria-readonly (ui::IsReadOnlySupported and grid cells). */
const ARIA_READONLY_ROLE =
  /^(checkbox|ColorWell|combobox|Date|DateTime|grid|gridcell|InputTime|listbox|menuitemcheckbox|menuitemradio|radio|radiogroup|searchbox|slider|spinbutton|switch|textbox|treegrid)$/;
/** Roles whose value can be set (Chrome's CanSetValueAttribute). */
const SETTABLE_ROLE = /^(ColorWell|Date|DateTime|InputTime|scrollbar|searchbox|slider|spinbutton|separator|textbox)$/;

/** Whether an element is read-only, natively or by aria-readonly (Chrome's Restriction). */
function isReadOnly(el: Element, role: string): boolean {
  if ((isHtml(el, 'textarea') || (isHtml(el, 'input') && TEXT_INPUT.test(el.type))) && el.readOnly) return true;
  if (isHtml(el, 'input') && el.type === 'number' && el.readOnly) return true;
  const contentEditable = el.hasAttribute('contenteditable');
  const explicit = ariaBool(el, 'aria-readonly');
  if (!contentEditable && explicit !== null && ARIA_READONLY_ROLE.test(role)) return explicit;
  if (/^(gridcell|columnheader|rowheader)$/.test(role)) {
    const grid = el.parentElement?.parentElement;
    const gridRole = grid ? roleOf(grid) : null;
    if (grid && (gridRole === 'grid' || gridRole === 'treegrid')) return ariaBool(grid, 'aria-readonly') === true;
  }
  return false;
}

/** Live region properties of a live region's root: its politeness, atomic and relevant. */
function liveRegion(el: Element, role: string): AXProperty[] {
  const implicit: Record<string, [string, boolean]> = {
    alert: ['assertive', true],
    status: ['polite', true],
    log: ['polite', false],
    marquee: ['off', false],
    timer: ['off', false],
  };
  const live = el.getAttribute('aria-live')?.trim().toLowerCase() || implicit[role]?.[0];
  if (!live || live === 'off') return [];
  const atomic = ariaBool(el, 'aria-atomic') ?? implicit[role]?.[1] ?? false;
  const relevant = el.getAttribute('aria-relevant')?.trim() || 'additions text';
  return [prop('live', 'token', live), bool('atomic', atomic, 'boolean'), prop('relevant', 'tokenList', relevant)];
}

/** An element's properties, in Chrome's order (inspector_type_builder_helper.cc). */
function propertiesOf(el: Element, role: string, idOf: IdOf, nameSources: AXValue['sources']): AXProperty[] {
  const out: AXProperty[] = liveRegion(el, role);
  const combobox = comboboxKind(el, role);
  // Global states.
  // An object element that shows no content (no plugin, no frame) is disabled.
  const emptyObject = isHtml(el, 'object') && !el.contentWindow;
  const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || emptyObject;
  if (disabled) out.push(bool('disabled', true, 'boolean'));
  const invalid = el.getAttribute('aria-invalid');
  if (invalid && invalid !== 'false') out.push(prop('invalid', 'token', invalid));
  else if (isListed(el)) out.push(prop('invalid', 'token', invalid === null && !isValidControl(el) ? 'true' : 'false'));
  else if (invalid !== null) out.push(prop('invalid', 'token', 'false'));
  if (isFocusable(el) || (isHtml(el, 'dialog') && el.open)) out.push(bool('focusable', true));
  if (el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus()) out.push(bool('focused', true));
  const field = isTextField(el) || isNativeRange(el);
  const editableField = field && (/^(textbox|searchbox|spinbutton)$/.test(role) || combobox === 'textField');
  const readOnly = isReadOnly(el, role);
  if (editableField) out.push(prop('editable', 'token', 'plaintext'));
  else if (isEditingHost(el)) out.push(prop('editable', 'token', 'richtext'));
  const settable = SETTABLE_ROLE.test(role) || combobox === 'textField';
  if (settable && !disabled && !readOnly) out.push(bool('settable', true));
  // Widget properties.
  if (combobox === 'select') out.push(prop('hasPopup', 'token', 'menu'));
  else {
    const popup = hasPopup(el) ?? (combobox ? 'listbox' : null);
    if (popup) out.push(prop('hasPopup', 'token', popup));
  }
  const level = levelOf(el, role);
  if (level !== null) out.push(prop('level', 'integer', level));
  if (/^(tablist|listbox|grid|tree|treegrid)$/.test(role)) {
    const multiple = ariaBool(el, 'aria-multiselectable') ?? (isHtml(el, 'select') && el.multiple);
    out.push(bool('multiselectable', multiple, 'boolean'));
  }
  const orientation = isNativeRange(el) && el.type === 'range' ? 'horizontal' : orientationOf(el, role);
  if (orientation) out.push(prop('orientation', 'token', orientation));
  if (role === 'textbox')
    out.push(bool('multiline', isHtml(el, 'textarea') || ariaBool(el, 'aria-multiline') === true, 'boolean'));
  if (READONLY_ROLE.test(role)) out.push(bool('readonly', readOnly, 'boolean'));
  if (REQUIRED_ROLE.test(role) || combobox === 'textField' || combobox === 'button') {
    const native = (isTextField(el) || isNativeRange(el) || isHtml(el, 'select')) && el.required;
    out.push(bool('required', native || el.getAttribute('aria-required') === 'true', 'boolean'));
  }
  if (isNativeRange(el)) {
    const max = el.type === 'range' ? 100 : 0;
    out.push(prop('valuemin', 'number', Number(el.min || 0)));
    out.push(prop('valuemax', 'number', Number(el.max || max)));
    out.push(prop('valuetext', 'string', el.value));
  } else if (isHtml(el, 'progress')) {
    out.push(prop('valuemin', 'number', 0));
    out.push(prop('valuemax', 'number', el.max));
    out.push(prop('valuetext', 'string', ''));
  } else if (isRange(el, role)) {
    const { min, max } = rangeBounds(el, role);
    out.push(prop('valuemin', 'number', min ?? 0));
    out.push(prop('valuemax', 'number', max ?? 0));
    // Chrome gives an ARIA range no valuetext, whatever aria-valuetext says.
    out.push(prop('valuetext', 'string', ''));
  }
  // Widget states.
  const pressed = role === 'button' ? tristate(el.getAttribute('aria-pressed')) : null;
  if (pressed) out.push(prop('pressed', 'tristate', pressed));
  else if (isHtml(el, 'input') && (el.type === 'checkbox' || el.type === 'radio'))
    out.push(prop('checked', 'tristate', el.indeterminate ? 'mixed' : String(el.checked)));
  else if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role))
    out.push(prop('checked', 'tristate', tristate(el.getAttribute('aria-checked')) ?? 'false'));
  if (combobox === 'select') out.push(bool('expanded', false));
  else if (role === 'DisclosureTriangle' && isHtml(el.parentElement, 'details'))
    out.push(bool('expanded', el.parentElement.open));
  else if (!isHtml(el, 'select')) {
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true' || expanded === 'false') out.push(bool('expanded', expanded === 'true'));
  }
  const selected = selectedOf(el, role);
  if (selected !== null) out.push(bool('selected', selected));
  if (role === 'dialog' || role === 'alertdialog')
    out.push(bool('modal', ariaBool(el, 'aria-modal') ?? (isHtml(el, 'dialog') && el.matches(':modal')), 'boolean'));
  // Relationships, then sparse attributes.
  for (const name of ['describedby', 'owns'] as const) {
    const list = idrefList(el, name, idOf);
    if (list && !(name === 'describedby' && !list.value.relatedNodes?.length)) out.push(list);
  }
  const url = urlOf(el, role);
  if (url) out.push(prop('url', 'string', url));
  const active = activeDescendant(el);
  if (active)
    out.push({
      name: 'activedescendant',
      value: {
        type: 'idref',
        relatedNodes: [{ backendDOMNodeId: idOf(active), ...(active.id && { idref: active.id }) }],
      },
    });
  for (const name of ['controls', 'details', 'flowto'] as const) {
    const list = idrefList(el, name, idOf);
    if (list) out.push(list);
  }
  // labelledby: the nodes of the source that named it, aria-labelledby's or the labels'.
  const named = nameSources?.find(s => s.value && !s.superseded);
  const related = named?.attributeValue?.relatedNodes ?? named?.nativeSourceValue?.relatedNodes;
  if (related) out.push({ name: 'labelledby', value: { type: 'nodeList', relatedNodes: related } });
  return out;
}

/** The active descendant: a list box select's selected option, or aria-activedescendant's target. */
function activeDescendant(el: Element): Element | null {
  if (isHtml(el, 'select')) {
    if (isMenuList(el)) return null;
    const selected = el.selectedOptions;
    return selected[selected.length - 1] ?? null;
  }
  const idref = el.getAttribute('aria-activedescendant')?.trim();
  const root = el.getRootNode();
  if (!idref || !(isDocument(root) || isShadowRoot(root))) return null;
  return root.getElementById(idref);
}

/** The url Chrome gives a link (its href) or an image (the source it shows). */
function urlOf(el: Element, role: string): string | null {
  if (role === 'link' && (isHtml(el, 'a') || isHtml(el, 'area'))) return el.href;
  if (role === 'image' && isHtml(el, 'img')) return el.currentSrc.trim() || null;
  return null;
}

/** A role as CDP gives it: ARIA roles as `role`, Chrome's own as `internalRole`. */
const roleValue = (role: string): AXValue => ({
  type: isInternalRole(role) ? 'internalRole' : 'role',
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
