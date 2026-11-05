import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, diffSubset, launch, missingFields, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';
import type { Protocol } from 'devtools-protocol';

// Ids are given in the order each side sees the animations; times depend on the frame each saw
// them in, and are checked on their own (see `timesMatchThePage`). `cssId` is a hash of Chrome's
// style data the page cannot compute.
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

/**
 * Cancels every animation of the page, in its shadow trees and same-origin iframes too, so a test
 * does not see the ones a test before it left running, then lets the cancels be reported.
 */
async function reset(t: TestPage) {
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

let fences = 0;
/**
 * Has the page start an animation and waits until each of `sides` announces it: what the page did before
 * has been reported by then, so a test can tell that something was not, without a sleep that a
 * slow machine outruns. The animation is cancelled again; its own events carry its name.
 */
async function fence(t: TestPage, ...sides: Side[]): Promise<void> {
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
async function settle(t: TestPage, side: Side) {
  await t.page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
  });
  await side.send('Animation.getPlaybackRate');
}

/**
 * Fields Chrome announces that we leave out, known and accepted; any other is reported. diffSubset
 * only checks the fields we send; `noneMissing` checks the other way.
 */
const KNOWN_MISSING = new Set<string>([
  // None at present: add a field here, saying why, only when leaving it out is accepted.
]);
/** Fails if Chrome announced a field of `chrome` that `ours` lacks and KNOWN_MISSING does not list. */
const noneMissing = (ours: unknown, chrome: unknown, what: string) =>
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
const aFramePast = (time: number, target: number, chrome: boolean) =>
  chrome && time >= target && time - target <= 17 ? target : time;

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

describe('Animation', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
  });

  /** The play states of the `Animation.animationUpdated` events `side` sent for the animation `id`. */
  const updatesOf = async (side: Side, id: string) =>
    (await side.events('Animation.animationUpdated'))
      .filter(e => e.animation.id === id)
      .map(e => e.animation.playState);

  test('animations running before enable are announced on enable', async () => {
    await reset(t);
    await t.page.evaluate(() => {
      const div = document.body.appendChild(document.createElement('div'));
      div.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: 2 }).id = 'early';
    });
    for (const side of [t.chrome, t.ours]) await side.send('Animation.enable');
    const [chrome, ours] = [await started(t.chrome, 1), await started(t.ours, 1)];
    assert.deepEqual(diffSubset(ours.get('early'), chrome.get('early')), []);
    noneMissing(ours.get('early'), chrome.get('early'), 'early');
    await fence(t, t.chrome, t.ours);
    const created = async (side: Side) => (await side.events('Animation.animationCreated')).length;
    assert.equal(await created(t.ours), await created(t.chrome));
  });

  test('CSS animations, transitions and Web Animations match Chrome', async () => {
    await reset(t);
    await t.page.evaluate(ADD('a'));
    const [chrome, ours] = [await started(t.chrome, 3), await started(t.ours, 3)];
    for (const name of ['ak', 'width', 'aweb']) {
      const own = ours.get(name);
      assert.ok(own, `missing ${name}`);
      assert.deepEqual(diffSubset(own, chrome.get(name)), [], name);
      noneMissing(own, chrome.get(name), name);
      assert.equal('keyframesRule' in (own.source ?? {}), 'keyframesRule' in (chrome.get(name)?.source ?? {}), name);
      // The times left out above: Chrome's start time is the page's, and an animation is announced
      // at its start (Chrome: at 0; we see it a frame later).
      const [page] = await stateOf(t, name);
      assert.ok(page, name);
      for (const [side, animation] of [
        ['Chrome', chrome.get(name)],
        ['ours', own],
      ] as const) {
        assert.equal(typeof animation?.startTime, 'number', `${side} ${name}`);
        assert.equal(typeof animation?.currentTime, 'number', `${side} ${name}`);
        assert.ok(
          Math.abs(Number(animation?.startTime) - page.startTime) < 1,
          `${side} ${name} starts at the page's time`
        );
        assert.ok(Number(animation?.currentTime) >= 0 && Number(animation?.currentTime) < 50, `${side} ${name}`);
      }
    }
    assert.equal(ours.get('ak')?.source?.iterations, undefined, 'infinite iterations are left out');
    await fence(t, t.chrome, t.ours);
    // Less the fence.
    const created = async (side: Side) => (await side.events('Animation.animationCreated')).length - 1;
    assert.equal(await created(t.ours), await created(t.chrome));
    assert.equal(await created(t.ours), 3);
  });

  test('seeking announces a new start time only for a running animation, as in Chrome', async () => {
    const results: Record<string, unknown> = {};
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
      const prefix = side === t.chrome ? 's' : 'q';
      await t.page.evaluate(ADD(prefix));
      const animation = (await started(side, 3)).get(`${prefix}k`);
      assert.ok(animation);
      const ids = [animation.id];
      /** The animation's play states in its updates, once `count` have come and then a fence. */
      const updates = async (count: number) => {
        await until(async () => {
          const list = await updatesOf(side, animation.id);
          return list.length >= count ? list : undefined;
        }, `${count} updates`);
        await fence(t, side);
        const list = await updatesOf(side, animation.id);
        await side.clear();
        return list;
      };
      await fence(t, side);
      await side.clear();
      await side.send('Animation.seekAnimations', { animations: ids, currentTime: 0 });
      const running = await updates(1);
      await side.send('Animation.setPaused', { animations: ids, paused: true });
      await fence(t, side);
      await side.clear();
      await side.send('Animation.seekAnimations', { animations: ids, currentTime: 100 });
      // The page then plays it, which Chrome reports: an update for the seek would come before.
      await t.page.evaluate(n => {
        for (const a of document.getAnimations()) if ('animationName' in a && a.animationName === n) a.play();
      }, `${prefix}k`);
      const paused = await updates(1);
      results[side === t.chrome ? 'chrome' : 'ours'] = { running, paused };
    }
    assert.deepEqual(results['chrome'], { running: ['running'], paused: ['running'] });
    assert.deepEqual(results['ours'], results['chrome']);
  });

  test('seeking each animation to its own time, and the errors, match Chrome', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
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

  test('a transition is paused and seeked as in Chrome', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
      const prefix = side === t.chrome ? 'x' : 'y';
      await t.page.evaluate(ADD(prefix));
      const id = (await started(side, 3)).get('width')?.id;
      assert.ok(id);
      await side.send('Animation.setPaused', { animations: [id], paused: true });
      await side.send('Animation.seekAnimations', { animations: [id], currentTime: 500 });
      const [state] = await stateOf(t, 'width');
      results.push([state?.playState, aFramePast(Math.round(Number(state?.currentTime)), 500, side === t.chrome)]);
    }
    assert.deepEqual(results[0], ['paused', 500]);
    assert.deepEqual(results[1], results[0]);
  });

  test('animations in shadow trees are announced, as in Chrome', async () => {
    await reset(t);
    await t.page.evaluate(() => {
      const host = document.body.appendChild(document.createElement('div'));
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>@keyframes sk { 50% { opacity: 0.5 } } p { animation: sk 0.4s infinite }</style><p>x</p>';
    });
    const [chrome, ours] = [await started(t.chrome, 1), await started(t.ours, 1)];
    assert.ok(chrome.get('sk'), 'Chrome announces it');
    assert.deepEqual(diffSubset(ours.get('sk'), chrome.get('sk')), []);
    noneMissing(ours.get('sk'), chrome.get('sk'), 'sk');
  });

  /** A shadow tree's style sheet that animates its <p>s with `name`. */
  const SHADOW = (name: string) =>
    `<style>@keyframes ${name} { 50% { opacity: 0.5 } } p { animation: ${name} 0.4s infinite }</style><p>x</p>`;

  /** Has the page run `script`, then checks both sides announce the animation `name`. */
  async function announced(script: string, name: string) {
    await reset(t);
    await t.page.evaluate(script);
    const [chrome, ours] = [await started(t.chrome, 1), await started(t.ours, 1)];
    assert.ok(chrome.get(name), 'Chrome announces it');
    assert.ok(ours.get(name), `we announce ${[...ours.keys()].join()} instead`);
    assert.deepEqual(diffSubset(ours.get(name), chrome.get(name)), []);
    noneMissing(ours.get(name), chrome.get(name), name);
  }

  test('a shadow root attached before its host is inserted is looked into, as in Chrome', async () => {
    await announced(
      `(async () => {
        const frame = () => new Promise(r => requestAnimationFrame(r));
        const host = document.createElement('div');
        host.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(SHADOW('dk'))};
        // Frames go by, each walking the shadow trees, before the host is in the document.
        for (let i = 0; i < 3; i++) await frame();
        document.body.append(host);
      })()`,
      'dk'
    );
  });

  test('declarative shadow roots are looked into, as in Chrome', async () => {
    await announced(
      `(() => {
        const div = document.body.appendChild(document.createElement('div'));
        div.setHTMLUnsafe('<div><template shadowrootmode="open">' + ${JSON.stringify(SHADOW('hk'))} + '</template></div>');
      })()`,
      'hk'
    );
  });

  test("shadow roots already in a new iframe's document are looked into, as in Chrome", async () => {
    await announced(
      `(() => {
        const iframe = document.createElement('iframe');
        iframe.srcdoc = '<div><template shadowrootmode="open"><p>x</p></template></div><script>'
          + 'document.querySelector("div").shadowRoot.querySelector("p")'
          + '.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 400, iterations: Infinity }).id = "fk"'
          + '</' + 'script>';
        document.body.append(iframe);
      })()`,
      'fk'
    );
  });

  test('an element removed from the document cancels its CSS animation, as in Chrome', async () => {
    await reset(t);
    await t.page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '@keyframes rk { to { opacity: 0.5 } } #rk { animation: rk 5s infinite }';
      document.head.append(style);
      document.body.appendChild(document.createElement('div')).id = 'rk';
    });
    const ids = [(await started(t.chrome, 1)).get('rk')?.id, (await started(t.ours, 1)).get('rk')?.id];
    await t.page.evaluate(() => document.getElementById('rk')?.remove());
    for (const [i, side] of [t.chrome, t.ours].entries())
      await until(
        async () => (await side.events('Animation.animationCanceled')).find(e => e.id === ids[i]),
        `the cancel (${i ? 'ours' : 'Chrome'})`
      );
  });

  test('pausing, seeking, timing and releasing do what they do in Chrome', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
      const prefix = side === t.chrome ? 'c' : 'o';
      await t.page.evaluate(ADD(prefix));
      const all = await started(side, 3);
      const animation = all.get(`${prefix}web`);
      assert.ok(animation);
      const ids = [animation.id];
      const name = `${prefix}web`;
      await side.send('Animation.setPaused', { animations: ids, paused: true });
      const paused = await stateOf(t, name);
      await side.send('Animation.seekAnimations', { animations: ids, currentTime: 1000 });
      const seekedPage = (await stateOf(t, name)).map(s =>
        aFramePast(Math.round(s.currentTime), 1000, side === t.chrome)
      );
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
      // Released, the animation plays on in the page.
      const released = await t.page.evaluate(async n => {
        const animation = document.getAnimations().find(a => a.id === n);
        const before = Number(animation?.currentTime);
        for (let i = 0; i < 5; i++) await new Promise(r => requestAnimationFrame(r));
        return [animation?.playState, Number(animation?.currentTime) > before];
      }, name);
      const { remoteObject } = await side.send('Animation.resolveAnimation', {
        animationId: all.get(`${prefix}k`)?.id ?? '',
      });
      await fence(t, side);
      results.push({
        paused: paused.map(s => s.playState),
        seekedPage,
        seeked: aFramePast(Math.round(currentTime), 1000, side === t.chrome),
        timing: timed.map(s => [
          s.playState,
          s.timing?.duration,
          s.timing?.delay,
          s.timing?.endDelay,
          s.timing?.iterations,
          s.timing?.easing,
        ]),
        resumed: resumed.map(s => s.playState),
        releasedError,
        released,
        className: remoteObject.className,
        // The domain's own changes are no updates.
        updated: (await updatesOf(side, animation.id)).length,
      });
    }
    assert.deepEqual(results[0], {
      paused: ['paused'],
      seekedPage: [1000],
      seeked: 1000,
      timing: [['paused', 5000, 10, 50, 3, 'linear']],
      resumed: ['running'],
      releasedError: 'error',
      released: ['running', true],
      className: 'CSSAnimation',
      updated: 0,
    });
    assert.deepEqual(results[1], results[0]);
  });

  test('the playback rate slows the animations down until disable, new ones too', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
      await side.send('Animation.enable');
      await t.page.evaluate(() => {
        const add = () => document.body.appendChild(document.createElement('div'));
        add().animate({ opacity: [0, 1] }, { duration: 100000 }).id = 'r1';
        add().animate({ opacity: [0, 1] }, { duration: 100000, delay: 100 }).id = 'r2';
      });
      await started(side, 2);
      await side.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
      assert.deepEqual(await side.send('Animation.getPlaybackRate'), { playbackRate: 0.1 });
      // Started at the slowed rate.
      await t.page.evaluate(() => {
        document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 100000).id = 'r3';
      });
      const r3 = await until(
        async () => (await side.events('Animation.animationStarted')).find(e => e.animation.name === 'r3'),
        'r3'
      );
      /** Each animation's current time, by id, and the time on the page's clock. */
      const read = () =>
        t.page.evaluate(() => ({
          now: performance.now(),
          times: Object.fromEntries(document.getAnimations().map(a => [a.id, Number(a.currentTime)])),
        }));
      const before = await read();
      await sleep(600);
      const after = await read();
      await side.send('Animation.disable');
      assert.deepEqual(await side.send('Animation.getPlaybackRate'), { playbackRate: 1 });
      const wall = after.now - before.now;
      const rates = Object.fromEntries(
        ['r1', 'r2', 'r3'].map(id => [id, ((after.times[id] ?? NaN) - (before.times[id] ?? NaN)) / wall])
      );
      for (const [id, rate] of Object.entries(rates))
        assert.ok(rate > 0.05 && rate < 0.15, `${id} ran at ${rate} of the clock at 10%: ${JSON.stringify(rates)}`);
      results.push(r3.animation.playbackRate);
    }
    // The rate is the timeline's in Chrome: an animation started meanwhile reports its own.
    assert.deepEqual(results, [1, 1]);
  });

  test('the page finishing or cancelling an animation is reported, pausing it is not', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
      await side.send('Animation.enable');
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
      await fence(t, side);
      const afterPause = (await updatesOf(side, created.animation.id)).length;
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

  test('once disabled, nothing is reported, as in Chrome', async () => {
    const results: unknown[] = [];
    for (const side of [t.chrome, t.ours]) {
      await reset(t);
      await side.send('Animation.enable');
      // Running, and known to the domain, when it is disabled: then changed by the page frame by
      // frame, as a poll left running would report.
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 100000);
        animation.id = 'off';
        Reflect.set(window, '__off', animation);
      });
      await until(
        async () => (await side.events('Animation.animationStarted')).find(e => e.animation.name === 'off'),
        'the animation'
      );
      await side.send('Animation.disable');
      await side.clear();
      for (const change of [
        'reverse()',
        'currentTime = 5000',
        'startTime = document.timeline.currentTime - 1000',
        'playbackRate = 2',
        'pause()',
        'play()',
        'finish()',
      ]) {
        await t.page.evaluate(`window.__off.${change}`);
        await settle(t, side);
      }
      // And one started meanwhile, then cancelled.
      await t.page.evaluate(() => {
        const animation = document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 10000);
        Reflect.set(window, '__off2', animation);
      });
      await settle(t, side);
      await t.page.evaluate(() => (Reflect.get(window, '__off2') as Animation).cancel());
      await settle(t, side);
      const all = [];
      for (const method of EVENTS) all.push(...(await side.events(method)));
      results.push(all.length);
    }
    assert.deepEqual(results, [0, 0]);
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

describe('Animation, which animations are told apart', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
    for (const side of [t.chrome, t.ours]) await side.send('Animation.enable');
  });

  /** Runs `code` (with `add(className, tag)`) and gives each side's new animations. */
  async function run(code: string, count: number) {
    for (const side of [t.chrome, t.ours]) await side.clear();
    await t.page.evaluate(
      `(() => { const add = (cls, tag = 'div') => document.body.appendChild(Object.assign(document.createElement(tag), { className: cls, textContent: 'hello' })); ${code} })()`
    );
    const list = (side: Side) =>
      until(async () => {
        const all = (await side.events('Animation.animationStarted')).map(e => e.animation);
        return all.length >= count ? all : undefined;
      }, `${count} animations`);
    return { chrome: await list(t.chrome), ours: await list(t.ours) };
  }

  test('cssId: the same rule shares one, another rule does not, as in Chrome', async () => {
    await t.page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent =
        '@keyframes i1 { to { left: 10px } } @keyframes i2 { to { top: 10px } }' +
        ' .ia { animation: i1 5s } .ia2 { animation: i1 5s 1s } .ion { animation-play-state: running } .ib { animation: i2 5s } .ic { animation: i1 5s, i2 5s }' +
        ' .it { transition: width 5s, height 5s; width: 1px; height: 1px } .it3 { transition: width 6s; width: 1px }';
      document.head.append(style);
    });
    const labels: string[] = [];
    const ids: { chrome: (string | undefined)[]; ours: (string | undefined)[] } = { chrome: [], ours: [] };
    const steps: [string, string, number][] = [
      ['a', `add('ia')`, 1],
      ['a again', `add('ia')`, 1],
      ['a with other classes', `add('ia ix')`, 1],
      ['a with inline style', `add('ia iy').style.color = 'red'`, 1],
      ['a replayed', `const e = add('ia'); e.id = 'ir'`, 1],
      [
        'a replayed after changes',
        `const e = document.getElementById('ir'); e.className = ''; e.getBoundingClientRect(); e.className = 'ia iz ion'; e.style.color = 'blue'`,
        1,
      ],
      ['a2', `add('ia2')`, 1],
      ['b', `add('ib')`, 1],
      ['c', `add('ic')`, 2],
      ['t', `const e = add('it'); e.getBoundingClientRect(); e.style.width = e.style.height = '9px'`, 2],
      ['t again', `const e = add('it'); e.getBoundingClientRect(); e.style.width = e.style.height = '9px'`, 2],
      ['t to 20px', `const e = add('it'); e.id = 'itt'; e.getBoundingClientRect(); e.style.width = '20px'`, 1],
      ['t to 30px', `document.getElementById('itt').style.width = '30px'`, 1],
      ['t3', `const e = add('it3'); e.getBoundingClientRect(); e.style.width = '9px'`, 1],
      ['waapi', `add('').animate({ opacity: [0, 1] }, 5000).id = 'iw'`, 1],
    ];
    for (const [label, code, count] of steps) {
      const got = await run(code, count);
      for (const side of ['chrome', 'ours'] as const) {
        const sorted = got[side].slice(0, count).sort((x, y) => x.name.localeCompare(y.name));
        if (side === 'chrome') labels.push(...sorted.map(a => `${label} ${a.name}`));
        ids[side].push(...sorted.map(a => a.cssId));
      }
    }
    // Which animations share an id: the ids differ, the relation is Chrome's. Left out: the same
    // declarations in two rules, which Chrome tells apart and we cannot (see cssIdOf).
    const relation = (list: (string | undefined)[]) =>
      list.map(
        (id, i) =>
          `${labels[i]}: ${list.flatMap((other, j) => (id !== undefined && other === id ? [labels[j]] : [])).join(', ')}`
      );
    assert.deepEqual(relation(ids.ours), relation(ids.chrome));
    assert.equal(ids.chrome.at(-1), undefined, 'a Web Animation has none');
    assert.equal(ids.ours.at(-1), undefined, 'a Web Animation has none');
  });

  test('animations of a same-origin iframe match Chrome', async () => {
    const got = await run(
      `const f = document.body.appendChild(document.createElement('iframe'));
       f.srcdoc = '<style>@keyframes fk { to { left: 1px } } div { position: relative; animation: fk 5s ease-in }'
         + ' p { transition: width 5s; width: 1px }</style><div>x</div><p>y</p><script>'
         + 'document.body.animate([{ opacity: 0 }, { opacity: 1 }], 5000).id = "fw";'
         + 'const p = document.querySelector("p"); p.getBoundingClientRect(); p.style.width = "9px"<' + '/script>'`,
      3
    );
    for (const name of ['fk', 'fw', 'width']) {
      const chrome = got.chrome.find(a => a.name === name);
      const ours = got.ours.find(a => a.name === name);
      assert.ok(chrome, `Chrome announces ${name}`);
      assert.ok(ours, `we announce ${name}`);
      assert.deepEqual(diffSubset(ours, chrome), [], name);
      noneMissing(ours, chrome, name);
      assert.equal('cssId' in ours, 'cssId' in chrome, name);
      assert.equal('keyframesRule' in (ours.source ?? {}), 'keyframesRule' in (chrome.source ?? {}), name);
      assert.equal('backendNodeId' in (ours.source ?? {}), 'backendNodeId' in (chrome.source ?? {}), name);
    }
  });

  test('animations of pseudo-elements name the node Chrome names', async () => {
    await t.page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent =
        '@keyframes pk { to { left: 10px } } .pb::before { content: "x"; animation: pk 5s }' +
        ' .pm::marker { animation: pk 5s } .pl::first-letter { animation: pk 5s } .pl::first-line { animation: pk 5s }' +
        ' .ps::selection { animation: pk 5s } .pd::backdrop { animation: pk 5s }';
      document.head.append(style);
    });
    const results: { chrome: unknown[]; ours: unknown[] } = { chrome: [], ours: [] };
    /** The node of the document with `backendNodeId`, looked up in the tree (we describe no pseudo-element). */
    const find = (node: Protocol.DOM.Node, id: number): Protocol.DOM.Node | undefined => {
      if (node.backendNodeId === id) return node;
      for (const child of [...(node.children ?? []), ...(node.pseudoElements ?? [])]) {
        const found = find(child, id);
        if (found) return found;
      }
      return undefined;
    };
    for (const [label, code] of [
      ['before', `add('pb')`],
      ['marker', `add('pm', 'li')`],
      ['backdrop', `add('pd', 'dialog').showModal()`],
    ] as const) {
      const got = await run(code, 1);
      for (const side of ['chrome', 'ours'] as const) {
        const id = got[side][0]?.source?.backendNodeId;
        const { root } = await t[side].send('DOM.getDocument', { depth: -1 });
        const node = id ? find(root, id) : undefined;
        results[side].push([label, node?.nodeName, node?.pseudoType]);
      }
    }
    // Chrome names the ::backdrop pseudo-element node, which our DOM does not have (it has ::before,
    // ::after and ::marker): we name the dialog, the nearest node the panel can show.
    assert.deepEqual(results.chrome.at(-1), ['backdrop', '::backdrop', 'backdrop']);
    assert.deepEqual(results.ours.at(-1), ['backdrop', 'DIALOG', undefined]);
    assert.deepEqual(results.ours.slice(0, -1), results.chrome.slice(0, -1));
    // Blink runs no animations on ::first-letter, ::first-line or ::selection: none is announced.
    for (const side of [t.chrome, t.ours]) await side.clear();
    await t.page.evaluate(() => {
      for (const cls of ['pl', 'ps'])
        document.body.appendChild(Object.assign(document.createElement('p'), { className: cls, textContent: 'x' }));
    });
    await fence(t, t.chrome, t.ours);
    const others = async (side: Side) =>
      (await side.events('Animation.animationStarted')).filter(e => !e.animation.name.startsWith('fence'));
    assert.deepEqual(await others(t.chrome), []);
    assert.deepEqual(await others(t.ours), []);
  });
});

/** What a side reported, by kind (created, started, updated, canceled), without times. */
async function reports(side: Side) {
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
async function onEachSide<T>(steps: (t: TestPage, side: Side) => Promise<T>): Promise<[T, T]> {
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

describe('Animation, beyond getAnimations()', () => {
  test('animations without a target, out of the document, or over at once are announced, as in Chrome', async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 0).id = 'zero';
        const loose = new Animation(new KeyframeEffect(null, { opacity: [0, 1] }, 10000));
        loose.id = 'loose';
        loose.play();
        document.createElement('div').animate({ opacity: [0, 1] }, 10000).id = 'detached';
        new Animation(null).id = 'unplayed';
      });
      await sleep(300);
      return reports(side);
    });
    assert.deepEqual(ours, chrome);
  });

  test('an animation cancelled before it started is reported cancelled, as in Chrome', async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() =>
        document.body
          .appendChild(document.createElement('div'))
          .animate({ opacity: [0, 1] }, 1000)
          .cancel()
      );
      await sleep(200);
      const sameTask = await reports(side);
      await t.page.evaluate(
        () =>
          new Promise(resolve => {
            const div = document.body.appendChild(document.createElement('div'));
            const animation = div.animate({ opacity: [0, 1] }, 1000);
            requestAnimationFrame(() => resolve(animation.cancel()));
          })
      );
      await sleep(200);
      // Cancelled in a task between animate() and the next frame, Chrome reports a start too, while
      // still pending, which the page cannot tell apart from a cancel in that frame: not compared.
      return { sameTask, nextFrame: await reports(side) };
    });
    assert.deepEqual(ours, chrome);
  });

  test('an animation played again after a cancel or its end keeps its id, as in Chrome', async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 100);
        animation.id = 'again';
        Reflect.set(window, '__again', animation);
      });
      await sleep(400);
      const finished = await reports(side);
      const found = await side.send('Animation.getCurrentTime', { id: '1' }).then(
        () => 'found',
        () => 'missing'
      );
      await t.page.evaluate(() => (Reflect.get(window, '__again') as Animation).play());
      await sleep(300);
      const replayed = await reports(side);
      await t.page.evaluate(() => (Reflect.get(window, '__again') as Animation).cancel());
      await sleep(200);
      const canceled = await reports(side);
      await t.page.evaluate(() => (Reflect.get(window, '__again') as Animation).play());
      await sleep(300);
      return { finished, found, replayed, canceled, again: await reports(side) };
    });
    assert.deepEqual(ours, chrome);
  });

  test("the page's own playback rate is reported, and kept after disable, as in Chrome", async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        Reflect.set(window, '__rate', div.animate({ opacity: [0, 1] }, 10000));
      });
      await sleep(200);
      await side.clear();
      await t.page.evaluate(() => (Reflect.get(window, '__rate') as Animation).reverse());
      // Under load Chrome reported the reverse after 200 ms (1 run in 24): waited for, then a fence.
      await until(async () => (await side.events('Animation.animationUpdated'))[0], 'the reverse');
      await fence(t, side);
      const reversed = (await side.events('Animation.animationUpdated'))
        .filter(e => !e.animation.name.startsWith('fence'))
        .map(e => e.animation.playbackRate);
      await side.send('Animation.setPlaybackRate', { playbackRate: 0.5 });
      await t.page.evaluate(() => ((Reflect.get(window, '__rate') as Animation).playbackRate = 2));
      await sleep(200);
      await side.send('Animation.disable');
      const after = await t.page.evaluate(() => (Reflect.get(window, '__rate') as Animation).playbackRate);
      return { reversed, after };
    });
    assert.deepEqual(chrome, { reversed: [-1], after: 2 });
    assert.deepEqual(ours, chrome);
  });

  test('disable gives a cancelled animation its own rate back, as in Chrome', async () => {
    // Chrome sets the rate on the timeline, not on the animation: the page reads its own throughout.
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        Reflect.set(window, '__cancel', div.animate({ opacity: [0, 1] }, 10000));
      });
      await sleep(200);
      await side.send('Animation.setPlaybackRate', { playbackRate: 0.5 });
      await t.page.evaluate(() => (Reflect.get(window, '__cancel') as Animation).cancel());
      await sleep(200);
      await side.send('Animation.disable');
      return t.page.evaluate(() => (Reflect.get(window, '__cancel') as Animation).playbackRate);
    });
    assert.equal(chrome, 1);
    assert.equal(ours, chrome);
  });

  test('seeking plays a finished animation and stops at the end of the effect, as in Chrome', async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const add = (id: string, timing: KeyframeAnimationOptions) => {
          const div = document.body.appendChild(document.createElement('div'));
          Reflect.set(window, `__${id}`, div.animate({ opacity: [0, 1] }, timing));
        };
        add('ended', { duration: 100 });
        add('long', { duration: 1000, delay: 100, endDelay: 50 });
      });
      await sleep(400);
      const state = (id: string) =>
        t.page.evaluate(n => {
          const animation = Reflect.get(window, n) as Animation;
          return [animation.playState, Math.round(Number(animation.currentTime))];
        }, `__${id}`);
      // Chrome takes `currentTimes` as seconds (see above): only times past the end compare.
      await side.send('Animation.seekAnimations', { animations: ['1'], currentTimes: [1e6] });
      const ended = await state('ended');
      await side.send('Animation.seekAnimations', { animations: ['2'], currentTimes: [1e6] });
      // Seeked while it still runs, Chrome at times reads it a frame past its end (1167 for 1150,
      // about 1 run in 20 under load): a frame's slack.
      const [playState, time] = await state('long');
      const long = [playState, aFramePast(Number(time), 1150, side === t.chrome)];
      await t.page.evaluate(() => (Reflect.get(window, '__long') as Animation).pause());
      // Paused for good: one still pending pause takes the time of the frame it is paused in.
      await sleep(100);
      await side.send('Animation.seekAnimations', { animations: ['2'], currentTimes: [1e6] });
      return { ended, long, paused: await state('long') };
    });
    assert.deepEqual(chrome, { ended: ['finished', 100], long: ['finished', 1150], paused: ['paused', 1150] });
    assert.deepEqual(ours, chrome);
  });

  test("a rate the page set that is still pending survives the panel's rate, as in Chrome", async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        Reflect.set(window, '__pending', div.animate({ opacity: [0, 1] }, 10000));
      });
      await sleep(200);
      await side.clear();
      // The rate is set while the reverse is pending, in the same frame as a rule (not guaranteed).
      await t.page.evaluate(() => (Reflect.get(window, '__pending') as Animation).updatePlaybackRate(-2));
      await side.send('Animation.setPlaybackRate', { playbackRate: 0.5 });
      await sleep(300);
      const reported = (await side.events('Animation.animationUpdated')).map(e => e.animation.playbackRate);
      await side.send('Animation.disable');
      const after = await t.page.evaluate(() => (Reflect.get(window, '__pending') as Animation).playbackRate);
      return { reported: reported.at(-1), after };
    });
    assert.deepEqual(chrome, { reported: -2, after: -2 });
    assert.deepEqual(ours, chrome);
  });

  test("the page's change to a start time is reported though the panel changes the animation in that frame, as in Chrome", async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const div = document.body.appendChild(document.createElement('div'));
        Reflect.set(window, '__moved', div.animate({ opacity: [0, 1] }, 10000));
      });
      const id = (await until(async () => (await side.events('Animation.animationStarted'))[0], 'the start')).animation
        .id;
      await side.clear();
      await t.page.evaluate(() => {
        const animation = Reflect.get(window, '__moved') as Animation;
        animation.startTime = Number(animation.startTime) - 1000;
      });
      await side.send('Animation.setTiming', { animationId: id, duration: 20000, delay: 0 });
      await sleep(300);
      return (await side.events('Animation.animationUpdated')).length;
    });
    // Only that the result matches Chrome's: the two changes may fall in different frames here, so
    // this passes without the fix too. The test below puts them in one frame, on our side only.
    assert.equal(chrome, 1);
    assert.equal(ours, chrome);
  });

  test("the page's change to a start time in the panel's frame is reported (ours, one frame)", async () => {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      await t.ours.send('Animation.enable');
      const updates = await t.page.evaluate(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 10000);
        await frame();
        await frame();
        await frame();
        const started = window.__ours.find(e => e.method === 'Animation.animationStarted');
        const id = String(Object(Object(started?.params).animation).id);
        window.__ours.length = 0;
        animation.startTime = Number(animation.startTime) - 1000;
        await window.__session.call('Animation.setTiming', { animationId: id, duration: 20000, delay: 0 });
        await frame();
        await frame();
        return window.__ours.filter(e => e.method === 'Animation.animationUpdated').length;
      });
      assert.equal(updates, 1);
    } finally {
      await t.page.close();
    }
  });

  test('a pending animation gets its own rate back though the domain is enabled again (ours)', async () => {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      const rate = await t.page.evaluate(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const call = (method: string, params = {}) => window.__session.call(method, params);
        await call('Animation.enable');
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 10000);
        await frame();
        await frame();
        await call('Animation.setPlaybackRate', { playbackRate: 0.5 });
        // Pending until ready: disable meets it pending, and the domain is enabled again meanwhile.
        animation.updatePlaybackRate(-2);
        await call('Animation.disable');
        await call('Animation.enable');
        await call('Animation.setPlaybackRate', { playbackRate: 0.25 });
        await animation.ready;
        await frame();
        await frame();
        await call('Animation.disable');
        await frame();
        return animation.playbackRate;
      });
      assert.equal(rate, -2);
    } finally {
      await t.page.close();
    }
  });

  test('an animation a disable left pending is not taken at the slowed rate by the next session (ours)', async () => {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      const rate = await t.page.evaluate(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const call = (method: string, params = {}) => window.__session.call(method, params);
        await call('Animation.enable');
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 10000);
        await frame();
        await frame();
        await call('Animation.setPlaybackRate', { playbackRate: 0.5 });
        // Pending (a play after a pause) with the page's rate untouched; the next session tracks it
        // at once, on enable, before it is ready. finish() ends the pending play at once, but the
        // disable's callback on `ready` runs only after this task: the new session sets its rate first.
        animation.pause();
        animation.play();
        void call('Animation.disable');
        void call('Animation.enable');
        animation.finish();
        void call('Animation.setPlaybackRate', { playbackRate: 0.25 });
        await animation.ready;
        await frame();
        await frame();
        await call('Animation.disable');
        await frame();
        return animation.playbackRate;
      });
      assert.equal(rate, 1);
    } finally {
      await t.page.close();
    }
  });

  test('a rate the page set pending at a disable survives it and is reported by the next session (ours)', async () => {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      const result = await t.page.evaluate(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const call = (method: string, params = {}) => window.__session.call(method, params);
        await call('Animation.enable');
        const div = document.body.appendChild(document.createElement('div'));
        const animation = div.animate({ opacity: [0, 1] }, 100000);
        await frame();
        await frame();
        await call('Animation.setPlaybackRate', { playbackRate: 0.25 });
        await frame();
        // Disabled and enabled again while the page's new rate is pending.
        animation.updatePlaybackRate(2);
        void call('Animation.disable');
        void call('Animation.enable');
        window.__ours.length = 0;
        for (let i = 0; i < 5; i++) await frame();
        const updated = window.__ours
          .filter(e => e.method === 'Animation.animationUpdated')
          .map(e => Number(Object(Object(e.params).animation).playbackRate));
        await call('Animation.disable');
        return { rate: animation.playbackRate, updated };
      });
      assert.deepEqual(result, { rate: 2, updated: [2] });
    } finally {
      await t.page.close();
    }
  });
});

describe('Animation, scroll-driven', () => {
  /** A scroller with `scroll()` and `view()` CSS animations, and a ScrollTimeline and ViewTimeline of the Web Animations API. */
  const SCROLLERS = `(() => {
    const style = document.createElement('style');
    style.textContent = '@keyframes sk { from { opacity: 0 } to { opacity: 1 } }'
      + ' #sc { height: 200px; overflow: scroll } #sc > div { height: 2000px; width: 3000px }'
      + ' #st { animation: sk linear; animation-timeline: scroll(nearest block) }'
      + ' #vt { height: 50px; margin-top: 600px; animation: sk 2s linear both; animation-timeline: view(); animation-range: entry 10% exit 90% }'
      + ' html { height: 3000px } #rt { animation: rk linear; animation-timeline: scroll(root) } @keyframes rk { to { opacity: 0.5 } }';
    document.head.append(style);
    const sc = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'sc' }));
    const inner = sc.appendChild(document.createElement('div'));
    inner.appendChild(Object.assign(document.createElement('div'), { id: 'st' }));
    inner.appendChild(Object.assign(document.createElement('div'), { id: 'vt' }));
    document.body.appendChild(Object.assign(document.createElement('div'), { id: 'rt' }));
    const w = inner.appendChild(document.createElement('div'));
    w.animate({ opacity: [0, 1] }, { timeline: new ScrollTimeline({ source: sc, axis: 'x' }) }).id = 'wscroll';
    w.animate({ opacity: [0, 1] }, { timeline: new ViewTimeline({ subject: w }), rangeStart: 'cover 20%' }).id = 'wview';
    w.animate({ opacity: [0, 1] }, { timeline: new ScrollTimeline({ source: sc }), duration: 1000, iterations: 2, delay: 100 }).id = 'wscrollms';
  })()`;

  /**
   * What one side does with the scroller's animations, on a page of its own: the panel's commands
   * act on the page both sides share. Two are named `sk`: they are told apart by their timeline.
   */
  async function play(chrome: boolean) {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    const side = chrome ? t.chrome : t.ours;
    try {
      await t.page.evaluate(SCROLLERS);
      // Laid out first: Chrome leaves `viewOrScrollTimeline` out of an animation announced before
      // its scroller is (seen now and then without this wait); ours always has it.
      await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await side.send('Animation.enable');
      // The node ids are compared as the nodes they name.
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = root;
      const backendIdOf = async (selector: string) => {
        const found = await side.send('DOM.querySelector', {
          nodeId,
          selector,
        });
        return (await side.send('DOM.describeNode', { nodeId: found.nodeId })).node.backendNodeId;
      };
      const ids = {
        document: root.backendNodeId,
        sc: await backendIdOf('#sc'),
        st: await backendIdOf('#st'),
        vt: await backendIdOf('#vt'),
        w: await backendIdOf('#sc > div > div:last-child'),
      };
      const nodeName = (id: number | undefined) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? String(id);
      const list = await until(async () => {
        const all = (await side.events('Animation.animationStarted')).map(e => e.animation);
        return all.length >= 6 ? all : undefined;
      }, '6 animations');
      const key = (a: Protocol.Animation.Animation) =>
        `${a.name}/${a.viewOrScrollTimeline?.subjectNodeId ? 'view' : 'scroll'}`;
      const announced = Object.fromEntries(
        list.map(a => {
          const timeline = a.viewOrScrollTimeline;
          const named = timeline && {
            ...timeline,
            sourceNodeId: nodeName(timeline.sourceNodeId),
            subjectNodeId: timeline.subjectNodeId && nodeName(timeline.subjectNodeId),
          };
          const source = {
            ...a.source,
            backendNodeId: nodeName(a.source?.backendNodeId),
          };
          return [
            key(a),
            {
              ...a,
              id: undefined,
              cssId: undefined,
              viewOrScrollTimeline: named,
              source,
            },
          ];
        })
      );
      const animations = list.map(a => a.id);
      await side.clear();
      await t.page.evaluate(() => {
        const sc = document.getElementById('sc');
        if (sc) sc.scrollTop = 500;
        if (document.scrollingElement) document.scrollingElement.scrollTop = 500;
      });
      await sleep(300);
      const scrolledUpdates = (await side.events('Animation.animationUpdated')).length;
      const times = async () => {
        const result: Record<string, number> = {};
        for (const a of list) {
          const { currentTime } = await side.send('Animation.getCurrentTime', {
            id: a.id,
          });
          result[key(a)] = Math.round(currentTime * 1e6) / 1e6;
        }
        return result;
      };
      const pageTimes = () =>
        t.page.evaluate(() =>
          document.getAnimations().map(a => [String(a.currentTime), a.playbackRate, a.effect?.getTiming().delay])
        );
      const scrolled = await times();
      // Running ones follow the scroller: a seek leaves them be.
      await side.send('Animation.seekAnimations', {
        animations,
        currentTime: 30,
      });
      await sleep(100);
      const seekedRunning = await pageTimes();
      await side.send('Animation.setPaused', { animations, paused: true });
      await sleep(100);
      // Paused ones are moved, in Chrome's scroll-timeline milliseconds. Chrome takes `currentTimes`
      // a thousand times larger, as it does for any animation (see "seeking each animation to its
      // own time"); ours takes them as `currentTime`, as the panel means them.
      await side.send('Animation.seekAnimations', {
        animations,
        currentTime: 0.5,
      });
      await sleep(100);
      const seekedPaused = [await pageTimes(), await times()];
      await side.send('Animation.seekAnimations', {
        animations,
        currentTimes: animations.map((_, i) => (chrome ? 0.0001 : 0.1) * i),
      });
      await sleep(100);
      const pausedTimes = [await pageTimes(), await times()];
      await side.send('Animation.setPaused', { animations, paused: false });
      await side.send('Animation.setPlaybackRate', { playbackRate: 0.5 });
      await sleep(100);
      const rated = await pageTimes();
      await side.clear();
      await side.send('Animation.setTiming', {
        animationId: animations[0] ?? '',
        duration: 500,
        delay: 10,
      });
      await sleep(300);
      const timed = (await side.events('Animation.animationUpdated')).map(e => ({
        ...e.animation,
        id: undefined,
        cssId: undefined,
        currentTime: undefined,
        viewOrScrollTimeline: undefined,
        source: { ...e.animation.source, backendNodeId: undefined },
      }));
      // The page changes the rate in the frame the panel times it: reported once, at the new rate.
      await side.clear();
      const timing = { animationId: animations[0] ?? '', duration: 600, delay: 0 };
      // Ours in one task; Chrome's command follows the page's change within a frame or so.
      await t.page.evaluate(
        (timing, ours) => {
          const first = document.getAnimations()[0];
          if (first) first.playbackRate = 2;
          return ours ? window.__session.call('Animation.setTiming', timing) : null;
        },
        timing,
        !chrome
      );
      if (chrome) await side.send('Animation.setTiming', timing);
      await sleep(300);
      const retimed = (await side.events('Animation.animationUpdated')).map(e => e.animation.playbackRate);
      await side.send('Animation.disable');
      return {
        announced,
        scrolledUpdates,
        scrolled,
        seekedRunning,
        seekedPaused,
        pausedTimes,
        rated,
        timed,
        retimed,
      };
    } finally {
      await t.page.close();
    }
  }

  test('scroll and view timelines are reported, seeked and timed as in Chrome', async () => {
    const chrome = await play(true);
    const ours = await play(false);
    assert.equal(Object.keys(chrome.announced).length, 6);
    // The root scroller's range is the document's beyond the viewport: 3000px less 600px.
    assert.equal(chrome.announced['rk/scroll']?.viewOrScrollTimeline?.endOffset, 2400);
    assert.equal(chrome.announced['rk/scroll']?.viewOrScrollTimeline?.sourceNodeId, 'document');
    assert.equal(chrome.announced['sk/scroll']?.viewOrScrollTimeline?.sourceNodeId, 'sc');
    for (const [name, animation] of Object.entries(chrome.announced)) {
      const own = ours.announced[name];
      assert.ok(own, `missing ${name}`);
      assert.deepEqual(diffSubset(own, animation), [], name);
      noneMissing(own, animation, name);
      assert.deepEqual(own.viewOrScrollTimeline, animation.viewOrScrollTimeline, name);
    }
    assert.deepEqual({ ...ours, announced: undefined }, { ...chrome, announced: undefined });
    assert.deepEqual(Object.values(chrome.pausedTimes[1] ?? {}), [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    assert.deepEqual(chrome.retimed, [2], 'one update, at the rate the page set');
  });
});
