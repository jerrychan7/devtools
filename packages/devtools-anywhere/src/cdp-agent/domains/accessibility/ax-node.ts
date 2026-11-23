// Entry of accessibility.js, which the Accessibility domain loads on first use (accessibility.ts):
// it turns the DOM into CDP AXNodes. Kept out of the bundle like snapDOM, for its size.
import type { Protocol } from 'devtools-protocol';
import {
  contentsText,
  documentNameOf,
  inputButtonText,
  isNativeTextField,
  nameOf,
  targetsOf,
  textNameOf,
  type IdOf,
} from './ax-name';
import { inDisplayNone } from './ax-text';
import { markerText, type MarkerText } from './ax-marker';
import { generatedContent, pseudoHidden, type GeneratedPseudo } from './ax-generated';
import {
  attr,
  byId,
  groupTable,
  hasAttr,
  innerTextOf,
  isFocusable,
  isFocused,
  isInternalRole,
  isMenuList,
  isSvgLink,
  matches,
  query,
  roleOf,
  scopeOf,
  textOf,
  TreeShape,
  type Inclusion,
} from './ax-tree';
import { isElement, isHtml, isHtmlElement, isText, styleOf } from '../../core/realm';
import type { Probe } from '../../probe/types';
import { isVirtual, VirtualNode, type AXRef } from './ax-virtual';

// This script has its own copy of core/natives.ts, which found the page's functions when it loaded, on
// demand: the agent gives it those it uses instead (accessibility.ts).
export { useNatives } from '../../core/natives';
import { nativeGet } from '../../core/natives';

type AXNode = Protocol.Accessibility.AXNode;
type AXProperty = Protocol.Accessibility.AXProperty;
type AXValue = Protocol.Accessibility.AXValue;
type AXPropertyName = Protocol.Accessibility.AXPropertyName;

/** The accessibility tree of a document, as CDP AXNodes. */
export interface AXTree {
  /**
   * The AXNode of a DOM node: in the tree, or one ignored with why not. `queried`: an ignored node
   * keeps its role and name, as queryAXTree gives it in Chrome.
   */
  node(node: AXRef, queried?: boolean): AXNode;
  /** The closest node in the tree above a node. */
  parent(node: AXRef): AXRef | null;
  /** The nodes of a node's children in the tree. */
  children(node: AXRef): AXRef[];
  /** Whether a node is in the tree. */
  inTree(node: AXRef): boolean;
  /**
   * A node without a DOM node (ax-virtual.ts), by its host and key: `marker` for an element's list
   * marker, which has the backend id of its ::marker; `before` and `after` for its generated
   * content, with the backend ids of its ::before and ::after.
   */
  virtual(host: Node, key: string): AXRef | null;
}

/** The backend id of an element's pseudo-element. */
export type PseudoIdOf = (host: Element, type: 'marker' | 'before' | 'after') => number;

/** The id of a node without a DOM node, by its host's id and its key: negative, unlike backend ids. */
export type VirtualIdOf = (hostId: number, key: string) => number;

/** What accessibility.js exports. */
export interface AccessibilityModule {
  /** `pseudoIdOf`: the backend id of an element's ::marker, ::before or ::after pseudo-element. */
  createAXTree(doc: Document, idOf: IdOf, frameId: string, virtualIdOf: VirtualIdOf, pseudoIdOf: PseudoIdOf): AXTree;
  /** Takes the agent's native functions (`nativesInUse`), past the page's wrappers. */
  useNatives(natives: Pick<Probe, 'natives' | 'top'>): void;
}

const bool = (name: AXPropertyName, value: boolean, type: AXValue['type'] = 'booleanOrUndefined'): AXProperty => ({
  name,
  value: { type, value },
});
/** A property that is true or false (never undefined). */
const flag = (name: AXPropertyName, value: boolean) => bool(name, value, 'boolean');
/** A token property. */
const token = (name: AXPropertyName, value: string) => prop(name, 'token', value);
const prop = (name: AXPropertyName, type: AXValue['type'], value: unknown): AXProperty => ({
  name,
  value: { type, value },
});

/** The idrefs of an attribute, with the nodes they name. */
function idrefList(el: Element, name: AXPropertyName, idOf: IdOf): AXProperty | null {
  const value = attr(el, `aria-${name}`);
  if (value === null) return null;
  const root = scopeOf(el);
  const relatedNodes: Protocol.Accessibility.AXRelatedNode[] = [];
  for (const idref of value.trim().split(/\s+/).filter(Boolean)) {
    const target = root && byId(root, idref);
    if (target) relatedNodes.push({ backendDOMNodeId: idOf(target), idref });
  }
  return { name, value: { type: 'idrefList', value, relatedNodes } };
}

/**
 * Whether aria-owns takes none of its targets: Chrome leaves out ids that name no element, targets
 * that are not rendered or carry aria-hidden themselves (one inside an aria-hidden subtree is still
 * taken), and drops the relation when none is left.
 */
function ownsNothing(el: Element): boolean {
  return !!scopeOf(el) && targetsOf(el, 'aria-owns').every(t => inDisplayNone(t) || attr(t, 'aria-hidden') === 'true');
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
  const value = attr(el, name)?.trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
};

/** A number ARIA attribute, if set to one. */
const ariaNumber = (el: Element, name: string) => {
  const value = attr(el, name);
  if (value === null || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Form-associated (listed) elements: those Chrome checks the validity of. */
const isListed = (el: Element) =>
  isHtmlElement(el) && /^(input|button|select|textarea|fieldset|output|object)$/.test(el.localName);

/** Input types whose control is a text field (Chrome's atomic text field). */
const TEXT_INPUT = /^(text|search|email|url|tel|password)$/;

/** An input or textarea that edits text. */
const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  isHtml(el, 'textarea') || (isHtml(el, 'input') && TEXT_INPUT.test(el.type));

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
  if (role === 'scrollbar' || role === 'slider') return min !== null && max !== null ? (min + max) / 2 : 50;
  return role === 'separator' ? 50 : role === 'meter' ? (min ?? 0) : role === 'spinbutton' ? 0 : null;
}

/** A password's value masked as Chrome shows it, with the field's -webkit-text-security. */
function masked(el: HTMLInputElement, value: string): string {
  const security = (
    styleOf(el) as CSSStyleDeclaration & {
      webkitTextSecurity?: string;
    }
  ).webkitTextSecurity;
  const mask = security === 'circle' ? '◦' : security === 'square' ? '■' : security === 'none' ? '' : '•';
  return mask ? mask.repeat(value.length) : value;
}

/** Input types whose value Chrome does not give (it would be "on" or the button's label). */
const VALUELESS_INPUT = /^(button|checkbox|image|radio|reset|submit|file|hidden)$/;

/** An element's value (`AXNode.value`), for the roles Chrome gives one. */
function valueOf(el: Element, role: string): AXValue | undefined {
  if (isNativeRange(el))
    return Number.isNaN(el.valueAsNumber) ? undefined : { type: 'number', value: el.valueAsNumber };
  if (isHtml(el, 'progress')) return hasAttr(el, 'value') ? { type: 'number', value: el.value } : undefined;
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
    return option ? (attr(option, 'aria-label') ?? option.label.trim()) : '';
  }
  if (isHtml(el, 'textarea')) return el.value;
  if (isHtml(el, 'input')) {
    if (VALUELESS_INPUT.test(el.type)) return '';
    return el.type === 'password' ? masked(el, el.value) : el.value;
  }
  // A focusable ARIA combobox (Chrome's ComboBoxMenuButton) shows its content as its value.
  if (comboboxKind(el, role) === 'button') return isFocusable(el) ? contentsText(el) : '';
  // An editing host's text as shown, its line breaks kept.
  if (isEditingHost(el)) return innerTextOf(el as HTMLElement);
  if (role === 'textbox' || role === 'searchbox') return textOf(el) ?? '';
  return '';
}

/** An element with contenteditable on it (not inherited). */
const isEditingHost = (el: Element) =>
  isHtmlElement(el) && el.isContentEditable && !(el.parentElement?.isContentEditable ?? false);

/** What content in an editing host edits: plain text under contenteditable=plaintext-only. */
function editableKind(el: Element | null): 'richtext' | 'plaintext' | null {
  if (!isHtmlElement(el) || !el.isContentEditable) return null;
  let host: HTMLElement = el;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return attr(host, 'contenteditable')?.trim().toLowerCase() === 'plaintext-only' ? 'plaintext' : 'richtext';
}

/** aria-haspopup's popup, `true` meaning a menu. */
function hasPopup(el: Element): string | null {
  const value = attr(el, 'aria-haspopup');
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

/**
 * Roles that take aria-orientation, with the orientation ARIA gives them by default, as
 * "orientation role role …"; combobox, radiogroup and treegrid take it with no default.
 */
const ORIENTATION = groupTable([
  'vertical listbox menu scrollbar tree',
  'horizontal menubar separator slider tablist toolbar',
]);

/** An element's orientation, explicit or the role's default. */
function orientationOf(el: Element, role: string): string | null {
  const explicit = attr(el, 'aria-orientation')?.trim().toLowerCase();
  const valid = explicit === 'horizontal' || explicit === 'vertical' ? explicit : null;
  if (/^(combobox|radiogroup|treegrid)$/.test(role)) return valid;
  return role in ORIENTATION ? (valid ?? ORIENTATION[role] ?? null) : null;
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
  if (isFocused(el)) return true;
  let container: Element | null = el.parentElement;
  while (container && !CONTAINER_WIDGET.test(roleOf(container))) container = container.parentElement;
  if (container) {
    const multiple = ariaBool(container, 'aria-multiselectable') ?? (isHtml(container, 'select') && container.multiple);
    if (multiple || query(container, '[aria-checked]')) return null;
  }
  return false;
}

/** The nesting level Chrome gives an element (aria-level, or counted for some roles). */
function levelOf(el: Element, role: string): number | null {
  const ariaLevel = Number(attr(el, 'aria-level'));
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
  // A text field or a number field (ax-name's native text fields).
  if (isNativeTextField(el) && el.readOnly) return true;
  const contentEditable = hasAttr(el, 'contenteditable');
  const explicit = ariaBool(el, 'aria-readonly');
  if (!contentEditable && explicit !== null && ARIA_READONLY_ROLE.test(role)) return explicit;
  if (/^(gridcell|columnheader|rowheader)$/.test(role)) {
    const grid = el.parentElement?.parentElement;
    const gridRole = grid ? roleOf(grid) : null;
    if (grid && (gridRole === 'grid' || gridRole === 'treegrid')) return ariaBool(grid, 'aria-readonly') === true;
  }
  return false;
}

/** The politeness of the live regions by role (ARIA's implicit aria-live), as "politeness role role …". */
const IMPLICIT_LIVE = groupTable(['assertive alert', 'polite status log', 'off marquee timer']);

/** Live region properties of a live region's root: its politeness, atomic and relevant. */
function liveRegion(el: Element, role: string): AXProperty[] {
  const live = attr(el, 'aria-live')?.trim().toLowerCase() || IMPLICIT_LIVE[role];
  if (!live || live === 'off') return [];
  // Of the live regions by role, alert and status are atomic.
  const atomic = ariaBool(el, 'aria-atomic') ?? (role === 'alert' || role === 'status');
  const relevant = attr(el, 'aria-relevant')?.trim() || 'additions text';
  return [token('live', live), flag('atomic', atomic), prop('relevant', 'tokenList', relevant)];
}

/** An element's properties, in Chrome's order (inspector_type_builder_helper.cc). */
function propertiesOf(el: Element, role: string, idOf: IdOf, nameSources: AXValue['sources']): AXProperty[] {
  const out: AXProperty[] = liveRegion(el, role);
  const combobox = comboboxKind(el, role);
  // Global states.
  // An object element that shows no content (no plugin, no frame) is disabled.
  const emptyObject = isHtml(el, 'object') && !el.contentWindow;
  // A disabled optgroup is not said to be disabled: its options are.
  const disabled =
    (matches(el, ':disabled') && !isHtml(el, 'optgroup')) || attr(el, 'aria-disabled') === 'true' || emptyObject;
  if (disabled) out.push(flag('disabled', true));
  const invalid = attr(el, 'aria-invalid');
  if (invalid && invalid !== 'false') out.push(token('invalid', invalid));
  else if (isListed(el)) out.push(token('invalid', invalid === null && !isValidControl(el) ? 'true' : 'false'));
  else if (invalid !== null) out.push(token('invalid', 'false'));
  if (isFocusable(el) || (isHtml(el, 'dialog') && el.open)) out.push(bool('focusable', true));
  if (isFocused(el)) out.push(bool('focused', true));
  const field = isTextField(el) || isNativeRange(el);
  const editableField = field && (/^(textbox|searchbox|spinbutton)$/.test(role) || combobox === 'textField');
  const readOnly = isReadOnly(el, role);
  if (editableField) out.push(token('editable', 'plaintext'));
  else if (editableKind(el))
    // The host and the elements in it; Chrome says a line break edits plain text, whatever the host.
    out.push(token('editable', isHtml(el, 'br') ? 'plaintext' : (editableKind(el) ?? 'richtext')));
  const settable = SETTABLE_ROLE.test(role) || combobox === 'textField';
  if (settable && !disabled && !readOnly) out.push(bool('settable', true));
  // A text field's datalist completes it.
  if (combobox === 'textField' && isHtml(el, 'input') && el.list) out.push(token('autocomplete', 'list'));
  // Widget properties.
  if (combobox === 'select') out.push(token('hasPopup', 'menu'));
  else {
    const popup = hasPopup(el) ?? (combobox ? 'listbox' : null);
    if (popup) out.push(token('hasPopup', popup));
  }
  const level = levelOf(el, role);
  if (level !== null) out.push(prop('level', 'integer', level));
  if (/^(tablist|listbox|grid|tree|treegrid)$/.test(role)) {
    const multiple = ariaBool(el, 'aria-multiselectable') ?? (isHtml(el, 'select') && el.multiple);
    out.push(flag('multiselectable', multiple));
  }
  const orientation = isNativeRange(el) && el.type === 'range' ? 'horizontal' : orientationOf(el, role);
  if (orientation) out.push(token('orientation', orientation));
  if (role === 'textbox')
    out.push(flag('multiline', isHtml(el, 'textarea') || (ariaBool(el, 'aria-multiline') ?? isEditingHost(el))));
  if (READONLY_ROLE.test(role)) out.push(flag('readonly', readOnly));
  if (REQUIRED_ROLE.test(role) || combobox === 'textField' || combobox === 'button') {
    const native = (isTextField(el) || isNativeRange(el) || isHtml(el, 'select')) && el.required;
    out.push(flag('required', native || attr(el, 'aria-required') === 'true'));
  }
  const range = (min: number, max: number, text: string) =>
    out.push(prop('valuemin', 'number', min), prop('valuemax', 'number', max), prop('valuetext', 'string', text));
  if (isNativeRange(el)) range(Number(el.min || 0), Number(el.max || (el.type === 'range' ? 100 : 0)), el.value);
  else if (isHtml(el, 'progress')) range(0, el.max, '');
  else if (isRange(el, role)) {
    const { min, max } = rangeBounds(el, role);
    // Chrome gives an ARIA range no valuetext, whatever aria-valuetext says.
    range(min ?? 0, max ?? 0, '');
  }
  // Widget states.
  const pressed = role === 'button' ? tristate(attr(el, 'aria-pressed')) : null;
  if (pressed) out.push(prop('pressed', 'tristate', pressed));
  else if (isHtml(el, 'input') && (el.type === 'checkbox' || el.type === 'radio'))
    out.push(prop('checked', 'tristate', el.indeterminate ? 'mixed' : String(el.checked)));
  else if (/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(role))
    out.push(prop('checked', 'tristate', tristate(attr(el, 'aria-checked')) ?? 'false'));
  if (combobox === 'select') out.push(bool('expanded', false));
  else if (role === 'DisclosureTriangle' && isHtml(el.parentElement, 'details'))
    out.push(bool('expanded', el.parentElement.open));
  else if (!isHtml(el, 'select')) {
    const expanded = attr(el, 'aria-expanded');
    if (expanded === 'true' || expanded === 'false') out.push(bool('expanded', expanded === 'true'));
  }
  const selected = selectedOf(el, role);
  // A disabled option is not said to be selected or not.
  if (selected !== null && !(disabled && isHtml(el, 'option'))) out.push(bool('selected', selected));
  if (role === 'dialog' || role === 'alertdialog')
    out.push(flag('modal', ariaBool(el, 'aria-modal') ?? (isHtml(el, 'dialog') && matches(el, ':modal'))));
  // Relationships, then sparse attributes.
  for (const name of ['describedby', 'owns'] as const) {
    const list = idrefList(el, name, idOf);
    if (list && !(name === 'describedby' && !list.value.relatedNodes?.length) && !(name === 'owns' && ownsNothing(el)))
      out.push(list);
  }
  const url = urlOf(el, role);
  if (url) out.push(prop('url', 'string', url));
  const active = activeDescendant(el);
  if (active)
    out.push({
      name: 'activedescendant',
      value: {
        type: 'idref',
        relatedNodes: [
          {
            backendDOMNodeId: idOf(active),
            ...(active.id && { idref: active.id }),
          },
        ],
      },
    });
  for (const name of ['controls', 'details', 'flowto'] as const) {
    const list = idrefList(el, name, idOf);
    if (list) out.push(list);
  }
  // labelledby: the nodes of the source that named it, aria-labelledby's or the labels'.
  const named = nameSources?.find(s => s.value && !s.superseded);
  const related = named?.attributeValue?.relatedNodes ?? named?.nativeSourceValue?.relatedNodes;
  if (related)
    out.push({
      name: 'labelledby',
      value: { type: 'nodeList', relatedNodes: related },
    });
  return out;
}

/** The active descendant: a list box select's selected option, or aria-activedescendant's target. */
function activeDescendant(el: Element): Element | null {
  if (isHtml(el, 'select')) {
    if (isMenuList(el)) return null;
    const selected = el.selectedOptions;
    return selected[selected.length - 1] ?? null;
  }
  const idref = attr(el, 'aria-activedescendant')?.trim();
  const scope = idref ? scopeOf(el) : null;
  return (idref && scope && byId(scope, idref)) || null;
}

/** The url Chrome gives a link (its href) or an image (the source it shows). */
function urlOf(el: Element, role: string): string | null {
  if (role === 'link' && (isHtml(el, 'a') || isHtml(el, 'area'))) return el.href;
  if (role === 'link' && isSvgLink(el)) return new URL(attr(el, 'href') ?? '', el.baseURI).href;
  if (role === 'image' && isHtml(el, 'img')) return el.currentSrc.trim() || null;
  return null;
}

/** A role as CDP gives it: ARIA roles as `role`, Chrome's own as `internalRole`. */
const roleValue = (role: string): AXValue => ({
  type: isInternalRole(role) ? 'internalRole' : 'role',
  value: role,
});

/** An ignored node's role and name, without their sources, as Chrome's queryAXTree gives them. */
function ignoredAsQueried(node: Text | Element, reason: string): Pick<AXNode, 'role' | 'name'> {
  const role = isText(node) ? 'StaticText' : roleOf(node);
  // A list box's hidden option has no text laid out to name it.
  const name =
    isHtml(node, 'option') && reason === 'notRendered'
      ? { value: '' }
      : isText(node)
        ? textNameOf(node)
        : nameOf(node, role, () => 0).name;
  return { role: roleValue(role), name: { type: 'computedString', value: name.value } };
}

/** A node without a DOM node, as Chrome gives those of the user-agent shadow trees. */
function virtualNode(node: VirtualNode, queried: boolean | undefined): Omit<AXNode, 'nodeId'> {
  const inclusion = node.inclusion;
  if (inclusion.kind !== 'included')
    return {
      ignored: true,
      ignoredReasons:
        inclusion.kind === 'ignored' && inclusion.noReason
          ? []
          : [{ name: inclusion.reason, value: { type: 'boolean', value: true } }],
      // queryAXTree gives the generic elements they are.
      role: { type: 'role', value: queried ? node.role : 'none' },
      ...(queried && { name: { type: 'computedString', value: '' } }),
    };
  const editable = node.editable ? [token('editable', 'plaintext')] : [];
  if (node.role === 'StaticText' || node.role === 'LineBreak')
    return {
      ignored: false,
      role: roleValue(node.role),
      name: {
        type: 'computedString',
        value: node.text,
        sources: [{ type: 'contents', value: { type: 'computedString', value: node.text } }],
      },
      properties: editable,
    };
  const sources: Protocol.Accessibility.AXValueSource[] = [
    { type: 'relatedElement', attribute: 'aria-labelledby' },
    { type: 'attribute', attribute: 'aria-label' },
  ];
  if (node.role === 'MenuListPopup') sources.push({ type: 'attribute', attribute: 'title' });
  return {
    ignored: false,
    role: roleValue(node.role),
    name: { type: 'computedString', value: '', sources },
    properties: editable,
  };
}

/** The text a text field or input button shows (ax-virtual.ts). */
const fieldText = (el: Element) =>
  isHtml(el, 'input') && /^(submit|reset|button)$/.test(el.type) ? inputButtonText(el) : textValueOf(el, roleOf(el));

/** An element's list marker in the tree: its text, its node, and why it is ignored. */
interface Marker {
  text: MarkerText;
  /** Key `marker`, with one StaticText child per run of its text, keys `marker:0`, `marker:1`… */
  node: VirtualNode;
  /** The reason of an ignored marker: in a summary, or in a list item hidden or not visible. */
  ignoredBy: 'presentationalRole' | 'ariaHiddenSubtree' | 'notVisible' | null;
  /**
   * A list item of a native list given another role (`<ul role="tablist"><li>`): Chrome makes its
   * marker an ignored node of no role, whose text children are StaticText nodes in the tree.
   */
  textOnly: boolean;
}

/** Whether an element is a list item of a ul, ol or menu with a role attribute other than list. */
const inRoledList = (el: Element) =>
  el.localName === 'li' &&
  /^(ul|ol|menu)$/.test(el.parentElement?.localName ?? '') &&
  // Chrome compares the role attribute as written, as for the item's own inclusion (ax-tree.ts).
  !/^(|list|directory)$/.test((el.parentElement && attr(el.parentElement, 'role')) ?? '');

const PRESENTATIONAL: Inclusion = { kind: 'ignored', reason: 'presentationalRole' };

/** Whether a node is a list marker or one of its children (ax-marker.ts). */
const isMarker = (node: AXRef): node is VirtualNode => isVirtual(node) && /^marker\b/.test(node.key);
/** Whether a node is a ::before or ::after or one of their children (ax-generated.ts). */
const isGenerated = (node: AXRef): node is VirtualNode => isVirtual(node) && /^(before|after)\b/.test(node.key);
/** The pseudo-element nodes, which have the backend ids of their pseudo-elements. */
const PSEUDO_KEYS = new Set(['marker', 'before', 'after']);
const UNINTERESTING: Inclusion = { kind: 'ignored', reason: 'uninteresting' };

export function createAXTree(
  doc: Document,
  idOf: IdOf,
  frameId: string,
  virtualIdOf: VirtualIdOf,
  pseudoIdOf: PseudoIdOf
): AXTree {
  const shape = new TreeShape(doc, fieldText);
  // The markers' nodes, made once per tree.
  const markers = new Map<Element, Marker | null>();
  const markerOf = (host: Element): Marker | null => {
    let marker = markers.get(host);
    if (marker !== undefined) return marker;
    const inclusion = shape.inclusion(host);
    const text = shape.inTree(host) ? markerText(host) : null;
    // A list item aria-hidden or not visible keeps its marker ignored and empty; not one aria-hidden
    // by an ancestor.
    const hidden = inclusion.kind === 'ignored' && /^(ariaHidden|notVisible)/.test(inclusion.reason);
    if (!text || (inclusion.kind === 'ignored' && inclusion.reason === 'ariaHiddenSubtree')) marker = null;
    else {
      const textOnly = !hidden && !text.alt && inRoledList(host);
      const ignoredBy = hidden
        ? inclusion.reason === 'notVisible'
          ? 'notVisible'
          : 'ariaHiddenSubtree'
        : textOnly || roleOf(host) === 'DisclosureTriangle'
          ? 'presentationalRole'
          : null;
      const parts = (hidden || text.alt ? [] : text.parts).map((part, i) => {
        // A quote: an ignored node over a StaticText of its text, as Chrome lays it out apart.
        if (text.quotes[i]) {
          const quoted = new VirtualNode(host, `marker:${i}:0`, 'StaticText', { kind: 'included' });
          quoted.text = part;
          const quote = new VirtualNode(host, `marker:${i}`, 'none', UNINTERESTING, [quoted]);
          quoted.parent = quote;
          return quote;
        }
        const child = new VirtualNode(
          host,
          `marker:${i}`,
          'StaticText',
          textOnly ? { kind: 'included' } : PRESENTATIONAL
        );
        child.text = part;
        return child;
      });
      const node = new VirtualNode(
        host,
        'marker',
        text.alt ? 'StaticText' : 'ListMarker',
        ignoredBy ? { kind: 'ignored', reason: ignoredBy } : { kind: 'included' },
        parts
      );
      for (const part of parts) part.parent = node;
      marker = { text, node, ignoredBy, textOnly };
    }
    markers.set(host, marker);
    return marker;
  };
  // The nodes of the ::before and ::after pseudo-elements, made once per tree.
  const generated = new Map<string, VirtualNode | null>();
  const generatedOf = (host: Element, pseudo: GeneratedPseudo): VirtualNode | null => {
    const key = pseudo.slice(2);
    const known = generated.get(`${idOf(host)}:${key}`);
    if (known !== undefined) return known;
    let node: VirtualNode | null = null;
    const inclusion = shape.inclusion(host);
    const hidden = inclusion.kind === 'ignored' && /^(ariaHidden|notVisible)/.test(inclusion.reason);
    const content = shape.inTree(host) && !hidden ? generatedContent(host, pseudo) : null;
    if (content && 'alt' in content) {
      node = new VirtualNode(host, key, 'StaticText', { kind: 'included' });
      node.text = content.alt;
    } else if (content && pseudoHidden(host, pseudo))
      node = new VirtualNode(host, key, 'none', { kind: 'ignored', reason: 'notVisible' });
    else if (content) {
      const parts = content.parts.map((part, i) => {
        if (part.kind === 'image') return new VirtualNode(host, `${key}:${i}`, 'image', { kind: 'included' });
        const text = new VirtualNode(host, `${key}:${i}${part.kind === 'quote' ? ':0' : ''}`, 'StaticText', {
          kind: 'included',
        });
        text.text = part.text;
        if (part.kind !== 'quote') return text;
        const quote = new VirtualNode(host, `${key}:${i}`, 'none', UNINTERESTING, [text]);
        text.parent = quote;
        return quote;
      });
      const wrap = (role: string, inclusion: Inclusion, k: string, raw: VirtualNode[]) => {
        const box = new VirtualNode(host, k, role, inclusion, raw);
        for (const part of raw) part.parent = box;
        return box;
      };
      node =
        content.box === 'inline'
          ? wrap('none', UNINTERESTING, key, parts)
          : content.box === 'block'
            ? wrap('generic', { kind: 'included' }, key, parts)
            : wrap('none', UNINTERESTING, key, [wrap('generic', { kind: 'included' }, `${key}:item`, parts)]);
    }
    generated.set(`${idOf(host)}:${key}`, node);
    return node;
  };
  // A marker has its ::marker's backend id, as in Chrome, and the node of a ::before or ::after its
  // pseudo-element's; the other nodes without a DOM node get ids below 0, kept for the session
  // (accessibility.ts).
  const id = (node: AXRef) =>
    String(
      !isVirtual(node)
        ? idOf(node)
        : PSEUDO_KEYS.has(node.key)
          ? pseudoIdOf(node.host, node.key as 'marker' | 'before' | 'after')
          : virtualIdOf(idOf(node.host), node.key)
    );
  const children = (node: AXRef): AXRef[] => {
    if (isMarker(node) || isGenerated(node)) return node.raw;
    const own = shape.children(node);
    if (!isElement(node)) return own;
    const marker = markerOf(node);
    const before = generatedOf(node, '::before');
    const after = generatedOf(node, '::after');
    return [...(marker ? [marker.node] : []), ...(before ? [before] : []), ...own, ...(after ? [after] : [])];
  };
  const parent = (node: AXRef): AXRef | null =>
    isMarker(node) || isGenerated(node) ? node.parent : shape.parent(node);
  const links = (node: AXRef, base: AXNode): AXNode => {
    const up = parent(node);
    return {
      ...base,
      ...(up && { parentId: id(up) }),
      childIds: children(node).map(id),
      // Chrome's nodes of the shadow trees have one; the page cannot see theirs.
      ...(!isVirtual(node)
        ? { backendDOMNodeId: idOf(node) }
        : PSEUDO_KEYS.has(node.key) && { backendDOMNodeId: Number(id(node)) }),
    };
  };
  /**
   * The AXNode of a marker or of one of its text children, which Chrome ignores as presentational.
   * `queried`: an ignored one keeps its role and name, as for DOM nodes.
   */
  const markerNode = (node: VirtualNode, queried?: boolean): AXNode => {
    const marker = markerOf(node.host) as Marker;
    const as = (role: string, value: string) =>
      queried
        ? { role: roleValue(role), name: { type: 'computedString' as const, value } }
        : { role: roleValue('none') };
    // The text of a marker in a roled list, and a quote and its text: as generated content's.
    if (node !== marker.node && node.inclusion !== PRESENTATIONAL) return generatedNode(node);
    if (node !== marker.node)
      return links(node, {
        nodeId: id(node),
        ignored: true,
        ignoredReasons: [{ name: 'presentationalRole', value: { type: 'boolean', value: true } }],
        ...as('StaticText', node.text),
      });
    if (marker.ignoredBy) {
      const value: AXValue =
        marker.ignoredBy === 'ariaHiddenSubtree'
          ? {
              type: 'idref',
              relatedNodes: [{ backendDOMNodeId: idOf(node.host), ...(node.host.id && { idref: node.host.id }) }],
            }
          : { type: 'boolean', value: true };
      return links(node, {
        nodeId: id(node),
        ignored: true,
        ignoredReasons: [{ name: marker.ignoredBy, value }],
        ...(marker.textOnly ? { role: roleValue('none') } : as('ListMarker', marker.text.name)),
      });
    }
    const value = marker.text.name;
    return links(node, {
      nodeId: id(node),
      ignored: false,
      role: roleValue(node.role),
      name: {
        type: 'computedString',
        value,
        sources: [{ type: marker.text.alt ? 'implicit' : 'contents', value: { type: 'computedString', value } }],
      },
      properties: [],
    });
  };
  /** The AXNode of a ::before or ::after or of one of its children (ax-generated.ts). */
  const generatedNode = (node: VirtualNode): AXNode => {
    if (node.inclusion.kind === 'ignored')
      return links(node, {
        nodeId: id(node),
        ignored: true,
        ignoredReasons: [{ name: node.inclusion.reason, value: { type: 'boolean', value: true } }],
        role: roleValue('none'),
      });
    const text = node.role === 'StaticText';
    const alt = node.key === 'before' || node.key === 'after';
    return links(node, {
      nodeId: id(node),
      ignored: false,
      role: roleValue(node.role),
      name: {
        type: 'computedString',
        value: node.text,
        ...(text
          ? { sources: [{ type: alt ? 'implicit' : 'contents', value: { type: 'computedString', value: node.text } }] }
          : node.role === 'generic' && {
              sources: [
                { type: 'relatedElement', attribute: 'aria-labelledby' },
                { type: 'attribute', attribute: 'aria-label' },
              ],
            }),
      },
      properties: [],
    });
  };
  return {
    parent,
    children,
    inTree: node => isMarker(node) || isGenerated(node) || shape.inTree(node),
    virtual(host, key) {
      if (!isElement(host)) return null;
      const pseudo = /^(before|after)\b/.exec(key)?.[0];
      if (pseudo) {
        const top = generatedOf(host, `::${pseudo}` as GeneratedPseudo);
        if (!top || key === pseudo) return top;
        const find = (nodes: AXRef[]): AXRef | null => {
          for (const c of nodes) {
            const found = isVirtual(c) ? (c.key === key ? c : find(c.raw)) : null;
            if (found) return found;
          }
          return null;
        };
        return find(top.raw);
      }
      if (!/^marker\b/.test(key)) return shape.virtual(host, key);
      const marker = markerOf(host)?.node;
      if (key === 'marker' || !marker) return marker ?? null;
      const all = marker.raw.flatMap(c => (isVirtual(c) ? [c, ...c.raw] : []));
      return all.find(c => isVirtual(c) && c.key === key) ?? null;
    },
    node(node, queried) {
      if (isMarker(node)) return markerNode(node, queried);
      if (isGenerated(node)) return generatedNode(node);
      if (isVirtual(node)) return links(node, { nodeId: id(node), ...virtualNode(node, queried) });
      const inclusion = shape.inclusion(node);
      if (inclusion.kind !== 'included') {
        // Chrome points at the node behind the reason: the aria-hidden root, or the control a
        // label only repeats the name of.
        const related =
          inclusion.hiddenRoot && inclusion.reason === 'ariaHiddenSubtree'
            ? inclusion.hiddenRoot
            : inclusion.reason === 'labelFor' && isElement(node)
              ? nativeGet<HTMLElement | null>(node, 'control')
              : null;
        const relatedNodes = related
          ? [{ backendDOMNodeId: idOf(related), ...(related.id && { idref: related.id }) }]
          : undefined;
        const reason: AXProperty = {
          name: inclusion.reason,
          value: relatedNodes ? { type: 'idref', relatedNodes } : { type: 'boolean', value: true },
        };
        return links(node, {
          nodeId: id(node),
          ignored: true,
          // Chrome gives some ignored nodes no reason (a ruby's annotation, folded into the ruby).
          ignoredReasons: inclusion.kind === 'ignored' && inclusion.noReason ? [] : [reason],
          ...(queried && (isText(node) || isElement(node))
            ? ignoredAsQueried(node, inclusion.reason)
            : { role: { type: 'role', value: 'none' } }),
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
      const editable = isText(node) && editableKind(node.parentElement);
      if (isText(node))
        return links(node, {
          nodeId: id(node),
          ignored: false,
          role: roleValue('StaticText'),
          name: textNameOf(node),
          properties: editable ? [token('editable', editable)] : [],
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
