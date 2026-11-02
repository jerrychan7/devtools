// Same-origin iframes in the Page domain: the frame tree and the events of frames attached,
// navigated and detached, against Chrome's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, EventName, TestPage } from '../../../../test-support/conformance.ts';

for (const key of ['id', 'parentId', 'parentFrameId']) VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const OTHER = '/packages/devtools-anywhere/test-support/frame-other.html';
const EVENTS: EventName[] = [
  'Page.frameAttached',
  'Page.frameNavigated',
  'Page.frameDetached',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
];

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, EVENTS);
  // A srcdoc iframe holding another one, there before DevTools connects.
  await t.page.evaluate(
    () =>
      new Promise(resolve => {
        const frame = document.createElement('iframe');
        frame.id = 'pre';
        frame.srcdoc = '<iframe name="inner" srcdoc="<b>in</b>"></iframe>';
        frame.onload = resolve;
        document.body.append(frame);
      })
  );
  for (const side of [t.ours, t.chrome]) await side.send('Page.enable');
});
after(() => env?.close());

/** The Page events of both sides in the order they came, without the stack of frameAttached. */
async function recorded() {
  const read = async (side: TestPage['ours']) => {
    const all: { method: string; params: unknown }[] = [];
    for (const method of EVENTS)
      for (const params of await side.events(method)) {
        const { stack: _, ...rest } = params as { stack?: unknown };
        all.push({ method, params: rest });
      }
    return all;
  };
  return Promise.all([read(t.ours), read(t.chrome)]);
}

/** Runs `action` in the page, then waits until both sides sent `count` frameStoppedLoading. */
async function act(action: () => Promise<unknown>, until: EventName = 'Page.frameStoppedLoading', count = 1) {
  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await action();
  await waitForBoth(t, until, count);
}

const sequence = (events: { method: string }[]) => events.map(e => e.method);

test('getFrameTree and getResourceTree list same-origin iframes as child frames', async () => {
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getFrameTree'), t.chrome.send('Page.getFrameTree')]);
  assert.deepEqual(diffSubset(ours, chrome), []);
  const pre = ours.frameTree.childFrames?.[0];
  assert.equal(pre?.frame.parentId, ours.frameTree.frame.id);
  assert.equal(pre?.frame.name, 'pre');
  assert.equal(pre?.childFrames?.[0]?.frame.name, 'inner');
  assert.equal(pre?.childFrames?.[0]?.frame.parentId, pre?.frame.id);

  const [a, b] = await Promise.all([t.ours.send('Page.getResourceTree'), t.chrome.send('Page.getResourceTree')]);
  assert.deepEqual(diffSubset(a.frameTree.childFrames, b.frameTree.childFrames), []);
  assert.deepEqual(diffSubset(a.frameTree.frame, b.frameTree.frame), []);
});

test('an iframe with a src: attached, then navigated once its document commits', async () => {
  await act(() =>
    t.page.evaluate(
      src =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { id: 'a', src, onload: resolve });
          document.body.append(frame);
        }),
      CHILD
    )
  );
  const [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
});

test('an empty iframe is navigated to about:blank right away', async () => {
  await act(() =>
    t.page.evaluate(() => {
      document.body.append(Object.assign(document.createElement('iframe'), { id: 'blank' }));
    })
  );
  const [ours, chrome] = await recorded();
  // Chrome reports the navigation before it starts loading.
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
});

test('an iframe navigating to another document, and its fragment in the frame tree', async () => {
  await act(() =>
    t.page.evaluate(
      src =>
        new Promise(resolve => {
          const frame = document.querySelector<HTMLIFrameElement>('#a');
          if (!frame) throw new Error('no #a');
          frame.onload = resolve;
          frame.src = `${src}#part`;
        }),
      OTHER
    )
  );
  const [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
  const navigated = ours.find(e => e.method === 'Page.frameNavigated')?.params as Protocol.Page.FrameNavigatedEvent;
  assert.equal(navigated.frame.urlFragment, '#part');
  const [a, b] = await Promise.all([t.ours.send('Page.getFrameTree'), t.chrome.send('Page.getFrameTree')]);
  assert.deepEqual(diffSubset(a, b), []);
});

test('removing an iframe detaches its frames, the innermost first', async () => {
  await act(
    () =>
      t.page.evaluate(() => {
        document.querySelector('#pre')?.remove();
      }),
    'Page.frameDetached',
    2
  );
  const [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
  const [a, b] = await Promise.all([t.ours.send('Page.getFrameTree'), t.chrome.send('Page.getFrameTree')]);
  assert.equal(a.frameTree.childFrames?.length, b.frameTree.childFrames?.length);
});

test('Page.disable stops the frame events', async () => {
  await t.ours.send('Page.disable');
  await t.ours.clear();
  await t.page.evaluate(() => document.querySelector('#blank')?.remove());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await t.ours.events('Page.frameDetached'), []);
  await t.ours.send('Page.enable');
});
