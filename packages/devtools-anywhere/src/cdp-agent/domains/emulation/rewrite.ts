import { adoptedOf, isHiddenSheet, quietly, watchAdopted, watchTrees } from '../../core/nodes/adopted';
import { closestOwn } from '../../core/nodes/nodes';
import { quietMutations } from '../../core/nodes/own-mutations';
import { setWrittenAttribute, type Written, writtenAttribute } from '../../core/nodes/written-attributes';
import { isCssom, isElement, isHtml, isNode, isSvg, realmOf } from '../../core/realm';
import { pageRulesRewritten } from '../css/matching/forced-pseudo';
import { type CssomChange, ownCall, ownSet, ownStyle, watchCssom, watchRealms } from '../css/sheets/watch/cssom-watch';
import { sizesRewrite } from './attributes';
import { type Merge, mergeDeclarations, mergeList } from './merge';
import { type Rewritten, styles } from './shown-style';
import { followTrees, pageTrees, realmsOf, type Tree } from './trees';

/** A rewrite of a text of the page's style sheets: a media query list, or a declaration block. */
export type Rewrite = (text: string) => string;

/** The rewrites in effect, composed: null where none is. */
interface Active {
  media: Rewrite | null;
  values: Rewrite | null;
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
 * rewritten like any other. matchMedia() is not affected. A <style> added in the same task as it is
 * read is rewritten after that task's script, and so is an element's style written in the task that
 * reads it. A property the page writes by name on a rule's style (rule.style.color = …) is seen only
 * once the CSS domain looks at the sheet, or at the next sync of the sheets. Our writes are seen by
 * the page's own mutation observers, and the page reads the rewritten values, as it reads them from
 * the CSSOM and the attributes.
 *
 * The rewrites are set by name: a media rewrite and a value rewrite, each of them composed with the
 * others of its kind, in the order their names were first set.
 */
const mediaRewrites = new Map<string, Rewrite>();
const valueRewrites = new Map<string, Rewrite>();
/** The records of the lists rewritten: a sheet let go takes its records with it (`styles`: shown-style.ts). */
const lists = new WeakMap<MediaList, Rewritten>();

const apply = (rewrites: Map<string, Rewrite>, text: string) => {
  let out = text;
  for (const rewrite of rewrites.values()) out = rewrite(out);
  return out;
};

const composed = (rewrites: Map<string, Rewrite>): Rewrite | null =>
  rewrites.size ? text => apply(rewrites, text) : null;

const current = (): Active => ({ media: composed(mediaRewrites), values: composed(valueRewrites) });

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
 * a new function; it does the same for as long as the media rewrites do not change. No caller in
 * the agent yet: the matchMedia() task will use it.
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

/** A media query list as the page wrote it, for showing: the original of a rewritten one. */
export function shownMedia(list: MediaList): string {
  const rewritten = lists.get(list);
  return rewritten && rewritten.applied === list.mediaText ? rewritten.original : list.mediaText;
}

/**
 * Puts `rewrite` of a text the page has in place. `record` is what was kept for the text, and
 * `current` what it reads now: while the text still reads `record.applied`, the page's original is
 * `record.original`; once the page changed it, the original is `merge` of the two (the page's change
 * kept, the rest as it was written). Returns whether a write was made and the record to keep (none
 * when the text is the page's own).
 */
function fixText(
  record: Rewritten | undefined,
  current: string,
  rewrite: Rewrite | null,
  merge: Merge,
  read: () => string,
  write: (text: string) => void
): { changed: boolean; record?: Rewritten } {
  const original = !record
    ? current
    : record.applied === current
      ? record.original
      : merge(record.original, record.applied, current);
  const target = rewrite ? rewrite(original) : original;
  if (target === original) {
    if (current === original) return { changed: false };
    write(original);
    return { changed: true };
  }
  // The text already reads what the rewrite gives: nothing to write (a browser may read it back
  // differently from what was written, so a comparison with the written text would never agree).
  if (record && record.applied === current && record.target === target) return { changed: false, record };
  if (current !== target) write(target);
  const applied = read();
  return { changed: applied !== current, record: { original, applied, target } };
}

/** Rewrites a media query list through the CSSOM (ours, not a change of the page's to report). */
function fixMedia(list: MediaList, rewrite: Rewrite | null): boolean {
  const fixed = fixText(
    lists.get(list),
    list.mediaText,
    rewrite,
    mergeList,
    () => list.mediaText,
    text => ownSet(list, 'mediaText', text)
  );
  if (fixed.record) {
    lists.set(list, fixed.record);
    track(writtenLists, list);
  } else lists.delete(list);
  return fixed.changed;
}

/** Rewrites a declaration block through the CSSOM (ours, not a change of the page's to report). */
function fixStyle(style: CSSStyleDeclaration, rewrite: Rewrite | null): boolean {
  const fixed = fixText(
    styles.get(style),
    style.cssText,
    rewrite,
    mergeDeclarations,
    () => style.cssText,
    text => ownSet(style, 'cssText', text)
  );
  if (fixed.record) {
    styles.set(style, fixed.record);
    track(writtenStyles, style);
  } else styles.delete(style);
  return fixed.changed;
}

/** How each attribute the emulation rewrites is merged back: a declaration block, or a list. */
const merges = (name: string): Merge => (name === 'style' ? mergeDeclarations : mergeList);

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
  if (paced && rewrite && holdBack(el, name, current, record, rewrite)) return false;
  const fixed = fixText(
    record,
    current,
    rewrite,
    merges(name),
    () => ownCall<string | null>(el, 'getAttribute', name) ?? '',
    text => {
      const before = ownCall<string | null>(el, 'getAttribute', name);
      quietMutations(() => ownCall(el, 'setAttribute', name, text), { target: el, name, before });
      wroteAt(el, name);
    }
  );
  setWrittenAttribute(el, name, fixed.record);
  if (fixed.record) track(writtenElements, el);
  return fixed.changed;
}

/*
 * Pacing. A page that answers a rewrite of ours in the same turn of its script (the microtasks after
 * our write, and the page's changes before the timer that closes the turn, see turnOf) can make the
 * rewrite answer it again forever: a mutation observer that puts back the text it had, for one, sees
 * our rewrite and restores its own text, which our observer sees and rewrites again, and no task ever
 * ends. So the rewrite of an attribute the page changed waits when the page changed it in the turn of
 * our last write; each answer in a turn doubles the wait, from two frames up to MAX_WAIT frames.
 *
 * A page that answers from a task of its own (a timer its observer sets) is taken for an answer in the turn only
 * if the timer runs before the turn closes. Observers run their callbacks in creation order: a page observer created
 * before ours runs first, so the timer it queues comes before our turn timer, and runs while the turn is open.
 * Otherwise it is a revert: a change after the turn has closed to a text that the rewrite would change again, such
 * as one with env(), or a media list written in another form. Once the page has changed a text, the emulation takes
 * the page's text as its original (fixText's merge), so a value the page keeps putting back is the original from
 * then on, and it is a revert all the same. A revert answers one of our writes, so each write is counted once. The
 * reverts of an attribute within REVERT_WINDOW are counted; above REVERT_LIMIT of them, each revert doubles the wait,
 * as an answer in the turn does. Until then a revert is written at once, whatever it puts back. The writes an
 * emulation change makes are never held back.
 */
const MAX_WAIT = 64;
/** The reverts of an attribute's rewrite are counted within this many ms, and more than REVERT_LIMIT back it off. */
const REVERT_WINDOW = 3000;
const REVERT_LIMIT = 3;

/** How an attribute's rewrites are paced: the turn of our last write, and the frames of the next wait. */
interface Pace {
  turn: number;
  wait: number;
  /** Whether a rewrite is due and waiting for its frame: the page's text is rewritten then. */
  held: boolean;
  /** When the counted reverts of the rewrite were made (by `readClock`), those within REVERT_WINDOW. */
  reverts: number[];
  /** Our writes to the attribute so far, and the write the last counted revert answered. */
  writes: number;
  revertOf: number;
}
const paces = new WeakMap<Element, Map<string, Pace>>();

/** The turn of the page's script our writes are made in: a timer closes it, so one task's writes share it. */
let turnOpen = false;
let turnNo = 0;
function turnOf(): number {
  if (!turnOpen) {
    turnOpen = true;
    Reflect.apply(setTimer, globalThis, [closeTurn, 0]);
  }
  return turnNo;
}
const closeTurn = () => {
  turnOpen = false;
  turnNo++;
};

/* The frames, timers and clock as the agent found them: a page may replace them later (a fake clock, say). */
const requestFrame = requestAnimationFrame;
const setTimer = setTimeout;
const perf = performance;
const readClock = perf.now;

/** Calls `fn` at the next frame, or after 50 ms where frames do not come (a page in the background). */
function nextFrame(fn: () => void): void {
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    fn();
  };
  Reflect.apply(requestFrame, globalThis, [run]);
  Reflect.apply(setTimer, globalThis, [run, 50]);
}

/** Calls `fn` after `frames` frames. */
function afterFrames(frames: number, fn: () => void): void {
  if (frames <= 1) nextFrame(fn);
  else nextFrame(() => afterFrames(frames - 1, fn));
}

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
  pace.reverts.push(Reflect.apply(readClock, perf, []) as number);
}

/** Whether the reverts of `pace`'s rewrite within REVERT_WINDOW, as of now, are more than REVERT_LIMIT. */
function revertsTooOften(pace: Pace): boolean {
  // A held rewrite keeps the decision it was held with: its reverts do not age out while it waits.
  if (!pace.held) {
    const now = Reflect.apply(readClock, perf, []) as number;
    pace.reverts = pace.reverts.filter(at => now - at < REVERT_WINDOW);
  }
  return pace.reverts.length > REVERT_LIMIT;
}

/**
 * Whether the rewrite of `el`'s attribute `name` that the page's change to `text` calls for is held
 * for frames, rather than made now (see the pacing note above). `record` is what was written last, and
 * `rewrite` is what the attribute is rewritten with.
 */
function holdBack(el: Element, name: string, text: string, record: Written | undefined, rewrite: Rewrite): boolean {
  const pace = paces.get(el)?.get(name);
  if (!pace) return false;
  // The page's text is what was written: there is nothing to rewrite.
  if (record && text === record.applied) return false;
  const answered = turnOpen && pace.turn === turnNo;
  // A revert: a change after the turn has closed, to a text the rewrite would change again. Counted, whether it is
  // the original (which the page's changes make the emulation's original) or another text. Our record of the last
  // write is not needed for it: a clear of the style drops that record.
  const reverted = !answered && rewrite(text) !== text;
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
    if (el) for (const name of ['style', 'media', 'sizes']) fixAttribute(el, name, null);
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

/** The elements whose attributes are rewritten: a `style`, the `media` of a <source>, the `sizes` of an <img> or <source>. */
const ELEMENTS = '[style], source[media], img[sizes], source[sizes]';

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
  return changed;
}

/** Rewrites a rule through the CSSOM: its media, its declarations, and what it holds. */
function fixRule(rule: CSSRule, act: Active): boolean {
  if (isCssom(rule, 'CSSImportRule')) {
    let changed = fixMedia(rule.media, act.media);
    if (rule.styleSheet) changed = fixSheet(rule.styleSheet, act) || changed;
    return changed;
  }
  let changed = isCssom(rule, 'CSSMediaRule') ? fixMedia(rule.media, act.media) : false;
  const style: unknown = 'style' in rule ? ownStyle(rule as CSSRule & { style: CSSStyleDeclaration }) : null;
  // A block using env() is read again on every change, and so is one this rewrote before (styles.has),
  // which is restored when the rewrite is gone.
  if (isCssom(style, 'CSSStyleDeclaration') && (styles.has(style) || style.cssText.includes('env(')))
    changed = fixStyle(style, act.values) || changed;
  if (isCssom(rule, 'CSSGroupingRule') || isCssom(rule, 'CSSKeyframesRule'))
    for (const inner of Array.from(rule.cssRules)) changed = fixRule(inner, act) || changed;
  return changed;
}

/** Whether a sheet is not the page's to rewrite: one of ours (a companion of the forced states, an injected one). */
const ownSheet = (sheet: CSSStyleSheet) => isHiddenSheet(sheet) || (!!sheet.ownerNode && !!closestOwn(sheet.ownerNode));

/** Rewrites a sheet: its media, and its rules. */
function fixSheet(sheet: CSSStyleSheet, act: Active): boolean {
  if (ownSheet(sheet)) return false;
  let changed = fixMedia(sheet.media, act.media);
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
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
    for (const sheet of Array.from(tree.styleSheets))
      if (isCssom(sheet, 'CSSStyleSheet')) changed = fixSheet(sheet, act) || changed;
    for (const sheet of adoptedOf(tree)) changed = fixSheet(sheet, act) || changed;
    for (const el of tree.querySelectorAll(ELEMENTS))
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
    const rule: CSSRule | undefined = sheet.cssRules[change.index];
    if (rule) changed = fixRule(rule, act);
  } else if (change.kind === 'media') changed = fixMedia(sheet.media, act.media);
  if (changed) pageRulesRewritten();
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
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type', 'style', 'sizes'],
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
      if (isSheetOwner(node) || node.querySelector('style, link')) return true;
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
      if (isElement(target) && !closestOwn(target) && (name === 'style' || name === 'media' || name === 'sizes'))
        fixElement(target, act, true);
    } else
      for (const node of Array.from(record.addedNodes)) {
        if (!isElement(node) || closestOwn(node)) continue;
        if (node.matches(ELEMENTS)) fixElement(node, act, true);
        for (const el of node.querySelectorAll(ELEMENTS)) if (!closestOwn(el)) fixElement(el, act, true);
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
  queueMicrotask(() => {
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
  return {
    observer: new MutationObserver(onRecords),
    observed: new Set(),
    stops: [watchAdopted(schedule, pageTrees), followTrees(schedule), watchCssom(onCssom, () => realmsOf(pageTrees()))],
  };
}

function stopWatching(): void {
  if (!watching) return;
  watching.observer.disconnect();
  for (const tree of watching.observed) tree.removeEventListener('load', onLoad, true);
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
    const pending = watching.observer.takeRecords();
    if (pending.length) onRecords(pending);
    watching.observer.disconnect();
    for (const tree of watching.observed) if (!now.has(tree)) tree.removeEventListener('load', onLoad, true);
    watching.observed.clear();
  }
  for (const tree of trees) {
    if (watching.observed.has(tree)) continue;
    watching.observed.add(tree);
    watching.observer.observe(tree, OBSERVED);
    tree.addEventListener('load', onLoad, true);
  }
}
