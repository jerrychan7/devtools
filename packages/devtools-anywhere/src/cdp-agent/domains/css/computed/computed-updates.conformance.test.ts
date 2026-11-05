import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['CSS.computedStyleUpdated']);
  await t.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="a">a<b id="b">b</b></div>'));
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const run = (f: () => void) => t.page.evaluate(f);

async function nodeId(side: Side, selector: string) {
  const root = (await side.send('DOM.getDocument', { depth: -1 })).root;
  return (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
}

/** How many `CSS.computedStyleUpdated` each side sent for its node after `action`, cleared first. */
async function updatesAfter(
  action: () => void,
  ids: [ours: number, chrome: number],
  wait = 300
): Promise<[ours: number, chrome: number]> {
  await t.ours.clear();
  await t.chrome.clear();
  await run(action);
  await sleep(wait);
  const [o, c] = [await t.ours.events('CSS.computedStyleUpdated'), await t.chrome.events('CSS.computedStyleUpdated')];
  assert.ok(o.every(e => e.nodeId === ids[0]));
  assert.ok(c.every(e => e.nodeId === ids[1]));
  return [o.length, c.length];
}

describe('CSS.trackComputedStyleUpdatesForNode', () => {
  test('reports changes of the node computed style, throttled, until untracked', async () => {
    const ids: [number, number] = [await nodeId(t.ours, '#a'), await nodeId(t.chrome, '#a')];
    // Like Chrome, an unknown node is no error.
    for (const side of [t.ours, t.chrome])
      assert.deepEqual(await side.send('CSS.trackComputedStyleUpdatesForNode', { nodeId: 999999 }), {});
    await t.ours.send('CSS.trackComputedStyleUpdatesForNode', { nodeId: ids[0] });
    await t.chrome.send('CSS.trackComputedStyleUpdatesForNode', { nodeId: ids[1] });

    const once = (n: number[]) => assert.deepEqual(n, [1, 1]);
    once(await updatesAfter(() => ((document.getElementById('a') as HTMLElement).style.color = 'red'), ids));
    // An attribute that changes no style, and a child's own style, are no update.
    assert.deepEqual(
      await updatesAfter(() => ((document.getElementById('a') as HTMLElement).title = 'x'), ids),
      [0, 0]
    );
    assert.deepEqual(
      await updatesAfter(() => ((document.getElementById('b') as HTMLElement).style.color = 'blue'), ids),
      [0, 0]
    );
    // An inherited value is.
    once(await updatesAfter(() => (document.body.style.fontSize = '30px'), ids));
    // Four changes 50ms apart are sent fewer times: throttled.
    const [o, c] = await updatesAfter(
      () => {
        const s = (document.getElementById('a') as HTMLElement).style;
        s.width = '1px';
        setTimeout(() => (s.width = '9px'), 50);
        setTimeout(() => (s.width = '19px'), 100);
        setTimeout(() => (s.width = '29px'), 150);
      },
      ids,
      800
    );
    // Chrome's count varies with timing (2 or 3 seen).
    for (const n of [o, c]) assert.ok(n >= 2 && n <= 3, `sent ${o} (ours), ${c} (Chrome)`);

    for (const side of [t.ours, t.chrome]) await side.send('CSS.trackComputedStyleUpdatesForNode', {});
    assert.deepEqual(
      await updatesAfter(() => ((document.getElementById('a') as HTMLElement).style.color = 'green'), ids),
      [0, 0]
    );
  });
});

describe('CSS.trackComputedStyleUpdates', () => {
  test('a take without tracking fails as in Chrome', async () => {
    const errors = await Promise.all(
      [t.ours, t.chrome].map(side =>
        side.send('CSS.takeComputedStyleUpdates').then(
          () => '',
          e => String(e)
        )
      )
    );
    for (const e of errors) assert.match(e, /No computed styles are being tracked right now/);
  });

  test('a take waits for a tracked property to change on a known node', async () => {
    const ids = await Promise.all([t.ours, t.chrome].map(side => nodeId(side, '#b')));
    for (const side of [t.ours, t.chrome])
      await side.send('CSS.trackComputedStyleUpdates', { propertiesToTrack: [{ name: 'display', value: 'block' }] });
    let done = 0;
    const takes = [t.ours, t.chrome].map(side =>
      side.send('CSS.takeComputedStyleUpdates').then(r => {
        done++;
        return r.nodeIds;
      })
    );
    await sleep(200);
    // Not a tracked property.
    await run(() => ((document.getElementById('b') as HTMLElement).style.color = 'pink'));
    await sleep(200);
    assert.equal(done, 0);
    await run(() => ((document.getElementById('b') as HTMLElement).style.display = 'block'));
    assert.deepEqual(await Promise.all(takes), [[ids[0]], [ids[1]]]);
  });

  test('untracking answers a waiting take with none', async () => {
    const takes = [t.ours, t.chrome].map(side => side.send('CSS.takeComputedStyleUpdates'));
    await sleep(200);
    for (const side of [t.ours, t.chrome]) await side.send('CSS.trackComputedStyleUpdates', { propertiesToTrack: [] });
    assert.deepEqual(await Promise.all(takes), [{ nodeIds: [] }, { nodeIds: [] }]);
  });
});
