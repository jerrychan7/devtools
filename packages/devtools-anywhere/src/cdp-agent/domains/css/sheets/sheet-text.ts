import { isCssom, isHtml } from '../../../core/realm';
import { Tok, tokenize } from './css-lexer-wasm';
import { type CssomChange, ownEdit, recordPageChanges } from './cssom-watch';
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
  /** The text is the one serialized from the CSSOM (`SheetTexts.serialize`), unchanged since. */
  serialized?: boolean;
  /** Changes the page made through the CSSOM since, where they are known, not yet applied. */
  pending?: Pending;
}

/**
 * The page's changes to a serialized sheet, kept until its source is asked for (a page may change
 * a sheet many times in a frame): the top-level rules inserted and deleted, in order, and those
 * whose text changed, each once.
 */
interface Pending {
  moves: { kind: 'insert' | 'delete'; index: number }[];
  changed: Set<CSSRule>;
}

/**
 * How many changes (moves and rules changed) a sheet of `rules` top-level rules keeps pending:
 * past that, its text is serialized anew. Applying them costs a pass over the sheet's text and
 * outline, and the text of each rule changed; finding where they are, the square of the moves.
 */
const pendingLimit = (rules: number) => Math.min(1024, Math.max(32, rules >> 2));

/** A run of top-level rules: `n` of the source's from `from` on, or with `from` -1, `n` new ones. */
type Run = [from: number, n: number];

/**
 * Splits `runs` so that one starts at rule `index`, and returns its place (`runs.length` past the
 * last rule), or -1 when the index is past the end.
 */
function runAt(runs: Run[], index: number): number {
  let at = 0;
  for (let p = 0; p < runs.length; p++) {
    const [from, n] = runs[p] as Run;
    if (index === at) return p;
    if (index < at + n) {
      const k = index - at;
      runs.splice(p, 1, [from, k], [from < 0 ? from : from + k, n - k]);
      return p + 1;
    }
    at += n;
  }
  return index === at ? runs.length : -1;
}

const isLead = (rule: CSSRule) => {
  const tag = tagOf(rule);
  return tag === 'CSSImportRule' || tag === 'CSSNamespaceRule';
};

/**
 * The serialized `source` with the page's `pending` changes applied, its rules now `rules`, as
 * serializing them anew would give it, with only the rules changed outlined and paired; null when
 * that cannot be told (the changes do not lead to `rules`, or change @import or @namespace rules).
 *
 * The moves are replayed on runs of the source's top-level rules, which tell for each rule of
 * `rules` the one of the source it was, if any; between those kept as they were, the source's
 * rules are replaced by the others (`replaceTops`).
 */
function applied(source: SheetSource, pending: Pending, rules: CSSRule[]): SheetSource | null {
  const top = source.top;
  const runs: Run[] = top.length ? [[0, top.length]] : [];
  for (const { kind, index } of pending.moves) {
    const p = runAt(runs, index);
    if (p < 0) return null;
    if (kind === 'insert') runs.splice(p, 0, [-1, 1]);
    else {
      const run = runs[p];
      if (!run) return null;
      if (run[0] >= 0) run[0]++;
      if (--run[1] === 0) runs.splice(p, 1);
    }
  }
  const { text, outline: o } = source;
  const edits: TopEdit[] = [];
  // Past the last rule kept: in the source, and in `rules`.
  let from = 0;
  let j = 0;
  const keep = (k: number, at: number): boolean => {
    if (k > from || at > j) {
      for (let i = from; i < k; i++) if (isLead((top[i] as [CSSRule, number])[0])) return false;
      const added = rules.slice(j, at);
      if (added.some(isLead)) return false;
      const start = from < top.length ? o.start((top[from] as [CSSRule, number])[1]) : text.length;
      const end = k < top.length ? o.start((top[k] as [CSSRule, number])[1]) : text.length;
      const insert = added.map(r => `${r.cssText}\n`).join('');
      edits.push({ from, count: k - from, start, end, insert, rules: added });
    }
    from = k + 1;
    j = at + 1;
    return true;
  };
  let at = 0;
  for (const [first, n] of runs) {
    if (first < 0) {
      at += n;
      continue;
    }
    for (let k = first; k < first + n; k++, at++) {
      const rule = rules[at];
      if (!rule || rule !== (top[k] as [CSSRule, number])[0]) return null;
      if (!pending.changed.has(rule) && !keep(k, at)) return null;
    }
  }
  if (at !== rules.length || !keep(top.length, rules.length)) return null;
  return edits.length ? replaceTops(source, edits) : source;
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
   * The page changed the sheet through the CSSOM, at `change` if known. A text serialized from the
   * CSSOM and paired is changed there alone when next asked for (`source`), as serializing it anew
   * would; any other is no longer known, as Chrome serializes a sheet changed so.
   */
  pageChanged(sheet: CSSStyleSheet, change?: CssomChange): void {
    const rec = this.recorded.get(sheet);
    if (!change || !rec?.serialized || !rec.source || rec.seen !== this.unseenTimes || this.stale.has(sheet))
      return this.invalidate(sheet);
    const pending = (rec.pending ??= { moves: [], changed: new Set() });
    if (change.kind === 'rule') pending.changed.add(change.rule);
    else pending.moves.push({ kind: change.kind, index: change.index });
    if (pending.moves.length + pending.changed.size > pendingLimit(rec.source.top.length))
      return this.invalidate(sheet);
    this.changed(sheet);
  }

  /**
   * Replaces `[start, end)` of the sheet's text by `insert`, its CSSOM changed the same way; the
   * rules are paired again around the change only, when they can be.
   */
  splice(sheet: CSSStyleSheet, start: number, end: number, insert: string): void {
    const rec = this.recorded.get(sheet);
    if (!rec || this.stale.has(sheet)) return;
    // The page's changes not applied yet: the source is not that of the CSSOM any more.
    if (rec.pending) return this.invalidate(sheet);
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
    const rec = this.recorded.get(sheet);
    if (rec) delete rec.pending;
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
    if (rec.pending) {
      const { pending, source } = rec;
      delete rec.pending;
      const rules = rulesOf(sheet);
      const next = rec.seen === this.unseenTimes && source ? applied(source, pending, rules) : null;
      if (!next) return this.serialize(sheet, rules);
      rec.text = next.text;
      rec.source = next;
      return next;
    }
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
    this.recorded.set(sheet, { text, unchecked: false, source, seen: this.unseenTimes, serialized: true });
    return source;
  }
}

/** The texts of the page's sheets, for every session. */
export const sheetTexts = new SheetTexts();
// Each change the page makes is recorded once, whatever the number of sessions.
recordPageChanges((sheet, text, change) =>
  text === undefined ? sheetTexts.pageChanged(sheet, change) : sheetTexts.set(sheet, text)
);

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
 * same way: only the top-level rule around the change is outlined and paired again
 * (`replaceTops`). null when the change is not inside one rule or does not leave it one rule.
 */
function respliced(source: SheetSource, start: number, end: number, insert: string): SheetSource | null {
  const o = source.outline;
  const k = source.top.findIndex(([, n]) => o.start(n) <= start && end <= o.end(n));
  const old = source.top[k];
  if (!old) return null;
  const [rule, node] = old;
  const from = o.start(node);
  const to = o.end(node);
  const slice = source.text.slice(from, start) + insert + source.text.slice(end, to);
  return replaceTops(source, [{ from: k, count: 1, start: from, end: to, insert: slice, rules: [rule] }]);
}

/**
 * Top-level rules `[from, from + count)` of a source, whose text is `[start, end)` (with what is
 * between them and around them there), to be replaced by `insert`, whose top-level rules are the
 * CSSOM's `rules`. `start` and `end` are between top-level rules, out of comments.
 */
export interface TopEdit {
  from: number;
  count: number;
  start: number;
  end: number;
  insert: string;
  rules: CSSRule[];
}

/** What a text's last top-level rule may leave after it: white space and comments only. */
const CLEAN_TAIL = /^(?:[ \t\n\r\f]|\/\*[\s\S]*?\*\/)*$/;

/**
 * The source after `edits` (in the order of the text, not overlapping) replaced runs of its
 * top-level rules: only the text of each edit is outlined and paired, the rules after it moved.
 * null when an edit's text is not as many whole top-level rules as its CSSOM rules, ended where it
 * ends, or does not pair with them.
 *
 * The outline's tables are not rebuilt: the new rules' records are added at their end (`graft`),
 * those of the rules they replace left where they are, unreferenced, and those of the rules after
 * them moved by the change's length, as their objects were before the outline was made of tables.
 * Edits so stay as cheap as the rules edited (and the moves), at the cost of the space the old
 * records take: once they are as many as the live ones, null is returned, for the text to be
 * outlined and paired anew, which leaves none. Records are not compacted in place, as the nodes in
 * `nodes`, indices, would all have to be renumbered. The outline's sibling links from `ROOT` keep
 * the replaced rules: `top` is what tells the top-level rules from then on.
 *
 * The old source is changed in place, and gives up its `outline` and `nodes` to the new one, even
 * when null is returned: callers replace it right away and must not use it again.
 */
export function replaceTops(source: SheetSource, edits: TopEdit[]): SheetSource | null {
  const o = source.outline;
  const top = source.top;
  if (o.dead * 2 > o.ruleCount) return null;
  const parts: string[] = [];
  let at = 0;
  let next = 0;
  for (const e of edits) {
    const last = e.from + e.count;
    if (e.from < next || last > top.length || e.start < at || e.end < e.start) return null;
    const before = top[e.from - 1];
    const after = top[last];
    if ((before && o.end(before[1]) > e.start) || (after ? o.start(after[1]) < e.end : e.end > source.text.length))
      return null;
    parts.push(source.text.slice(at, e.start), e.insert);
    at = e.end;
    next = last;
  }
  parts.push(source.text.slice(at));
  const text = parts.join('');
  const result: SheetSource = { ...source, text, lines: lineStarts(text), top: [] };
  // Outlined and paired first, the source moved only once they all are.
  const added: [CSSRule, number][][] = [];
  let delta = 0;
  for (const e of edits) {
    const alone = outline(e.insert);
    const tops: number[] = [];
    for (let r = alone.firstChild(ROOT); r >= 0; r = alone.next(r)) tops.push(r);
    if (tops.length !== e.rules.length) return null;
    const lastTop = tops[tops.length - 1];
    if (lastTop !== undefined) {
      const end = alone.end(lastTop);
      const ended = alone.blockStart(lastTop) >= 0 ? alone.closed(lastTop) : e.insert[end - 1] === ';';
      if (!ended || !CLEAN_TAIL.test(e.insert.slice(end))) return null;
    } else if (!CLEAN_TAIL.test(e.insert)) return null;
    const first = tops[0];
    if (first !== undefined && !pairList(result, o.graft(alone, first, e.start + delta), e.rules, TOP)) return null;
    added.push(e.rules.map(r => [r, result.nodes.get(r) as number]));
    delta += e.insert.length - (e.end - e.start);
  }
  delta = 0;
  let k = 0;
  const keep = (until: number) => {
    for (; k < until; k++) {
      const kept = top[k] as [CSSRule, number];
      if (delta) o.shift(kept[1], delta);
      result.top.push(kept);
    }
  };
  edits.forEach((e, i) => {
    keep(e.from);
    for (; k < e.from + e.count; k++) {
      const [rule, node] = top[k] as [CSSRule, number];
      o.dead += o.size(node);
      forget(result.nodes, rule);
    }
    result.top.push(...(added[i] ?? []));
    delta += e.insert.length - (e.end - e.start);
  });
  keep(top.length);
  return result;
}

/** Drops `rule`, gone from its sheet, and the rules in it from `nodes`. */
function forget(nodes: Map<CSSRule, number>, rule: CSSRule): void {
  if (rule.parentStyleSheet) return;
  nodes.delete(rule);
  const children = childRules(rule);
  for (let i = 0; i < children.length; i++) forget(nodes, children[i] as CSSRule);
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
