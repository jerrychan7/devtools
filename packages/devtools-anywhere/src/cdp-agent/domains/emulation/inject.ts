import { disconnect, nativeCall, newObserver, observe, takeRecords } from '../../core/natives';
import { hideAdopted } from '../../core/nodes/adopted';
import { closestOwn } from '../../core/nodes/nodes';
import { documentOf, isElement, realmOf } from '../../core/realm';
import { afterFrames, inTurn, MAX_WAIT, task, turnOf } from '../../core/turn';
import { ownCall } from '../css/sheets/watch/cssom-watch';
import { followTrees, pageTrees, type Tree } from './trees';

/**
 * Style sheets and element scans of devtools-anywhere itself, by name, in every tree of the page
 * (the frames' documents and their shadow roots), following the trees as they come and go while
 * one is active. The sheets are adopted hidden from the page (`hideAdopted`): the page does not see
 * them in `adoptedStyleSheets`, and the CSS domain does not list them. The scans never visit
 * devtools-anywhere's own elements. The queries and the observer are the browser's own (core/natives.ts), not
 * what the page may have put over them; a sheet is made by the constructor its document's window has.
 *
 * Pacing. A visit may write to the page (a mark on the element), which the page's own mutation observers see. A
 * page that answers such a write by adding elements, in the same turn of its script (core/turn.ts: at once, in a
 * microtask or in a timer of no delay), would have them visited and written at once, which it answers again, and no
 * task ever ends. So the elements a document gets in the turn of a scan's last write there are held for frames
 * before they are visited: each batch held so waits twice the frames of the one before, from two frames up to
 * MAX_WAIT frames, and the answers that come while a batch is held join it, with no longer a wait.
 *
 * An addition in a turn of the page's own is visited at once and ends the doubling; one that comes so while a visit
 * is held ends the doubling too (the next batch waits two frames again), but is visited with what is held, after the
 * frames that batch still waits. So a page that adds elements on its own, some of them in
 * the turn of a write by chance (a frame callback of the page's that runs after the one a held visit ran in), has
 * them held for two frames at most. An answer from a later task of the page's (a frame callback, a timer with a
 * delay) is not told from an addition of its own, and is visited at once: such a page goes on adding at its own pace
 * (docs/limitations.md). The pace is kept per document, so that a frame answering the marks does not hold the scan
 * of another.
 */

/** A sheet injected by name: its text, and per tree the function that takes it out again. */
interface Injection {
  css: string;
  /** One constructed sheet per document: a sheet can only be adopted by the documents it was made in. */
  sheets: WeakMap<Document, CSSStyleSheet>;
  into: Map<Tree, () => void>;
}

/** What a scan does with an element: it returns true where it wrote to the page (see the pacing note). */
export type Visit = (el: Element) => boolean | void;

/** A scan by name: its visit, and the elements it has visited (each is visited once by a scan). */
interface Scan {
  visit: Visit;
  seen: WeakSet<Element>;
}

const injections = new Map<string, Injection>();
const scans = new Map<string, Scan>();
/** Observes the trees the scans look at, while there are scans. */
let observer: MutationObserver | null = null;
const observed = new Set<Tree>();
let stopFollowing: (() => void) | null = null;
/**
 * How the visits of the elements added to a document are paced: the turn of the scans' last write there, the frames
 * of the next wait, and the elements added while a visit is held (null while none is), which are visited when it
 * runs. They are held weakly: the page may have dropped them by then.
 */
interface Pace {
  wroteIn: number;
  wait: number;
  held: WeakRef<Element>[] | null;
}

/** The pace of each document; a new map once the last scan stops, which drops the waits and what is held. */
let paces = new WeakMap<Document, Pace>();

function paceOf(doc: Document): Pace {
  let pace = paces.get(doc);
  if (!pace) paces.set(doc, (pace = { wroteIn: -1, wait: 1, held: null }));
  return pace;
}

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
 * never visited. A visit that writes to the page returns true: the elements the page adds in answer are
 * visited some frames later (see the pacing note).
 */
export function scanElements(name: string, visit: Visit | null): void {
  if (!visit) {
    scans.delete(name);
    // The next scans start with no wait, and with nothing held: a hold that is still to run finds its pace gone.
    if (!scans.size) paces = new WeakMap();
  } else {
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
  if (scan.visit(el) === true) paceOf(documentOf(el)).wroteIn = turnOf();
}

/** Visits each element of `root` and below for `scan`. */
function visitAll(root: ParentNode, scan: Scan): void {
  for (const el of nativeCall<NodeListOf<Element>>(root, 'querySelectorAll', '*')) visitElement(el, scan);
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
    if (observer) disconnect(observer);
    observer = null;
    observed.clear();
    return;
  }
  const watching = (observer ??= newObserver(onRecords));
  const fresh = trees.filter(tree => !observed.has(tree));
  if ([...observed].some(tree => !now.has(tree))) {
    // A tree the page took out is no longer observed: the observer is set again on those there are,
    // and the records taken before are handled after that, so that what they make is observed too.
    const pending = takeRecords(watching);
    disconnect(watching);
    for (const tree of observed) if (!now.has(tree)) observed.delete(tree);
    for (const tree of observed) observe(watching, tree, OBSERVED);
    if (pending.length) onRecords(pending);
  }
  for (const tree of fresh) {
    observed.add(tree);
    observe(watching, tree, OBSERVED);
    for (const scan of scans.values()) visitAll(tree, scan);
  }
}

/** Visits `added`, elements added to the trees, and what is below them, for each scan. */
function visitAdded(added: Element[]): void {
  for (const el of added)
    for (const scan of scans.values()) {
      visitElement(el, scan);
      visitAll(el, scan);
    }
}

/**
 * The elements added to the trees are visited for each scan: at once, or, where their document got them in the turn
 * of a scan's last write there, after a wait that doubles with each such answer (see the pacing note).
 */
function onRecords(records: MutationRecord[]): void {
  const byDocument = new Map<Document, Element[]>();
  for (const record of records) {
    const added = Array.from(record.addedNodes).filter(isElement);
    if (!added.length) continue;
    const doc = documentOf(record.target);
    const before = byDocument.get(doc);
    if (before) before.push(...added);
    else byDocument.set(doc, added);
  }
  for (const [doc, added] of byDocument) {
    const pace = paceOf(doc);
    const answer = inTurn(pace.wroteIn);
    if (!answer) pace.wait = 1;
    // A visit is held already: it takes these too, when it runs.
    if (pace.held) pace.held.push(...added.map(el => new WeakRef(el)));
    else if (!answer) visitAdded(added);
    else hold(doc, pace, added);
  }
}

/** Holds the visit of `added`, the answer of `doc` to a write, for twice the frames of the wait before. */
function hold(doc: Document, pace: Pace, added: Element[]): void {
  pace.wait = Math.min(MAX_WAIT, pace.wait * 2);
  const batch = (pace.held = added.map(el => new WeakRef(el)));
  // The visit runs in a task of its own after the frames, not in the frame callback: what the page's frame
  // callbacks add after that one would be in the turn of its writes.
  afterFrames(pace.wait, () =>
    task(() => {
      // The scans stopped since (and may run again): the ones that run now have visited these, or will.
      if (paces.get(doc) !== pace) return;
      pace.held = null;
      visitAdded(batch.map(ref => ref.deref()).filter(el => el !== undefined));
    })
  );
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
