import { nativeCall, nativeGet, windowOf } from '../../core/natives';
import { afterFrames, inTurn, MAX_WAIT, queue, turnOf } from '../../core/turn';
import { adoptedOf, isHiddenSheet, quietly, watchAdopted, watchTrees } from '../../core/nodes/adopted';
import { closestOwn } from '../../core/nodes/nodes';
import { quietMutations } from '../../core/nodes/own-mutations';
import { setWrittenAttribute, type Written, writtenAttribute } from '../../core/nodes/written-attributes';
import { isCssom, isElement, isHtml, isNode, isSvg, realmOf } from '../../core/realm';
import { pageRulesRewritten } from '../css/matching/forced-pseudo';
import {
  type CssomChange,
  cssSupports,
  onMediaEdit,
  ownCall,
  ownGet,
  ownPlayer,
  ownSet,
  ownStyle,
  watchCssom,
  watchRealms,
} from '../css/sheets/watch/cssom-watch';
import {
  blockRecord,
  dropRecord,
  onNamedWrite,
  play,
  sheetTrusted,
  sourceTrusted,
  startRecord,
} from '../css/sheets/watch/written-blocks';
import { writtenBlock } from '../css/sheets/text/block-text';
import { sizesRewrite } from './attributes';
import { schemeDeclarations, schemeValue, type Preference } from './color-scheme';
import { asciiLower, withoutTakenSemicolon } from './css-tokens';
import {
  blockReading,
  type Merge,
  mergeDeclarations,
  mergeList,
  playedBlock,
  sameDeclarations,
  serialized,
  serializedBlock,
  writeDeclarations,
} from './merge';
import { unwrapSafeArea } from './safe-area';
import { mediaLists, type Rewritten, styles } from './shown-style';
import { followTrees, pageTrees, realmsOf, type Tree } from './trees';

/** A rewrite of a text of the page's style sheets: a media query list, or a declaration block. */
export type Rewrite = (text: string) => string;

/** The rewrites in effect, composed: null where none is. */
interface Active {
  media: Rewrite | null;
  values: Rewrite | null;
  /** The color-scheme value of the emulated preference, for a <meta name="color-scheme">'s content. */
  scheme: Rewrite | null;
}

/**
 * Emulation that Chrome does in the style engine (media features, safe area insets) is done here
 * by rewriting the page's style sheets in place through the CSSOM: media query lists (of @media,
 * @import and the sheets of <style> and <link>) and declaration blocks. Each text is kept as it
 * was, to be put back when the emulation ends; a text the page or the frontend changed since is
 * taken as the new original. The companions of forced pseudo-classes (CSS.forcePseudoState) copy
 * the rewritten rules, so they are rebuilt after a rewrite.
 *
 * The `style` attributes of the page's elements, the `media` of its <source> elements and the
 * `sizes` of its <img> and <source> elements are rewritten the same way, through setAttribute: the
 * client is shown the attribute as the page wrote it (core/nodes/written-attributes.ts), and our
 * writes are not reported as changes of the page's (core/nodes/own-mutations.ts).
 *
 * The page's changes through the CSSOM are rewritten at once, in the call that made them (a rule
 * inserted or changed, a sheet's own media list), so that an insertRule() followed by
 * getComputedStyle() in the same task sees the rewrite; replace() is rewritten when its promise
 * resolves. The others are seen by mutation observers and rewritten in a microtask after the change,
 * unless the page answers a rewrite of ours in the same turn of its script (a guard putting back its text), or keeps
 * putting back a value that the rewrite replaces from tasks of its own: then the rewrite waits, and the
 * wait grows while the page keeps answering (see the pacing note below).
 *
 * Limits: the rules of a sheet that cannot be read (cross-origin) are left as they are; its media is
 * rewritten like any other. The queries matchMedia() gives get the same rewrite (match-media.ts). A <style>
 * added in the same task as it is read is rewritten after that task's script, and so is an element's style
 * written in the task that reads it. A property the page writes by name on a rule's style (rule.style.color = …)
 * is seen only
 * once the CSS domain looks at the sheet, or at the next sync of the sheets. Our writes are seen by
 * the page's own mutation observers, and the page reads the rewritten values, as it reads them from
 * the CSSOM and the attributes.
 *
 * The rewrites are set by name: a media rewrite and a value rewrite, each of them composed with the
 * others of its kind, in the order their names were first set.
 */
const mediaRewrites = new Map<string, Rewrite>();
const valueRewrites = new Map<string, Rewrite>();

const apply = (rewrites: Map<string, Rewrite>, text: string) => {
  let out = text;
  for (const rewrite of rewrites.values()) out = rewrite(out);
  return out;
};

const composed = (rewrites: Map<string, Rewrite>): Rewrite | null =>
  rewrites.size ? text => apply(rewrites, text) : null;

/** The color-scheme value of the emulated preference (rewriteColorScheme), or null for none. */
let scheme: Rewrite | null = null;

const current = (): Active => ({ media: composed(mediaRewrites), values: composed(valueRewrites), scheme });

const rewriting = () => mediaRewrites.size > 0 || valueRewrites.size > 0;

/** Sets (or with null, removes) the media rewrite `name`, and rewrites the page's sheets with it. */
export function rewriteMedia(name: string, rewrite: Rewrite | null): void {
  if (rewrite) mediaRewrites.set(name, rewrite);
  else mediaRewrites.delete(name);
  update();
  for (const listener of mediaListeners)
    try {
      listener();
    } catch {
      // Ours, not the page's: the others are told too.
    }
}

/** Told each time a media rewrite is set or removed (`rewriteMedia`), once the page's sheets are rewritten. */
const mediaListeners = new Set<() => void>();

/**
 * The media rewrites now in effect, composed into one, or null when there are none: the text of a
 * media query as the emulation has it, as a `matchMedia()` of the page would see it (a matchMedia
 * hook calls it with the query's text, the query being whatever the page passed). Each call gives
 * a new function; it does the same for as long as the media rewrites do not change. The probe's
 * matchMedia() is given it (match-media.ts).
 *
 * @internal
 */
export function currentMediaRewrite(): Rewrite | null {
  return composed(mediaRewrites);
}

/**
 * Calls `listener` each time a media rewrite is set or removed (`rewriteMedia`), after the page's
 * sheets are rewritten with it. Returns the function that stops it.
 *
 * @internal
 */
export function onMediaRewriteChange(listener: () => void): () => void {
  mediaListeners.add(listener);
  return () => void mediaListeners.delete(listener);
}

/** Sets (or with null, removes) the declaration rewrite `name`, and rewrites the page's sheets with it. */
export function rewriteValues(name: string, rewrite: Rewrite | null): void {
  if (rewrite) valueRewrites.set(name, rewrite);
  else valueRewrites.delete(name);
  update();
}

/** Whether Chrome reads a value as a color-scheme: the probe's CSS.supports (cssSupports), not the page's. */
const supportsScheme = (value: string) => cssSupports('color-scheme', value);

/** The color-scheme preference the page's values follow (rewriteColorScheme), or none. */
let colorPreference: Preference | undefined;

/**
 * Makes the page's `color-scheme` values follow the emulated preference (color-scheme.ts): the declarations
 * of its sheets, style attributes and CSSOM, and the content of its <meta name="color-scheme">. Given no
 * preference, they are as the page wrote them again. The root is not given a scheme of its own.
 */
export function rewriteColorScheme(preference: Preference | undefined): void {
  // Unchanged: the values already follow it, and the page is not read again for nothing.
  if (preference === colorPreference) return;
  colorPreference = preference;
  scheme = preference ? schemeValue(preference, supportsScheme) : null;
  rewriteValues('colorScheme', scheme && schemeDeclarations(scheme));
}

/**
 * How a text is merged back and compared: a declaration block (a style attribute, a style's text), or a list (media
 * queries, sizes). `same` tells whether two texts say the same thing, so that a text is written only where what it says
 * changes: a declaration block is compared by the values the browser reads for its names, its spacing aside.
 */
interface Kind {
  merge: Merge;
  same: (a: string, b: string) => boolean;
}
const DECLARATIONS: Kind = { merge: mergeDeclarations, same: sameDeclarations };
const LISTS: Kind = { merge: mergeList, same: (a, b) => a === b };

/**
 * Puts `rewrite` of a text the page has in place. `record` is what was kept for the text, and
 * `current` what it reads now: while the text still reads `record.applied`, the page's original is
 * `record.original`; once the page changed it, the original is `kind.merge` of the two (the page's change
 * kept, the rest as it was written). Returns whether a write was made and the record to keep (none
 * when the text is the page's own).
 */
function fixText(
  record: Rewritten | undefined,
  current: string,
  rewrite: Rewrite | null,
  kind: Kind,
  read: () => string,
  write: (text: string) => void
): { changed: boolean; record?: Rewritten } {
  return applyText(planText(record, current, rewrite, kind), current, read, write);
}

/** What fixText does with the page's text now: see planText. */
interface Plan {
  original: string;
  target: string;
  /** The text to write, or undefined where the text reads so already. */
  write: string | undefined;
  /** The record to keep as it is, where the text already reads what the rewrite gives. */
  keep: Rewritten | undefined;
}

/**
 * The decision fixText makes, without making it: the original of the page's text, what the rewrite gives it, and
 * what to write. The pacing (holdBack) asks the same question, so that a change which makes the rewrite write is a
 * revert whatever the rewrite makes of the text itself.
 */
function planText(record: Rewritten | undefined, current: string, rewrite: Rewrite | null, kind: Kind): Plan {
  const original = !record
    ? current
    : record.applied === current
      ? record.original
      : kind.merge(record.original, record.applied, current);
  const target = rewrite ? rewrite(original) : original;
  // The rewrite changes nothing here, so the original is written back only where the page's text says something else:
  // a text that says the same, in other spacing, is left as the browser wrote it (as below).
  if (target === original)
    return {
      original,
      target,
      write: current === original || kind.same(current, original) ? undefined : original,
      keep: undefined,
    };
  // The text already reads what the rewrite gives: nothing to write (a browser may read it back
  // differently from what was written, so a comparison with the written text would never agree).
  if (record && record.applied === current && record.target === target)
    return { original, target, write: undefined, keep: record };
  // A text that says the same as the one the page has, in other spacing, is not written: the browser keeps its own
  // serialization. An edit of other declarations of the attribute is then no change of the rewrite's to make, and
  // no revert (see the pacing note).
  const write = current !== target && !kind.same(current, target) ? target : undefined;
  return { original, target, write, keep: undefined };
}

/** Makes the write `plan` says, reads the text back, and gives whether it changed and the record to keep. */
function applyText(
  plan: Plan,
  current: string,
  read: () => string,
  write: (text: string) => void
): { changed: boolean; record?: Rewritten } {
  if (plan.keep) return { changed: false, record: plan.keep };
  if (plan.target === plan.original) {
    if (plan.write === undefined) return { changed: false };
    write(plan.write);
    return { changed: true };
  }
  if (plan.write !== undefined) write(plan.write);
  const applied = read();
  return { changed: applied !== current, record: { original: plan.original, applied, target: plan.target } };
}

/** Rewrites a media query list through the CSSOM (ours, not a change of the page's to report). */
function fixMedia(list: MediaList, rewrite: Rewrite | null): boolean {
  const fixed = fixText(
    mediaLists.get(list),
    nativeGet<string>(list, 'mediaText'),
    rewrite,
    LISTS,
    () => nativeGet<string>(list, 'mediaText'),
    text => ownSet(list, 'mediaText', text)
  );
  if (fixed.record) {
    mediaLists.set(list, fixed.record);
    track(writtenLists, list);
  } else mediaLists.delete(list);
  return fixed.changed;
}

/**
 * The page is about to edit `list` entry by entry (appendMedium(), deleteMedium()): a list the emulation rewrote is
 * given the page's own entries for the call, so that the entry the page names is there, or is not, as in Chrome,
 * and what the call leaves is the page's list. Returns what rewrites the list again once the call is through.
 */
function editMedia(list: object): (() => void) | undefined {
  if (!isMediaList(list)) return undefined;
  const record = mediaLists.get(list);
  const applied = nativeGet<string>(list, 'mediaText');
  if (!record || record.applied !== applied) return undefined;
  ownSet(list, 'mediaText', record.original);
  mediaLists.delete(list);
  return () => {
    fixMedia(list, current().media);
    // The companions of the forced states copy the list: they are made again where it reads another text.
    if (nativeGet<string>(list, 'mediaText') !== applied) pageRulesRewritten();
  };
}

/** A media list, of any realm: one the emulation may have a record of. */
const isMediaList = (value: object): value is MediaList => mediaLists.has(value as MediaList);

/**
 * A declaration the browser serializes with no value: a side of a shorthand whose value is pending (a var() or an
 * env() in it), once another side of it was set after it. The shorthand's own text is in no serialization then.
 */
const NO_VALUE = /: +(?:!important)?;/;

/** The text of a sheet's file, fetched when a block of it is first looked for; null while it is not there. */
const fileTexts = new WeakMap<CSSStyleSheet, string | null>();
let fetchFile: typeof fetch | undefined;

/** Takes the page's own fetch (the probe's), for the texts of the sheets of files. */
export function useFetch(fetcher: typeof fetch): void {
  fetchFile = fetcher;
}

/**
 * The text of the file `sheet` was loaded from, once it is there: it is fetched (from the HTTP cache, mostly) the
 * first time it is asked for, and the page's sheets are rewritten again when it comes. Fetched as the page's own
 * fetch() does, with the credentials the sheet was loaded with: those of a <link crossorigin="use-credentials">
 * go to another origin too, and no others do.
 */
function fileText(sheet: CSSStyleSheet): string | undefined {
  const known = fileTexts.get(sheet);
  if (known !== undefined) return known ?? undefined;
  fileTexts.set(sheet, null);
  const href = sheet.href;
  const owner = nativeGet<Node | null>(sheet, 'ownerNode');
  const crossOrigin = isHtml(owner, 'link') ? nativeCall<string | null>(owner, 'getAttribute', 'crossorigin') : null;
  const credentials = asciiLower(crossOrigin ?? '') === 'use-credentials' ? 'include' : 'same-origin';
  if (href && fetchFile)
    void fetchFile(href, { cache: 'force-cache', credentials })
      .then(response => (response.ok ? response.text() : Promise.reject(new Error(response.statusText))))
      .then(
        text => {
          fileTexts.set(sheet, text);
          if (rewriting()) schedule();
        },
        () => {}
      );
  return undefined;
}

/** What planWritten found to do with a block that has a record of its writes. */
interface WrittenPlan {
  /** Whether the block is to be written: what the rewrite gives is not what it holds. */
  writes: boolean;
  /** Writes the block, each write through `write`, and gives what to keep for it: none where it is the page's own. */
  commit(write?: (set: () => void) => void): Rewritten | undefined;
}

/**
 * What to do with a declaration block whose serialization does not tell what it declares (NO_VALUE), or that has
 * a record of its writes (written-blocks.ts): the block is rewritten by playing the record again with each text
 * rewritten, and put back by playing it as the page wrote it. The browser makes of the same writes the same
 * block, so nothing of the block is guessed.
 *
 * The record is the one kept as the page wrote the block. A rule's block that has none, never written since the
 * agent loaded (sourceTrusted), starts one from the text of its rule in its sheet (writtenBlock), where that text
 * reads as the block does. A record is used only while playing it gives a block that reads as `style` does, text
 * and order: otherwise it is ended, for good, and nothing is written from it. `generic` is what the rewrite by
 * the block's own text kept for it, if it rewrote it before: the block the record started from was that one.
 *
 * Undefined where there is no such record: the block is rewritten by its own text, as any other (fixText), which
 * leaves the declarations it reads with no value as they are.
 */
function planWritten(
  style: CSSStyleDeclaration,
  generic: { original: string; applied: string } | undefined,
  current: string,
  rewrite: Rewrite | null
): WrittenPlan | undefined {
  let record = blockRecord(style);
  // The block does not hold what `heldBase` says of the sides it reads with no value: it is written whatever it holds.
  let force = false;
  const rule = style.parentRule;
  const source = () => (rule ? writtenBlock(rule, fileText, sheetTrusted(style)) : undefined);
  const apply = (text: string) => (rewrite ? rewrite(text) : text);
  if (!record) {
    if (!rule || !NO_VALUE.test(current) || !sourceTrusted(style)) return undefined;
    const base = source();
    if (base === undefined) return undefined;
    // Rewritten by its own text before the text it was written in was there (a file's): as that text, rewritten.
    const was = generic && generic.applied === current ? generic.original : current;
    if (serializedBlock(base) !== was) return undefined;
    record = startRecord(style, base);
    if (generic) force = !!(record.heldBase = apply(base));
  } else if (record.base === null) {
    // Written since the agent loaded, from a block that did not hold all it declared: that block was its rule's
    // text, where it reads as the block did.
    const base = source();
    if (base === undefined) return undefined;
    const pre = generic && generic.applied === record.pre ? generic.original : record.pre;
    if (serializedBlock(base) !== pre) return void dropRecord(style);
    record.base = base;
    if (generic) force = !!(record.heldBase = apply(base));
    record.from = 'text';
  } else if (record.from === 'read') {
    // Started from what the block read as: the page's own text, where the rewrite had written that block.
    if (generic) {
      if (generic.applied !== record.pre && serializedBlock(generic.applied) !== record.pre)
        return void dropRecord(style);
      record.heldBase = record.base;
      record.base = generic.original;
    }
    // A value left open is serialized with a semicolon after it, which the text parsed again takes into the value.
    else record.base = withoutTakenSemicolon(record.base);
    record.from = 'text';
  }
  // A text the page read from a rewritten block and wrote again is the page's as it was written.
  const base = record.base ?? '';
  if (record.heldBase === undefined && unwrapSafeArea(base) !== base) {
    record.heldBase = base;
    record.base = unwrapSafeArea(base);
  }
  for (const write of record.writes)
    if (write.held === undefined && unwrapSafeArea(write.value) !== write.value) {
      write.held = write.value;
      write.value = unwrapSafeArea(write.value);
    }
  // But where the block is to be written whatever it holds: the rewrite by its own text may have moved a property.
  if (!force && playedBlock(record, true).reading !== blockReading(style)) return void dropRecord(style);
  const found = record;
  const targetBase = apply(found.base ?? '');
  const targets = found.writes.map(write => (write.remove || write.value === '' ? write.value : apply(write.value)));
  const writes =
    force ||
    targetBase !== (found.heldBase ?? found.base) ||
    found.writes.some((write, i) => targets[i] !== (write.held ?? write.value));
  return {
    writes,
    commit(write) {
      if (writes) {
        play(found, ownPlayer(style, write), false, apply);
        if (targetBase === found.base) delete found.heldBase;
        else found.heldBase = targetBase;
        found.writes.forEach((w, i) => {
          const target = targets[i];
          if (target === undefined || target === w.value) delete w.held;
          else w.held = target;
        });
      }
      if (found.heldBase === undefined && !found.writes.some(w => w.held !== undefined)) return undefined;
      const applied = nativeGet<string>(style, 'cssText');
      return { original: playedBlock(found, false).text, applied, target: applied, written: found };
    },
  };
}

/** Rewrites a declaration block through the CSSOM (ours, not a change of the page's to report). */
function fixStyle(style: CSSStyleDeclaration, rewrite: Rewrite | null): boolean {
  const current = nativeGet<string>(style, 'cssText');
  const record = styles.get(style);
  if (record?.written || NO_VALUE.test(current) || blockRecord(style)) {
    const plan = planWritten(style, record?.written ? undefined : record, current, rewrite);
    if (plan) {
      const kept = plan.commit();
      if (kept) {
        styles.set(style, kept);
        track(writtenStyles, style);
      } else styles.delete(style);
      return plan.writes;
    }
  }
  const fixed = fixText(
    record,
    current,
    rewrite,
    DECLARATIONS,
    () => nativeGet<string>(style, 'cssText'),
    // The texts are the browser's serializations, or made of one: written a declaration at a time where they can be.
    text => writeDeclarations(style, text)
  );
  if (fixed.record) {
    styles.set(style, fixed.record);
    track(writtenStyles, style);
  } else styles.delete(style);
  return fixed.changed;
}

/** How each attribute the emulation rewrites is merged back and compared: a declaration block, or a list. */
const kindOf = (name: string): Kind => (name === 'style' ? DECLARATIONS : LISTS);

/**
 * Rewrites the style attribute of `el` where its block has a record of its writes (planWritten): the page wrote it
 * through the element's style, and the attribute is the browser's serialization of the block, which may not tell
 * what it declares. Undefined where it has none, or the attribute was set since: it is rewritten by its text. The
 * element's style is read only for an attribute that may be such a block's (fixAttribute tells why).
 */
function fixPlayed(
  el: Element,
  current: string,
  record: Written | undefined,
  rewrite: Rewrite | null,
  paced: boolean
): boolean | undefined {
  if (!record?.played && !NO_VALUE.test(current) && !ENV_CALL.test(current)) return undefined;
  if (!serialized(current)) return undefined;
  const style = ownGet<CSSStyleDeclaration | undefined>(el, 'style');
  if (!style || !blockRecord(style)) return undefined;
  // The attribute is not the block's serialization: it was set since, and the block is what its text gives.
  if (nativeGet<string>(style, 'cssText') !== current) return void dropRecord(style);
  const plan = planWritten(style, record?.played ? undefined : record, current, rewrite);
  if (!plan) return undefined;
  if (paced && rewrite && holdBack(el, 'style', current, record, plan.writes)) return false;
  const attribute = () => ownCall<string | null>(el, 'getAttribute', 'style');
  const kept = plan.commit(set => quietMutations(set, { target: el, name: 'style', before: attribute() }));
  if (plan.writes) wroteAt(el, 'style');
  setWrittenAttribute(
    el,
    'style',
    kept && { original: kept.original, applied: attribute() ?? '', target: kept.target, played: true }
  );
  if (kept) track(writtenElements, el);
  return plan.writes;
}

/**
 * Rewrites an attribute of `el` with setAttribute: ours, which the client does not see (`quietMutations`).
 * Read and written through the agent's own natives (ownCall), not the element's methods, which a page
 * may have wrapped. `paced`: the page changed the attribute, so the rewrite may be held (see holdBack).
 */
function fixAttribute(el: Element, name: string, rewrite: Rewrite | null, paced = false): boolean {
  const current = ownCall<string | null>(el, 'getAttribute', name);
  if (current === null) {
    setWrittenAttribute(el, name, undefined);
    return false;
  }
  const record = writtenAttribute(el, name);
  if (name === 'style') {
    const played = fixPlayed(el, current, record, rewrite, paced);
    if (played !== undefined) return played;
  }
  const plan = planText(record, current, rewrite, kindOf(name));
  if (paced && rewrite && holdBack(el, name, current, record, plan.write !== undefined)) return false;
  const fixed = applyText(
    plan,
    current,
    () => ownCall<string | null>(el, 'getAttribute', name) ?? '',
    text => {
      // Each write is one of the attribute, and none of them is the client's to hear of.
      const quiet = (set: () => void) =>
        quietMutations(set, { target: el, name, before: ownCall<string | null>(el, 'getAttribute', name) });
      // A style attribute that reads as the browser serializes one (`serialized`), and is the text of the element's
      // style: the CSSOM wrote it last. The text parsed again is not always that block: a value left open takes the
      // semicolon and the declarations after it, and a longhand written into a shorthand loses its place
      // (writeDeclarations). So it is written through the element's style, a declaration at a time.
      // The style is not read for any other text: the browser parses the next attribute set on an element whose
      // style was read in another order (the `!important` declarations last).
      const style =
        name === 'style' && serialized(current) ? ownGet<CSSStyleDeclaration | undefined>(el, 'style') : undefined;
      if (style && nativeGet<string>(style, 'cssText') === current) writeDeclarations(style, text, quiet);
      else quiet(() => ownCall(el, 'setAttribute', name, text));
      wroteAt(el, name);
    }
  );
  setWrittenAttribute(el, name, fixed.record);
  if (fixed.record) track(writtenElements, el);
  return fixed.changed;
}

/*
 * Pacing. A page that answers a rewrite of ours in the same turn of its script (the microtasks after
 * our write, and the page's changes before the timer that closes the turn, see core/turn.ts) can make the
 * rewrite answer it again forever: a mutation observer that puts back the text it had, for one, sees
 * our rewrite and restores its own text, which our observer sees and rewrites again, and no task ever
 * ends. So the rewrite of an attribute the page changed waits when the page changed it in the turn of
 * our last write; each answer in a turn doubles the wait, from two frames up to MAX_WAIT frames.
 *
 * A page that answers from a task of its own (a timer its observer sets) is taken for an answer in the turn when its
 * observer queues the timer in the checkpoint of our write: the turn closes with a timer queued by a microtask after
 * that checkpoint (turnOf), which comes after the timers its observers queue there, whichever observer was made
 * first (a page that clears that timer ends the turn TURN_MAX ms after it began). (Observers run their callbacks in
 * creation order, so before that fix a page observer made before ours queued its timer ahead of the turn's, and one
 * made after it did not.) Otherwise it is a revert: a change after the
 * turn has closed that makes the rewrite write over it (planText): a text whose values the rewrite changes, as with
 * env() or a media list written in another form, or one whose original the change merges into reads as another text,
 * which the rewrite then writes, and the page puts back, forever. A text whose declared values are the page's, as the
 * browser reads them, is written by neither side, so an edit of other declarations of an attribute is no revert.
 * Once the page has changed a text, the emulation takes the page's text as its original (fixText's merge), so a value
 * the page keeps putting back is the original from then on, and it is a revert all the same. A revert answers one of
 * our writes, so each write is counted once. The reverts of an attribute within REVERT_WINDOW are counted; above
 * REVERT_LIMIT of them, each revert doubles the wait, as an answer in the turn does. Until then a revert is written at
 * once, whatever it puts back. The writes an emulation change makes are never held back.
 */
/** The reverts of an attribute's rewrite are counted within this many ms, and more than REVERT_LIMIT back it off. */
const REVERT_WINDOW = 3000;
const REVERT_LIMIT = 3;

/** How an attribute's rewrites are paced: the turn of our last write, and the frames of the next wait. */
interface Pace {
  turn: number;
  wait: number;
  /** Whether a rewrite is due and waiting for its frame: the page's text is rewritten then. */
  held: boolean;
  /** When the counted reverts of the rewrite were made (by the probe's clock), those within REVERT_WINDOW. */
  reverts: number[];
  /** Our writes to the attribute so far, and the write the last counted revert answered. */
  writes: number;
  revertOf: number;
}
const paces = new WeakMap<Element, Map<string, Pace>>();

/** Notes that the agent wrote `el`'s attribute `name` in the current turn (see holdBack). */
function wroteAt(el: Element, name: string): void {
  let byName = paces.get(el);
  if (!byName) paces.set(el, (byName = new Map()));
  const pace = byName.get(name) ?? { turn: 0, wait: 1, held: false, reverts: [], writes: 0, revertOf: -1 };
  pace.turn = turnOf();
  pace.writes++;
  byName.set(name, pace);
}

/**
 * Counts a revert of `pace`'s rewrite now. A revert answers one of our writes, so the first change counted after
 * a write is the revert; another change before the next write (a second record of the same task, or one while
 * the rewrite is held) is the same one.
 */
function countRevert(pace: Pace): void {
  if (pace.revertOf === pace.writes) return;
  pace.revertOf = pace.writes;
  pace.reverts.push(windowOf().now());
}

/** Whether the reverts of `pace`'s rewrite within REVERT_WINDOW, as of now, are more than REVERT_LIMIT. */
function revertsTooOften(pace: Pace): boolean {
  // A held rewrite keeps the decision it was held with: its reverts do not age out while it waits.
  if (!pace.held) {
    const now = windowOf().now();
    pace.reverts = pace.reverts.filter(at => now - at < REVERT_WINDOW);
  }
  return pace.reverts.length > REVERT_LIMIT;
}

/**
 * Whether the rewrite of `el`'s attribute `name` that the page's change to `text` calls for is held
 * for frames, rather than made now (see the pacing note above). `record` is what was written last, and
 * `writes` is whether the rewrite writes the change (planText): that is what a revert is.
 */
function holdBack(el: Element, name: string, text: string, record: Written | undefined, writes: boolean): boolean {
  const pace = paces.get(el)?.get(name);
  if (!pace) return false;
  // The page's text is what was written: there is nothing to rewrite.
  if (record && text === record.applied) return false;
  const answered = inTurn(pace.turn);
  // A revert: a change after the turn has closed that the rewrite writes over, whether it is the original (which the
  // page's changes make the emulation's original) or another text, and whether or not the rewrite changes the text
  // itself: the original the change merges into may read differently (planText). Our record of the last write is not
  // needed for it: a clear of the style drops that record.
  const reverted = !answered && writes;
  if (reverted) countRevert(pace);
  const backingOff = revertsTooOften(pace);
  if (!answered && !reverted) {
    // A change that answers nothing is written at once, even while a rewrite is held: that rewrite, when it
    // runs, rewrites whatever text the page has then. It resets the wait only once the window holds no more
    // reverts than the limit: a clear of the style in between does not restart the wait.
    if (!backingOff) pace.wait = 1;
    return false;
  }
  // A revert that is not yet too many is written at once, whatever text it puts back, the original included: a page's
  // own write of the text it had is not told from a guard's put-back, and the back-off above holds a page that keeps
  // reverting past the limit.
  if (!answered && !backingOff) {
    pace.wait = 1;
    return false;
  }
  // An answer while a rewrite is held is covered by that rewrite, which reads the page's text when it runs.
  if (pace.held) return true;
  pace.wait = answered || backingOff ? Math.min(MAX_WAIT, pace.wait * 2) : 1;
  pace.held = true;
  afterFrames(pace.wait, () => {
    pace.held = false;
    if (rewriting()) fixElement(el, current(), false);
  });
  return true;
}

/*
 * What was rewritten, held weakly. A sheet or an element the page took out of the page keeps its
 * rewrite until the emulation ends, when it is restored though it is out of the page: a page that
 * puts it back later sees the page's own text, not the emulation's.
 */
const writtenElements = new Set<WeakRef<Element>>();
const writtenLists = new Set<WeakRef<MediaList>>();
const writtenStyles = new Set<WeakRef<CSSStyleDeclaration>>();
/** The reference of each object in one of the sets, so that it is in a set once. */
let refs = new WeakMap<object, WeakRef<object>>();
let sweepAt = 1024;

/** Keeps `obj` in `set`, once; the dead references in it are swept as it grows. */
function track<T extends object>(set: Set<WeakRef<T>>, obj: T): void {
  if (refs.has(obj)) return;
  if (set.size >= sweepAt) {
    for (const ref of set) if (!ref.deref()) set.delete(ref);
    sweepAt = Math.max(1024, set.size * 2);
  }
  const ref = new WeakRef(obj);
  refs.set(obj, ref);
  set.add(ref);
}

/** Restores what was rewritten and is still alive, wherever it is now, and forgets it. */
function restoreWritten(): void {
  for (const ref of writtenElements) {
    const el = ref.deref();
    if (el) for (const name of ['style', 'media', 'sizes', 'content']) fixAttribute(el, name, null);
  }
  for (const ref of writtenLists) {
    const list = ref.deref();
    if (list) fixMedia(list, null);
  }
  for (const ref of writtenStyles) {
    const style = ref.deref();
    if (style) fixStyle(style, null);
  }
  writtenElements.clear();
  writtenLists.clear();
  writtenStyles.clear();
  refs = new WeakMap();
}

/**
 * The elements whose attributes are rewritten: a `style`, the `media` of a <source>, the `sizes` of an <img> or
 * <source>, and the `content` of a <meta>. Every <meta> is looked at: one may be made a color-scheme meta.
 */
const ELEMENTS = '[style], source[media], img[sizes], source[sizes], meta';

/** A <meta name="color-scheme">, whose content is a color-scheme value (the name is ASCII case-insensitive). */
const isColorSchemeMeta = (el: Element) =>
  asciiLower(nativeCall<string | null>(el, 'getAttribute', 'name') ?? '') === 'color-scheme';

/**
 * Rewrites the attributes of `el` that the emulation rewrites; returns whether a write was made. A
 * <picture>'s source is chosen again by the browser when its media changes, and an image's `sizes`
 * is read when the image is chosen: both are set before that, as the page sets them. `paced`: the
 * page changed them (see fixAttribute).
 */
function fixElement(el: Element, act: Active, paced = false): boolean {
  let changed = fixAttribute(el, 'style', act.values, paced);
  if (isHtml(el, 'source')) changed = fixAttribute(el, 'media', act.media, paced) || changed;
  if (isHtml(el, 'source') || isHtml(el, 'img'))
    changed = fixAttribute(el, 'sizes', act.media && sizesRewrite(act.media), paced) || changed;
  if (isHtml(el, 'meta'))
    changed = fixAttribute(el, 'content', isColorSchemeMeta(el) ? act.scheme : null, paced) || changed;
  return changed;
}

/**
 * What a declaration block's text has when it may call env(): the name in any case (CSS compares function names
 * so), or an escape, which the name may be written with (`e\nv(`).
 */
const ENV_CALL = /env\(|\\/i;

/**
 * Whether a declaration block's text uses env() or color-scheme, or does not hold all the block declares (NO_VALUE):
 * read through the natives (core/natives.ts).
 */
const envOrScheme = (style: CSSStyleDeclaration): boolean => {
  const text = nativeGet<string>(style, 'cssText');
  return ENV_CALL.test(text) || /color-scheme/.test(text) || NO_VALUE.test(text);
};

/** Rewrites a rule through the CSSOM: its media, its declarations, and what it holds. */
function fixRule(rule: CSSRule, act: Active): boolean {
  if (isCssom(rule, 'CSSImportRule')) {
    let changed = fixMedia(nativeGet<MediaList>(rule, 'media'), act.media);
    const sheet = nativeGet<CSSStyleSheet | null>(rule, 'styleSheet');
    if (sheet) changed = fixSheet(sheet, act) || changed;
    return changed;
  }
  let changed = isCssom(rule, 'CSSMediaRule') ? fixMedia(nativeGet<MediaList>(rule, 'media'), act.media) : false;
  const style: unknown = 'style' in rule ? ownStyle(rule as CSSRule & { style: CSSStyleDeclaration }) : null;
  // A block using env() or color-scheme is read again on every change, and so is one this rewrote before
  // (styles.has), which is restored when the rewrite is gone.
  if (isCssom(style, 'CSSStyleDeclaration') && (styles.has(style) || envOrScheme(style)))
    changed = fixStyle(style, act.values) || changed;
  // What the rule holds: the rules of a grouping rule or of @keyframes, and those nested in a style rule (their
  // declarations between them included, which are rules of their own).
  if ('cssRules' in rule)
    for (const inner of Array.from(nativeGet<CSSRuleList>(rule, 'cssRules'))) changed = fixRule(inner, act) || changed;
  return changed;
}

/** Whether a sheet is not the page's to rewrite: one of ours (a companion of the forced states, an injected one). */
const ownSheet = (sheet: CSSStyleSheet) => {
  if (isHiddenSheet(sheet)) return true;
  const owner = nativeGet<Node | null>(sheet, 'ownerNode');
  return !!owner && !!closestOwn(owner);
};

/** Rewrites a sheet: its media, and its rules. */
function fixSheet(sheet: CSSStyleSheet, act: Active): boolean {
  if (ownSheet(sheet)) return false;
  let changed = fixMedia(nativeGet<MediaList>(sheet, 'media'), act.media);
  let rules: CSSRuleList;
  try {
    rules = nativeGet<CSSRuleList>(sheet, 'cssRules');
  } catch {
    return changed; // A cross-origin sheet.
  }
  for (const rule of Array.from(rules)) changed = fixRule(rule, act) || changed;
  return changed;
}

/**
 * Rewrites every readable sheet and element of the page; returns whether anything was written. `paced`:
 * the sync follows a change of the page, so its attribute writes are paced as fixChanged's are (see
 * holdBack), which keeps a page answering them from looping through here.
 */
function sync(act: Active, paced = false): boolean {
  let changed = false;
  for (const tree of pageTrees()) {
    for (const sheet of Array.from(nativeGet<StyleSheetList>(tree, 'styleSheets')))
      if (isCssom(sheet, 'CSSStyleSheet')) changed = fixSheet(sheet, act) || changed;
    for (const sheet of adoptedOf(tree)) changed = fixSheet(sheet, act) || changed;
    for (const el of nativeCall<NodeListOf<Element>>(tree, 'querySelectorAll', ELEMENTS))
      if (!closestOwn(el)) changed = fixElement(el, act, paced) || changed;
  }
  return changed;
}

/**
 * A change of the page through the CSSOM, told by cssom-watch.ts in the call that made it, except
 * replace() (told once its promise resolves) and a property written by name (told when the CSS domain
 * settles the styles it took): the rule it changed (or the one it inserted) is rewritten at once; the
 * sheet's own media list is, when that is what changed; the whole sheet when that is not known.
 */
function onCssom(sheet: CSSStyleSheet, _text?: string, _by?: object, change?: CssomChange): void {
  if (!rewriting() || ownSheet(sheet)) return;
  const act = current();
  let changed = false;
  if (!change) changed = fixSheet(sheet, act);
  else if (change.kind === 'rule') changed = fixRule(change.rule, act);
  else if (change.kind === 'insert') {
    const rule: CSSRule | undefined = nativeGet<CSSRuleList>(sheet, 'cssRules')[change.index];
    if (rule) changed = fixRule(rule, act);
  } else if (change.kind === 'media') changed = fixMedia(nativeGet<MediaList>(sheet, 'media'), act.media);
  if (changed) pageRulesRewritten();
}

/**
 * The page wrote a property of `style` by name (written-blocks.ts): a rule's block is rewritten at once, as one
 * written through setProperty() is. An element's is seen by the observer, as its attribute changes.
 */
function onNamed(style: object): void {
  if (!rewriting() || !isCssom(style, 'CSSStyleDeclaration')) return;
  const rule = nativeGet<CSSRule | null>(style, 'parentRule');
  const sheet = rule?.parentStyleSheet;
  if (!sheet || ownSheet(sheet) || !(styles.has(style) || envOrScheme(style))) return;
  if (fixStyle(style, current().values)) pageRulesRewritten();
}

/** What is watched while something is rewritten. */
interface Watching {
  observer: MutationObserver;
  /** The trees observed (their `load` listeners are removed with them). */
  observed: Set<Tree>;
  stops: (() => void)[];
}
let watching: Watching | null = null;
let scheduled = false;

const OBSERVED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type', 'style', 'sizes', 'name', 'content'],
};

/** The elements that own a style sheet: a <style> (HTML or SVG) and a <link>. */
const isSheetOwner = (node: Node | null) => isHtml(node, 'style') || isSvg(node, 'style') || isHtml(node, 'link');

/** Whether mutations may have added or changed style sheets (or added shadow trees, which may have some). */
function touchesSheets(records: MutationRecord[]): boolean {
  for (const record of records) {
    // The style or sizes attribute of a <style> or <link> changes no sheet, so it is no reason for a sync of
    // the sheets: fixChanged rewrites it, paced like any other element's.
    if (record.type === 'attributes' && (record.attributeName === 'style' || record.attributeName === 'sizes'))
      continue;
    if (isSheetOwner(record.target) || isSheetOwner(record.target.parentNode)) return true;
    for (const node of Array.from(record.addedNodes)) {
      if (!isElement(node) || closestOwn(node)) continue;
      if (isSheetOwner(node) || nativeCall<Element | null>(node, 'querySelector', 'style, link')) return true;
    }
  }
  return false;
}

/**
 * Rewrites the attributes the page set on elements, and the elements it added, at once (no sheet
 * changed): the `style`, `media` and `sizes` the emulation rewrites.
 */
function fixChanged(records: MutationRecord[], act: Active): void {
  for (const record of records) {
    if (record.type === 'attributes') {
      const target = record.target;
      const name = record.attributeName;
      if (
        isElement(target) &&
        !closestOwn(target) &&
        (name === 'style' || name === 'media' || name === 'sizes' || isHtml(target, 'meta'))
      )
        fixElement(target, act, true);
    } else
      for (const node of Array.from(record.addedNodes)) {
        if (!isElement(node) || closestOwn(node)) continue;
        if (nativeCall<boolean>(node, 'matches', ELEMENTS)) fixElement(node, act, true);
        for (const el of nativeCall<NodeListOf<Element>>(node, 'querySelectorAll', ELEMENTS))
          if (!closestOwn(el)) fixElement(el, act, true);
      }
  }
}

/** A <link> sheet can only be read once loaded. */
const onLoad = (event: Event) => {
  const target = event.target;
  if (isNode(target) && isSheetOwner(target)) schedule();
};

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queue(() => {
    scheduled = false;
    update(true);
  });
}

/** The page's mutations: a change of a sheet schedules the whole page; the rest is rewritten at once. */
function onRecords(records: MutationRecord[]): void {
  if (touchesSheets(records)) schedule();
  else fixChanged(records, current());
}

/** Starts watching while something is rewritten: the observers, the CSSOM hooks, the trees. */
function startWatching(): Watching {
  onMediaEdit(editMedia);
  onNamedWrite(onNamed);
  return {
    observer: new (windowOf().MO)(onRecords),
    observed: new Set(),
    stops: [
      watchAdopted(schedule, pageTrees),
      followTrees(schedule),
      watchCssom(onCssom, () => realmsOf(pageTrees())),
      () => onMediaEdit(null),
      () => onNamedWrite(null),
    ],
  };
}

function stopWatching(): void {
  if (!watching) return;
  Reflect.apply(windowOf().disconnect, watching.observer, []);
  for (const tree of watching.observed) Reflect.apply(windowOf().unlisten, tree, ['load', onLoad, true]);
  for (const stop of watching.stops) stop();
  watching = null;
}

/**
 * Rewrites the page's sheets with the rewrites now set, and watches them for changes while there are any.
 * `paced`: it follows a change of the page (schedule), not a change of the emulation, which takes effect at once.
 */
function update(paced = false): void {
  const changed = quietly(() => sync(current(), paced));
  if (changed) pageRulesRewritten();
  if (!rewriting()) {
    // What was rewritten and has left the page goes back too, as the page's own.
    restoreWritten();
    return stopWatching();
  }
  const trees = pageTrees();
  watching ??= startWatching();
  watchRealms(trees.map(tree => realmOf(tree).document));
  // The adopted sheets of trees that came since are watched too.
  watchTrees(trees);
  const now = new Set(trees);
  if ([...watching.observed].some(tree => !now.has(tree))) {
    // A tree the page took out is no longer observed: the observer is set again on those there are.
    const pending: MutationRecord[] = Reflect.apply(windowOf().takeRecords, watching.observer, []);
    if (pending.length) onRecords(pending);
    Reflect.apply(windowOf().disconnect, watching.observer, []);
    for (const tree of watching.observed)
      if (!now.has(tree)) Reflect.apply(windowOf().unlisten, tree, ['load', onLoad, true]);
    watching.observed.clear();
  }
  for (const tree of trees) {
    if (watching.observed.has(tree)) continue;
    watching.observed.add(tree);
    Reflect.apply(windowOf().observe, watching.observer, [tree, OBSERVED]);
    Reflect.apply(windowOf().listen, tree, ['load', onLoad, true]);
  }
}
