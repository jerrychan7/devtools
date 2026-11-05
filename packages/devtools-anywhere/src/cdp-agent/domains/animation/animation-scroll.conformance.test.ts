import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSubset, openPage } from '../../../../test-support/conformance.ts';
import type { Protocol } from 'devtools-protocol';
import { EVENTS, env, sleep, until, noneMissing } from '../../../../test-support/animation-conformance.ts';

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
