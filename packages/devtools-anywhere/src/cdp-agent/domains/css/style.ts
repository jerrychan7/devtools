import type { Protocol } from 'devtools-protocol';
import { splitTopLevel } from '../../core/selectors';

export type CSSStyle = Protocol.CSS.CSSStyle;
export type CSSProperty = Protocol.CSS.CSSProperty;
export type StyleOrigin = Protocol.CSS.StyleSheetOrigin;
/** `extraFields` also carries `isTableSetVisuallyTable`, which devtools-protocol does not declare. */
export type ComputedStyleResponse = Protocol.CSS.GetComputedStyleForNodeResponse & {
  extraFields: Protocol.CSS.ComputedStyleExtraFields & { isTableSetVisuallyTable: boolean };
};

export const INLINE_PREFIX = 'inline:';

/** What the CSS domain watches in the document and shadow roots for style sheet changes. */
export const OBSERVED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type'],
};

/** A pseudo-element at the end of a selector: `a::before`, legacy `a:after`, `::marker`. */
export const PSEUDO_SUFFIX =
  /(?:::(before|after|marker|first-line|first-letter|placeholder|selection|backdrop|file-selector-button|cue|(?:part|slotted|highlight|view-transition[\w-]*)\([^)]*\))|:(before|after|first-line|first-letter))$/i;

/** Splits `a.b::before` into the host selector `a.b` and the pseudo-element `before`. */
export function splitPseudoElement(selector: string): { host: string; pseudo: string | null } {
  const m = PSEUDO_SUFFIX.exec(selector);
  if (!m) return { host: selector, pseudo: null };
  const host = selector.slice(0, m.index).trim();
  return { host: host && !/[\s>+~]$/.test(host) ? host : `${host}*`, pseudo: (m[1] || m[2] || '').toLowerCase() };
}

/**
 * The text the client last set on a style, with the CSSOM text it produced. The CSSOM drops
 * comments and invalid declarations, but Chrome keeps them as properties: disabled ones (the
 * Styles pane comments a property out when it is unchecked) and ones with parsedOk false.
 * The source is used as long as the page has not changed the style since.
 */
export const sources = new WeakMap<CSSStyleDeclaration, { text: string; applied: string }>();

/** Sets `text` on a style, keeping it to report disabled and invalid declarations. */
export function setStyleText(decl: CSSStyleDeclaration, text: string, apply: () => void) {
  apply();
  sources.set(decl, { text, applied: decl.cssText });
}

export interface Declaration {
  raw: string;
  disabled: boolean;
}

/** Declarations of a style text in order, those in comments disabled. */
export function declarations(text: string): Declaration[] {
  const result: Declaration[] = [];
  const comment = /\/\*([\s\S]*?)\*\//g;
  let last = 0;
  const enabled = (part: string) => splitTopLevel(part, ';').forEach(raw => result.push({ raw, disabled: false }));
  for (let m = comment.exec(text); m; m = comment.exec(text)) {
    enabled(text.slice(last, m.index));
    last = m.index + m[0].length;
    const inner = (m[1] ?? '').trim().replace(/;$/, '');
    if (inner.includes(':')) result.push({ raw: inner, disabled: true });
  }
  enabled(text.slice(last));
  return result;
}

/**
 * Like Chrome, after the declared properties come the longhands the style actually holds,
 * without ranges: normal ones first, then !important ones, each in declaration order.
 * Longhands a `border` resets but cannot set (`border-image-*`) are implicit.
 */
export function appliedProperties(decl: CSSStyleDeclaration, list: Declaration[]): CSSProperty[] {
  const names = list.filter(d => !d.disabled).map(d => d.raw.slice(0, d.raw.indexOf(':')).trim().toLowerCase());
  const borderImage = names.some(n => n.startsWith('border-image'));
  const normal: CSSProperty[] = [];
  const important: CSSProperty[] = [];
  for (const name of Array.from(decl)) {
    const value = decl.getPropertyValue(name);
    if (decl.getPropertyPriority(name) === 'important') {
      important.push({ name, value: `${value} !important`, important: true });
      continue;
    }
    const implicit = !borderImage && name.startsWith('border-image-') && names.includes('border');
    normal.push({ name, value, ...(implicit && { implicit }) });
  }
  return [...normal, ...important];
}

/**
 * Serializes declarations as `name: value;` separated by spaces, the text the client edits;
 * disabled ones as `/* name: value; *\/`. Each declared property gets a range; longhands of
 * shorthands follow without one.
 */
export function buildStyle(styleSheetId: string, decl: CSSStyleDeclaration, line: number, column: number): CSSStyle {
  const cssProperties: CSSProperty[] = [];
  const shorthandEntries: Protocol.CSS.ShorthandEntry[] = [];
  const probe = document.createElement('div').style;
  const source = sources.get(decl);
  const list =
    source && source.applied === decl.cssText
      ? declarations(source.text)
      : splitTopLevel(decl.cssText, ';').map(raw => ({ raw, disabled: false }));
  let text = '';
  for (const { raw, disabled } of list) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const name = raw.slice(0, colon).trim();
    let value = raw.slice(colon + 1).trim();
    if (!name) continue;
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/\s*!\s*important$/i, '');
    const declText = `${name}: ${value}${important ? ' !important' : ''};`;
    // Whether the browser accepts the declaration.
    probe.cssText = declText;
    const parsedOk = probe.length > 0;
    const propertyText = disabled ? `/* ${declText} */` : declText;
    if (text) text += ' ';
    const start = column + text.length;
    text += propertyText;
    // Like Chrome, values of !important declarations keep the flag.
    const shown = important ? `${value} !important` : value;
    const property: CSSProperty = {
      name,
      value: shown,
      ...(important && { important }),
      implicit: false,
      text: propertyText,
      // Like Chrome, only reported when false.
      ...(!parsedOk && { parsedOk }),
      disabled,
      range: { startLine: line, startColumn: start, endLine: line, endColumn: start + propertyText.length },
    };
    cssProperties.push(property);
    if (disabled || !parsedOk) continue;
    // Expand shorthands into their longhands, like Chrome does: listed on the shorthand (the
    // Styles pane shows them when it is expanded) and as properties of their own.
    const longhands: CSSProperty[] = Array.from(probe, longhand => ({
      name: longhand,
      value: important ? `${probe.getPropertyValue(longhand)} !important` : probe.getPropertyValue(longhand),
      ...(important && { important }),
    }));
    if (longhands.length > 1 || (longhands.length === 1 && longhands[0]?.name !== name)) {
      shorthandEntries.push({ name, value: shown, ...(important && { important }) });
      property.longhandProperties = longhands;
    }
  }
  cssProperties.push(...appliedProperties(decl, list));
  return {
    styleSheetId,
    cssProperties,
    shorthandEntries,
    cssText: text,
    range: { startLine: line, startColumn: column, endLine: line, endColumn: column + text.length },
  };
}
