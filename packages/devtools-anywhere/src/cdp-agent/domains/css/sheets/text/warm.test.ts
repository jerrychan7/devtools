// The warm-up's scheduling, with sheets and sessions stood in for: what each slice warms, with
// and without requestIdleCallback, and when it stops.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WAITS, stopWarming, warmUp } from './warm.ts';

const g = globalThis as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };

/** A session whose sheets have the given text lengths still to check, warming each in the time
 * estimated for it; what it warmed. */
function session(cold: Map<object, number>, fail?: object) {
  const warmed: object[] = [];
  return {
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
    /** Runs the callbacks waiting, those they ask for too, up to `max`; how many ran. */
    run(max = 1000) {
      let ran = 0;
      while (waiting.size && ran < max) {
        const [id, cb] = waiting.entries().next().value as [number, (d: never) => void];
        waiting.delete(id);
        const end = performance.now() + remaining;
        cb({ timeRemaining: () => end - performance.now(), didTimeout: false } as never);
        ran++;
      }
      return ran;
    },
  };
}

afterEach(() => {
  delete g.requestIdleCallback;
  delete g.cancelIdleCallback;
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
  idle.run();
  assert.deepEqual(new Set(s.warmed), new Set([a, b, big]));
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
  assert.ok(ran <= MAX_WAITS + 1, String(ran));
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
  const s = session(new Map([[sheet(), SMALL]]));
  const x = sheet();
  warmUp(s, [x]);
  assert.equal(idle.waiting.size, 1);
  stopWarming(s);
  assert.equal(idle.waiting.size, 0);
});

test('without requestIdleCallback: slices of the budget timed from when they run', async () => {
  const sheets = Array.from({ length: 12 }, sheet);
  const s = session(new Map(sheets.map(x => [x, SMALL] as [object, number])));
  const big = sheet();
  const b = session(new Map([[big, BIG]]));
  warmUp(s, sheets);
  warmUp(b, [big]);
  // A slice takes about 8 sheets of 1 ms each: two slices, 50 ms apart.
  await new Promise(r => setTimeout(r, 70));
  assert.ok(s.warmed.length >= 1 && s.warmed.length < 12, String(s.warmed.length));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(s.warmed.length, 12);
  // The big sheet is never warmed without idle periods: let go after MAX_WAITS slices.
  await new Promise(r => setTimeout(r, 50 * (MAX_WAITS + 2)));
  assert.deepEqual(b.warmed, []);
  stopWarming(s);
  stopWarming(b);
});
