// Local updates of a paired SheetSource: a change inside one rule (`respliced`), top-level rules
// replaced (`replaceTops`), a new text for the sheet diffed against the old one rule by rule
// (`retexted`), and the page's CSSOM changes applied to a serialized text (`applied`). Each
// outlines and pairs only what changed, or gives up (null) for the caller to pair anew.
import { type CssOutline, ROOT } from '../parse/css-outline';
import { outline } from '../parse/css-outline-wasm';
import { replacedLines } from './text-lines';
import { type SheetSource, TOP, childRules, pairList, tagOf } from './pair';

/**
 * The page's changes to a serialized sheet, kept until its source is asked for (a page may change
 * a sheet many times in a frame): the top-level rules inserted and deleted, in order, and those
 * whose text changed, each once.
 */
export interface Pending {
  moves: { kind: 'insert' | 'delete'; index: number }[];
  changed: Set<CSSRule>;
}

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
export function applied(source: SheetSource, pending: Pending, rules: CSSRule[]): SheetSource | null {
  const { topRules, topNodes } = source;
  const count = topRules.length;
  const runs: Run[] = count ? [[0, count]] : [];
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
      for (let i = from; i < k; i++) if (isLead(topRules[i] as CSSRule)) return false;
      const added = rules.slice(j, at);
      if (added.some(isLead)) return false;
      const start = from < count ? o.start(topNodes[from] as number) : text.length;
      const end = k < count ? o.start(topNodes[k] as number) : text.length;
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
      if (!rule || rule !== topRules[k]) return null;
      if (!pending.changed.has(rule) && !keep(k, at)) return null;
    }
  }
  if (at !== rules.length || !keep(count, rules.length)) return null;
  return edits.length ? replaceTops(source, edits) : source;
}

/**
 * The source after `[start, end)` of its text was replaced by `insert`, the CSSOM changed the
 * same way: only the top-level rule around the change is outlined and paired again
 * (`replaceTops`). null when the change is not inside one rule or does not leave it one rule.
 */
export function respliced(source: SheetSource, start: number, end: number, insert: string): SheetSource | null {
  const o = source.outline;
  const k = source.topNodes.findIndex(n => o.start(n) <= start && end <= o.end(n));
  if (k < 0) return null;
  const rule = source.topRules[k] as CSSRule;
  const node = source.topNodes[k] as number;
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
 * the replaced rules: `topRules` is what tells the top-level rules from then on.
 *
 * The old source is changed in place, and gives up its `outline` and `nodes` to the new one, even
 * when null is returned: callers replace it right away and must not use it again.
 */
export function replaceTops(source: SheetSource, edits: TopEdit[]): SheetSource | null {
  const o = source.outline;
  const { topRules, topNodes } = source;
  const count = topRules.length;
  if (o.dead * 2 > o.ruleCount) return null;
  const parts: string[] = [];
  let at = 0;
  let next = 0;
  for (const e of edits) {
    const last = e.from + e.count;
    if (e.from < next || last > count || e.start < at || e.end < e.start) return null;
    const before = e.from > 0 ? (topNodes[e.from - 1] as number) : -1;
    const after = last < count ? (topNodes[last] as number) : -1;
    if ((before >= 0 && o.end(before) > e.start) || (after >= 0 ? o.start(after) < e.end : e.end > source.text.length))
      return null;
    parts.push(source.text.slice(at, e.start), e.insert);
    at = e.end;
    next = last;
  }
  parts.push(source.text.slice(at));
  const text = parts.join('');
  const result: SheetSource = {
    ...source,
    text,
    lines: replacedLines(source.lines, edits),
    topRules: [],
    topNodes: [],
  };
  // Outlined and paired first, the source moved only once they all are.
  const added: number[][] = [];
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
    added.push(e.rules.map(r => result.nodes.get(r) as number));
    delta += e.insert.length - (e.end - e.start);
  }
  delta = 0;
  let k = 0;
  const keep = (until: number) => {
    for (; k < until; k++) {
      const node = topNodes[k] as number;
      if (delta) o.shift(node, delta);
      result.topRules.push(topRules[k] as CSSRule);
      result.topNodes.push(node);
    }
  };
  edits.forEach((e, i) => {
    keep(e.from);
    for (; k < e.from + e.count; k++) {
      o.dead += o.size(topNodes[k] as number);
      forget(result.nodes, topRules[k] as CSSRule);
    }
    const nodes = added[i] ?? [];
    for (let j = 0; j < nodes.length; j++) {
      result.topRules.push(e.rules[j] as CSSRule);
      result.topNodes.push(nodes[j] as number);
    }
    delta += e.insert.length - (e.end - e.start);
  });
  keep(count);
  return result;
}

/** Drops `rule`, gone from its sheet, and the rules in it from `nodes`. */
function forget(nodes: Map<CSSRule, number>, rule: CSSRule): void {
  if (rule.parentStyleSheet) return;
  nodes.delete(rule);
  const children = childRules(rule);
  for (let i = 0; i < children.length; i++) forget(nodes, children[i] as CSSRule);
}

/** Rules that may only come first in a sheet: kept or replaced with all the others. */
const POSITIONAL = /^(?:import|namespace|charset)$/i;
/** The most insertions and deletions the rules are compared for (`commonRuns`). */
const MAX_EDITS = 1024;

/** Whether top-level rule `node` ends where a rule after it is parsed as it would be alone. */
const terminated = (text: string, o: CssOutline, node: number) =>
  o.blockStart(node) >= 0 ? o.closed(node) : text.charCodeAt(o.end(node) - 1) === 59; /* ; */

/**
 * The top-level rules of `o`, if each ends cleanly and only white space and closed comments follow
 * the last to the end of `text`: the parser is then where it was at the start, so that what would
 * come after is parsed as it would be alone. Null otherwise.
 */
function wholeRules(text: string, o: CssOutline): number[] | null {
  const nodes: number[] = [];
  let tail = 0;
  for (let n = o.firstChild(ROOT); n >= 0; n = o.next(n)) {
    if (!terminated(text, o, n)) return null;
    nodes.push(n);
    tail = o.end(n);
  }
  return CLEAN_TAIL.test(text.slice(tail)) ? nodes : null;
}

/**
 * The pairs `[i, j]` of a longest common subsequence of `a` and `b` (Myers' O((N+M)D) diff, after
 * their common start and end), in order; null when they differ by more than `MAX_EDITS`
 * insertions and deletions.
 */
export function commonRuns<T>(a: ArrayLike<T>, b: ArrayLike<T>): [number, number][] | null {
  const pairs: [number, number][] = [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pairs.push([pre, pre++]);
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n && m) {
    const max = Math.min(n + m, MAX_EDITS);
    // trace[d][k + d]: how far along `a` diagonal k reaches with d edits.
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      const prev = trace[d - 1];
      const at = (k: number) => (prev as Int32Array)[k + d - 1] as number;
      const cur = new Int32Array(2 * d + 1);
      for (let k = -d; k <= d; k += 2) {
        let x = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
        let y = x - k;
        while (x < n && y < m && a[pre + x] === b[pre + y]) {
          x++;
          y++;
        }
        cur[k + d] = x;
        if (x >= n && y >= m) {
          found = d;
          break;
        }
      }
      trace.push(cur);
    }
    if (found < 0) return null;
    const middle: [number, number][] = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
      const prev = trace[d - 1] as Int32Array;
      const at = (k: number) => prev[k + d - 1] as number;
      const k = x - y;
      const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
      const pk = down ? k + 1 : k - 1;
      const px = at(pk);
      for (const sx = down ? px : px + 1; x > sx;) middle.push([pre + --x, pre + --y]);
      x = px;
      y = px - pk;
    }
    while (x > 0) middle.push([pre + --x, pre + --y]);
    for (let i = middle.length - 1; i >= 0; i--) pairs.push(middle[i] as [number, number]);
  }
  for (let i = suf; i > 0; i--) pairs.push([a.length - i, b.length - i]);
  return pairs;
}

/** Calls `f` with `rule` and each rule in it. */
function eachRule(rule: CSSRule, f: (rule: CSSRule) => void): void {
  f(rule);
  const list = childRules(rule);
  for (let i = 0; i < list.length; i++) eachRule(list[i] as CSSRule, f);
}

/** The first of `nodes` for which `after` holds, `after` holding for all after it too. */
function search(nodes: number[], after: (node: number) => boolean): number {
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (after(nodes[mid] as number)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The source of `sheet` once its text is `text`, its CSSOM changed to the rules of that text (each
 * top-level rule inserted alone, as CSS.setStyleSheetText does) by deleting the top-level rules
 * whose text is gone and inserting those whose text is new: those whose text is the same are kept,
 * as the same objects. Undefined, the sheet left as it was, when that cannot be told: the caller
 * replaces all the rules; null when the CSSOM was changed but its new rules did not pair (the text
 * is paired anew when used).
 *
 * The top-level rules are compared by their texts (`commonRuns`), either:
 * - locally, when the text changed in one place: the paired rules the change leaves whole before
 *   and after it are kept, and the text between them, outlined alone, must be whole rules
 *   (`wholeRules`). Its records are grafted onto the outline, as `respliced` does for one rule;
 * - or over the whole text outlined anew, which must end with whole rules (not in a comment, nor
 *   in a rule left open).
 * Texts too different to compare (`commonRuns`) have all their rules replaced, as the caller
 * would, with the outline made. Neither way when a rule removed or inserted is an @import, @namespace or @charset rule, or would go
 * before one: those may only come first, and would be dropped or refused elsewhere.
 *
 * The rules kept keep their records' order and number (pre-order, those of a rule follow each
 * other), so that their pairs move by an offset. Those inserted are paired with the records they
 * were inserted from. `source` is given up as by `respliced`.
 */
export function retexted(
  sheet: CSSStyleSheet,
  source: SheetSource,
  text: string,
  rules: CSSRule[]
): SheetSource | null | undefined {
  const { outline: o, topRules, topNodes, text: old } = source;
  const count = topRules.length;
  // The pairs in the CSSOM's order: not after CSS.addRule put a rule before @namespace ones.
  if (count !== rules.length) return undefined;
  let lead = 0;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as CSSRule;
    if (topRules[i] !== rule) return undefined;
    const tag = tagOf(rule);
    if (tag === 'CSSImportRule' || tag === 'CSSNamespaceRule') lead = i + 1;
  }
  if (text === old) return source;
  const delta = text.length - old.length;

  // The common start and end of the texts, and the rules before and after the change between.
  let p = 0;
  const shortest = Math.min(old.length, text.length);
  while (p < shortest && old.charCodeAt(p) === text.charCodeAt(p)) p++;
  let s = 0;
  while (s < shortest - p && old.charCodeAt(old.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
  let a = search(topNodes, node => o.end(node) > p);
  while (a > 0 && !terminated(old, o, topNodes[a - 1] as number)) a--;
  let b = search(topNodes, node => o.start(node) >= old.length - s);
  const from = a ? o.end(topNodes[a - 1] as number) : 0;
  const slice = text.slice(from, (b < count ? o.start(topNodes[b] as number) : old.length) + delta);
  let n = o.dead * 2 > o.ruleCount ? null : outline(slice);
  let nodes = n && wholeRules(slice, n);
  const local = !!nodes;
  let newText = slice;
  if (!local) {
    n = outline(text);
    nodes = wholeRules(text, n);
    newText = text;
    [a, b] = [0, count];
  }
  if (!n || !nodes) return undefined;

  // The texts of the rules compared: slices, compared only along the way the diff takes.
  const textOf = (t: string, out: CssOutline, node: number) => t.slice(out.start(node), out.end(node));
  const before: string[] = [];
  for (let i = a; i < b; i++) before.push(textOf(old, o, topNodes[i] as number));
  const outlined = n;
  const after = nodes.map(node => textOf(newText, outlined, node));
  // Too different: all replaced, with the text's outline already made.
  const runs = commonRuns(before, after) ?? [];
  const kept = new Uint8Array(before.length);
  const same = new Uint8Array(after.length);
  for (const [i, j] of runs) {
    kept[i] = 1;
    same[j] = 1;
  }
  /** Walks the edit: `del(i)` for each rule removed, `ins(j)` inserted, `keep(i, j)`, in order. */
  const walk = (del: (i: number) => void, ins: (j: number) => void, keep: (i: number, j: number) => void) => {
    for (let i = 0, j = 0; i < before.length || j < after.length;)
      if (i < before.length && !kept[i]) del(i++);
      else if (j < after.length && !same[j]) ins(j++);
      else keep(i++, j++);
  };
  // Rules that must come first are neither removed nor inserted, nor any rule before them.
  let index = a;
  let fixed = false;
  walk(
    i => {
      if (index < lead || POSITIONAL.test(o.name(old, topNodes[a + i] as number))) fixed = true;
    },
    j => {
      if (index < lead || POSITIONAL.test(outlined.name(newText, nodes[j] as number))) fixed = true;
    },
    () => index++
  );
  if (fixed) return undefined;

  // The CSSOM: the rules removed deleted from the last, then those inserted in order, so that
  // neither moves the many rules after them (as deleting or inserting each first would).
  for (let i = before.length - 1; i >= 0; i--) if (!kept[i]) sheet.deleteRule(a + i);
  const added: (CSSRule | undefined)[] = [];
  index = a;
  for (let j = 0; j < after.length; j++) {
    if (same[j]) index++;
    else
      try {
        sheet.insertRule(textOf(newText, outlined, nodes[j] as number), index);
        added[j] = sheet.cssRules[index];
        index++;
      } catch {
        // Dropped, as the parser drops it.
      }
  }

  // The pairs: the new records grafted onto the outline when outlined alone.
  let base = 0;
  const pairs = local ? source.nodes : new Map<CSSRule, number>();
  if (local) {
    const head = nodes[0];
    if (head !== undefined) base = o.graft(outlined, head, from) - head;
    for (let i = a; i < b; i++) o.dead += o.size(topNodes[i] as number);
  }
  const segRules: CSSRule[] = [];
  const segNodes: number[] = [];
  const next: SheetSource = {
    text,
    // Only the lines between the texts' common start and end are counted again.
    lines: replacedLines(source.lines, [{ start: p, end: old.length - s, insert: text.slice(p, text.length - s) }]),
    outline: local ? o : outlined,
    nodes: pairs,
    topRules: segRules,
    topNodes: segNodes,
    namespaces: source.namespaces,
  };
  let ok = true;
  let run: CSSRule[] = [];
  let runStart = -1;
  /** Pairs the rules inserted since the last one kept with the records they were inserted from. */
  const flush = () => {
    if (ok && run.length) ok = pairList(next, (nodes[runStart] as number) + base, run, TOP, true);
    run = [];
    runStart = -1;
  };
  walk(
    // Gone, its pairs with it when they stay in the map.
    i => local && eachRule(topRules[a + i] as CSSRule, r => pairs.delete(r)),
    j => {
      if (runStart < 0) runStart = j;
      const rule = added[j];
      if (rule) run.push(rule);
    },
    (i, j) => {
      flush();
      const rule = topRules[a + i] as CSSRule;
      const node = topNodes[a + i] as number;
      const copy = (nodes[j] as number) + base;
      eachRule(rule, r => {
        const at = source.nodes.get(r);
        if (at !== undefined) pairs.set(r, at - node + copy);
      });
      segRules.push(rule);
      segNodes.push(copy);
    }
  );
  flush();
  if (!ok) return null;
  if (local) {
    for (let i = b; i < count; i++) o.shift(topNodes[i] as number, delta);
    next.topRules = topRules.slice(0, a).concat(segRules, topRules.slice(b));
    next.topNodes = topNodes.slice(0, a).concat(segNodes, topNodes.slice(b));
  }
  return next;
}
