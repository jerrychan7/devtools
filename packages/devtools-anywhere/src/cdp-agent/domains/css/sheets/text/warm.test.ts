// The warm-up's scheduling, with sheets and sessions stood in for: what each slice warms, with
// and without requestIdleCallback, and when it stops.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WAITS, stopWarming, warmUp } from './warm.ts';

const g = globalThis as {
  requestIdleCallback?: unknown;
  cancelIdleCallback?: unknown;
  setTimeout: unknown;
  clearTimeout: unknown;
};
const realTimers = { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout };
/** The sessions made by a test, stopped after it so that nothing it queued is left to the next. */
const sessions: Parameters<typeof stopWarming>[0][] = [];

/** A session whose sheets have the given text lengths still to check, warming each in the time
 * estimated for it; what it warmed. */
function session(cold: Map<object, number>, fail?: object) {
  const warmed: object[] = [];
  const made = {
    warmed,
    warm(sheet: CSSStyleSheet) {
      // Takes about the time estimated for it.
      const end = performance.now() + (cold.get(sheet) ?? 0) / 13000;
      while (performance.now() < end);
      warmed.push(sheet);
      cold.set(sheet, 0);
    },
    cold(sheet: CSSStyleSheet) {
      if (sheet === fail) throw new Error('cold');
      return cold.get(sheet) ?? 0;
    },
  };
  sessions.push(made);
  return made;
}
const sheet = () => ({}) as CSSStyleSheet;
/** About 1 ms of work, and 100 ms (longer than any budget). */
const SMALL = 13000;
const BIG = 1300000;

/** Idle callbacks run by hand, each given `remaining` ms. */
function idleBy(remaining: number) {
  const waiting = new Map<number, (d: { timeRemaining(): number; didTimeout: boolean }) => void>();
  let next = 0;
  g.requestIdleCallback = (cb: never) => (waiting.set(++next, cb), next);
  g.cancelIdleCallback = (id: number) => waiting.delete(id);
  return {
    waiting,
    /** Runs the callbacks waiting, those they ask for too, up to `max`; how many ran. After each,
     * `each` is called. */
    run(max = 1000, each?: () => void) {
      let ran = 0;
      while (waiting.size && ran < max) {
        const [id, cb] = waiting.entries().next().value as [number, (d: never) => void];
        waiting.delete(id);
        const end = performance.now() + remaining;
        cb({ timeRemaining: () => end - performance.now(), didTimeout: false } as never);
        ran++;
        each?.();
      }
      return ran;
    },
  };
}

/** Timers run by hand, without waiting for their delays. */
function timersByHand() {
  const waiting = new Map<number, () => void>();
  let next = 0;
  g.setTimeout = (cb: () => void) => (waiting.set(++next, cb), next);
  g.clearTimeout = (id: number) => waiting.delete(id);
  return {
    waiting,
    /** Runs the timers waiting, those they set too, up to `max`; how many ran. After each, `each`
     * is called. */
    run(max = 1000, each?: () => void) {
      let ran = 0;
      while (waiting.size && ran < max) {
        const [id, cb] = waiting.entries().next().value as [number, () => void];
        waiting.delete(id);
        cb();
        ran++;
        each?.();
      }
      return ran;
    },
  };
}

afterEach(() => {
  for (const s of sessions.splice(0)) stopWarming(s);
  delete g.requestIdleCallback;
  delete g.cancelIdleCallback;
  Object.assign(g, realTimers);
});

test('in long idle periods: small sheets in order, a big one alone', () => {
  const idle = idleBy(50);
  const [a, b, big] = [sheet(), sheet(), sheet()];
  const s = session(
    new Map<object, number>([
      [a, SMALL],
      [big, BIG],
      [b, SMALL],
    ])
  );
  warmUp(s, [a, big, b]);
  // What each slice warmed: the small ones first, the big one waiting behind them, then alone.
  const slices: object[][] = [];
  let seen = 0;
  idle.run(1000, () => {
    slices.push(s.warmed.slice(seen));
    seen = s.warmed.length;
  });
  assert.deepEqual(slices, [[a, b], [big]]);
  assert.deepEqual(s.warmed, [a, b, big]);
  assert.equal(idle.waiting.size, 0);
});

test('never a long idle period: a big sheet is let go after MAX_WAITS slices, and nothing waits', () => {
  const idle = idleBy(10);
  const [a, big] = [sheet(), sheet()];
  const s = session(
    new Map<object, number>([
      [big, BIG],
      [a, SMALL],
    ])
  );
  warmUp(s, [big, a]);
  const ran = idle.run();
  assert.deepEqual(s.warmed, [a]);
  // It waited through every slice, each one counted.
  assert.equal(ran, MAX_WAITS);
  assert.equal(idle.waiting.size, 0);
});

test('idle periods never long enough for a sheet within the budget: it is let go after MAX_WAITS slices', () => {
  // 2 ms each, as on a page busy every frame; the sheet is about 4 ms of work.
  const idle = idleBy(2);
  const mid = sheet();
  const s = session(new Map([[mid, SMALL * 4]]));
  warmUp(s, [mid]);
  const ran = idle.run();
  assert.deepEqual(s.warmed, []);
  assert.equal(ran, MAX_WAITS);
  assert.equal(idle.waiting.size, 0);
});

test('a session that has nothing to do for a sheet leaves it to another waiting', () => {
  const idle = idleBy(50);
  const x = sheet();
  const done = session(new Map());
  const other = session(new Map([[x, SMALL]]));
  warmUp(done, [x]);
  warmUp(other, [x]);
  idle.run();
  assert.deepEqual([done.warmed, other.warmed], [[], [x]]);
});

test('a sheet that throws is let go, the others still warmed', () => {
  const idle = idleBy(50);
  const [bad, a] = [sheet(), sheet()];
  const s = session(
    new Map<object, number>([
      [bad, SMALL],
      [a, SMALL],
    ]),
    bad
  );
  warmUp(s, [bad, a]);
  idle.run();
  assert.deepEqual(s.warmed, [a]);
  assert.equal(idle.waiting.size, 0);
});

test('stopWarming cancels the idle callback once no session waits', () => {
  const idle = idleBy(50);
  const x = sheet();
  const s = session(new Map([[x, SMALL]]));
  warmUp(s, [x]);
  assert.equal(idle.waiting.size, 1);
  stopWarming(s);
  assert.equal(idle.waiting.size, 0);
  assert.deepEqual(s.warmed, []);
});

test('stopWarming one session keeps the sheets another waits for, warmed once', () => {
  const idle = idleBy(50);
  const [x, y] = [sheet(), sheet()];
  // The sessions share the texts, as they do: what one warms is no longer cold for the other.
  const cold = new Map<object, number>([
    [x, SMALL],
    [y, SMALL],
  ]);
  const stopped = session(cold);
  const other = session(cold);
  warmUp(stopped, [x, y]);
  warmUp(other, [x]);
  stopWarming(stopped);
  assert.equal(idle.waiting.size, 1);
  idle.run();
  assert.deepEqual([stopped.warmed, other.warmed], [[], [x]]);
  assert.equal(idle.waiting.size, 0);
});

test('without requestIdleCallback: slices of the budget, a big sheet let go after MAX_WAITS of them', () => {
  const timers = timersByHand();
  const sheets = Array.from({ length: 12 }, sheet);
  const s = session(new Map(sheets.map(x => [x, SMALL] as [object, number])));
  const big = sheet();
  const b = session(new Map([[big, BIG]]));
  warmUp(s, sheets);
  warmUp(b, [big]);
  assert.equal(timers.waiting.size, 1);
  // A slice takes at most 8 sheets of at least 1 ms each: the first leaves some, later ones the rest.
  timers.run(1);
  assert.ok(s.warmed.length >= 1 && s.warmed.length < 12, String(s.warmed.length));
  const ran = timers.run();
  assert.equal(s.warmed.length, 12);
  // The big sheet is never warmed without idle periods: let go, and no timer is left set.
  assert.deepEqual(b.warmed, []);
  assert.ok(ran >= MAX_WAITS - 1 && ran < MAX_WAITS + 12, String(ran));
  assert.equal(timers.waiting.size, 0);
});
