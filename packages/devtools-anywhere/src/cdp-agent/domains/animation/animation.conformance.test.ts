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

  /** A shadow tree's style sheet that animates its <p>s with `name`. */
  const SHADOW = (name: string) =>
    `<style>@keyframes ${name} { 50% { opacity: 0.5 } } p { animation: ${name} 0.4s infinite }</style><p>x</p>`;

  /** Has the page run `script`, then checks both sides announce the animation `name`. */
  async function announced(script: string, name: string) {
    for (const side of [t.chrome, t.ours]) await side.clear();
    await t.page.evaluate(script);
    const [chrome, ours] = [await started(t.chrome, 1), await started(t.ours, 1)];
    assert.ok(chrome.get(name), 'Chrome announces it');
    assert.ok(ours.get(name), `we announce ${[...ours.keys()].join()} instead`);
    assert.deepEqual(diffSubset(ours.get(name), chrome.get(name)), []);
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
    // A Web Animation named by its id: an iframe's CSS animations are not told apart from Web
    // Animations yet (`instanceof` against the top window's classes), whichever tree they are in.
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
    await sleep(300);
    assert.equal((await t.chrome.events('Animation.animationStarted')).length, 0);
    assert.equal((await t.ours.events('Animation.animationStarted')).length, 0);
  });
});
