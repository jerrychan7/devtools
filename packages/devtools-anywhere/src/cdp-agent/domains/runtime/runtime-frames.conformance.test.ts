// Same-origin iframes in the Runtime domain: an execution context per frame document, created and
// destroyed as frames come, navigate and go, against Chrome's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const OTHER = '/packages/devtools-anywhere/test-support/frame-other.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'Runtime.executionContextCreated',
    'Runtime.executionContextDestroyed',
    'Runtime.consoleAPICalled',
    'Runtime.exceptionThrown',
  ]);
  // A srcdoc iframe, there before DevTools connects.
  await t.page.evaluate(
    () =>
      new Promise(resolve => {
        const frame = Object.assign(document.createElement('iframe'), { id: 'pre', onload: resolve });
        frame.srcdoc = '<p id="in">pre</p><script>var where = "pre"; let lexical = 1;</script>';
        document.body.append(frame);
      })
  );
  for (const side of [t.ours, t.chrome]) await side.send('Runtime.enable');
});
after(() => env?.close());

/**
 * The default contexts a side announced and destroyed, in order, as frame paths (`top`, `#pre`,
 * …) rather than ids: Chrome also has Puppeteer's isolated worlds.
 */
async function lifecycle(side: Side, frameName: (frameId: string) => Promise<string>) {
  const created = (await side.events('Runtime.executionContextCreated')).filter(e => e.context.auxData?.['isDefault']);
  const ids = new Set(created.map(e => e.context.id));
  const destroyed = (await side.events('Runtime.executionContextDestroyed')).filter(e => ids.has(e.executionContextId));
  return {
    created: await Promise.all(
      created.map(async e => {
        const { id: _, ...context } = e.context;
        return { ...context, frame: await frameName(String(context.auxData?.['frameId'])) };
      })
    ),
    destroyed: destroyed.length,
  };
}

/** Names frames by the id of their `<iframe>`, from each side's frame tree. */
function namer(side: Side) {
  return async (frameId: string) => {
    const { frameTree } = await side.send('Page.getFrameTree');
    const visit = (tree: Protocol.Page.FrameTree): string | undefined =>
      tree.frame.id === frameId
        ? (tree.frame.name ?? 'top')
        : tree.childFrames?.map(visit).find(name => name !== undefined);
    return visit(frameTree) ?? 'gone';
  };
}

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

describe('execution contexts', () => {
  test('Runtime.enable announces the context of each frame, newest first', async () => {
    const [ours, chrome] = await both(side => lifecycle(side, namer(side)));
    assert.deepEqual(
      ours.created.map(c => c.frame),
      chrome.created.map(c => c.frame)
    );
    assert.deepEqual(diffSubset(ours.created, chrome.created), []);
    assert.equal(ours.created.find(c => c.frame === 'pre')?.origin, new URL(env?.baseUrl ?? '').origin);
  });

  test('an iframe gets a context when its document commits, a new one when it navigates', async () => {
    await both(side => side.clear());
    await t.page.evaluate(
      src =>
        new Promise(resolve => {
          document.body.append(Object.assign(document.createElement('iframe'), { id: 'a', src, onload: resolve }));
        }),
      CHILD
    );
    await waitForBoth(t, 'Runtime.executionContextCreated');
    let [ours, chrome] = await both(side => lifecycle(side, namer(side)));
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.deepEqual(
      ours.created.map(c => c.frame),
      ['a']
    );

    // The old context is destroyed before the new one is created.
    await t.page.evaluate(
      src =>
        new Promise(resolve => {
          const frame = document.querySelector<HTMLIFrameElement>('#a');
          if (!frame) throw new Error('no #a');
          frame.onload = resolve;
          frame.src = src;
        }),
      OTHER
    );
    await waitForBoth(t, 'Runtime.executionContextCreated', 2);
    [ours, chrome] = await both(side => lifecycle(side, namer(side)));
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.equal(ours.destroyed, 1);
  });

  test('removing an iframe destroys its context', async () => {
    await both(side => side.clear());
    await t.page.evaluate(() => document.querySelector('#a')?.remove());
    await waitForBoth(t, 'Runtime.executionContextDestroyed');
    const [ours] = await t.ours.events('Runtime.executionContextDestroyed');
    assert.ok(ours?.executionContextUniqueId);
  });
});
