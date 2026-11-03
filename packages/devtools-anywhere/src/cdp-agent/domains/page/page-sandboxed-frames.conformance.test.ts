// Sandboxed iframes without allow-same-origin, whose same-origin document is opaque: in the Page
// domain, against Chrome's. Chrome keeps them in the page's frame tree, with no child target.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, EventName, TestPage } from '../../../../test-support/conformance.ts';

for (const key of ['id', 'parentId', 'parentFrameId']) VOLATILE.add(key);

const BASE = '/packages/devtools-anywhere/test-support/';
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
  t = await openPage(env, [...EVENTS, 'Target.attachedToTarget', 'Network.requestWillBeSent']);
  for (const side of [t.ours, t.chrome]) {
    await side.send('Page.enable');
    await side.send('Network.enable');
  }
  await t.chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
});
after(() => env?.close());

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

/** Checks on each side that the request to `marker` has the loader of the frame's navigation. */
async function sameLoader(marker: string) {
  for (const side of [t.ours, t.chrome]) {
    let sent: Protocol.Network.RequestWillBeSentEvent | undefined;
    for (let i = 0; i < 100 && !sent; i++) {
      sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes(marker));
      if (!sent) await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(sent, marker);
    const navigated = (await side.events('Page.frameNavigated')).find(e => e.frame.id === sent.frameId);
    assert.equal(sent.loaderId, navigated?.frame.loaderId, marker);
  }
}

const sequence = (events: { method: string }[]) => events.map(e => e.method);

/** Adds sandboxed iframes, then waits until both sides sent frameStoppedLoading for each. */
async function add(frames: [id: string, sandbox: string, src: string | null][]) {
  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(
    `Promise.all(${JSON.stringify(frames)}.map(([id, sb, src]) => new Promise(r => {
      const f = document.createElement('iframe'); f.id = id; f.setAttribute('sandbox', sb);
      if (src) f.src = src; else f.srcdoc = '<b>x</b>';
      f.onload = r; document.body.append(f);
    })))`
  );
  await waitForBoth(t, 'Page.frameStoppedLoading', frames.length);
}

test('sandboxed iframes are attached and navigated in the page, with no child target', async () => {
  await add([
    ['s1', 'allow-scripts', `${BASE}frame-child.html?n=s1#x`],
    ['s2', '', `${BASE}frame-other.html?n=s2`],
    ['s3', 'allow-scripts', null],
  ]);
  const [ours, chrome] = await recorded();
  // Each frame's events in Chrome's order; across frames the order may differ.
  for (const id of ['s1', 's2', 's3']) {
    const of = (events: typeof ours) => {
      const frameId = (
        events.find(e => (e.params as { frame?: { name?: string } }).frame?.name === id)?.params as
          | Protocol.Page.FrameNavigatedEvent
          | undefined
      )?.frame.id;
      return events.filter(e => {
        const p = e.params as { frameId?: string; frame?: { id: string } };
        return (p.frameId ?? p.frame?.id) === frameId;
      });
    };
    assert.deepEqual(sequence(of(ours)), sequence(of(chrome)), id);
    assert.deepEqual(diffSubset(of(ours), of(chrome)), [], id);
  }
  assert.deepEqual(await t.chrome.events('Target.attachedToTarget'), []);
  await sameLoader('n=s1');
  await sameLoader('n=s2');
});

test('getFrameTree lists them with ids the same as DOM and Network give', async () => {
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getFrameTree'), t.chrome.send('Page.getFrameTree')]);
  assert.deepEqual(diffSubset(ours, chrome), []);
  for (const side of [t.ours, t.chrome]) {
    const { frameTree } = await side.send('Page.getFrameTree');
    const s1 = frameTree.childFrames?.find(c => c.frame.name === 's1')?.frame;
    assert.ok(s1);
    const { root } = await side.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#s1' });
    const { node } = await side.send('DOM.describeNode', { nodeId });
    assert.equal(node.frameId, s1.id);
    const sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes('n=s1'));
    assert.equal(sent?.frameId, s1.id);
  }
});

test('a sandboxed iframe navigating, then removed', async () => {
  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(
    `new Promise(r => { const f = document.getElementById('s2'); f.onload = r; f.src = '${BASE}frame-child.html?n=s2b'; })`
  );
  await waitForBoth(t, 'Page.frameStoppedLoading', 1);
  let [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
  await sameLoader('n=s2b');

  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(`document.getElementById('s2').remove()`);
  await waitForBoth(t, 'Page.frameDetached', 1);
  [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
});
