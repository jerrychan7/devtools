import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, launch, missingFields, openPage } from './conformance.ts';
import type { Env, Side, TestPage } from './conformance.ts';

// Shared by the Animation domain's conformance tests: the browser, the helpers, Chrome's own fields.

// Ids are given in the order each side sees the animations; times depend on the frame each saw
// them in, and are checked on their own (see `timesMatchThePage`). `cssId` is a hash of Chrome's
// style data the page cannot compute.
for (const key of ['id', 'backendNodeId', 'startTime', 'currentTime', 'cssId']) VOLATILE.add(key);

export const EVENTS = [
  'Animation.animationCreated',
  'Animation.animationStarted',
  'Animation.animationUpdated',
  'Animation.animationCanceled',
] as const;

export let env: Env | undefined;
before(async () => {
  env = await launch();
});
after(() => env?.close());

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (const start = Date.now(); Date.now() - start < 5000; await sleep(20)) {
    const value = await read();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Cancels every animation of the page, in its shadow trees and same-origin iframes too, so a test
 * does not see the ones a test before it left running, then lets the cancels be reported.
 */
export async function reset(t: TestPage) {
  await t.page.evaluate(async () => {
    const walk = (root: Document | ShadowRoot) => {
      for (const animation of root.getAnimations()) animation.cancel();
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el instanceof HTMLIFrameElement && el.contentDocument) walk(el.contentDocument);
      }
    };
    walk(document);
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
  });
  for (const side of [t.chrome, t.ours]) await side.clear();
}

export let fences = 0;
/**
 * Has the page start an animation and waits until each of `sides` announces it: what the page did before
 * has been reported by then, so a test can tell that something was not, without a sleep that a
 * slow machine outruns. The animation is cancelled again; its own events carry its name.
 */
export async function fence(t: TestPage, ...sides: Side[]): Promise<void> {
  const name = `fence${++fences}`;
  await t.page.evaluate(n => {
    const div = document.body.appendChild(document.createElement('div'));
    div.animate({ opacity: [0, 1] }, 100000).id = n;
  }, name);
  for (const side of sides)
    await until(
      async () => (await side.events('Animation.animationStarted')).find(e => e.animation.name === name),
      name
    );
  // Chrome reports an update a frame or so after a start in the same frame: frames go by too.
  for (const side of sides) await settle(t, side);
  await t.page.evaluate(
    n =>
      document
        .getAnimations()
        .find(a => a.id === n)
        ?.cancel(),
    name
  );
}

/**
 * Lets the page run a few frames, then makes a round trip to `side`: its events from those frames
 * have arrived by then (for the domain disabled, where no animation of the page can be a fence).
 */
export async function settle(t: TestPage, side: Side) {
  await t.page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
  });
  await side.send('Animation.getPlaybackRate');
}

/**
 * Fields Chrome announces that we leave out, known and accepted; any other is reported. diffSubset
 * only checks the fields we send; `noneMissing` checks the other way.
 */
export const KNOWN_MISSING = new Set<string>([
  // None at present: add a field here, saying why, only when leaving it out is accepted.
]);
/** Fails if Chrome announced a field of `chrome` that `ours` lacks and KNOWN_MISSING does not list. */
export const noneMissing = (ours: unknown, chrome: unknown, what: string) =>
  assert.deepEqual(
    missingFields(ours, chrome).filter(path => !KNOWN_MISSING.has(path)),
    [],
    `${what}: fields Chrome has and we do not`
  );

/**
 * For Chrome's side (`chrome`), `time`, or `target` if `time` is up to a frame past it; for ours,
 * `time` as it is, which must be exact: Chrome's animation, paused and seeked,
 * still moves on by a frame now and then (1017 for 1000, 517 for 500: 3 runs in 15 under load).
 */
export const aFramePast = (time: number, target: number, chrome: boolean) =>
  chrome && time >= target && time - target <= 17 ? target : time;

/** The animations a side announced, by name. */
export async function started(side: Side, count: number) {
  return until(async () => {
    const list = (await side.events('Animation.animationStarted')).map(e => e.animation);
    return list.length >= count ? new Map(list.map(a => [a.name, a])) : undefined;
  }, `${count} animations`);
}

/** Adds a CSS animation, a transition and a Web Animation, each on its own element. */
export const ADD = (prefix: string) => `(() => {
  const style = document.createElement('style');
  style.textContent = '@keyframes ${prefix}k { from { left: 0 } to { left: 100px } }'
    + ' #${prefix}css { position: relative; animation: ${prefix}k 3s ease-in 0.5s infinite alternate }'
    + ' #${prefix}tr { transition: width 20s linear 0.1s; width: 10px }';
  document.head.append(style);
  const add = id => document.body.appendChild(Object.assign(document.createElement('div'), { id }));
  add('${prefix}css');
  const tr = add('${prefix}tr');
  tr.getBoundingClientRect();
  tr.style.width = '100px';
  const animation = add('${prefix}waapi').animate(
    [{ transform: 'none' }, { transform: 'scale(2)', offset: 0.3, easing: 'ease-out' }, { transform: 'scale(1)' }],
    { duration: 10000, delay: 200, endDelay: 50, iterations: 3, direction: 'alternate', fill: 'forwards' }
  );
  animation.id = '${prefix}web';
})()`;

/** Each side's play state, current time and timing of the page's animations named `name`. */
export function stateOf(t: TestPage, name: string) {
  return t.page.evaluate(
    n =>
      document
        .getAnimations()
        .filter(
          a =>
            a.id === n ||
            ('animationName' in a && a.animationName === n) ||
            ('transitionProperty' in a && a.transitionProperty === n)
        )
        .map(a => ({
          playState: a.playState,
          startTime: Number(a.startTime),
          currentTime: Number(a.currentTime),
          timing: a.effect?.getTiming(),
        })),
    name
  );
}

/** What a side reported, by kind (created, started, updated, canceled), without times. */
export async function reports(side: Side) {
  const out: string[] = [];
  for (const method of EVENTS)
    for (const e of await side.events(method)) {
      const kind = method.slice('Animation.animation'.length);
      if ('id' in e) out.push(`${kind} ${e.id}`);
      else
        out.push(`${kind} ${e.animation.id} ${e.animation.name} ${e.animation.playState} ${e.animation.playbackRate}`);
    }
  await side.clear();
  return out;
}

/** Runs `steps` against each side, on a page of its own with the domain enabled: [Chrome's, ours]. */
export async function onEachSide<T>(steps: (t: TestPage, side: Side) => Promise<T>): Promise<[T, T]> {
  const results: T[] = [];
  for (const which of ['chrome', 'ours'] as const) {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      await t[which].send('Animation.enable');
      results.push(await steps(t, t[which]));
    } finally {
      await t.page.close();
    }
  }
  const [chrome, ours] = results;
  assert.ok(chrome !== undefined && ours !== undefined);
  return [chrome, ours];
}
