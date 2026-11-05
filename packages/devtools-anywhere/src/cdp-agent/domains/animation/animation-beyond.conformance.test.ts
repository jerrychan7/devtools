import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from '../../../../test-support/conformance.ts';
import {
  EVENTS,
  env,
  sleep,
  until,
  fence,
  aFramePast,
  reports,
  onEachSide,
} from '../../../../test-support/animation-conformance.ts';

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
