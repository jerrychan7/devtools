// Same-origin iframes in shadow trees: like Chrome, each gets a frame, so it appears in the Page
// frame tree and events, as a DOM contentDocument, with an execution context and with its
// requests, against Chrome's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import {
  VOLATILE,
  diffSubset,
  launch,
  openPage,
  waitForBoth,
  setUpAndTearDown,
} from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

for (const key of ['id', 'parentId']) VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const NETWORK = '/packages/devtools-anywhere/test-support/frame-network.html';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, [
      'Page.frameAttached',
      'Page.frameNavigated',
      'Page.frameDetached',
      'Runtime.executionContextCreated',
      'Network.requestWillBeSent',
    ]);
    // An iframe in a shadow tree, holding one in a shadow tree of its own document; there before
    // DevTools connects.
    await t.page.evaluate(
      src =>
        new Promise(resolve => {
          const host = Object.assign(document.createElement('div'), { id: 'open-host' });
          const frame = Object.assign(document.createElement('iframe'), { id: 'outer', src });
          frame.onload = () => {
            const doc = frame.contentDocument;
            if (!doc) throw new Error('no document');
            const inner = Object.assign(doc.createElement('iframe'), { id: 'inner', srcdoc: '<b>in</b>' });
            inner.onload = resolve;
            doc.body.attachShadow({ mode: 'open' }).append(inner);
          };
          host.attachShadow({ mode: 'open' }).append(frame);
          document.body.append(host);
        }),
      CHILD
    );
    for (const side of [t.ours, t.chrome]) {
      await side.send('Page.enable');
      await side.send('Runtime.enable');
      await side.send('Network.enable');
    }
  },
  () => env?.close()
);

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

/** The frame names of a side's frame tree, by frame id. */
async function names(side: Side): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = (tree: Protocol.Page.FrameTree) => {
    out.set(tree.frame.id, tree.frame.name ?? 'top');
    tree.childFrames?.forEach(visit);
  };
  visit((await side.send('Page.getFrameTree')).frameTree);
  return out;
}

test('getFrameTree lists the iframes of shadow trees, nested ones under their frame', async () => {
  const [ours, chrome] = await both(side => side.send('Page.getFrameTree'));
  assert.deepEqual(diffSubset(ours, chrome), []);
  const outer = ours.frameTree.childFrames?.[0];
  assert.equal(outer?.frame.name, 'outer');
  assert.equal(outer?.childFrames?.[0]?.frame.name, 'inner');
});

test('DOM.getDocument with pierce gives the iframes of shadow trees their frame and document', async () => {
  const owners = async (side: Side) => {
    const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
    const frameNames = await names(side);
    const out: { id: string | undefined; frame: string | undefined; documentURL: string | undefined }[] = [];
    const visit = (n: Protocol.DOM.Node) => {
      if (n.nodeName === 'IFRAME') {
        const id = n.attributes?.[n.attributes.indexOf('id') + 1];
        out.push({ id, frame: frameNames.get(n.frameId ?? ''), documentURL: n.contentDocument?.documentURL });
      }
      [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])].forEach(
        visit
      );
    };
    visit(root);
    return out;
  };
  const [ours, chrome] = await both(owners);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(
    ours.map(o => o.frame),
    ['outer', 'inner']
  );
});

test('Runtime.enable announces an execution context for each of them', async () => {
  const frames = async (side: Side) => {
    const frameNames = await names(side);
    return (await side.events('Runtime.executionContextCreated'))
      .filter(e => e.context.auxData?.['isDefault'])
      .map(e => frameNames.get(String(e.context.auxData?.['frameId'])))
      .sort();
  };
  const [ours, chrome] = await both(frames);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, ['inner', 'outer', 'top']);
});

test('an iframe added to a shadow tree attached later is attached and navigated, its requests its own', async () => {
  await both(side => side.clear());
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        const host = Object.assign(document.createElement('section'), { id: 'late-host' });
        document.body.append(host);
        const root = host.attachShadow({ mode: 'closed' });
        root.append(Object.assign(document.createElement('iframe'), { id: 'late', src, onload: resolve }));
      }),
    NETWORK
  );
  await waitForBoth(t, 'Page.frameNavigated');
  const [ours, chrome] = await both(async side => {
    const frameNames = await names(side);
    const requests = (await side.events('Network.requestWillBeSent'))
      .filter(e => /early-(fetch|xhr|img)/.test(e.request.url))
      .map(e => `${frameNames.get(e.frameId ?? '')} ${new URL(e.request.url).search}`)
      .sort();
    return {
      attached: (await side.events('Page.frameAttached')).map(e => frameNames.get(e.frameId)),
      navigated: (await side.events('Page.frameNavigated')).map(e => e.frame.name),
      requests,
    };
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours.attached, ['late']);
  assert.equal(ours.requests.length, 3);
});

test('removing a shadow host detaches the frames of its shadow tree, the innermost first', async () => {
  await both(side => side.clear());
  const before = await both(names);
  await t.page.evaluate(() => document.querySelector('#open-host')?.remove());
  const [ours, chrome] = await waitForBoth(t, 'Page.frameDetached', 2);
  assert.deepEqual(
    ours.map(e => before[0].get(e.frameId)),
    chrome.map(e => before[1].get(e.frameId))
  );
  assert.deepEqual(
    ours.map(e => before[0].get(e.frameId)),
    ['inner', 'outer']
  );
});
