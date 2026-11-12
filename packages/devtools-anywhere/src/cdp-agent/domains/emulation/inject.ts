import { hideAdopted } from '../../core/nodes/adopted';
import { closestOwn } from '../../core/nodes/nodes';
import { documentOf, isElement, realmOf } from '../../core/realm';
import { ownCall } from '../css/sheets/watch/cssom-watch';
import { followTrees, pageTrees, type Tree } from './trees';

/**
 * Style sheets and element scans of devtools-anywhere itself, by name, in every tree of the page
 * (the frames' documents and their shadow roots), following the trees as they come and go while
 * one is active. The sheets are adopted hidden from the page (`hideAdopted`): the page does not see
 * them in `adoptedStyleSheets`, and the CSS domain does not list them. The scans never visit
 * devtools-anywhere's own elements.
 */

/** A sheet injected by name: its text, and per tree the function that takes it out again. */
interface Injection {
  css: string;
  /** One constructed sheet per document: a sheet can only be adopted by the documents it was made in. */
  sheets: WeakMap<Document, CSSStyleSheet>;
  into: Map<Tree, () => void>;
}

/** A scan by name: its visit, and the elements it has visited (each is visited once by a scan). */
interface Scan {
  visit: (el: Element) => void;
  seen: WeakSet<Element>;
}

const injections = new Map<string, Injection>();
const scans = new Map<string, Scan>();
/** Observes the trees the scans look at, while there are scans. */
let observer: MutationObserver | null = null;
const observed = new Set<Tree>();
let stopFollowing: (() => void) | null = null;

/**
 * Puts a style sheet with `css` in every tree of the page under `name`, replacing the one it had
 * (`null` removes it). It applies to the page's elements in each tree, after the page's sheets.
 */
export function injectOwnStyle(name: string, css: string | null): void {
  const old = injections.get(name);
  if (old) for (const restore of old.into.values()) restore();
  injections.delete(name);
  if (css !== null) injections.set(name, { css, sheets: new WeakMap(), into: new Map() });
  update();
}

/**
 * Calls `visit` once for each element of the page, in every tree: those there now, and those added
 * later (through a mutation observer). `null` stops it. Setting a `visit` (replacing the one before)
 * visits the elements there now again, each once for that visit. devtools-anywhere's own elements are
 * never visited.
 */
export function scanElements(name: string, visit: ((el: Element) => void) | null): void {
  if (!visit) scans.delete(name);
  else {
    // The trees observed already get the new visit now; the trees sync finds new get every scan.
    const now = new Set(pageTrees());
    const known = [...observed].filter(tree => now.has(tree));
    const scan: Scan = { visit, seen: new WeakSet() };
    scans.set(name, scan);
    for (const tree of known) visitAll(tree, scan);
  }
  update();
}

/** Visits `el` for `scan`, unless devtools-anywhere owns it or the scan has visited it. */
function visitElement(el: Element, scan: Scan): void {
  if (closestOwn(el) || scan.seen.has(el)) return;
  scan.seen.add(el);
  scan.visit(el);
}

/** Visits each element of `root` and below for `scan`. */
function visitAll(root: ParentNode, scan: Scan): void {
  for (const el of root.querySelectorAll('*')) visitElement(el, scan);
}

/** The sheet of `injection` for `tree`'s document, made in that document's realm with its text. */
function sheetOf(injection: Injection, tree: Tree): CSSStyleSheet {
  const doc = documentOf(tree);
  let sheet = injection.sheets.get(doc);
  if (!sheet) {
    sheet = new (realmOf(tree).CSSStyleSheet)();
    ownCall(sheet, 'replaceSync', injection.css);
    injection.sheets.set(doc, sheet);
  }
  return sheet;
}

/** The mutation observer's options: the trees' children, at any depth. */
const OBSERVED: MutationObserverInit = { childList: true, subtree: true };

/**
 * Puts every injection in the trees of the page, and observes the trees while there are scans. A
 * tree the page took out gets its injected sheet taken back out, as it may come back.
 */
function sync(): void {
  const trees = pageTrees();
  const now = new Set(trees);
  for (const injection of injections.values()) {
    for (const tree of trees)
      if (!injection.into.has(tree)) injection.into.set(tree, hideAdopted(tree, sheetOf(injection, tree)));
    for (const [tree, restore] of injection.into)
      if (!now.has(tree)) {
        restore();
        injection.into.delete(tree);
      }
  }
  if (!scans.size) {
    observer?.disconnect();
    observer = null;
    observed.clear();
    return;
  }
  observer ??= new MutationObserver(onRecords);
  const fresh = trees.filter(tree => !observed.has(tree));
  if ([...observed].some(tree => !now.has(tree))) {
    // A tree the page took out is no longer observed: the observer is set again on those there are,
    // and the records taken before are handled after that, so that what they make is observed too.
    const pending = observer.takeRecords();
    observer.disconnect();
    for (const tree of observed) if (!now.has(tree)) observed.delete(tree);
    for (const tree of observed) observer.observe(tree, OBSERVED);
    if (pending.length) onRecords(pending);
  }
  for (const tree of fresh) {
    observed.add(tree);
    observer.observe(tree, OBSERVED);
    for (const scan of scans.values()) visitAll(tree, scan);
  }
}

/** Visits the elements added to the trees, for each scan. */
function onRecords(records: MutationRecord[]): void {
  for (const record of records)
    for (const node of Array.from(record.addedNodes)) {
      if (!isElement(node)) continue;
      for (const scan of scans.values()) {
        visitElement(node, scan);
        visitAll(node, scan);
      }
    }
}

/** Keeps the trees in step with the page while something is injected or scanned; stops when nothing is. */
function update(): void {
  if (!injections.size && !scans.size) {
    stopFollowing?.();
    stopFollowing = null;
    sync();
    return;
  }
  stopFollowing ??= followTrees(sync);
  sync();
}
