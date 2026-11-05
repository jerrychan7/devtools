import { isCssom, isHtml } from '../../../core/realm';
import { Tok, tokenize } from './css-lexer';
import { ownEdit } from './cssom-watch';
import { type CssDecl, type CssRule, outline } from './css-outline';
import { lineStarts, offsetAt, positionAt } from './text-lines';
import type { Protocol } from 'devtools-protocol';
import { type CSSStyle, type Written, styleOf } from '../style';

/**
 * The text a style sheet was written in, as Chrome serves it: that of its <style>, of its file
 * (fetched again), or the one a script gave replace() or replaceSync(), kept up to date by the
 * CSS domain's own edits. Its rules are found in it by css-outline.ts and paired with the CSSOM's
 * in order; when that fails, or the page changed the sheet through the CSSOM since, there is
 * none and the CSS domain falls back to a text serialized from the CSSOM.
 */
export interface SheetSource {
  text: string;
  lines: number[];
  /** The outline node each CSSOM rule was written as. */
  nodes: Map<CSSRule, CssRule>;
  /** The top-level rules, each with its node. */
  top: [CSSRule, CssRule][];
  /**
   * The sheet's @namespace rules as the CSSOM serializes them: a selector parsed alone is parsed
   * after them, so that its namespace prefixes are declared.
   */
  namespaces: string;
}

interface Recorded {
  text: string;
  /** Whether the CSSOM is still to be checked against the text (one not given by the CSSOM). */
  unchecked: boolean;
  /** Paired lazily; null when pairing failed. */
  source?: SheetSource | null;
  /** Another session edited the sheet since this one recorded its text. */
  elsewhere?: boolean;
}

/** The rules as serialized, but @import (which replaceSync() leaves out). */
function snapshot(rules: CSSRule[]): string {
  return rules
    .filter(r => !isCssom(r, 'CSSImportRule'))
    .map(r => r.cssText)
    .join('\n');
}

/**
 * Changes the page makes through the CSSOM are seen by cssom-watch.ts, while the CSS domain is
 * enabled; the texts recorded are dropped when it is enabled again. A text not from the CSSOM's
 * own replace() (that of a <style>, a file) is checked once against the sheet: parsed alone, it
 * must give the rules the sheet has, or the page changed them before.
 */
export class SheetTexts {
  private recorded = new WeakMap<CSSStyleSheet, Recorded>();
  /** Sheets the page changed through the CSSOM since their text was recorded. */
  private stale = new WeakSet<CSSStyleSheet>();
  private rulesOf: (sheet: CSSStyleSheet) => CSSRule[];

  constructor(rulesOf: (sheet: CSSStyleSheet) => CSSRule[]) {
    this.rulesOf = rulesOf;
  }

  /**
   * Takes `text` for the sheet's, its CSSOM rules being what it gives now, or with `check`, those
   * it gave when parsed, if the page has not changed them since.
   */
  set(sheet: CSSStyleSheet, text: string, check = false): void {
    this.stale.delete(sheet);
    this.recorded.set(sheet, { text, unchecked: check });
  }

  /**
   * Replaces `[start, end)` of the sheet's text by `insert`, its CSSOM changed the same way; the
   * rules are paired again around the change only, when they can be.
   */
  splice(sheet: CSSStyleSheet, start: number, end: number, insert: string): void {
    const rec = this.recorded.get(sheet);
    if (!rec || this.stale.has(sheet)) return;
    const next = rec.source && respliced(rec.source, start, end, insert);
    if (next) this.recorded.set(sheet, { text: next.text, unchecked: false, source: next });
    else this.set(sheet, rec.text.slice(0, start) + insert + rec.text.slice(end));
  }

  has(sheet: CSSStyleSheet): boolean {
    return this.recorded.has(sheet);
  }

  /** The page changed the sheet through the CSSOM: its text is no longer known. */
  invalidate(sheet: CSSStyleSheet): void {
    this.stale.add(sheet);
  }

  /** Forgets every text: changes made meanwhile were not seen. */
  reset(): void {
    this.recorded = new WeakMap();
    this.stale = new WeakSet();
  }

  /**
   * Another session edited the sheet. Like Chrome, this one keeps the text it had; its rules are
   * paired with it again (the edit may have replaced some), and where they no longer pair, its
   * ranges match none.
   */
  editedElsewhere(sheet: CSSStyleSheet): void {
    const rec = this.recorded.get(sheet);
    if (!rec) return;
    delete rec.source;
    rec.elsewhere = true;
  }

  /** The text recorded for the sheet, paired or not. */
  textOf(sheet: CSSStyleSheet): string | null {
    return this.recorded.get(sheet)?.text ?? null;
  }

  /**
   * Whether another session edited the sheet and its rules no longer pair with the text this
   * session keeps. A text that never paired is not one: its sheet is served serialized.
   */
  unpaired(sheet: CSSStyleSheet): boolean {
    const rec = this.recorded.get(sheet);
    return !this.stale.has(sheet) && rec?.elsewhere === true && rec.source === null;
  }

  /** The text of the sheet with its rules paired, or null. */
  source(sheet: CSSStyleSheet): SheetSource | null {
    if (this.stale.has(sheet)) return null;
    let rec = this.recorded.get(sheet);
    const owner = sheet.ownerNode;
    if (!rec && isHtml(owner, 'style') && owner.sheet === sheet) {
      this.set(sheet, owner.textContent, true);
      rec = this.recorded.get(sheet);
    }
    if (!rec) return null;
    if (rec.source !== undefined) return rec.source;
    const rules = this.rulesOf(sheet);
    if (rec.unchecked) {
      rec.unchecked = false;
      const alone = new CSSStyleSheet();
      const text = rec.text;
      ownEdit(() => alone.replaceSync(text));
      if (snapshot(Array.from(alone.cssRules)) !== snapshot(rules)) {
        this.stale.add(sheet);
        return null;
      }
    }
    if (rec.source === undefined) rec.source = pair(rec.text, rules);
    return rec.source;
  }
}

/** The at-rule name each kind of CSSOM rule is written with; a kind not listed pairs with none. */
const AT_NAMES: Record<string, string> = {
  CSSMediaRule: 'media',
  CSSSupportsRule: 'supports',
  CSSContainerRule: 'container',
  CSSLayerBlockRule: 'layer',
  CSSLayerStatementRule: 'layer',
  CSSScopeRule: 'scope',
  CSSStartingStyleRule: 'starting-style',
  CSSImportRule: 'import',
  CSSNamespaceRule: 'namespace',
  CSSFontFaceRule: 'font-face',
  CSSKeyframesRule: 'keyframes',
  CSSPageRule: 'page',
  CSSPropertyRule: 'property',
  CSSCounterStyleRule: 'counter-style',
  CSSFontFeatureValuesRule: 'font-feature-values',
  CSSFontPaletteValuesRule: 'font-palette-values',
  CSSViewTransitionRule: 'view-transition',
  CSSPositionTryRule: 'position-try',
  CSSFunctionRule: 'function',
};

const MARGINS = /^(top|bottom)-(left-corner|left|center|right|right-corner)$|^(left|right)-(top|middle|bottom)$/;

const tagOf = (rule: CSSRule) => Object.prototype.toString.call(rule).slice(8, -1);
const childRules = (rule: CSSRule): CSSRule[] =>
  'cssRules' in rule && rule.cssRules && typeof rule.cssRules === 'object'
    ? Array.from(rule.cssRules as CSSRuleList)
    : [];
/**
 * Without whitespace and comments, and the `&` each selector of a list may start with: the CSSOM
 * adds one to every relative selector (`a, img` in a style rule is `& a, & img`).
 */
const loose = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?(\*\/|$)|\s+/g, '')
    .split(',')
    .map(p => p.replace(/^&/, ''))
    .join(',');

/**
 * Pairs the CSSOM's rules with those of the text's outline, in order: outline rules the CSSOM
 * dropped (invalid ones, runs of declarations it found all invalid) are passed over; a CSSOM rule
 * left without one fails the pairing.
 *
 * The @import and @namespace rules the CSSOM has first pair with the first such rules of the text
 * wherever they are: CSS.addRule puts a rule asked for before them after them in the CSSOM, its
 * text where asked (as Chrome 156 does), so that the text has a style rule before them.
 */
function pair(text: string, rules: CSSRule[]): SheetSource | null {
  let top = outline(text);
  const namespaces = namespaceText(rules);
  const source: SheetSource = { text, lines: lineStarts(text), nodes: new Map(), top: [], namespaces };
  let lead = rules.findIndex(r => !isCssom(r, 'CSSImportRule') && !isCssom(r, 'CSSNamespaceRule'));
  if (lead < 0) lead = rules.length;
  // Out of order only as a fallback for a text CSS.addRule put a rule in before the @namespace
  // rules of: any other text with rules before them has none in the CSSOM, and pairs in order.
  const used = new Set<CssRule>();
  let j = 0;
  for (const rule of rules.slice(0, lead)) {
    while (top[j] && !matches(text, top[j] as CssRule, rule, TOP, '')) j++;
    const node = top[j++];
    if (!node) return null;
    used.add(node);
    source.nodes.set(rule, node);
    source.top.push([rule, node]);
  }
  top = top.filter(n => !used.has(n));
  if (!pairList(source, top, rules.slice(lead), TOP, true)) return null;
  // In the order of the text, which SheetTexts.splice relies on.
  source.top.sort((a, b) => a[1].start - b[1].start);
  return source;
}

/** The @namespace rules among `rules` as the CSSOM serializes them, on one line. */
export function namespaceText(rules: CSSRule[]): string {
  return rules
    .filter(r => isCssom(r, 'CSSNamespaceRule'))
    .map(r => r.cssText)
    .join(' ');
}

/** `wrap` puts a prelude where it was, for the browser to parse it alone. */
type Wrap = (prelude: string) => string;
const TOP: Wrap = p => `${p}{}`;

/** Pairs `cssom` with `outlined` into `source.nodes` (and with `top`, its top-level pairs). */
function pairList(source: SheetSource, outlined: CssRule[], cssom: CSSRule[], wrap: Wrap, top = false): boolean {
  let j = 0;
  for (const rule of cssom) {
    for (;;) {
      const node = outlined[j++];
      if (!node) return false;
      if (!matches(source.text, node, rule, wrap, source.namespaces)) continue;
      source.nodes.set(rule, node);
      if (top) source.top.push([rule, node]);
      const tag = tagOf(rule);
      const inner: Wrap =
        tag === 'CSSStyleRule' ? p => `:root{${p}{}}` : tag === 'CSSKeyframesRule' ? p => `@keyframes x{${p}{}}` : wrap;
      if (!pairList(source, node.rules, childRules(rule), inner)) return false;
      break;
    }
  }
  return true;
}

/** Moves a node and those in it by `delta`. */
function shift(node: CssRule, delta: number) {
  node.start += delta;
  node.end += delta;
  node.preludeStart += delta;
  node.preludeEnd += delta;
  if (node.blockStart >= 0) {
    node.blockStart += delta;
    node.blockEnd += delta;
  }
  for (const d of node.decls) {
    d.start += delta;
    d.end += delta;
    d.nameEnd += delta;
    d.valueStart += delta;
    d.valueEnd += delta;
  }
  for (const r of node.rules) shift(r, delta);
}

/**
 * The source after `[start, end)` of its text was replaced by `insert`, the CSSOM changed the
 * same way: only the top-level rule around the change is outlined and paired again, the others
 * moved. null when the change is not inside one rule or does not leave it one rule.
 *
 * The old source is changed in place, and gives up its `top` and `nodes` to the new one: callers
 * replace it right away and must not use it again (SheetTexts.splice does).
 */
function respliced(source: SheetSource, start: number, end: number, insert: string): SheetSource | null {
  const k = source.top.findIndex(([, n]) => n.start <= start && end <= n.end);
  const old = source.top[k];
  if (!old) return null;
  const [rule, node] = old;
  const delta = insert.length - (end - start);
  const text = source.text.slice(0, start) + insert + source.text.slice(end);
  const slice = text.slice(node.start, node.end + delta);
  const [fresh, ...more] = outline(slice);
  if (!fresh || more.length || fresh.start !== 0 || fresh.end !== slice.length) return null;
  shift(fresh, node.start);
  const next: SheetSource = {
    text,
    lines: lineStarts(text),
    nodes: source.nodes,
    top: source.top,
    namespaces: source.namespaces,
  };
  if (!pairList(next, [fresh], [rule], TOP)) return null;
  for (let i = k + 1; i < source.top.length; i++) {
    const after = source.top[i];
    if (after) shift(after[1], delta);
  }
  source.top[k] = [rule, fresh];
  return next;
}

function matches(text: string, node: CssRule, rule: CSSRule, wrap: Wrap, namespaces: string): boolean {
  const tag = tagOf(rule);
  if (tag === 'CSSNestedDeclarations') {
    // Some declaration of the run is one the CSSOM kept.
    const style = isCssom(rule, 'CSSNestedDeclarations') ? rule.style : null;
    return (
      node.kind === 'nested' &&
      !!style &&
      node.decls.some(d => d.kind === 'decl' && style.getPropertyValue(text.slice(d.start, d.nameEnd)) !== '')
    );
  }
  if (tag === 'CSSStyleRule' || tag === 'CSSKeyframeRule') {
    if (node.kind !== 'qualified') return false;
    const prelude = text.slice(node.preludeStart, node.preludeEnd);
    const written = isCssom(rule, 'CSSStyleRule') ? rule.selectorText : Reflect.get(rule, 'keyText');
    if (typeof written !== 'string') return false;
    if (loose(prelude) === loose(written)) return true;
    // Serialized otherwise (escapes, `from` for 0%): as the browser serializes the text alone,
    // after the sheet's @namespace rules (`svg|\61` is `svg|a` only where `svg` is declared).
    const sheet = new CSSStyleSheet();
    try {
      // Our own sheet: not reported as the page's change.
      ownEdit(() => sheet.replaceSync(namespaces + wrap(prelude)));
    } catch {
      return false;
    }
    // The innermost rule: the wrapping ones are around it.
    let first: CSSRule | undefined = Array.from(sheet.cssRules).find(r => !isCssom(r, 'CSSNamespaceRule'));
    for (let inner = first && childRules(first)[0]; inner; inner = childRules(inner)[0]) first = inner;
    if (!first || tagOf(first) !== tag) return false;
    const parsed = first && (isCssom(first, 'CSSStyleRule') ? first.selectorText : Reflect.get(first, 'keyText'));
    return typeof parsed === 'string' && loose(parsed) === loose(written);
  }
  if (node.kind !== 'at') return false;
  const name = AT_NAMES[tag];
  const written = node.name.toLowerCase().replace(/^-webkit-/, '');
  // The margin rules of @page are named after their box.
  if (tag === 'CSSMarginRule') return MARGINS.test(written);
  return written === name;
}

/** A range of the text, in lines and columns. */
export function rangeOf(source: SheetSource, start: number, end: number): Protocol.CSS.SourceRange {
  const a = positionAt(source.lines, start);
  const b = positionAt(source.lines, end);
  return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column };
}

/** The offsets of a range, or null when it is outside the text. */
export function offsetsOf(source: SheetSource, range: Protocol.CSS.SourceRange): [number, number] | null {
  const start = offsetAt(source.lines, range.startLine, range.startColumn);
  const end = offsetAt(source.lines, range.endLine, range.endColumn);
  return start < 0 || end < start || end > source.text.length ? null : [start, end];
}

/**
 * The selectors of a prelude as Chrome gives their ranges: each from its first character to the
 * comma after it (white space before it included), the last one to the end of the prelude.
 */
export function selectorSpans(text: string, node: CssRule): [number, number][] {
  const from = node.preludeStart;
  const prelude = text.slice(from, node.preludeEnd);
  const { kinds, starts } = tokenize(prelude);
  const spans: [number, number][] = [];
  let start = -1;
  let depth = 0;
  kinds.forEach((k, i) => {
    const at = starts[i] ?? 0;
    if (k === Tok.LParen || k === Tok.Func || k === Tok.LBracket || k === Tok.LBrace) depth++;
    else if (k === Tok.RParen || k === Tok.RBracket || k === Tok.RBrace) depth--;
    if (k === Tok.Comma && depth === 0) {
      spans.push([from + Math.max(start, 0), from + at]);
      start = -1;
    } else if (start < 0 && k !== Tok.Ws && k !== Tok.Comment) start = at;
  });
  // Like Chrome, without the white space ending it, even that of an escape (`.k\31 `).
  let end = node.preludeEnd;
  while (end > from && /[ \t\n\r\f]/.test(text[end - 1] ?? '')) end--;
  spans.push([from + Math.max(start, 0), end]);
  return spans.map(([s, e]) => [Math.min(s, e), e]);
}

/**
 * Where the declarations of a rule are, as Chrome's style range: from past `{` to before `}`, or
 * to the first nested rule; for nested declarations, from the first to the last of them.
 */
export function styleSpan(text: string, node: CssRule): [number, number] {
  const last = node.decls[node.decls.length - 1];
  if (node.kind === 'nested') {
    if (!last || last.semicolon || last.kind === 'comment') return [node.start, node.end];
    // A last declaration without `;` runs to the `}`.
    let end = node.end;
    while (end < text.length && /\s/.test(text[end] ?? '')) end++;
    return [node.start, text[end] === '}' || end >= text.length ? end : node.end];
  }
  // Like Chrome, after the `{` of a nested rule with no selector first in the block (`a {{`).
  const first = node.rules[0];
  const start =
    first?.kind === 'qualified' && first.preludeStart === first.preludeEnd && !last
      ? first.blockStart + 1
      : node.blockStart + 1;
  // Declarations before nested rules end with the last of them.
  const end = node.rules.length && last ? declSpan(text, last)[1] : node.closed ? node.blockEnd - 1 : node.blockEnd;
  return [Math.min(start, end), Math.max(end, Math.min(start, text.length))];
}

/** Where a declaration is: one in a comment is the whole comment. */
function declSpan(text: string, d: CssDecl): [number, number] {
  if (d.kind === 'decl') return [d.start, d.end];
  const close = text.indexOf('*/', d.end);
  return [text.lastIndexOf('/*', d.start), close < 0 ? text.length : close + 2];
}

/** The style of a rule as written in the text. */
export function sourceStyle(
  styleSheetId: string,
  decl: CSSStyleDeclaration,
  source: SheetSource,
  node: CssRule
): CSSStyle {
  const { text } = source;
  const [from, to] = styleSpan(text, node);
  const last = node.decls.length - 1;
  // Like Chrome, a comment is a disabled declaration only of a property it knows: the rule's style
  // has an attribute for each (`margin-top`, …).
  const shown = node.decls.filter(
    d => d.kind === 'decl' || text.startsWith('--', d.start) || text.slice(d.start, d.nameEnd).toLowerCase() in decl
  );
  const written = shown.map((d): Written => {
    const [start, span] = declSpan(text, d);
    // The last declaration without `;` runs to the `}`.
    const end = d.kind === 'decl' && !d.semicolon && d === node.decls[last] ? Math.max(span, to) : span;
    // Like Chrome, the value with `!important` as written.
    let until = d.semicolon ? d.end - 1 : d.end;
    while (until > d.valueEnd && /\s/.test(text[until - 1] ?? '')) until--;
    return {
      name: text.slice(d.start, d.nameEnd),
      value: text.slice(d.valueStart, d.valueEnd),
      shown: text.slice(d.valueStart, d.important ? until : d.valueEnd),
      // Like Chrome, a commented-out declaration is not important.
      important: d.important && d.kind === 'decl',
      disabled: d.kind === 'comment',
      text: text.slice(start, end),
      range: rangeOf(source, start, end),
    };
  });
  return styleOf(styleSheetId, decl, written, text.slice(from, to), rangeOf(source, from, to));
}
