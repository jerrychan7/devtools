import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_BUNDLE, openPage } from '../../../../test-support/conformance.ts';
import {
  EVENTS,
  env,
  sleep,
  until,
  fence,
  reports,
  onEachSide,
} from '../../../../test-support/animation-conformance.ts';

describe('Animation, play state changes', () => {
  /** Runs each step in the page, and takes what each side reported after it. */
  const steps = (list: [name: string, code: string][]) =>
    onEachSide(async (t, side) => {
      const out: Record<string, string[]> = {};
      for (const [name, code] of list) {
        await t.page.evaluate(code);
        await fence(t, side);
        out[name] = (await reports(side)).map(r => r.split(' ').slice(0, 2).join(' '));
      }
      return out;
    });

  test('pausing or cancelling is reported with a cancel, playing again with an update, as in Chrome', async () => {
    const [chrome, ours] = await steps([
      [
        'make',
        `window.a = document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 10000)`,
      ],
      ['pause', 'a.pause()'],
      ['seek while paused', 'a.currentTime = 3000'],
      ['play', 'a.play()'],
      ['pause and play in one task', 'a.pause(); a.play()'],
      ['seek and pause in one task', 'a.currentTime = 1000; a.pause()'],
      ['cancel while paused', 'a.cancel()'],
      ['pause while idle', 'a.pause()'],
      ['reverse while paused', 'a.reverse()'],
      ['finish', 'a.finish()'],
      ['pause while finished', 'a.pause()'],
      ['play again', 'a.play()'],
      ['cancel', 'a.cancel()'],
      [
        'made paused',
        `document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 1000).pause()`,
      ],
    ]);
    assert.deepEqual(chrome['pause'], ['Canceled 1']);
    assert.deepEqual(ours, chrome);
  });

  test("the panel's pause is reported with a cancel, its play with an update, as in Chrome", async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 10000);
      });
      // Sleeps, not fences: Chrome reports the play's new start time a while after a fence's start.
      await sleep(300);
      await reports(side);
      const out: Record<string, string[]> = {};
      const step = async (name: string, send: () => Promise<unknown>) => {
        await send();
        await sleep(250);
        out[name] = (await reports(side)).map(r => r.split(' ').slice(0, 2).join(' '));
      };
      const animations = ['1'];
      await step('pause', () => side.send('Animation.setPaused', { animations, paused: true }));
      await step('seek paused', () => side.send('Animation.seekAnimations', { animations, currentTime: 500 }));
      await step('play', () => side.send('Animation.setPaused', { animations, paused: false }));
      await step('seek running', () => side.send('Animation.seekAnimations', { animations, currentTime: 500 }));
      await step('pause again', () => side.send('Animation.setPaused', { animations, paused: true }));
      return out;
    });
    assert.deepEqual(chrome['pause'], ['Canceled 1']);
    assert.deepEqual(ours, chrome);
  });

  test('getCurrentTime: null once cancelled, the time since the start once finished, as in Chrome', async () => {
    const [chrome, ours] = await onEachSide(async (t, side) => {
      await t.page.evaluate(() => {
        const add = () => document.body.appendChild(document.createElement('div'));
        add().animate({ opacity: [0, 1] }, 100);
        Reflect.set(window, '__r', add().animate({ opacity: [0, 1] }, 10000));
        Reflect.set(window, '__c', add().animate({ opacity: [0, 1] }, 10000));
      });
      await sleep(400);
      await t.page.evaluate(() => {
        (Reflect.get(window, '__r') as Animation).playbackRate = -2;
        (Reflect.get(window, '__c') as Animation).cancel();
      });
      await sleep(300);
      const time = async (id: string) => (await side.send('Animation.getCurrentTime', { id })).currentTime;
      const [finished, reversed, canceled] = [await time('1'), await time('2'), await time('3')];
      const page = await t.page.evaluate(() => Number((Reflect.get(window, '__r') as Animation).currentTime));
      return {
        // About 700ms after the start of each.
        finished: Math.round(finished / 100),
        // The rate left out: the time since the start, not the page's current time.
        reversed: Math.round(reversed / 100),
        reversedPage: Math.round(page / 100),
        canceled,
      };
    });
    assert.equal(chrome.canceled, null);
    assert.ok(chrome.finished >= 6, `finished at ${chrome.finished}`);
    assert.deepEqual(ours, chrome);
  });
  test("the page's rate before the start or while paused, a long pending one and a scroll-driven pause, as in Chrome", async () => {
    const [chrome, ours] = await steps([
      [
        'rate set in the task that made it',
        `window.a = document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 10000); a.playbackRate = 2`,
      ],
      ['pause', 'a.pause()'],
      ['rate set while paused', 'a.playbackRate = 3'],
      ['rate updated while paused', 'a.updatePlaybackRate(4)'],
      ['play', 'a.play()'],
      [
        'pending for frames',
        `window.q = document.body.animate({ opacity: [0, 1] }, { timeline: new ScrollTimeline({ source: document.createElement('div') }) })`,
      ],
      ['cancelled after frames', 'q.cancel()'],
      [
        'scroll-driven',
        `window.sc = document.body.appendChild(Object.assign(document.createElement('div'), { style: 'height: 100px; overflow: scroll' }));
         sc.appendChild(Object.assign(document.createElement('div'), { style: 'height: 1000px' }));
         window.s = sc.animate({ opacity: [0, 1] }, { timeline: new ScrollTimeline({ source: sc }) })`,
      ],
      ['scroll-driven paused', 's.pause()'],
      ['scroll-driven played', 's.play()'],
    ]);
    assert.deepEqual(chrome['rate set in the task that made it'], ['Created 1', 'Started 1']);
    assert.deepEqual(chrome['scroll-driven paused'], ['Canceled 3']);
    assert.deepEqual(ours, chrome);
  });
  test('a cancel or pause before the start reports no start (Chrome: only when a frame ran before it)', async () => {
    const make = (name: string) =>
      `window.${name} = document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 1000);`;
    const [chrome, ours] = await steps([
      ['cancel in a timer', `${make('c')} setTimeout(() => c.cancel())`],
      ['pause in a timer', `${make('p')} setTimeout(() => p.pause())`],
      ['cancel in a microtask', `${make('m')} Promise.resolve().then(() => m.cancel())`],
      ['pause in the next frame', `${make('f')} requestAnimationFrame(() => f.pause())`],
      [
        'pause an unplayed one in a timer',
        `window.u = new Animation(new KeyframeEffect(document.body, { opacity: [0, 1] }, 1000)); setTimeout(() => u.pause())`,
      ],
    ]);
    // Chrome sends a start before the cancel only when a frame's animation update ran before the
    // timer, which depends on the frame timing of the run (see `track`): either sequence is taken
    // from it. Ours never sends one.
    for (const [step, id] of [
      ['cancel in a timer', 1],
      ['pause in a timer', 2],
    ] as const) {
      const without = [`Created ${id}`, `Canceled ${id}`];
      const withStart = [`Created ${id}`, `Started ${id}`, `Canceled ${id}`];
      assert.ok(
        [without, withStart].some(list => JSON.stringify(list) === JSON.stringify(chrome[step])),
        `${step}: ${JSON.stringify(chrome[step])}`
      );
      assert.deepEqual(ours[step], without, step);
      chrome[step] = without;
    }
    assert.deepEqual(ours, chrome);
  });
  test("an error of the domain's own listener fails none of the page's calls (ours)", async () => {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      await t.ours.send('Animation.enable');
      const consoled: string[] = [];
      t.page.on('console', m => consoled.push(m.text()));
      const result = await t.page.evaluate(async () => {
        const errors: unknown[] = [];
        window.addEventListener('error', e => errors.push(e.error instanceof Error ? e.error.message : e.error));
        const probe: unknown = Reflect.get(window, '__devtoolsAnywhereProbe__');
        const onAnimation: unknown = probe && Reflect.get(probe, 'onAnimation');
        if (typeof onAnimation !== 'function' || typeof probe !== 'object' || !probe) return 'no probe';
        const logs = (): number => {
          const list: unknown = Reflect.get(probe, 'logs');
          return Array.isArray(list) ? list.length : -1;
        };
        const before = logs();
        Reflect.apply(onAnimation, probe, [
          () => {
            throw new TypeError('listener');
          },
        ]);
        const a = document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 10000);
        a.play();
        a.cancel();
        new Animation();
        await new Promise(r => setTimeout(r, 50));
        return { errors, logged: logs() - before };
      });
      // Not the page's: no error event, nothing in the Console panel's log, only the browser's console.
      assert.deepEqual(result, { errors: [], logged: 0 });
      assert.equal(consoled.filter(text => text.startsWith('devtools-anywhere: internal error')).length, 4);
      // The domain's own listener still ran: both were announced.
      const created = await until(async () => {
        const list = await t.ours.events('Animation.animationCreated');
        return list.length >= 2 ? list : undefined;
      }, 'both announcements');
      assert.equal(created.length, 2);
      // A seek plays the animation with the browser's own play(), past the hook: nothing to fail it.
      await t.ours.send('Animation.seekAnimations', { animations: ['1'], currentTime: 100 });
      assert.equal(await t.page.evaluate(() => document.getAnimations()[0]?.playState), 'running');
    } finally {
      await t.page.close();
    }
  });
  test("the panel's pause, play, seek and rate pass the page's hooks of Animation.prototype by (ours)", async () => {
    assert.ok(env);
    const t = await openPage(env, [...EVENTS]);
    try {
      await t.ours.send('Animation.enable');
      // Hooks the page adds after the probe, as an animation library or analytics would.
      await t.page.evaluate(() => {
        const calls: string[] = [];
        Reflect.set(window, '__calls', calls);
        const proto = Animation.prototype;
        for (const name of ['play', 'pause'] as const) {
          const f = proto[name];
          proto[name] = function (this: Animation) {
            calls.push(name);
            return f.call(this);
          };
        }
        for (const name of ['playbackRate', 'currentTime']) {
          const own = Object.getOwnPropertyDescriptor(proto, name);
          const set = own?.set;
          if (!own || !set) continue;
          Object.defineProperty(proto, name, {
            ...own,
            set(this: Animation, value: unknown) {
              calls.push(name);
              set.call(this, value);
            },
          });
        }
        const div = document.body.appendChild(document.createElement('div'));
        div.animate({ opacity: [0, 1] }, 100000).id = 'hooked';
      });
      const id = (await until(async () => (await t.ours.events('Animation.animationStarted'))[0], 'the start'))
        .animation.id;
      await t.ours.send('Animation.setPaused', { animations: [id], paused: true });
      await t.ours.send('Animation.seekAnimations', { animations: [id], currentTime: 500 });
      // The rate is written once the pause is no longer pending.
      await t.page.evaluate(async () => {
        await document.getAnimations().find(x => x.id === 'hooked')?.ready;
      });
      await t.ours.send('Animation.setPlaybackRate', { playbackRate: 0.5 });
      const paused = await t.page.evaluate(() => {
        const a = document.getAnimations().find(x => x.id === 'hooked');
        return [a?.playState, a?.currentTime, a?.playbackRate];
      });
      await t.ours.send('Animation.setPaused', { animations: [id], paused: false });
      await t.ours.send('Animation.disable');
      // The disable gives the rate back once the play is no longer pending.
      const state = await t.page.evaluate(async () => {
        const a = document.getAnimations().find(x => x.id === 'hooked');
        await a?.ready;
        await new Promise(r => requestAnimationFrame(r));
        return { playState: a?.playState, rate: a?.playbackRate, calls: Reflect.get(window, '__calls') };
      });
      assert.deepEqual(paused, ['paused', 500, 0.5]);
      assert.deepEqual(state, { playState: 'running', rate: 1, calls: [] });
    } finally {
      await t.page.close();
    }
  });

  test('an error of a listener does not reach a console.error the page wrapped before the probe (ours)', async () => {
    assert.ok(env);
    const page = await env.browser.newPage();
    try {
      await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
      // An error reporter's wrapper, in place before the probe is loaded.
      await page.evaluate(() => {
        const reported: unknown[] = [];
        Reflect.set(window, '__reported', reported);
        const error = console.error;
        console.error = (...args: unknown[]) => {
          reported.push(args[0]);
          error.apply(console, args);
        };
      });
      await page.addScriptTag({ path: PROBE_BUNDLE });
      const reported = await page.evaluate(async () => {
        const probe: unknown = Reflect.get(window, '__devtoolsAnywhereProbe__');
        const onAnimation: unknown = probe && Reflect.get(probe, 'onAnimation');
        if (typeof onAnimation !== 'function' || typeof probe !== 'object' || !probe) return 'no probe';
        Reflect.apply(onAnimation, probe, [
          () => {
            throw new TypeError('listener');
          },
        ]);
        document.body.appendChild(document.createElement('div')).animate({ opacity: [0, 1] }, 10000);
        await new Promise(r => setTimeout(r, 50));
        return Reflect.get(window, '__reported');
      });
      assert.deepEqual(reported, []);
    } finally {
      await page.close();
    }
  });
});
