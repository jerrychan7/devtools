// Warming up the sheets' texts while the page is idle: the check and pairing a text needs at its
// first use (`SheetTexts.source`) done ahead, a few milliseconds at a time, so that the first
// CSS.getMatchedStylesForNode or getStyleSheetText does not wait for them. Shared by every
// session, as the texts are: a sheet several sessions wait for is warmed once.

/** What one slice may take, in ms, before giving the page its turn back. */
export const WARM_BUDGET = 8;
/**
 * The time left in an idle period from which a sheet longer than the budget alone is warmed: the
 * longest idle periods are 50 ms, given when nothing else is to be done.
 */
const LONG_IDLE = 40;
/** About what checking and pairing a text costs, in ms per UTF-16 code unit (75 µs a KB, M2). */
const MS_PER_UNIT = 1 / 13000;

interface Warmer {
  /** Checks and pairs the sheet's text, if the sheet is still the session's. */
  warm(sheet: CSSStyleSheet): void;
  /** The length of the text still to check or pair, 0 if none. */
  cold(sheet: CSSStyleSheet): number;
}

/** The sheets to warm, in order, with the sessions waiting for each. */
const queue = new Map<CSSStyleSheet, Set<Warmer>>();
let scheduled: (() => void) | null = null;

interface Deadline {
  timeRemaining(): number;
}

function schedule(): void {
  if (scheduled || !queue.size) return;
  const idle = (globalThis as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle(slice);
    scheduled = () => cancelIdleCallback(handle);
  } else {
    // Without idle callbacks: a slice every so often, given what an idle period would be.
    const start = performance.now();
    const handle = setTimeout(() => slice({ timeRemaining: () => 50 - (performance.now() - start) }), 50);
    scheduled = () => clearTimeout(handle);
  }
}

/**
 * Warms sheets in order until the budget is spent. One estimated longer than the budget is
 * warmed alone, in a long idle period; until then it waits at the end of the queue, the others
 * going first.
 */
function slice(deadline: Deadline): void {
  scheduled = null;
  const start = performance.now();
  const budget = Math.min(WARM_BUDGET, Math.max(0, deadline.timeRemaining()));
  let first = true;
  for (let n = queue.size; n > 0 && queue.size; n--) {
    const [sheet, warmers] = queue.entries().next().value as [CSSStyleSheet, Set<Warmer>];
    queue.delete(sheet);
    const warmer = warmers.values().next().value as Warmer;
    const cold = warmer.cold(sheet);
    if (!cold) continue;
    const elapsed = performance.now() - start;
    const cost = cold * MS_PER_UNIT;
    const fits = elapsed + cost <= budget;
    const alone = first && cost > WARM_BUDGET && deadline.timeRemaining() >= LONG_IDLE;
    if (!fits && !alone) {
      queue.set(sheet, warmers);
      if (elapsed >= budget) break;
      continue;
    }
    first = false;
    try {
      warmer.warm(sheet);
    } catch {
      // Left to its first use, which reports what went wrong.
    }
    if (alone || performance.now() - start >= budget) break;
  }
  schedule();
}

/** Queues `sheets` to warm for `warmer`, in order, while the page is idle. */
export function warmUp(warmer: Warmer, sheets: Iterable<CSSStyleSheet>): void {
  for (const sheet of sheets) {
    let warmers = queue.get(sheet);
    if (!warmers) queue.set(sheet, (warmers = new Set()));
    warmers.add(warmer);
  }
  schedule();
}

/** Stops warming for `warmer` (its session disabled CSS): sheets no other session waits for are let go. */
export function stopWarming(warmer: Warmer): void {
  for (const [sheet, warmers] of queue) {
    warmers.delete(warmer);
    if (!warmers.size) queue.delete(sheet);
  }
  if (!queue.size) {
    scheduled?.();
    scheduled = null;
  }
}
