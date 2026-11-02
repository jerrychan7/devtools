// Shadow roots that scripts of same-origin iframes attach, against Chrome's: pushed to the client
// like the top page's, closed ones included, and the iframes in them given a frame.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

for (const key of ['nodeId', 'backendNodeId', 'parentId', 'hostId', 'id']) VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['DOM.shadowRootPushed', 'Page.frameAttached']);
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        const frame = Object.assign(document.createElement('iframe'), { id: 'host-frame', src, onload: resolve });
        document.body.append(frame);
      }),
    CHILD
  );
  for (const side of [t.ours, t.chrome]) {
    await side.send('Page.enable');
    await side.send('DOM.getDocument', { depth: -1, pierce: true });
  }
});
after(() => env?.close());

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

/** Runs `script` in the iframe's window. */
const inFrame = (script: (win: Window) => void) =>
  t.page.evaluate(`(${script.toString()})(document.querySelector('#host-frame').contentWindow)`);

test('a shadow root attached in an iframe to a known host is pushed, closed ones too', async () => {
  await both(side => side.clear());
  await inFrame(win => {
    const doc = win.document;
    doc.querySelector('#child')?.attachShadow({ mode: 'closed' });
    doc.body.attachShadow({ mode: 'open' });
  });
  const [ours, chrome] = await waitForBoth(t, 'DOM.shadowRootPushed', 2);
  assert.deepEqual(diffSubset(ours, chrome), []);
  assert.deepEqual(
    ours.map(e => e.root.shadowRootType),
    ['closed', 'open']
  );
});

test('an iframe in a closed shadow root attached in an iframe gets a frame', async () => {
  await both(side => side.clear());
  await t.page.evaluate(`new Promise(resolve => {
    const doc = document.querySelector('#host-frame').contentDocument;
    const host = doc.createElement('div');
    doc.body.append(host);
    const inner = doc.createElement('iframe');
    inner.name = 'deep';
    inner.srcdoc = '<i>deep</i>';
    inner.onload = resolve;
    host.attachShadow({ mode: 'closed' }).append(inner);
  })`);
  await waitForBoth(t, 'Page.frameAttached');
  const [ours, chrome] = await both(side => side.send('Page.getFrameTree'));
  assert.deepEqual(diffSubset(ours, chrome), []);
  const deep = ours.frameTree.childFrames?.[0]?.childFrames?.[0] satisfies Protocol.Page.FrameTree | undefined;
  assert.equal(deep?.frame.name, 'deep');
});
