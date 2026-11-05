import { isCssom, isHtml } from '../../../core/realm';
import { Tok, tokenize } from './css-lexer';
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
}

interface Recorded {
  text: string;
  /** The CSSOM's rules as serialized when the text was recorded. */
  snapshot: string;
  /** Paired lazily; null when pairing failed. */
  source?: SheetSource | null;
}

/** The CSSOM's rules as serialized, to tell when the page changed them. */
function snapshot(rules: CSSRule[]): string {
  return rules.map(r => r.cssText).join('\n');
}

export class SheetTexts {
  private recorded = new WeakMap<CSSStyleSheet, Recorded>();
  /** Sheets the page changed through the CSSOM since their text was recorded. */
  private stale = new WeakSet<CSSStyleSheet>();
  private rulesOf: (sheet: CSSStyleSheet) => CSSRule[];

  constructor(rulesOf: (sheet: CSSStyleSheet) => CSSRule[]) {
    this.rulesOf = rulesOf;
  }

  /** Takes `text` for the sheet's, its CSSOM rules being what it gives now. */
  set(sheet: CSSStyleSheet, text: string): void {
    this.stale.delete(sheet);
    this.recorded.set(sheet, { text: text.replace(/^﻿/, ''), snapshot: snapshot(this.rulesOf(sheet)) });
  }

  has(sheet: CSSStyleSheet): boolean {
    return this.recorded.has(sheet);
  }

  /** The page changed the sheet through the CSSOM: its text is no longer known. */
  invalidate(sheet: CSSStyleSheet): void {
    this.stale.add(sheet);
  }

  /** The text of the sheet with its rules paired, or null. */
  source(sheet: CSSStyleSheet): SheetSource | null {
    if (this.stale.has(sheet)) return null;
    let rec = this.recorded.get(sheet);
    const owner = sheet.ownerNode;
    if (!rec && isHtml(owner, 'style') && owner.sheet === sheet) {
      this.set(sheet, owner.textContent);
      rec = this.recorded.get(sheet);
    }
    if (!rec) return null;
    const rules = this.rulesOf(sheet);
    // A change the page made unseen (a property set through the CSSOM).
    if (snapshot(rules) !== rec.snapshot) {
      this.stale.add(sheet);
      return null;
    }
    if (rec.source === undefined) rec.source = pair(rec.text, rules);
    return rec.source;
  }
}

/** The at-rule name each kind of CSSOM rule is written with; others take any at-rule. */
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
};

const tagOf = (rule: CSSRule) => Object.prototype.toString.call(rule).slice(8, -1);
const childRules = (rule: CSSRule): CSSRule[] =>
  'cssRules' in rule && rule.cssRules && typeof rule.cssRules === 'object'
    ? Array.from(rule.cssRules as CSSRuleList)
    : [];
/** Without whitespace and comments, and a leading `&` (the CSSOM adds one to relative selectors). */
const loose = (s: string) => s.replace(/\/\*[\s\S]*?(\*\/|$)|\s+/g, '').replace(/^&/, '');

/**
 * Pairs the CSSOM's rules with those of the text's outline, in order: outline rules the CSSOM
 * dropped (invalid ones, runs of declarations it found all invalid) are passed over; a CSSOM rule
 * left without one fails the pairing.
 */
function pair(text: string, rules: CSSRule[]): SheetSource | null {
  const nodes = new Map<CSSRule, CssRule>();
  /** `wrap` puts a prelude where it was, for the browser to parse it alone. */
  const list = (outlined: CssRule[], cssom: CSSRule[], wrap: (p: string) => string): boolean => {
    let j = 0;
    for (const rule of cssom) {
      for (;;) {
        const node = outlined[j++];
        if (!node) return false;
        if (!matches(text, node, rule, wrap)) continue;
        nodes.set(rule, node);
        const tag = tagOf(rule);
        const inner =
          tag === 'CSSStyleRule'
            ? (p: string) => `:root{${p}{}}`
            : tag === 'CSSKeyframesRule'
              ? (p: string) => `@keyframes x{${p}{}}`
              : wrap;
        if (!list(node.rules, childRules(rule), inner)) return false;
        break;
      }
    }
    return true;
  };
  if (!list(outline(text), rules, p => `${p}{}`)) return null;
  return { text, lines: lineStarts(text), nodes };
}

function matches(text: string, node: CssRule, rule: CSSRule, wrap: (p: string) => string): boolean {
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
    // Serialized otherwise (escapes, `from` for 0%): as the browser serializes the text alone.
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(wrap(prelude));
    } catch {
      return false;
    }
    let first: CSSRule | undefined = sheet.cssRules[0];
    while (first && tagOf(first) !== tag) first = childRules(first)[0];
    const parsed = first && (isCssom(first, 'CSSStyleRule') ? first.selectorText : Reflect.get(first, 'keyText'));
    return typeof parsed === 'string' && loose(parsed) === loose(written);
  }
  if (node.kind !== 'at') return false;
  const name = AT_NAMES[tag];
  return !name || node.name.toLowerCase().replace(/^-webkit-/, '') === name;
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
  spans.push([from + Math.max(start, 0), node.preludeEnd]);
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
  const written = node.decls.map((d, i): Written => {
    const [start, span] = declSpan(text, d);
    // The last declaration without `;` runs to the `}`.
    const end = d.kind === 'decl' && !d.semicolon && i === last ? Math.max(span, to) : span;
    // Like Chrome, the value with `!important` as written.
    let shown = d.semicolon ? d.end - 1 : d.end;
    while (shown > d.valueEnd && /\s/.test(text[shown - 1] ?? '')) shown--;
    return {
      name: text.slice(d.start, d.nameEnd),
      value: text.slice(d.valueStart, d.valueEnd),
      shown: text.slice(d.valueStart, d.important ? shown : d.valueEnd),
      important: d.important,
      disabled: d.kind === 'comment',
      text: text.slice(start, end),
      range: rangeOf(source, start, end),
    };
  });
  return styleOf(styleSheetId, decl, written, text.slice(from, to), rangeOf(source, from, to));
}
