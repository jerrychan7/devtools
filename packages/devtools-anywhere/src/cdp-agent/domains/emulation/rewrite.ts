import { adoptedOf, quietly, watchAdopted } from '../../core/nodes/adopted';
import { frames } from '../../core/frames/frames';
import { closestOwn, isOwn } from '../../core/nodes/nodes';
import { isCssom, isElement, isHtml, isNode } from '../../core/realm';
import { isCompanion, pageRulesRewritten } from '../css/matching/forced-pseudo';
import { ownEdit } from '../css/sheets/cssom-watch';

/** A rewrite of a text of the page's style sheets: a media query list, or a declaration block. */
export type Rewrite = (text: string) => string;
type Tree = Document | ShadowRoot;

/** What a text was before we rewrote it, and what it read right after. */
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
 * Limits: sheets that cannot be read (cross-origin) are left as they are, inline styles too, and
 * matchMedia() is not affected. Rules the page inserts through the CSSOM are rewritten on the next
 * change of the page's style sheets seen in the DOM.
 *
 * One for the page: a media rewrite and a value rewrite each, by name.
 */
const mediaRewrites = new Map<string, Rewrite>();
const valueRewrites = new Map<string, Rewrite>();
const lists = new Map<MediaList, Rewritten>();
const styles = new Map<CSSStyleDeclaration, Rewritten>();

const apply = (rewrites: Map<string, Rewrite>, text: string) => {
  let out = text;
  for (const rewrite of rewrites.values()) out = rewrite(out);
  return out;
};

/** Sets (or with null, removes) the media rewrite `name`, and rewrites the page's sheets with it. */
export function rewriteMedia(name: string, rewrite: Rewrite | null) {
  if (rewrite) mediaRewrites.set(name, rewrite);
  else mediaRewrites.delete(name);
  update();
}

/** Sets (or with null, removes) the declaration rewrite `name`, and rewrites the page's sheets with it. */
export function rewriteValues(name: string, rewrite: Rewrite | null) {
  if (rewrite) valueRewrites.set(name, rewrite);
  else valueRewrites.delete(name);
  update();
}

/** A media query list as the page wrote it, for showing: the original of a rewritten one. */
export function shownMedia(list: MediaList): string {
  const rewritten = lists.get(list);
  return rewritten && rewritten.applied === list.mediaText ? rewritten.original : list.mediaText;
}

/** Puts `target` (`original` rewritten) in place of what `read` gives, keeping the original in `records`. */
function fix<K>(
  records: Map<K, Rewritten>,
  key: K,
  seen: Set<K>,
  rewrites: Map<string, Rewrite>,
  read: () => string,
  write: (text: string) => void
): boolean {
  const current = read();
  const record = records.get(key);
  const original = record && record.applied === current ? record.original : current;
  const target = rewrites.size ? apply(rewrites, original) : original;
  if (target === original) {
    records.delete(key);
    if (current === original) return false;
    write(original);
    return true;
  }
  seen.add(key);
  if (current !== target) write(target);
  records.set(key, { original, applied: read() });
  return current !== target;
}

/** The document and the shadow roots of each frame, but those of devtools-anywhere's own elements. */
function trees(): Tree[] {
  const out: Tree[] = [];
  for (const frame of frames) {
    const doc = frame.document;
    const visit = (root: Tree) => {
      out.push(root);
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode: node => (isOwn(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const shadow = isElement(n) ? frames.shadowRootOf(n) : null;
        if (shadow) visit(shadow);
      }
    };
    visit(doc);
  }
  return out;
}

/** Rewrites every readable sheet of the page with the current rewrites; returns whether anything changed. */
function sync(): boolean {
  const seenLists = new Set<MediaList>();
  const seenStyles = new Set<CSSStyleDeclaration>();
  let changed = false;
  const media = (list: MediaList) => {
    changed =
      fix(
        lists,
        list,
        seenLists,
        mediaRewrites,
        () => list.mediaText,
        t => (list.mediaText = t)
      ) || changed;
  };
  const visitRules = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (isCssom(rule, 'CSSImportRule')) {
        media(rule.media);
        if (rule.styleSheet) visitSheet(rule.styleSheet);
        continue;
      }
      if (isCssom(rule, 'CSSMediaRule')) media(rule.media);
      const style: unknown = 'style' in rule ? rule.style : null;
      // Only blocks using env() are read again on every change (with the rewrite gone, those rewritten).
      if (isCssom(style, 'CSSStyleDeclaration') && (styles.has(style) || style.cssText.includes('env('))) {
        // Ours, not a change of the page's to report.
        const set = (t: string) => ownEdit(() => (style.cssText = t));
        changed = fix(styles, style, seenStyles, valueRewrites, () => style.cssText, set) || changed;
      }
      if (isCssom(rule, 'CSSGroupingRule') || isCssom(rule, 'CSSKeyframesRule')) visitRules(rule.cssRules);
    }
  };
  const visitSheet = (sheet: CSSStyleSheet) => {
    if (isCompanion(sheet) || (sheet.ownerNode && closestOwn(sheet.ownerNode))) return;
    media(sheet.media);
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // A cross-origin sheet.
    }
    visitRules(rules);
  };
  for (const tree of trees()) {
    for (const sheet of Array.from(tree.styleSheets)) if (isCssom(sheet, 'CSSStyleSheet')) visitSheet(sheet);
    for (const sheet of adoptedOf(tree)) visitSheet(sheet);
  }
  // Those no longer in the page are let go.
  for (const list of lists.keys()) if (!seenLists.has(list)) lists.delete(list);
  for (const style of styles.keys()) if (!seenStyles.has(style)) styles.delete(style);
  return changed;
}

/** What is watched for style sheet changes while something is rewritten. */
let watching: { observer: MutationObserver; observed: Set<Tree>; stop: (() => void)[] } | null = null;
let scheduled = false;

const OBSERVED: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributeFilter: ['href', 'rel', 'disabled', 'media', 'type'],
};

const isSheetOwner = (node: Node | null) => isHtml(node, 'style') || isHtml(node, 'link');

/** Whether mutations may have added or changed style sheets (or added shadow trees, which may have some). */
function touchesSheets(records: MutationRecord[]): boolean {
  for (const record of records) {
    if (isSheetOwner(record.target) || isSheetOwner(record.target.parentNode)) return true;
    for (const node of Array.from(record.addedNodes)) {
      if (!isElement(node) || closestOwn(node)) continue;
      if (isSheetOwner(node) || node.querySelector('style, link') || frames.shadowRootOf(node)) return true;
    }
  }
  return false;
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

/** Rewrites the page's sheets, and watches them for changes while there is something to rewrite. */
function update() {
  const changed = quietly(sync);
  if (changed) pageRulesRewritten();
  if (!mediaRewrites.size && !valueRewrites.size) {
    watching?.observer.disconnect();
    for (const tree of watching?.observed ?? []) tree.removeEventListener('load', onLoad, true);
    watching?.stop.forEach(stop => stop());
    watching = null;
    return;
  }
  if (!watching) {
    const observer = new MutationObserver(records => {
      if (touchesSheets(records)) schedule();
    });
    watching = {
      observer,
      observed: new Set(),
      stop: [watchAdopted(schedule, trees), frames.onChange(schedule)],
    };
  }
  for (const tree of trees()) {
    if (watching.observed.has(tree)) continue;
    watching.observed.add(tree);
    watching.observer.observe(tree, OBSERVED);
    tree.addEventListener('load', onLoad, true);
  }
}
