import { adoptedOf, quietly, watchAdopted } from '../../core/nodes/adopted';
import { closestOwn } from '../../core/nodes/nodes';
import { quietMutations } from '../../core/nodes/own-mutations';
import { setWrittenAttribute, writtenAttribute } from '../../core/nodes/written-attributes';
import { isCssom, isElement, isHtml, isNode, realmOf } from '../../core/realm';
import { isCompanion, pageRulesRewritten } from '../css/matching/forced-pseudo';
import { type CssomChange, ownSet, ownStyle, watchCssom, watchRealms } from '../css/sheets/watch/cssom-watch';
import { sizesRewrite } from './attributes';
import { followTrees, pageTrees, realmsOf, type Tree } from './trees';

/** A rewrite of a text of the page's style sheets: a media query list, or a declaration block. */
export type Rewrite = (text: string) => string;

/** The rewrites in effect, composed: null where none is. */
interface Active {
  media: Rewrite | null;
  values: Rewrite | null;
}

/** A text the page had, and what it was rewritten to: `applied` as it reads after the write. */
interface Rewritten {
  original: string;
  applied: string;
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
 * The page's changes through the CSSOM are rewritten at once, in the call that made them, so that
 * an insertRule() followed by getComputedStyle() in the same task sees the rewrite. The others are
 * seen by mutation observers and rewritten in a microtask after the change.
 *
 * Limits: sheets that cannot be read (cross-origin) are left as they are, and matchMedia() is not
 * affected. A <style> added in the same task as it is read is rewritten after that task's script,
 * and so is an element's style written in the task that reads it. Our writes are seen by the
 * page's own mutation observers.
 *
 * One for the page: a media rewrite and a value rewrite each, by name.
 */
const mediaRewrites = new Map<string, Rewrite>();
const valueRewrites = new Map<string, Rewrite>();
/** The records of the lists and declaration blocks rewritten: a sheet let go takes its records with it. */
const lists = new WeakMap<MediaList, Rewritten>();
const styles = new WeakMap<CSSStyleDeclaration, Rewritten>();

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
 * `current` what it reads now: the page's original is `record.original` while the text still reads
 * `record.applied`, else what it reads now (the page changed it). Returns whether a write was made
 * and the record to keep (none when the text is the page's own).
 */
function fixText(
  record: Rewritten | undefined,
  current: string,
  rewrite: Rewrite | null,
  read: () => string,
  write: (text: string) => void
): { changed: boolean; record?: Rewritten } {
  const original = record && record.applied === current ? record.original : current;
  const target = rewrite ? rewrite(original) : original;
  if (target === original) {
    if (current === original) return { changed: false };
    write(original);
    return { changed: true };
  }
  if (current !== target) write(target);
  return { changed: current !== target, record: { original, applied: read() } };
}

/** Rewrites a media query list through the CSSOM (ours, not a change of the page's to report). */
function fixMedia(list: MediaList, rewrite: Rewrite | null): boolean {
  const fixed = fixText(
    lists.get(list),
    list.mediaText,
    rewrite,
    () => list.mediaText,
    text => ownSet(list, 'mediaText', text)
  );
  if (fixed.record) lists.set(list, fixed.record);
  else lists.delete(list);
  return fixed.changed;
}

/** Rewrites a declaration block through the CSSOM (ours, not a change of the page's to report). */
function fixStyle(style: CSSStyleDeclaration, rewrite: Rewrite | null): boolean {
  const fixed = fixText(
    styles.get(style),
    style.cssText,
    rewrite,
    () => style.cssText,
    text => ownSet(style, 'cssText', text)
  );
  if (fixed.record) styles.set(style, fixed.record);
  else styles.delete(style);
  return fixed.changed;
}

/** Rewrites an attribute of `el` with setAttribute: ours, which the client does not see (`quietMutations`). */
function fixAttribute(el: Element, name: string, rewrite: Rewrite | null): boolean {
  const current = el.getAttribute(name);
  if (current === null) {
    setWrittenAttribute(el, name, undefined);
    return false;
  }
  const fixed = fixText(
    writtenAttribute(el, name),
    current,
    rewrite,
    () => el.getAttribute(name) ?? '',
    text => quietMutations(() => el.setAttribute(name, text))
  );
  setWrittenAttribute(el, name, fixed.record);
  return fixed.changed;
}

/** The elements whose attributes are rewritten: a `style`, the `media` of a <source>, the `sizes` of an <img> or <source>. */
const ELEMENTS = '[style], source[media], img[sizes], source[sizes]';

/**
 * Rewrites the attributes of `el` that the emulation rewrites; returns whether a write was made. A
 * <picture>'s source is chosen again by the browser when its media changes, and an image's `sizes`
 * is read when the image is chosen: both are set before that, as the page sets them.
 */
function fixElement(el: Element, act: Active): boolean {
  let changed = fixAttribute(el, 'style', act.values);
  if (isHtml(el, 'source')) changed = fixAttribute(el, 'media', act.media) || changed;
  if (isHtml(el, 'source') || isHtml(el, 'img'))
    changed = fixAttribute(el, 'sizes', act.media && sizesRewrite(act.media)) || changed;
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
  // Only blocks using env() are read again on every change (with the rewrite gone, those rewritten).
  if (isCssom(style, 'CSSStyleDeclaration') && (styles.has(style) || style.cssText.includes('env(')))
    changed = fixStyle(style, act.values) || changed;
  if (isCssom(rule, 'CSSGroupingRule') || isCssom(rule, 'CSSKeyframesRule'))
    for (const inner of Array.from(rule.cssRules)) changed = fixRule(inner, act) || changed;
  return changed;
}

/** Whether a sheet is not the page's to rewrite: one of ours, or a companion of the forced states. */
const ownSheet = (sheet: CSSStyleSheet) => isCompanion(sheet) || (!!sheet.ownerNode && !!closestOwn(sheet.ownerNode));

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

/** Rewrites every readable sheet and element of the page; returns whether anything was written. */
function sync(act: Active): boolean {
  let changed = false;
  for (const tree of pageTrees()) {
    for (const sheet of Array.from(tree.styleSheets))
      if (isCssom(sheet, 'CSSStyleSheet')) changed = fixSheet(sheet, act) || changed;
    for (const sheet of adoptedOf(tree)) changed = fixSheet(sheet, act) || changed;
    for (const el of tree.querySelectorAll(ELEMENTS)) if (!closestOwn(el)) changed = fixElement(el, act) || changed;
  }
  return changed;
}

/**
 * A change of the page through the CSSOM, told by cssom-watch.ts in the call that made it: the rule
 * it changed (or the one it inserted) is rewritten at once; the whole sheet when that is not known.
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
  }
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

const isSheetOwner = (node: Node | null) => isHtml(node, 'style') || isHtml(node, 'link');

/** Whether mutations may have added or changed style sheets (or added shadow trees, which may have some). */
function touchesSheets(records: MutationRecord[]): boolean {
  for (const record of records) {
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
        fixElement(target, act);
    } else
      for (const node of Array.from(record.addedNodes)) {
        if (!isElement(node) || closestOwn(node)) continue;
        if (node.matches(ELEMENTS)) fixElement(node, act);
        for (const el of node.querySelectorAll(ELEMENTS)) if (!closestOwn(el)) fixElement(el, act);
      }
  }
}

/** A <link> sheet (or an @import of a <style>) can only be read once loaded. */
const onLoad = (event: Event) => {
  const target = event.target;
  if (isNode(target) && isSheetOwner(target)) schedule();
};

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    update();
  });
}

/** Starts watching while something is rewritten: the observers, the CSSOM hooks, the trees. */
function startWatching(): Watching {
  return {
    observer: new MutationObserver(records => {
      if (touchesSheets(records)) schedule();
      else fixChanged(records, current());
    }),
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

/** Rewrites the page's sheets with the rewrites now set, and watches them for changes while there are any. */
function update(): void {
  const changed = quietly(() => sync(current()));
  if (changed) pageRulesRewritten();
  if (!rewriting()) return stopWatching();
  const trees = pageTrees();
  watching ??= startWatching();
  watchRealms(trees.map(tree => realmOf(tree).document));
  for (const tree of trees) {
    if (watching.observed.has(tree)) continue;
    watching.observed.add(tree);
    watching.observer.observe(tree, OBSERVED);
    tree.addEventListener('load', onLoad, true);
  }
}
