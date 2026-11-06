import { isCssom, isHtml } from '../../../core/realm';
import { Tok, tokenize } from './css-lexer-wasm';
import { ownEdit, recordPageChanges } from './cssom-watch';
import { type CssOutline, ROOT, outline } from './css-outline';
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
  /** The text's outline: its rules are the nodes below. */
  outline: CssOutline;
  /** The outline node (rule index) each CSSOM rule was written as. */
  nodes: Map<CSSRule, number>;
  /** The top-level rules, each with its node, in the order of the text. */
  top: [CSSRule, number][];
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
  /** The `unseen` count when recorded: changes the page made since may have gone unseen. */
  seen: number;
}

/**
 * Whether `rules` serialize as `parsed`, the rules of their text parsed alone, but @import (which
 * replaceSync() leaves out). Rule by rule, so that the first difference ends it, the number of
 * rules first.
 */
function sameRules(parsed: CSSRuleList, rules: CSSRule[]): boolean {
  let imports = 0;
  for (const rule of rules) if (tagOf(rule) === 'CSSImportRule') imports++;
  if (rules.length - imports !== parsed.length) return false;
  for (let i = 0, j = 0; i < rules.length; i++) {
    const rule = rules[i] as CSSRule;
    if (imports && tagOf(rule) === 'CSSImportRule') continue;
    if (rule.cssText !== (parsed[j++] as CSSRule).cssText) return false;
  }
  return true;
}

/**
 * One store for the page, shared by every session (`sheetTexts`): all serve the same text, and a
 * session enabling CSS late gets the current one. Changes the page makes through the CSSOM are
 * seen by cssom-watch.ts while some session watches, and recorded here once. A text not from the
 * CSSOM's own replace() (that of a <style>, a file), and every text kept while no session
 * watched, is checked once against the sheet: parsed alone, it must give the rules the sheet
 * has, or the page changed them before. Each change of a sheet's text counts a generation.
 */
export class SheetTexts {
  private recorded = new WeakMap<CSSStyleSheet, Recorded>();
  /** Sheets the page changed through the CSSOM since their text was recorded. */
  private stale = new WeakSet<CSSStyleSheet>();
  /** The tick of each sheet's last change; ticks count every change of any sheet. */
  private generations = new WeakMap<CSSStyleSheet, number>();
  private tick = 0;
  /** The tick of the last time watching started with none watching before. */
  private unseenAt = 0;
  private unseenTimes = 0;

  /** How many times watching started with none watching before. */
  get unseenCount(): number {
    return this.unseenTimes;
  }

  private changed(sheet: CSSStyleSheet): void {
    this.generations.set(sheet, ++this.tick);
  }

  /**
   * The generation of the sheet's text: it changes with each change of the text (recorded, or
   * made unknown), and for every sheet when watching starts after none watched, as the page may
   * have changed it meanwhile.
   */
  generation(sheet: CSSStyleSheet): number {
    return Math.max(this.generations.get(sheet) ?? 0, this.unseenAt);
  }

  /**
   * Takes `text` for the sheet's, its CSSOM rules being what it gives now, or with `check`, those
   * it gave when parsed, if the page has not changed them since.
   */
  set(sheet: CSSStyleSheet, text: string, check = false): void {
    this.stale.delete(sheet);
    this.recorded.set(sheet, { text, unchecked: check, seen: this.unseenTimes });
    this.changed(sheet);
  }

  /**
   * Replaces `[start, end)` of the sheet's text by `insert`, its CSSOM changed the same way; the
   * rules are paired again around the change only, when they can be.
   */
  splice(sheet: CSSStyleSheet, start: number, end: number, insert: string): void {
    const rec = this.recorded.get(sheet);
    if (!rec || this.stale.has(sheet)) return;
    const next = rec.source && respliced(rec.source, start, end, insert);
    if (next) {
      this.recorded.set(sheet, { text: next.text, unchecked: false, source: next, seen: this.unseenTimes });
      this.changed(sheet);
    } else this.set(sheet, rec.text.slice(0, start) + insert + rec.text.slice(end));
  }

  has(sheet: CSSStyleSheet): boolean {
    return this.recorded.has(sheet);
  }

  /** The page changed the sheet through the CSSOM: its text is no longer known. */
  invalidate(sheet: CSSStyleSheet): void {
    this.stale.add(sheet);
    this.changed(sheet);
  }

  /**
   * Watching starts again after none watched: changes the page made meanwhile were not seen, so
   * each text is checked against its sheet again before it is used.
   */
  unseen(): void {
    this.unseenTimes++;
    this.unseenAt = ++this.tick;
  }

  /**
   * The text of the sheet with its rules (as `rulesOf` gives them) paired, or null. Once the page
   * changed the sheet through the CSSOM, the text is serialized from its rules as Chrome does:
   * each rule's text, @import ones included, followed by a line break.
   */
  source(sheet: CSSStyleSheet, rulesOf: (sheet: CSSStyleSheet) => CSSRule[]): SheetSource | null {
    if (this.stale.has(sheet)) return this.serialize(sheet, rulesOf(sheet));
    let rec = this.recorded.get(sheet);
    const owner = sheet.ownerNode;
    if (!rec && isHtml(owner, 'style') && owner.sheet === sheet) {
      this.set(sheet, owner.textContent, true);
      rec = this.recorded.get(sheet);
    }
    // A constructed sheet whose text went unseen (made before anyone watched) is serialized too.
    if (!rec) return !owner && !sheet.ownerRule && !sheet.href ? this.serialize(sheet, rulesOf(sheet)) : null;
    if (rec.seen !== this.unseenTimes) {
      rec.seen = this.unseenTimes;
      rec.unchecked = true;
      delete rec.source;
    }
    if (rec.source !== undefined) return rec.source;
    const rules = rulesOf(sheet);
    if (rec.unchecked) {
      rec.unchecked = false;
      const alone = new CSSStyleSheet();
      const text = rec.text;
      ownEdit(() => alone.replaceSync(text));
      if (!sameRules(alone.cssRules, rules)) {
        this.invalidate(sheet);
        return this.serialize(sheet, rules);
      }
    }
    if (rec.source === undefined) rec.source = pair(rec.text, rules);
    // Its rules not found in it: the page changed them unseen, in a way the check does not tell
    // (an @import, which replaceSync() leaves out). Serialized then, like a changed sheet.
    return rec.source ?? this.serialize(sheet, rules);
  }

  /**
   * Takes the text serialized from the sheet's rules for its own, from the generation the page's
   * change started (not a new one); null when its rules do not pair with it.
   */
  private serialize(sheet: CSSStyleSheet, rules: CSSRule[]): SheetSource | null {
    const text = rules.map(r => `${r.cssText}\n`).join('');
    const source = pair(text, rules);
    if (!source) return null;
    this.stale.delete(sheet);
    this.recorded.set(sheet, { text, unchecked: false, source, seen: this.unseenTimes });
    return source;
  }
}

/** The texts of the page's sheets, for every session. */
export const sheetTexts = new SheetTexts();
// Each change the page makes is recorded once, whatever the number of sessions.
recordPageChanges((sheet, text) => (text === undefined ? sheetTexts.invalidate(sheet) : sheetTexts.set(sheet, text)));

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
const NO_RULES: ArrayLike<CSSRule> = [];
/** The rules in `rule`, read in place: a style rule's list is most often empty. */
const childRules = (rule: CSSRule): ArrayLike<CSSRule> => {
  const list: unknown = 'cssRules' in rule ? rule.cssRules : undefined;
  return list && typeof list === 'object' && (list as CSSRuleList).length ? (list as CSSRuleList) : NO_RULES;
};
/**
 * Strings, which `CSSOM_WRITES` leaves as they are; a legacy pseudo-element, written with one
 * colon (not escaped, nor the second of two); an attribute selector's value written as an
 * identifier, with its modifier.
 */
const CSSOM_WRITES =
  /("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*')|(?<![:\\]):(before|after|first-line|first-letter)(?![\w\\-])|\[\s*([-\w]+)\s*([~|^$*]?=)\s*(-?[_a-zA-Z][-\w]*)\s*(?:\s([iIsS]))?\s*\]/g;

/**
 * A selector as the CSSOM writes it back, where that is easily told: legacy pseudo-elements with
 * two colons (`::before` for `:before`), attribute values quoted (`[type="file"]`).
 */
const asCssomWrites = (s: string) =>
  !s.includes(':') && !s.includes('[')
    ? s
    : s.replace(CSSOM_WRITES, (all, str, pseudo, name, op, value, flag) =>
        str !== undefined
          ? all
          : pseudo !== undefined
            ? `::${(pseudo as string).toLowerCase()}`
            : `[${name}${op}"${value}"${flag ? ` ${(flag as string).toLowerCase()}` : ''}]`
      );

/**
 * Without whitespace and comments, and the `&` each selector of a list may start with: the CSSOM
 * adds one to every relative selector (`a, img` in a style rule is `& a, & img`). What the CSSOM
 * writes otherwise and `asCssomWrites` tells is written as the CSSOM does, so that such a selector
 * does not take a style sheet parsed alone to be told the same.
 */
const loose = (s: string) =>
  asCssomWrites(s.replace(/\/\*[\s\S]*?(\*\/|$)/g, ''))
    .replace(/\s+/g, '')
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
  const o = outline(text);
  const namespaces = namespaceText(rules);
  const source: SheetSource = { text, lines: lineStarts(text), outline: o, nodes: new Map(), top: [], namespaces };
  let lead = rules.findIndex(r => !isCssom(r, 'CSSImportRule') && !isCssom(r, 'CSSNamespaceRule'));
  if (lead < 0) lead = rules.length;
  // Out of order only as a fallback for a text CSS.addRule put a rule in before the @namespace
  // rules of: any other text with rules before them has none in the CSSOM, and pairs in order.
  let used: Set<number> | undefined;
  let node = o.firstChild(ROOT);
  for (let i = 0; i < lead; i++) {
    const rule = rules[i] as CSSRule;
    const tag = tagOf(rule);
    while (node >= 0 && !matches(text, o, node, rule, tag, TOP, '')) node = o.next(node);
    if (node < 0) return null;
    (used ??= new Set()).add(node);
    source.nodes.set(rule, node);
    source.top.push([rule, node]);
    node = o.next(node);
  }
  if (!pairList(source, o.firstChild(ROOT), lead ? rules.slice(lead) : rules, TOP, true, used)) return null;
  // In the order of the text, which SheetTexts.splice relies on.
  if (used) source.top.sort((a, b) => o.start(a[1]) - o.start(b[1]));
  return source;
}

/** The @namespace rules among `rules` as the CSSOM serializes them, on one line. */
export function namespaceText(rules: CSSRule[]): string {
  const texts: string[] = [];
  for (const r of rules) {
    const tag = tagOf(r);
    if (tag === 'CSSNamespaceRule') texts.push(r.cssText);
    // They follow only @import and @layer statements: none comes after any other rule.
    else if (tag !== 'CSSImportRule' && tag !== 'CSSLayerStatementRule') break;
  }
  return texts.join(' ');
}

/** `wrap` puts a prelude where it was, for the browser to parse it alone. */
type Wrap = (prelude: string) => string;
const TOP: Wrap = p => `${p}{}`;

/**
 * Pairs `cssom` with the outline's rules from `first` on (siblings, but those in `skip`) into
 * `source.nodes` (and with `top`, its top-level pairs).
 */
function pairList(
  source: SheetSource,
  first: number,
  cssom: ArrayLike<CSSRule>,
  wrap: Wrap,
  top = false,
  skip?: Set<number>
): boolean {
  const o = source.outline;
  let node = first;
  for (let i = 0; i < cssom.length; i++) {
    const rule = cssom[i] as CSSRule;
    const tag = tagOf(rule);
    for (; ; node = o.next(node)) {
      if (node < 0) return false;
      if (skip?.has(node) || !matches(source.text, o, node, rule, tag, wrap, source.namespaces)) continue;
      source.nodes.set(rule, node);
      if (top) source.top.push([rule, node]);
      const inner: Wrap =
        tag === 'CSSStyleRule' ? p => `:root{${p}{}}` : tag === 'CSSKeyframesRule' ? p => `@keyframes x{${p}{}}` : wrap;
      if (!pairList(source, o.firstChild(node), childRules(rule), inner)) return false;
      node = o.next(node);
      break;
    }
  }
  return true;
}

/**
 * The source after `[start, end)` of its text was replaced by `insert`, the CSSOM changed the
 * same way: only the top-level rule around the change is outlined and paired again, the others
 * moved. null when the change is not inside one rule or does not leave it one rule.
 *
 * The outline's tables are not rebuilt: the new rule's records are added at their end (`graft`),
 * those of the rule it replaces left where they are, unreferenced, and those of the rules after it
 * moved by the change's length, as their objects were before the outline was made of tables. Edits
 * so stay as cheap as the rule edited (and the moves), at the cost of the space the old records
 * take: once they are as many as the live ones, null is returned, for the text to be outlined and
 * paired anew, which leaves none. Records are not compacted in place, as the nodes in `nodes`,
 * indices, would all have to be renumbered. The outline's sibling links from `ROOT` keep the
 * replaced rule: `top` is what tells the top-level rules from then on.
 *
 * The old source is changed in place, and gives up its `outline`, `top` and `nodes` to the new
 * one: callers replace it right away and must not use it again (SheetTexts.splice does).
 */
function respliced(source: SheetSource, start: number, end: number, insert: string): SheetSource | null {
  const o = source.outline;
  if (o.dead * 2 > o.ruleCount) return null;
  const k = source.top.findIndex(([, n]) => o.start(n) <= start && end <= o.end(n));
  const old = source.top[k];
  if (!old) return null;
  const [rule, node] = old;
  const delta = insert.length - (end - start);
  const text = source.text.slice(0, start) + insert + source.text.slice(end);
  const slice = text.slice(o.start(node), o.end(node) + delta);
  const alone = outline(slice);
  const fresh = alone.firstChild(ROOT);
  if (fresh < 0 || alone.next(fresh) >= 0 || alone.start(fresh) !== 0 || alone.end(fresh) !== slice.length) return null;
  const next: SheetSource = {
    text,
    lines: lineStarts(text),
    outline: o,
    nodes: source.nodes,
    top: source.top,
    namespaces: source.namespaces,
  };
  const copy = o.graft(alone, fresh, o.start(node));
  if (!pairList(next, copy, [rule], TOP)) return null;
  o.dead += o.size(node);
  for (let i = k + 1; i < source.top.length; i++) {
    const after = source.top[i];
    if (after) o.shift(after[1], delta);
  }
  source.top[k] = [rule, copy];
  return next;
}

/** Whether `node` of `o` is where `rule`, of the CSSOM type `tag` (`tagOf`), was written. */
function matches(
  text: string,
  o: CssOutline,
  node: number,
  rule: CSSRule,
  tag: string,
  wrap: Wrap,
  namespaces: string
): boolean {
  const kind = o.kind(node);
  if (tag === 'CSSNestedDeclarations') {
    // Some declaration of the run is one the CSSOM kept.
    const style = (rule as CSSNestedDeclarations).style as CSSStyleDeclaration | undefined;
    if (kind !== 'nested' || !style) return false;
    for (let d = o.firstDecl(node), e = d + o.declCountOf(node); d < e; d++)
      if (!o.commented(d) && style.getPropertyValue(text.slice(o.declStart(d), o.nameEnd(d))) !== '') return true;
    return false;
  }
  if (tag === 'CSSStyleRule' || tag === 'CSSKeyframeRule') {
    if (kind !== 'qualified') return false;
    const prelude = text.slice(o.preludeStart(node), o.preludeEnd(node));
    const written: unknown = Reflect.get(rule, tag === 'CSSStyleRule' ? 'selectorText' : 'keyText');
    if (typeof written !== 'string') return false;
    // As written most often; else without what the CSSOM drops or adds.
    if (prelude === written || loose(prelude) === loose(written)) return true;
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
  if (kind !== 'at') return false;
  const name = AT_NAMES[tag];
  const written = o
    .name(text, node)
    .toLowerCase()
    .replace(/^-webkit-/, '');
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
 * comma after it (white space and comments before it included), the last one to the `{`.
 */
export function selectorSpans(source: SheetSource, node: number): [number, number][] {
  const { text, outline: o } = source;
  const from = o.preludeStart(node);
  const prelude = text.slice(from, o.preludeEnd(node));
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
  // Like Chrome, with the comments ending it (to the `{`), without the white space, even that of
  // an escape (`.k\31 `).
  let end = o.blockStart(node) >= 0 ? o.blockStart(node) : o.preludeEnd(node);
  while (end > from && /[ \t\n\r\f]/.test(text[end - 1] ?? '')) end--;
  spans.push([from + Math.max(start, 0), end]);
  return spans.map(([s, e]) => [Math.min(s, e), e]);
}

/**
 * The text of a selector as Chrome gives it: what is in its range without comments, trimmed of
 * CSS white space (U+2028 and others JavaScript trims are characters of a selector). Like Chrome,
 * a comment is anything from `/*` to `*\/`, in a string too.
 */
export function selectorText(range: string): string {
  return range.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
}

/**
 * Where the declarations of a rule are, as Chrome's style range: from past `{` to before `}`, or
 * to the first nested rule; for nested declarations, from the first to the last of them.
 */
export function styleSpan(source: SheetSource, node: number): [number, number] {
  const { text, outline: o } = source;
  const last = o.lastDecl(node);
  if (o.kind(node) === 'nested') {
    if (last < 0 || o.semicolon(last) || o.commented(last)) return [o.start(node), o.end(node)];
    // A last declaration without `;` runs to the `}`.
    let end = o.end(node);
    while (end < text.length && /\s/.test(text[end] ?? '')) end++;
    return [o.start(node), text[end] === '}' || end >= text.length ? end : o.end(node)];
  }
  // Like Chrome, after the `{` of a nested rule with no selector first in the block (`a {{`).
  const first = o.firstChild(node);
  const start =
    first >= 0 && o.kind(first) === 'qualified' && o.preludeStart(first) === o.preludeEnd(first) && last < 0
      ? o.blockStart(first) + 1
      : o.blockStart(node) + 1;
  // Declarations before nested rules end with the last of them.
  const end =
    first >= 0 && last >= 0 ? declSpan(text, o, last)[1] : o.closed(node) ? o.blockEnd(node) - 1 : o.blockEnd(node);
  return [Math.min(start, end), Math.max(end, Math.min(start, text.length))];
}

/** Where declaration `d` is: one in a comment is the whole comment. */
function declSpan(text: string, o: CssOutline, d: number): [number, number] {
  if (!o.commented(d)) return [o.declStart(d), o.declEnd(d)];
  const close = text.indexOf('*/', o.declEnd(d));
  return [text.lastIndexOf('/*', o.declStart(d)), close < 0 ? text.length : close + 2];
}

/** The style of a rule as written in the text. */
export function sourceStyle(
  styleSheetId: string,
  decl: CSSStyleDeclaration,
  source: SheetSource,
  node: number
): CSSStyle {
  const { text, outline: o } = source;
  const [from, to] = styleSpan(source, node);
  const last = o.lastDecl(node);
  const written: Written[] = [];
  for (let d = o.firstDecl(node); d <= last; d++) {
    const comment = o.commented(d);
    const dStart = o.declStart(d);
    // Like Chrome, a comment is a disabled declaration only of a property it knows: the rule's
    // style has an attribute for each (`margin-top`, …).
    if (comment && !text.startsWith('--', dStart) && !(text.slice(dStart, o.nameEnd(d)).toLowerCase() in decl))
      continue;
    const [start, span] = declSpan(text, o, d);
    const semicolon = o.semicolon(d);
    const valueStart = o.valueStart(d);
    const valueEnd = o.valueEnd(d);
    // The last declaration without `;` runs to the `}`.
    const end = !comment && !semicolon && d === last ? Math.max(span, to) : span;
    // Like Chrome, the value with `!important` as written.
    let until = semicolon ? o.declEnd(d) - 1 : o.declEnd(d);
    while (until > valueEnd && /\s/.test(text[until - 1] ?? '')) until--;
    written.push({
      name: text.slice(dStart, o.nameEnd(d)),
      value: text.slice(valueStart, valueEnd),
      shown: text.slice(valueStart, o.important(d) ? until : valueEnd),
      // Like Chrome, a commented-out declaration is not important.
      important: o.important(d) && !comment,
      disabled: comment,
      text: text.slice(start, end),
      range: rangeOf(source, start, end),
    });
  }
  return styleOf(styleSheetId, decl, written, text.slice(from, to), rangeOf(source, from, to));
}
