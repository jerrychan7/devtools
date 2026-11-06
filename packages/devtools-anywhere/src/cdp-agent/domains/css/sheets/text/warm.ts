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
/**
 * How many slices a sheet longer than the budget may wait for a long idle period: past that it is
 * let go, left to its first use, so that a page never idle that long is not woken up for nothing.
 */
export const MAX_WAITS = 20;
/** Without requestIdleCallback: the delay between slices, in ms. */
const FALLBACK_DELAY = 50;
/** About what checking and pairing a text costs, in ms per UTF-16 code unit (75 µs a KB, M2). */
const MS_PER_UNIT = 1 / 13000;

interface Warmer {
  /** Checks and pairs the sheet's text, if the sheet is still the session's. */
  warm(sheet: CSSStyleSheet): void;
  /** The length of the text still to check or pair, 0 if none. */
  cold(sheet: CSSStyleSheet): number;
}

interface Waiting {
  /** The sessions waiting for the sheet. */
  warmers: Set<Warmer>;
  /** The slices it waited through for a long idle period. */
  waits: number;
}

/** The sheets to warm, in order. */
const queue = new Map<CSSStyleSheet, Waiting>();
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
    // Without idle callbacks, idle time cannot be told: a slice of the budget now and then, timed
    // from when it runs, and no sheet longer than the budget (those wait, then are let go).
    const handle = setTimeout(() => {
      const start = performance.now();
      slice({ timeRemaining: () => WARM_BUDGET - (performance.now() - start) });
    }, FALLBACK_DELAY);
    scheduled = () => clearTimeout(handle);
  }
}

/** The length still to check or pair for one of the sessions waiting, with that session. */
function coldest(sheet: CSSStyleSheet, warmers: Set<Warmer>): [number, Warmer | null] {
  for (const warmer of warmers) {
    const cold = warmer.cold(sheet);
    if (cold) return [cold, warmer];
  }
  return [0, null];
}

/**
 * Warms sheets in order until the budget is spent. One estimated longer than the budget is
 * warmed alone, in a long idle period; until then it waits at the end of the queue, the others
 * going first, and after MAX_WAITS slices it is let go.
 */
function slice(deadline: Deadline): void {
  scheduled = null;
  try {
    const start = performance.now();
    const budget = Math.min(WARM_BUDGET, Math.max(0, deadline.timeRemaining()));
    let first = true;
    for (let n = queue.size; n > 0 && queue.size; n--) {
      const [sheet, waiting] = queue.entries().next().value as [CSSStyleSheet, Waiting];
      queue.delete(sheet);
      try {
        const [cold, warmer] = coldest(sheet, waiting.warmers);
        if (!warmer) continue;
        const elapsed = performance.now() - start;
        const cost = cold * MS_PER_UNIT;
        const fits = elapsed + cost <= budget;
        const alone = first && cost > WARM_BUDGET && deadline.timeRemaining() >= LONG_IDLE;
        if (!fits && !alone) {
          if (cost > WARM_BUDGET && ++waiting.waits >= MAX_WAITS) continue;
          queue.set(sheet, waiting);
          if (elapsed >= budget) break;
          continue;
        }
        first = false;
        warmer.warm(sheet);
        if (alone || performance.now() - start >= budget) break;
      } catch {
        // Let go: left to its first use, which reports what went wrong.
      }
    }
  } finally {
    schedule();
  }
}

/** Queues `sheets` to warm for `warmer`, in order, while the page is idle. */
export function warmUp(warmer: Warmer, sheets: Iterable<CSSStyleSheet>): void {
  for (const sheet of sheets) {
    let waiting = queue.get(sheet);
    if (!waiting) queue.set(sheet, (waiting = { warmers: new Set(), waits: 0 }));
    waiting.warmers.add(warmer);
  }
  schedule();
}

/** Stops warming for `warmer` (its session disabled CSS): sheets no other session waits for are let go. */
export function stopWarming(warmer: Warmer): void {
  for (const [sheet, waiting] of queue) {
    waiting.warmers.delete(warmer);
    if (!waiting.warmers.size) queue.delete(sheet);
  }
  if (!queue.size) {
    scheduled?.();
    scheduled = null;
  }
}
