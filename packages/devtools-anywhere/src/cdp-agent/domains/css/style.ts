import type { Protocol } from 'devtools-protocol';
import { splitTopLevel } from '../../core/style/selectors';
import { shownStyle } from '../emulation/shown-style';
import { isOwnStyleRule, ownCall, ownGet, ownSet, ownSheet, ownStyle } from './sheets/watch/cssom-watch';
import { textStyle } from './sheets/text/ranges';

export type CSSStyle = Protocol.CSS.CSSStyle;
export type CSSProperty = Protocol.CSS.CSSProperty;
export type StyleOrigin = Protocol.CSS.StyleSheetOrigin;
/** `extraFields` also carries `isTableSetVisuallyTable`, which devtools-protocol does not declare. */
export type ComputedStyleResponse = Protocol.CSS.GetComputedStyleForNodeResponse & {
  extraFields: Protocol.CSS.ComputedStyleExtraFields & { isTableSetVisuallyTable: boolean };
};

export const INLINE_PREFIX = 'inline:';

/**
 * A pseudo-element at the end of a selector: `a::before`, legacy `a:after`, `::marker`,
 * `::view-transition-group(name)`, `::scroll-button(*)`, `::column::scroll-marker`, with the
 * pseudo-classes after it (`::scroll-button(*):disabled`) in the last group.
 */
export const PSEUDO_SUFFIX =
  /(?:::(before|after|marker|first-line|first-letter|placeholder|selection|backdrop|file-selector-button|cue|view-transition|scroll-marker-group|column::scroll-marker|scroll-marker|column|details-content|checkmark|picker-icon|target-text|search-text|spelling-error|grammar-error|interest-hint|(?:part|slotted|highlight|cue|picker|scroll-button|view-transition-[\w-]+)\([^)]*\))|:(before|after|first-line|first-letter))((?::[\w-]+(?:\([^)]*\))?)*)$/i;

/**
 * Splits `a.b::before:hover` into the host selector `a.b`, the pseudo-element `before` and the
 * pseudo-classes after it, `:hover` (null without). The pseudo-element's name is lowercased, its
 * argument (a view transition's name) kept as written.
 */
export function splitPseudoElement(selector: string): {
  host: string;
  pseudo: string | null;
  pseudoClasses: string | null;
} {
  const m = PSEUDO_SUFFIX.exec(selector);
  if (!m) return { host: selector, pseudo: null, pseudoClasses: null };
  const host = selector.slice(0, m.index).trim();
  return {
    host: host && !/[\s>+~]$/.test(host) ? host : `${host}*`,
    pseudo: normalizePseudo(m[1] || m[2] || ''),
    pseudoClasses: m[3] || null,
  };
}

/** `View-Transition-Group( a )` → `view-transition-group(a)`: the name lowercased, the argument trimmed. */
export function normalizePseudo(pseudo: string): string {
  const open = pseudo.indexOf('(');
  if (open < 0) return pseudo.toLowerCase();
  return `${pseudo.slice(0, open).trim().toLowerCase()}(${pseudo.slice(open + 1, pseudo.lastIndexOf(')')).trim()})`;
}

/**
 * The text the client last set on a style, with the CSSOM text it produced. The CSSOM drops
 * comments and invalid declarations, but Chrome keeps them as properties: disabled ones (the
 * Styles pane comments a property out when it is unchecked) and ones with parsedOk false.
 * The source is used as long as the page has not changed the style since.
 */
export const sources = new WeakMap<CSSStyleDeclaration, { text: string; applied: string }>();

/** Chrome's, for a style text that would not stay a rule's style (setStyleTexts). */
export const INVALID_STYLE = 'SyntaxError Style text is not valid.';

/**
 * Whether a style text stays a rule's style: as Chrome checks it (VerifyStyleText), the text
 * put in `div {…}` and followed by a rule of one declaration must parse as those two rules
 * only. So a text that closes the rule's block (`color: red }`) or leaves something open (a
 * block, a comment, a string) is refused, which would change the rules around it.
 */
export function styleTextFits(text: string): boolean {
  // The page may have changed these interfaces: read through the native functions.
  const probe = ownSheet();
  try {
    ownCall(probe, 'replaceSync', `div {${text}} div { --verify-style-text: none; }`);
  } catch {
    return false;
  }
  const list = ownGet<CSSRuleList>(probe, 'cssRules');
  if (ownGet<number>(list, 'length') !== 2) return false;
  const isDiv = (rule: CSSRule | null): rule is CSSStyleRule =>
    isOwnStyleRule(rule) && ownGet<string>(rule, 'selectorText') === 'div';
  const first = ownCall<CSSRule | null>(list, 'item', 0);
  const last = ownCall<CSSRule | null>(list, 'item', 1);
  if (!isDiv(first) || !isDiv(last)) return false;
  const style = ownStyle(last);
  return (
    ownGet<number>(style, 'length') === 1 && ownCall<string>(style, 'getPropertyValue', '--verify-style-text') !== ''
  );
}

/** Sets `text` on a style, keeping it to report disabled and invalid declarations. */
export function setStyleText(decl: CSSStyleDeclaration, text: string, apply: () => void) {
  apply();
  sources.set(decl, { text, applied: decl.cssText });
}

export interface Declaration {
  raw: string;
  disabled: boolean;
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

/** A declaration as written in a style's text, and where. */
export interface Written {
  name: string;
  /** Without `!important`. */
  value: string;
  /** The value shown, `!important` as written; by default the value and ` !important`. */
  shown?: string;
  important: boolean;
  disabled: boolean;
  /** Not a declaration whatever its value: one given up at a `{` (`color: red {}`). */
  invalid?: boolean;
  text: string;
  range: Protocol.CSS.SourceRange;
}

/**
 * The properties of a style: each written declaration with its range, those of shorthands with
 * their longhands, then the longhands the style holds, without ranges.
 */
export function styleOf(
  styleSheetId: string,
  decl: CSSStyleDeclaration,
  written: readonly Written[],
  cssText: string,
  range: Protocol.CSS.SourceRange
): CSSStyle {
  const cssProperties: CSSProperty[] = [];
  const shorthandEntries: Protocol.CSS.ShorthandEntry[] = [];
  const probe = document.createElement('div').style;
  for (const { name, value, shown: asWritten, important, disabled, invalid, text, range } of written) {
    // Whether the browser accepts the declaration.
    ownSet(probe, 'cssText', invalid ? '' : `${name}: ${value}${important ? ' !important' : ''};`);
    const parsedOk = probe.length > 0;
    // Like Chrome, values of !important declarations keep the flag.
    const shown = asWritten ?? (important ? `${value} !important` : value);
    const property: CSSProperty = {
      name,
      value: shown,
      ...(important && { important }),
      implicit: false,
      text,
      // Like Chrome, only reported when false, and not for a disabled one (`-webkit-foo: )`).
      ...(!parsedOk && !disabled && { parsedOk }),
      disabled,
      // A copy: `written` may be kept for the next call (textWritten).
      range: { ...range },
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
  const list = written.map(w => ({ raw: `${w.name}:${w.value}`, disabled: w.disabled || w.invalid === true }));
  cssProperties.push(...appliedProperties(decl, list));
  return { styleSheetId, cssProperties, shorthandEntries, cssText, range };
}

/**
 * A style on `line` from `column`: as the text it was given writes it (`textStyle`), while that
 * text is still what it holds; otherwise (no text, or the page changed the style since) its
 * declarations serialized as `name: value;` separated by spaces, the text the client edits. Where the
 * emulation rewrote the declarations, those are the page's own (shownStyle).
 */
export function buildStyle(styleSheetId: string, decl: CSSStyleDeclaration, line: number, column: number): CSSStyle {
  const source = sources.get(decl);
  const current = source && source.applied === decl.cssText ? source.text : undefined;
  // Like Chrome, the text as written, each declaration with its range in it.
  if (current !== undefined) return textStyle(styleSheetId, decl, current, line, column);
  // The declarations as the page wrote them, where the emulation rewrote them (domains/emulation/rewrite.ts).
  const shown = shownStyle(decl);
  let text = '';
  const written: Written[] = [];
  for (const raw of splitTopLevel(shown.cssText, ';')) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const name = raw.slice(0, colon).trim();
    let value = raw.slice(colon + 1).trim();
    if (!name) continue;
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/\s*!\s*important$/i, '');
    const propertyText = `${name}: ${value}${important ? ' !important' : ''};`;
    if (text) text += ' ';
    const start = column + text.length;
    text += propertyText;
    written.push({
      name,
      value,
      important,
      disabled: false,
      text: propertyText,
      range: { startLine: line, startColumn: start, endLine: line, endColumn: start + propertyText.length },
    });
  }
  return styleOf(styleSheetId, shown, written, text, {
    startLine: line,
    startColumn: column,
    endLine: line,
    endColumn: column + text.length,
  });
}
