// Same-origin documents in `<object>` and `<embed>`: Chrome gives each a frame like an iframe's,
// in the Page frame tree and events, as a DOM contentDocument and with an execution context; not
// to an `<object>` showing an image. Against Chrome's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

for (const key of ['id', 'parentId', 'parentFrameId']) VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const IMAGE = '/packages/devtools-anywhere/test-support/assets/pixel.png';

let env: Env | undefined;
let t: TestPage;

/** Appends an `<object>` or `<embed>` loading `url`; resolves once it loaded. */
const append = (tag: 'object' | 'embed', id: string, url: string) =>
  t.page.evaluate(
    (tag, id, url) =>
      new Promise(resolve => {
        const el = document.createElement(tag);
        el.id = id;
        if (el instanceof HTMLObjectElement) el.data = url;
        else el.src = url;
        el.onload = resolve;
        document.body.append(el);
      }),
    tag,
    id,
    url
  );

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'Page.frameAttached',
    'Page.frameNavigated',
    'Page.frameDetached',
    'Runtime.executionContextCreated',
  ]);
  await append('object', 'obj', CHILD);
  await append('object', 'img', IMAGE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('Page.enable');
    await side.send('Runtime.enable');
  }
});
after(() => env?.close());

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

test('an <object> showing a document is a child frame, one showing an image is not', async () => {
  const [ours, chrome] = await both(side => side.send('Page.getFrameTree'));
  assert.deepEqual(diffSubset(ours, chrome), []);
  assert.deepEqual(
    ours.frameTree.childFrames?.map(c => c.frame.name),
    ['obj']
  );
});

test('an <embed> showing a document is attached and navigated like an iframe', async () => {
  await both(side => side.clear());
  await append('embed', 'emb', CHILD);
  await waitForBoth(t, 'Page.frameNavigated');
  const [ours, chrome] = await both(async side => {
    const frameNames = await names(side);
    return {
      attached: (await side.events('Page.frameAttached')).map(e => frameNames.get(e.frameId)),
      navigated: (await side.events('Page.frameNavigated')).map(e => e.frame),
    };
  });
  assert.deepEqual(diffSubset(ours, chrome), []);
  assert.deepEqual(ours.attached, ['emb']);
});

test('DOM.getDocument gives each its frame id and content document', async () => {
  const owners = async (side: Side) => {
    const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
    const frameNames = await names(side);
    const out: {
      tag: string;
      frame: string | undefined;
      documentURL: string | undefined;
      children: number | undefined;
    }[] = [];
    const visit = (n: Protocol.DOM.Node) => {
      if (n.nodeName === 'OBJECT' || n.nodeName === 'EMBED')
        out.push({
          tag: n.nodeName,
          frame: n.frameId && frameNames.get(n.frameId),
          documentURL: n.contentDocument?.documentURL,
          children: n.contentDocument?.childNodeCount,
        });
      [...(n.children ?? []), ...(n.contentDocument ? [n.contentDocument] : [])].forEach(visit);
    };
    visit(root);
    return out;
  };
  const [ours, chrome] = await both(owners);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(
    ours.map(o => o.frame),
    ['obj', undefined, 'emb']
  );
});

test('each has an execution context', async () => {
  const contexts = async (side: Side) => {
    const frameNames = await names(side);
    return (await side.events('Runtime.executionContextCreated'))
      .filter(e => e.context.auxData?.['isDefault'])
      .map(e => frameNames.get(String(e.context.auxData?.['frameId'])))
      .sort();
  };
  // Runtime.enable again announces every context.
  await both(async side => {
    await side.send('Runtime.disable');
    await side.clear();
    await side.send('Runtime.enable');
  });
  const [ours, chrome] = await both(contexts);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, ['emb', 'obj', 'top']);
});

test('removing an <object> detaches its frame', async () => {
  await both(side => side.clear());
  const before = await both(names);
  await t.page.evaluate(() => document.querySelector('#obj')?.remove());
  const [ours, chrome] = await waitForBoth(t, 'Page.frameDetached');
  assert.deepEqual(diffSubset(ours, chrome), []);
  assert.equal(before[0].get(ours[0]?.frameId ?? ''), 'obj');
});
