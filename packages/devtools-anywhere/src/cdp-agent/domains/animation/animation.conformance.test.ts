import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, diffSubset, launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';
import type { Protocol } from 'devtools-protocol';

// Ids are given in the order each side sees the animations; times depend on the frame each saw
// them in. `cssId` is a hash of Chrome's style data the page cannot compute.
for (const key of ['id', 'backendNodeId', 'startTime', 'currentTime', 'cssId']) VOLATILE.add(key);

const EVENTS = [
  'Animation.animationCreated',
  'Animation.animationStarted',
  'Animation.animationUpdated',
  'Animation.animationCanceled',
] as const;

let env: Env | undefined;
before(async () => {
  env = await launch();
});
after(() => env?.close());

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (const start = Date.now(); Date.now() - start < 5000; await sleep(20)) {
    const value = await read();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The animations a side announced, by name. */
async function started(side: Side, count: number) {
  return until(async () => {
    const list = (await side.events('Animation.animationStarted')).map(e => e.animation);
    return list.length >= count ? new Map(list.map(a => [a.name, a])) : undefined;
  }, `${count} animations`);
}

/** Adds a CSS animation, a transition and a Web Animation, each on its own element. */
const ADD = (prefix: string) => `(() => {
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
function stateOf(t: TestPage, name: string) {
  return t.page.evaluate(
    n =>
      document
        .getAnimations()
        .filter(a => a.id === n || ('animationName' in a && a.animationName === n))
        .map(a => ({ playState: a.playState, currentTime: Number(a.currentTime), timing: a.effect?.getTiming() })),
    name
  );
}

describe('Animation', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
  });

  test('animations running before enable are announced on enable', async () => {
    await t.page.evaluate(() => {
      const div = document.body.appendChild(document.createElement('div'));
      div.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: 2 }).id = 'early';
    });
    for (const side of [t.chrome, t.ours]) await side.send('Animation.enable');
    const [chrome, ours] = [await started(t.chrome, 1), await started(t.ours, 1)];
    assert.deepEqual(diffSubset(ours.get('early'), chrome.get('early')), []);
    assert.equal((await t.ours.events('Animation.animationCreated')).length, 1);
  });

  test('CSS animations, transitions and Web Animations match Chrome', async () => {
    for (const side of [t.chrome, t.ours]) await side.clear();
    await t.page.evaluate(ADD('a'));
    const [chrome, ours] = [await started(t.chrome, 3), await started(t.ours, 3)];
    for (const name of ['ak', 'width', 'aweb']) {
      const own = ours.get(name);
      assert.ok(own, `missing ${name}`);
      assert.deepEqual(diffSubset(own, chrome.get(name)), [], name);
      assert.equal('keyframesRule' in (own.source ?? {}), 'keyframesRule' in (chrome.get(name)?.source ?? {}), name);
    }
    assert.equal(ours.get('ak')?.source?.iterations, undefined, 'infinite iterations are left out');
    assert.equal((await t.ours.events('Animation.animationCreated')).length, 3);
  });

  test('seeking announces a new start time only for a running animation, as in Chrome', async () => {
    const results: Record<string, unknown> = {};
    for (const side of [t.chrome, t.ours]) {
      await t.page.evaluate(() => document.getAnimations().forEach(a => a.cancel()));
      await side.clear();
      const prefix = side === t.chrome ? 's' : 'q';
      await t.page.evaluate(ADD(prefix));
      const animation = (await started(side, 3)).get(`${prefix}k`);
      assert.ok(animation);
      const ids = [animation.id];
      const updates = async () => {
        await sleep(300);
        const list = (await side.events('Animation.animationUpdated')).map(e => e.animation.playState);
        await side.clear();
        return list;
      };
      await sleep(300);
      await side.clear();
      await side.send('Animation.seekAnimations', { animations: ids, currentTime: 0 });
      const running = await updates();
      await side.send('Animation.setPaused', { animations: ids, paused: true });
      await updates();
      await side.send('Animation.seekAnimations', { animations: ids, currentTime: 100 });
      const paused = await updates();
      results[side === t.chrome ? 'chrome' : 'ours'] = { running, paused };
    }
    assert.deepEqual(results['chrome'], { running: ['running'], paused: [] });
    assert.deepEqual(results['ours'], results['chrome']);
  });

  test('seeking each animation to its own time, and the errors, match Chrome', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await t.page.evaluate(() => document.getAnimations().forEach(a => a.cancel()));
      await side.clear();
      const prefix = side === t.chrome ? 'm' : 'n';
      await t.page.evaluate(ADD(prefix));
      const all = await started(side, 3);
      const names = [`${prefix}k`, `${prefix}web`];
      const ids = names.map(n => all.get(n)?.id ?? '');
      await side.send('Animation.setPaused', { animations: ids, paused: true });
      await side.send('Animation.seekAnimations', { animations: ids, currentTimes: [700, 1500] });
      const times = [];
      for (const name of names) times.push((await stateOf(t, name)).map(s => Math.round(s.currentTime)));
      const error = (params: Omit<Protocol.Animation.SeekAnimationsRequest, 'animations'>) =>
        side.send('Animation.seekAnimations', { animations: ids, ...params }).then(
          () => 'none',
          (e: unknown) => (e instanceof Error ? e.message.replace(/^.*\): /, '') : String(e))
        );
      results.push({
        times,
        neither: await error({}),
        both: await error({ currentTime: 1, currentTimes: [1, 1] }),
        short: await error({ currentTimes: [1] }),
      });
    }
    // Chrome 156 takes `currentTimes` as seconds (700 → 700000 ms; the Web Animation, 1500 s, ends at
    // 30250 ms), against the protocol and its own source, which say milliseconds; the panel sends
    // milliseconds, so its scrubber only works with milliseconds. The errors are Chrome's.
    const [chrome, ours] = results;
    assert.deepEqual({ ...Object(ours), times: [[700], [1500]] }, ours);
    assert.deepEqual({ ...Object(chrome), times: Object(ours).times }, ours);
  });

  test('animations in shadow trees are announced, as in Chrome', async () => {
    for (const side of [t.chrome, t.ours]) await side.clear();
    await t.page.evaluate(() => {
      const host = document.body.appendChild(document.createElement('div'));
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>@keyframes sk { 50% { opacity: 0.5 } } p { animation: sk 0.4s infinite }</style><p>x</p>';
    });
    const [chrome, ours] = [await started(t.chrome, 1), await started(t.ours, 1)];
    assert.ok(chrome.get('sk'), 'Chrome announces it');
    assert.deepEqual(diffSubset(ours.get('sk'), chrome.get('sk')), []);
  });

  test('pausing, seeking, timing and releasing do what they do in Chrome', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await side.clear();
      await t.page.evaluate(() => document.getAnimations().forEach(a => a.cancel()));
      await side.clear();
      const prefix = side === t.chrome ? 'c' : 'o';
      await t.page.evaluate(ADD(prefix));
      const animation = (await started(side, 3)).get(`${prefix}web`);
      assert.ok(animation);
      const ids = [animation.id];
      const name = `${prefix}web`;
      await side.send('Animation.setPaused', { animations: ids, paused: true });
      const paused = await stateOf(t, name);
      await side.send('Animation.seekAnimations', { animations: ids, currentTime: 1000 });
      const { currentTime } = await side.send('Animation.getCurrentTime', { id: animation.id });
      await side.send('Animation.setTiming', { animationId: animation.id, duration: 5000, delay: 10 });
      const timed = await stateOf(t, name);
      await side.send('Animation.setPaused', { animations: ids, paused: false });
      const resumed = await stateOf(t, name);
      await side.send('Animation.releaseAnimations', { animations: ids });
      const releasedError = await side.send('Animation.getCurrentTime', { id: animation.id }).then(
        () => 'none',
        () => 'error'
      );
      const { remoteObject } = await side.send('Animation.resolveAnimation', {
        animationId: (await started(side, 3)).get(`${prefix}k`)?.id ?? '',
      });
      await sleep(100);
      results.push({
        paused: paused.map(s => s.playState),
        // Chrome reads one frame later than it seeked to.
        seeked: Math.abs(currentTime - 1000) < 40,
        timing: timed.map(s => [s.playState, s.timing?.duration, s.timing?.delay]),
        resumed: resumed.map(s => s.playState),
        releasedError,
        className: remoteObject.className,
        // The domain's own changes are no updates.
        updated: (await side.events('Animation.animationUpdated')).length,
      });
    }
    assert.deepEqual(results[1], results[0]);
  });

  test('the playback rate slows the animations down until disable', async () => {
    const elapsed: number[][] = [];
    for (const side of [t.chrome, t.ours]) {
      await side.send('Animation.enable');
      const before = await t.page.evaluate(() => document.getAnimations().map(a => Number(a.currentTime)));
      await side.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
      assert.deepEqual(await side.send('Animation.getPlaybackRate'), { playbackRate: 0.1 });
      await sleep(500);
      const after = await t.page.evaluate(() => document.getAnimations().map(a => Number(a.currentTime)));
      await side.send('Animation.disable');
      assert.deepEqual(await side.send('Animation.getPlaybackRate'), { playbackRate: 1 });
      elapsed.push(after.map((t, i) => t - (before[i] ?? 0)));
    }
    for (const list of elapsed)
      for (const ms of list) assert.ok(ms < 150, `advanced ${ms}ms in 500ms at 10%: ${JSON.stringify(elapsed)}`);
  });

  test('the page finishing or cancelling an animation is reported, pausing it is not', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await side.send('Animation.enable');
      await side.clear();
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 10000);
        animation.id = 'short';
        Reflect.set(window, '__short', animation);
      });
      const created = await until(
        async () => (await side.events('Animation.animationStarted')).find(e => e.animation.name === 'short'),
        'the short animation'
      );
      await side.clear();
      await t.page.evaluate(() => (Reflect.get(window, '__short') as Animation).pause());
      await sleep(200);
      const afterPause = (await side.events('Animation.animationUpdated')).length;
      await t.page.evaluate(() => (Reflect.get(window, '__short') as Animation).finish());
      const updated = await until(
        async () =>
          (await side.events('Animation.animationUpdated')).find(
            (e: Protocol.Animation.AnimationUpdatedEvent) => e.animation.id === created.animation.id
          ),
        `the finish (${side === t.chrome ? 'Chrome' : 'ours'})`
      );
      await t.page.evaluate(() => (Reflect.get(window, '__short') as Animation).cancel());
      const canceled = await until(
        async () => (await side.events('Animation.animationCanceled')).find(e => e.id === created.animation.id),
        'the cancel'
      );
      results.push({ afterPause, playState: updated.animation.playState, canceled: !!canceled });
      await side.send('Animation.disable');
    }
    assert.deepEqual(results[1], results[0]);
  });

  test('unknown ids fail as in Chrome', async () => {
    const messages: string[][] = [];
    for (const side of [t.chrome, t.ours]) {
      await side.send('Animation.enable');
      const fail = (p: Promise<unknown>) =>
        p.then(
          () => 'no error',
          (e: unknown) =>
            (e instanceof Error ? e.message : String(e)).replace(/^Protocol error \([^)]*\): /, '').split('\n')[0] ?? ''
        );
      messages.push([
        await fail(side.send('Animation.getCurrentTime', { id: 'nope' })),
        await fail(side.send('Animation.setPaused', { animations: ['nope'], paused: true })),
        await fail(side.send('Animation.seekAnimations', { animations: ['nope'], currentTime: 1 })),
        await fail(side.send('Animation.setTiming', { animationId: 'nope', duration: 1, delay: 1 })),
        await fail(side.send('Animation.resolveAnimation', { animationId: 'nope' })),
        await fail(side.send('Animation.releaseAnimations', { animations: ['nope'] })),
      ]);
      await side.send('Animation.disable');
    }
    assert.deepEqual(messages[1], messages[0]);
  });
});
