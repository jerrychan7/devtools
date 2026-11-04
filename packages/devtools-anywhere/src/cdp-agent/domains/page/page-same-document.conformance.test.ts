// Navigations within the document of a frame (fragments, the History API, traversals), in
// same-origin iframes and the top page, against Chrome's Page.navigatedWithinDocument.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

for (const key of ['id', 'parentId']) VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['Page.navigatedWithinDocument', 'Page.frameNavigated']);
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        document.body.append(Object.assign(document.createElement('iframe'), { id: 'f', src, onload: resolve }));
      }),
    CHILD
  );
  for (const side of [t.ours, t.chrome]) await side.send('Page.enable');
});
after(() => env?.close());

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

/** The events of a side as [frame name, URL, type], frames named from its frame tree. */
async function navigations(side: Side) {
  const { frameTree } = await side.send('Page.getFrameTree');
  const name = (id: string) =>
    id === frameTree.frame.id ? 'top' : frameTree.childFrames?.find(c => c.frame.id === id)?.frame.name;
  return (await side.events('Page.navigatedWithinDocument')).map(e => [
    name(e.frameId),
    e.url.slice(e.url.lastIndexOf('/') + 1),
    e.navigationType,
  ]);
}

/** Runs `script` in the iframe's window, then waits until both sides reported `count` navigations. */
async function inFrame(script: string, count: number) {
  await both(side => side.clear());
  await t.page.evaluate(`(win => { ${script} })(document.querySelector('#f').contentWindow)`);
  await waitForBoth(t, 'Page.navigatedWithinDocument', count);
  const [ours, chrome] = await both(navigations);
  assert.deepEqual(ours, chrome);
  return ours;
}

test('a fragment navigation in an iframe', async () => {
  const ours = await inFrame(`win.location.hash = 'part';`, 1);
  assert.deepEqual(ours, [['f', 'frame-child.html#part', 'fragment']]);
});

test('pushState and replaceState in an iframe, also to the same URL', async () => {
  const ours = await inFrame(
    `win.history.pushState(1, '', 'pushed?q=1#f'); win.history.replaceState(2, '', 'replaced'); win.history.pushState(3, '');`,
    3
  );
  assert.deepEqual(ours, [
    ['f', 'pushed?q=1#f', 'historyApi'],
    ['f', 'replaced', 'historyApi'],
    ['f', 'replaced', 'historyApi'],
  ]);
});

test('going back within the document of an iframe', async () => {
  const ours = await inFrame(`win.history.go(-2);`, 1);
  assert.deepEqual(ours, [['f', 'frame-child.html#part', 'fragment']]);
});

test("the frame tree has the iframe's new URL", async () => {
  const [ours, chrome] = await both(side => side.send('Page.getFrameTree'));
  assert.deepEqual(diffSubset(ours, chrome), []);
  const frame = ours.frameTree.childFrames?.[0]?.frame satisfies Protocol.Page.Frame | undefined;
  assert.match(frame?.url ?? '', /frame-child\.html$/);
  assert.equal(frame?.urlFragment, '#part');
  assert.equal((await t.ours.events('Page.frameNavigated')).length, 0);
});

test('the top page', async () => {
  await both(side => side.clear());
  await t.page.evaluate(() => {
    location.hash = 'top';
    history.pushState(null, '', '?top');
  });
  await waitForBoth(t, 'Page.navigatedWithinDocument', 2);
  const [ours, chrome] = await both(navigations);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, [
    ['top', 'fixture.html#top', 'fragment'],
    ['top', 'fixture.html?top', 'historyApi'],
  ]);
});

test('Page.disable stops the navigations, and enabling again reports each one once', async () => {
  await both(side => side.send('Page.disable'));
  await both(side => side.clear());
  await t.page.evaluate(`document.querySelector('#f').contentWindow.location.hash = 'off';`);
  await new Promise(resolve => setTimeout(resolve, 100));
  // Nothing is reported while disabled.
  assert.deepEqual(await both(side => side.events('Page.navigatedWithinDocument')), [[], []]);
  for (const side of [t.ours, t.chrome]) {
    await side.send('Page.enable');
    await side.send('Page.enable');
  }
  // The navigation made while disabled is not reported late, nor the next one twice.
  const ours = await inFrame(`win.location.hash = 'on';`, 1);
  assert.deepEqual(ours, [['f', 'frame-child.html#on', 'fragment']]);
});
