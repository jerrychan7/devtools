// Page.getResourceTree with same-origin frames: like Chrome, each frame lists the resources of
// the document it shows, and the top one none of theirs. Against Chrome's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

const NETWORK = '/packages/devtools-anywhere/test-support/frame-network.html';
const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const IMAGE = '/packages/devtools-anywhere/test-support/assets/pixel.png';

let env: Env | undefined;
let t: TestPage;

/** Appends `<tag>` loading `url` (with `query` added, to tell the loads apart); resolves on load. */
const append = (tag: 'iframe' | 'object' | 'img', id: string, url: string) =>
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
  t = await openPage(env, []);
  await append('img', 'top-img', `${IMAGE}?n=top`);
  await append('iframe', 'net', NETWORK);
  await append('object', 'obj', CHILD);
  await append('object', 'obj-img', `${IMAGE}?n=object`);
  for (const side of [t.ours, t.chrome]) await side.send('Page.enable');
});
after(() => env?.close());

/** Each frame's resources, by frame name, as `type path`, sorted. */
async function resources(side: Side) {
  const { frameTree } = await side.send('Page.getResourceTree');
  const out: Record<string, string[]> = {};
  const visit = (tree: Protocol.Page.FrameResourceTree) => {
    out[tree.frame.name ?? 'top'] = tree.resources
      .map(r => `${r.type} ${r.mimeType} ${new URL(r.url).pathname.split('/').pop()}${new URL(r.url).search}`)
      .sort();
    tree.childFrames?.forEach(visit);
  };
  visit(frameTree);
  return out;
}

test('each frame lists its own resources, the top one none of its children', async () => {
  const [ours, chrome] = await Promise.all([resources(t.ours), resources(t.chrome)]);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours['net'], ['Image image/png pixel.png?n=early-img']);
});

test('a frame that navigated lists the resources of its new document only', async () => {
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        const frame = document.querySelector<HTMLIFrameElement>('#net');
        if (!frame) throw new Error('no #net');
        frame.onload = resolve;
        frame.src = src;
      }),
    CHILD
  );
  const [ours, chrome] = await Promise.all([resources(t.ours), resources(t.chrome)]);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours['net'], []);
});
