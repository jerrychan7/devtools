// The store of the page's sheet texts (`sheetTexts`): what each sheet was written in, checked
// once against its CSSOM, made unknown or kept up to date as the page and the CSS domain change
// the sheet, and paired with its rules when asked for (pair.ts, updated in place by splice.ts).
import { isHtml } from '../../../../core/realm';
import { unwrapSafeArea } from '../../../emulation/safe-area';
import { mediaLists, shownCssText, shownMedia, styles } from '../../../emulation/shown-style';
import { forgetSheet, ownEdit, ownStyle, recordPageChanges, type RuleChange, settle } from '../watch/cssom-watch';
import { type SheetSource, childRules, pair, tagOf } from './pair';
import { Tok, tokenize } from '../parse/css-lexer';
import { type Pending, applied, respliced, retexted } from './splice';

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
 * How many changes (moves and rules changed) a sheet of `rules` top-level rules keeps pending:
 * past that, its text is serialized anew. Applying them costs a pass over the sheet's text and
 * outline, and the text of each rule changed; finding where they are, the square of the moves.
 */
const pendingLimit = (rules: number) => Math.min(1024, Math.max(32, rules >> 2));

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
    if (!sameRule(rule, parsed[j++] as CSSRule)) return false;
  }
  return true;
}

/**
 * Whether `rule` is the rule `parsed` was read as. The emulation rewrites the values of some declarations and
 * the media of some rules (domains/emulation/rewrite.ts), so a rule it rewrote is compared by what the page
 * wrote (shownCssText, shownMedia), and the rules nested in it by this same test: two values the page wrote may
 * be rewritten to the same text, and a change of the page that the rewrite hides, in a declaration or in a
 * nested rule, is not taken as no change. So a rule the emulation holds a record for is never taken as the same by
 * its text alone: the text may read the same after a change of the page that the rewrite gives its own value.
 */
function sameRule(rule: CSSRule, parsed: CSSRule): boolean {
  if (rule.cssText === parsed.cssText && !rewritten(rule)) return true;
  const tag = tagOf(rule);
  if (tag !== tagOf(parsed)) return false;
  if (tag === 'CSSMediaRule') {
    return (
      shownMedia((rule as CSSMediaRule).media) === (parsed as CSSMediaRule).media.mediaText && sameNested(rule, parsed)
    );
  }
  // A rule whose prelude is its name, or a group's condition: the prelude is compared whole, prefix included.
  if (tag === 'CSSKeyframesRule' || GROUPS.has(tag)) {
    const prelude = preludeOf(rule);
    return prelude !== undefined && prelude === preludeOf(parsed) && sameNested(rule, parsed);
  }
  const head = headOf(rule);
  if (head === undefined || head !== headOf(parsed)) return false;
  if (
    'style' in rule &&
    shownCssText(ownStyle(rule as CSSRule & { style: CSSStyleDeclaration })) !==
      ownStyle(parsed as CSSRule & { style: CSSStyleDeclaration }).cssText
  )
    return false;
  return sameNested(rule, parsed);
}

/** Whether the emulation holds a record for `rule`, or for a rule nested in it: a rewritten block or a media list. */
function rewritten(rule: CSSRule): boolean {
  if (tagOf(rule) === 'CSSMediaRule' && mediaLists.has((rule as CSSMediaRule).media)) return true;
  if ('style' in rule && styles.has(ownStyle(rule as CSSRule & { style: CSSStyleDeclaration }))) return true;
  return Array.from(childRules(rule)).some(child => rewritten(child));
}

/**
 * The text that names a rule before its declarations and its nested rules (a selector, a key, a name), or
 * undefined for a kind of rule that is not compared.
 */
function headOf(rule: CSSRule): string | undefined {
  switch (tagOf(rule)) {
    case 'CSSStyleRule':
    case 'CSSPageRule':
      return (rule as CSSStyleRule | CSSPageRule).selectorText;
    case 'CSSKeyframeRule':
      return (rule as CSSKeyframeRule).keyText;
    case 'CSSMarginRule':
    case 'CSSPositionTryRule':
      return (rule as CSSRule & { name: string }).name;
    case 'CSSFontFaceRule':
    case 'CSSNestedDeclarations':
      return '';
    default:
      return undefined;
  }
}

/** The rules that group others under a prelude the emulation does not rewrite (a media rule's is `shownMedia`). */
const GROUPS = new Set([
  'CSSSupportsRule',
  'CSSLayerBlockRule',
  'CSSContainerRule',
  'CSSScopeRule',
  'CSSStartingStyleRule',
]);

/**
 * The text of a rule before the brace that opens its block, as the CSS lexer reads it: a brace in a string, or in
 * the parentheses and brackets of the prelude (`@supports (--x: {a})`), does not open the block.
 */
function preludeOf(rule: CSSRule): string | undefined {
  const text = rule.cssText;
  const { kinds, starts } = tokenize(text);
  let depth = 0;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    if (kind === Tok.LBrace && depth === 0) return text.slice(0, starts[i] ?? text.length);
    if (kind === Tok.Func || kind === Tok.LParen || kind === Tok.LBracket || kind === Tok.LBrace) depth++;
    else if (kind === Tok.RParen || kind === Tok.RBracket || kind === Tok.RBrace) depth--;
  }
  return undefined;
}

/** Whether the rules nested in `rule` are those nested in `parsed`, each as `sameRule` tells. */
function sameNested(rule: CSSRule, parsed: CSSRule): boolean {
  const rules = childRules(rule);
  const expected = childRules(parsed);
  if (rules.length !== expected.length) return false;
  for (let i = 0; i < rules.length; i++) if (!sameRule(rules[i] as CSSRule, expected[i] as CSSRule)) return false;
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
  /** <style> elements added or given a new text while watched, with the `unseen` count then. */
  private addedWatched = new WeakMap<Node, number>();

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
    settle();
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
  pageChanged(sheet: CSSStyleSheet, change?: RuleChange): void {
    const rec = this.recorded.get(sheet);
    if (!change || !rec?.serialized || !rec.source || rec.seen !== this.unseenTimes || this.stale.has(sheet))
      return this.invalidate(sheet);
    const pending = (rec.pending ??= { moves: [], changed: new Set() });
    if (change.kind === 'rule') pending.changed.add(change.rule);
    else pending.moves.push({ kind: change.kind, index: change.index });
    if (pending.moves.length + pending.changed.size > pendingLimit(rec.source.topRules.length))
      return this.invalidate(sheet);
    this.changed(sheet);
  }

  /**
   * Replaces `[start, end)` of the sheet's text by `insert`, its CSSOM changed the same way; the
   * rules are paired again around the change only, when they can be.
   */
  splice(sheet: CSSStyleSheet, start: number, end: number, insert: string): void {
    settle();
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

  /**
   * Gives the sheet `text` for its own, changing its CSSOM rules to those of the text (each
   * top-level rule inserted alone, invalid ones dropped) by deleting and inserting only the
   * top-level rules whose text changed, and pairing those alone (`retexted`). False when that
   * cannot be done, the sheet left as it was: the caller replaces all its rules and records the text.
   */
  retext(sheet: CSSStyleSheet, text: string, rulesOf: (sheet: CSSStyleSheet) => CSSRule[]): boolean {
    settle();
    if (this.stale.has(sheet)) return false;
    const source = this.source(sheet, rulesOf);
    if (!source || this.stale.has(sheet)) return false;
    const next = retexted(sheet, source, text, rulesOf(sheet));
    if (next === undefined) return false;
    // Paired lazily when the new rules did not pair with their text alone.
    const rec: Recorded = { text, unchecked: false, seen: this.unseenTimes };
    if (next) rec.source = next;
    this.recorded.set(sheet, rec);
    this.changed(sheet);
    return true;
  }

  has(sheet: CSSStyleSheet): boolean {
    return this.recorded.has(sheet);
  }

  /** The page changed the sheet through the CSSOM: its text is no longer known. */
  invalidate(sheet: CSSStyleSheet): void {
    const rec = this.recorded.get(sheet);
    // Serialized anew when next used: what is pending, here and in the styles taken, is in it.
    if (rec) delete rec.pending;
    forgetSheet(sheet);
    this.stale.add(sheet);
    this.changed(sheet);
  }

  /**
   * A <style> was added to a tree, or its text changed, while some session watched: as a watching
   * session's MutationObserver tells, which sees only what happens while it observes, and is let
   * go (its records with it) when that session stops watching. Either gives the element a new
   * sheet (or none, out of a document), as does each later change of its text or connection: every
   * sheet it has from then on is made from its text while watched, and while the `unseen` count is
   * the same, watched since. Its text is taken without the check.
   */
  watchedStyle(style: Node): void {
    this.addedWatched.set(style, this.unseenTimes);
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
    // The page's writes of styles' properties by name, seen now.
    settle();
    if (this.stale.has(sheet)) return this.serialize(sheet, rulesOf(sheet));
    const rec = this.recordOf(sheet);
    const owner = sheet.ownerNode;
    // A constructed sheet whose text went unseen (made before anyone watched) is serialized too.
    if (!rec) return !owner && !sheet.ownerRule && !sheet.href ? this.serialize(sheet, rulesOf(sheet)) : null;
    if (rec.pending) {
      const { pending, source } = rec;
      delete rec.pending;
      const rules = rulesOf(sheet);
      const next = rec.seen === this.unseenTimes && source ? applied(source, pending, rules) : null;
      if (next) {
        rec.text = next.text;
        rec.source = next;
        return next;
      }
      const serialized = this.serialize(sheet, rules);
      // Not paired either: the recorded text is not the sheet's any more, nor given again.
      if (!serialized) this.stale.add(sheet);
      return serialized;
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
        return this.revise(sheet, text, this.serialize(sheet, rules));
      }
    }
    if (rec.source === undefined) rec.source = pair(rec.text, rules);
    // Its rules not found in it: the page changed them unseen, in a way the check does not tell
    // (an @import, which replaceSync() leaves out). Serialized then, like a changed sheet.
    return rec.source ?? this.revise(sheet, rec.text, this.serialize(sheet, rules));
  }

  /**
   * The sheet's record, made from its <style>'s text if it has none yet: unchecked when the sheet
   * was made while watched, every change the page made to it seen.
   */
  private recordOf(sheet: CSSStyleSheet): Recorded | undefined {
    const rec = this.recorded.get(sheet);
    if (rec) return rec;
    const owner = sheet.ownerNode;
    if (!isHtml(owner, 'style') || owner.sheet !== sheet) return undefined;
    this.set(sheet, owner.textContent, this.addedWatched.get(owner) !== this.unseenTimes);
    return this.recorded.get(sheet);
  }

  /**
   * The text the sheet's header can be given without checking or pairing it (`source` does both,
   * at its first use): the recorded one, with its line starts once paired. Undefined when that
   * text is not the one `source` gives as it is: a sheet changed by the page, with changes
   * pending, or without a recorded text, for which `source` is cheap or gives none.
   */
  peek(sheet: CSSStyleSheet): { text: string; lines?: readonly number[] } | undefined {
    settle();
    if (this.stale.has(sheet)) return undefined;
    const rec = this.recordOf(sheet);
    // Pairing failed, the serialized text too: the registry serializes its own (`text`).
    if (!rec || rec.pending || rec.source === null) return undefined;
    // A source paired before watching last started is checked again: its text is the same.
    return rec.source ? rec.source : { text: rec.text };
  }

  /**
   * Whether `source` has work to do for the sheet (checking or pairing its recorded text): the
   * length of that text then, 0 otherwise. What warming up (warm.ts) looks at.
   */
  coldLength(sheet: CSSStyleSheet): number {
    if (this.stale.has(sheet)) return 0;
    const rec = this.recordOf(sheet);
    if (!rec || rec.pending) return 0;
    const seen = rec.seen === this.unseenTimes;
    return seen && rec.source !== undefined ? 0 : rec.text.length;
  }

  /** Listeners told of a sheet whose header text turned out not to be its text (`revise`). */
  private revised = new Set<(sheet: CSSStyleSheet) => void>();

  /**
   * Calls `listener` with each sheet whose recorded text, which its header was given (`peek`),
   * is found not to be its own when first checked or paired: it is served serialized from then
   * on. Gives the function that stops it.
   */
  onRevised(listener: (sheet: CSSStyleSheet) => void): () => void {
    this.revised.add(listener);
    return () => void this.revised.delete(listener);
  }

  /** Tells the listeners the sheet's text is no longer `was`, when it is not. */
  private revise(sheet: CSSStyleSheet, was: string, source: SheetSource | null): SheetSource | null {
    if (source?.text !== was) for (const listener of this.revised) listener(sheet);
    return source;
  }

  /**
   * Takes the text serialized from the sheet's rules for its own, from the generation the page's
   * change started (not a new one); null when its rules do not pair with it.
   */
  private serialize(sheet: CSSStyleSheet, rules: CSSRule[]): SheetSource | null {
    // What was written through the styles taken is in the rules' text now.
    forgetSheet(sheet);
    const text = rules.map(r => `${unwrapSafeArea(r.cssText)}\n`).join('');
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
