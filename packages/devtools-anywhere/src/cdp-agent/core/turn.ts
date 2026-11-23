/**
 * The turn of the page's script that the agent's writes into the page are made in, and the frames a write waits
 * for. A page may answer a write of the agent's with a change of its own in the same turn (a mutation observer
 * that puts back what it had, or adds something for each change it sees), which the agent's observer would answer
 * in turn, for ever: the emulation's rewrites of attributes (domains/emulation/rewrite/rewrite.ts) and its scans of new
 * elements (domains/emulation/inject/inject.ts) tell such answers by the turn, and wait for frames before they write
 * again.
 *
 * The frames, timers and clock are the probe's (windowOf), not the page's: a page may replace them (a fake clock,
 * say), and the agent's own frames and timers must not be the page's to see or to run.
 */
import { windowOf } from './natives';

/**
 * A timer closes the turn, so one task's writes share it. The page can clear that timer (a loop over timer ids
 * clears it too), so a turn also ends TURN_MAX ms after it began: the page's later changes are then not taken for
 * answers in it, for ever.
 */
let turnOpen = false;
let turnNo = 0;
let turnBegan = 0;
const TURN_MAX = 1000;

/** Whether the turn `turnNo` is open: its timer has not run, and it has not lasted TURN_MAX ms. */
const turnIsOpen = (): boolean => turnOpen && windowOf().now() - turnBegan < TURN_MAX;

/** Calls `fn` in a microtask, as the probe took it (natives). */
export const queue = (fn: () => void): void => void Reflect.apply(windowOf().microtask, globalThis, [fn]);

/** Calls `fn` in a task of its own, as soon as one runs: a timer of no delay, as the probe took it (natives). */
export const task = (fn: () => void): void => void Reflect.apply(windowOf().timeout, globalThis, [fn, 0]);

/** Closes the turn `no`, if that is still the open one: a timer of an earlier turn does not close a later one. */
const closeTurn = (no: number) => {
  if (!turnOpen || no !== turnNo) return;
  turnOpen = false;
  turnNo++;
};

/** The turn a write of the agent's is made in now: the open one, or a new one, which this opens. */
export function turnOf(): number {
  if (!turnIsOpen()) {
    // A turn still marked open here has run past TURN_MAX, its timer cleared by the page or not yet run: its writes are
    // not answers in the new turn.
    if (turnOpen) turnNo++;
    turnOpen = true;
    turnBegan = windowOf().now();
    const no = turnNo;
    // The timer is queued by a microtask, which runs after the page's observers have run their callbacks in this
    // checkpoint: a timer one of them queues then comes before the close, whichever observer was made first.
    queue(() => task(() => closeTurn(no)));
  }
  return turnNo;
}

/** Whether `turn`, the turn of a write (turnOf), is still open: a change of the page now answers that write. */
export const inTurn = (turn: number): boolean => turnIsOpen() && turn === turnNo;

/** Calls `fn` at the next frame, or after 50 ms where frames do not come (a page in the background). */
function nextFrame(fn: () => void): void {
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    fn();
  };
  Reflect.apply(windowOf().raf, globalThis, [run]);
  Reflect.apply(windowOf().timeout, globalThis, [run, 50]);
}

/** Calls `fn` after `frames` frames. */
export function afterFrames(frames: number, fn: () => void): void {
  if (frames <= 1) nextFrame(fn);
  else nextFrame(() => afterFrames(frames - 1, fn));
}

/** The most frames a write waits for a page that keeps answering it. */
export const MAX_WAIT = 64;
