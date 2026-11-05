import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSubset, openPage } from '../../../../test-support/conformance.ts';
import type { Side, TestPage } from '../../../../test-support/conformance.ts';
import type { Protocol } from 'devtools-protocol';
import {
  EVENTS,
  env,
  sleep,
  until,
  reset,
  fence,
  settle,
  noneMissing,
  aFramePast,
  started,
  ADD,
  stateOf,
} from '../../../../test-support/animation-conformance.ts';

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
    // Which animations share an id: the ids differ, the relation is Chrome's.
    const relation = (list: (string | undefined)[]) =>
      list.map(
        (id, i) =>
          `${labels[i]}: ${list.flatMap((other, j) => (id !== undefined && other === id ? [labels[j]] : [])).join(', ')}`
      );
    assert.deepEqual(relation(ids.ours), relation(ids.chrome));
    assert.equal(ids.chrome.at(-1), undefined, 'a Web Animation has none');
    assert.equal(ids.ours.at(-1), undefined, 'a Web Animation has none');
  });

  test('cssId follows the rules that won each property, as in Chrome', async () => {
    await t.page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent =
        '@keyframes j1 { to { left: 10px } } .ja { animation: j1 5s } .jb { animation: j1 5s }' +
        ' .jt { transition: width 5s; width: 1px } .jt.jh { width: 20px } .jt.jw { width: 30px !important }' +
        ' .ju { transition: width 5s } .jv { transition: width 5s; width: 1px }';
      document.head.append(style);
      const other = document.createElement('style');
      other.textContent = '.jc { animation: j1 5s }';
      document.head.append(other);
    });
    const labels: string[] = [];
    const ids: { chrome: (string | undefined)[]; ours: (string | undefined)[] } = { chrome: [], ours: [] };
    const hover = `const e = add('jt'); e.id = 'jth'; e.getBoundingClientRect(); e.classList.add('jh')`;
    const steps: [string, string, number][] = [
      ['rule a', `add('ja')`, 1],
      ['rule b, same declarations', `add('jb')`, 1],
      ['same selector in another sheet', `add('jc')`, 1],
      ['inline', `add('').style.animation = 'j1 5s'`, 1],
      ['inline again', `add('').style.animation = 'j1 5s 1s'`, 1],
      ['hover in', hover, 1],
      ['hover out', `document.getElementById('jth').classList.remove('jh')`, 1],
      ['hover in again', `document.getElementById('jth').classList.add('jh')`, 1],
      ['hover out again', `document.getElementById('jth').classList.remove('jh')`, 1],
      ['important', `const e = add('jt'); e.getBoundingClientRect(); e.classList.add('jw')`, 1],
      ['inline width', `const e = add('jt'); e.getBoundingClientRect(); e.style.width = '9px'`, 1],
      [
        'no width rule',
        `const e = add('ju'); e.style.width = '1px'; e.getBoundingClientRect(); e.style.width = '9px'`,
        1,
      ],
      ['width in the same rule', `const e = add('jv'); e.getBoundingClientRect(); e.style.width = '9px'`, 1],
    ];
    for (const [label, code, count] of steps) {
      const got = await run(code, count);
      for (const side of ['chrome', 'ours'] as const) {
        if (side === 'chrome') labels.push(label);
        ids[side].push(got[side][0]?.cssId);
      }
    }
    const relation = (list: (string | undefined)[]) =>
      list.map(
        (id, i) =>
          `${labels[i]}: ${list.flatMap((other, j) => (id !== undefined && other === id ? [labels[j]] : [])).join(', ')}`
      );
    assert.deepEqual(relation(ids.ours), relation(ids.chrome));
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
