// The store of the page's sheet texts (`sheetTexts`): what each sheet was written in, checked
// once against its CSSOM, made unknown or kept up to date as the page and the CSS domain change
// the sheet, and paired with its rules when asked for (pair.ts, updated in place by splice.ts).
import { isHtml } from '../../../../core/realm';
import { type CssomChange, forgetSheet, ownEdit, recordPageChanges, settle } from '../watch/cssom-watch';
import { type SheetSource, pair, tagOf } from './pair';
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
  pageChanged(sheet: CSSStyleSheet, change?: CssomChange): void {
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
    // What was written through the styles taken is in the rules' text now.
    forgetSheet(sheet);
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
