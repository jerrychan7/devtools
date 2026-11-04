// Navigations a Navigation API `navigate` listener intercepts, in the top page and a same-origin
// iframe: Chrome reports each once, as `other`, when it commits, whatever started it. Against
// Chrome's Page.navigatedWithinDocument.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['Page.navigatedWithinDocument']);
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        document.body.append(Object.assign(document.createElement('iframe'), { id: 'f', src, onload: resolve }));
      }),
    CHILD
  );
  // In each window, `intercepting` decides whether its listener intercepts; the handler of an
  // intercepted navigation settles a little later, so that the reports are seen to come first.
  await t.page.evaluate(() => {
    for (const win of [window, document.querySelector('iframe')?.contentWindow]) {
      if (!win) continue;
      Object.assign(win, { intercepting: true });
      win.navigation.addEventListener('navigate', event => {
        if (Reflect.get(win, 'intercepting') && event.canIntercept) {
          event.intercept({ handler: () => new Promise(resolve => setTimeout(resolve, 200)) });
        }
      });
    }
  });
  for (const side of [t.ours, t.chrome]) await side.send('Page.enable');
});
after(() => env?.close());

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

/** The events of a side as [frame, URL, type]. */
async function navigations(side: Side) {
  const { frameTree } = await side.send('Page.getFrameTree');
  return (await side.events('Page.navigatedWithinDocument')).map(e => [
    e.frameId === frameTree.frame.id ? 'top' : 'f',
    e.url.slice(e.url.lastIndexOf('/') + 1),
    e.navigationType,
  ]);
}

/**
 * Runs `script` with `win` the window of the top page or the iframe; once both sides reported
 * `count` navigations and a little more time passed (for any reported twice), compares them.
 */
async function run(where: 'top' | 'f', script: string, count: number) {
  await both(side => side.clear());
  const win = where === 'top' ? 'window' : "document.querySelector('#f').contentWindow";
  await t.page.evaluate(`(win => { ${script} })(${win})`);
  await waitForBoth(t, 'Page.navigatedWithinDocument', count);
  await new Promise(resolve => setTimeout(resolve, 300));
  const [ours, chrome] = await both(navigations);
  assert.deepEqual(ours, chrome);
  return ours;
}

for (const where of ['top', 'f'] as const) {
  const page = where === 'top' ? 'fixture.html' : 'frame-child.html';

  test(`${where}: navigation.navigate(), a push and a replace`, async () => {
    const ours = await run(
      where,
      `win.navigation.navigate('a.html'); win.navigation.navigate('b.html', { history: 'replace' });`,
      2
    );
    assert.deepEqual(ours, [
      [where, 'a.html', 'other'],
      [where, 'b.html', 'other'],
    ]);
  });

  test(`${where}: the history methods, location and a reload, intercepted`, async () => {
    const ours = await run(
      where,
      `win.history.pushState(null, '', 'c.html'); win.history.replaceState(null, '', 'd.html');
       win.location.hash = 'h'; win.navigation.reload();`,
      4
    );
    assert.deepEqual(ours, [
      [where, 'c.html', 'other'],
      [where, 'd.html', 'other'],
      [where, 'd.html#h', 'other'],
      [where, 'd.html#h', 'other'],
    ]);
  });

  test(`${where}: a traversal, intercepted`, async () => {
    const ours = await run(where, `win.navigation.back();`, 1);
    assert.deepEqual(ours, [[where, 'd.html', 'other']]);
  });

  test(`${where}: navigations not intercepted are reported as before`, async () => {
    const ours = await run(
      where,
      `win.intercepting = false; win.history.pushState(null, '', '${page}'); win.location.hash = 'n';`,
      2
    );
    assert.deepEqual(ours, [
      [where, page, 'historyApi'],
      [where, `${page}#n`, 'fragment'],
    ]);
    await run(where, `win.history.back(); win.intercepting = true;`, 1);
  });
}
