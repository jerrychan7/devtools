// Geometry of nodes in same-origin iframes against Chrome's: box models, content quads and
// scrolling in the top viewport (through the iframes' position, border, padding, scrolling and
// transforms).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;

const FIXTURE = '/packages/devtools-anywhere/test-support/frame-geometry.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.setViewport({ width: 800, height: 600 });
  // A plain iframe with a border and padding, and a transformed one; the top page, both
  // iframes and a scroller in the first one are scrolled.
  await t.page.evaluate(
    src =>
      Promise.all(
        [
          'left:20px;top:200px;width:320px;height:300px;border:5px solid;padding:7px',
          'left:380px;top:180px;width:300px;height:280px;border:4px solid;padding:3px;transform:rotate(8deg) scale(1.1)',
        ].map(
          (style, i) =>
            new Promise(resolve => {
              const frame = document.createElement('iframe');
              frame.id = `fg-${i ? 'turned-frame' : 'frame'}`;
              frame.style.cssText = `position:absolute;z-index:10;background:#fff;${style}`;
              frame.onload = resolve;
              frame.src = src;
              document.body.append(frame);
            })
        )
      ).then(() => {
        document.body.style.minHeight = '2000px';
        scrollTo(0, 30);
        for (const frame of document.querySelectorAll('iframe')) {
          const win = frame.contentWindow;
          if (!win || !frame.id) continue;
          win.scrollTo(0, 12);
          win.document.getElementById('fg-scroller')?.scrollTo(0, 150);
        }
      }),
    FIXTURE
  );
});
after(() => env?.close());

function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  const next = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
  if (node.contentDocument) next.push(node.contentDocument);
  for (const child of next) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const hasId = (id: string) => (n: DomNode) =>
  (n.attributes ?? []).some((v, i) => i % 2 === 0 && v === 'id' && n.attributes?.[i + 1] === id);

/** The node `#id` in the iframe `#frame` (and in its iframe `#fg-inner` if `deep`). */
async function nodeIn(side: Side, frame: string, id: string, deep = false): Promise<DomNode> {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  let scope = find(root, hasId(frame))?.contentDocument;
  if (deep) scope = scope && find(scope, hasId('fg-inner'))?.contentDocument;
  const node = scope && find(scope, hasId(id));
  assert.ok(node, `#${frame} #${id}`);
  return node;
}

const close = (ours: number[], chrome: number[], what: string) => {
  assert.equal(ours.length, chrome.length, `${what}: ${ours} vs ${chrome}`);
  ours.forEach((v, i) => assert.ok(Math.abs(v - (chrome[i] ?? NaN)) <= 0.5, `${what}[${i}]: ${v} vs ${chrome[i]}`));
};

const CASES: [frame: string, id: string, deep?: boolean][] = [];
for (const frame of ['fg-frame', 'fg-turned-frame']) {
  for (const id of ['fg-btn', 'fg-turned', 'fg-text', 'fg-bold', 'fg-scrolled', 'fg-inner']) CASES.push([frame, id]);
  CASES.push([frame, 'fg-deep', true]);
}

for (const [frame, id, deep] of CASES) {
  test(`DOM.getBoxModel and DOM.getContentQuads of #${frame} ${deep ? '#fg-inner ' : ''}#${id}`, async () => {
    const ours = await nodeIn(t.ours, frame, id, deep);
    const chrome = await nodeIn(t.chrome, frame, id, deep);
    const [a, b] = await Promise.all([
      t.ours.send('DOM.getBoxModel', { nodeId: ours.nodeId }),
      t.chrome.send('DOM.getBoxModel', { nodeId: chrome.nodeId }),
    ]);
    for (const box of ['content', 'padding', 'border', 'margin'] as const) close(a.model[box], b.model[box], box);
    assert.equal(a.model.width, b.model.width, 'width');
    assert.equal(a.model.height, b.model.height, 'height');
    const [qa, qb] = await Promise.all([
      t.ours.send('DOM.getContentQuads', { nodeId: ours.nodeId }),
      t.chrome.send('DOM.getContentQuads', { nodeId: chrome.nodeId }),
    ]);
    assert.equal(qa.quads.length, qb.quads.length, 'quads');
    qa.quads.forEach((q, i) => close(q, qb.quads[i] ?? [], `quads[${i}]`));
  });
}

test('DOM.getContentQuads of a text node in an iframe', async () => {
  const quads = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      const p = await nodeIn(side, 'fg-turned-frame', 'fg-text');
      const text = p.children?.[0];
      assert.equal(text?.nodeType, 3);
      return (await side.send('DOM.getContentQuads', { nodeId: text.nodeId })).quads;
    })
  );
  const [ours = [], chrome = []] = quads;
  assert.equal(ours.length, chrome.length);
  ours.forEach((q, i) => close(q, chrome[i] ?? [], `quads[${i}]`));
});

test('DOM.scrollIntoViewIfNeeded scrolls the iframes holding the node', async () => {
  const positions = () =>
    t.page.evaluate(() => {
      const frame = document.getElementById('fg-frame');
      const win = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
      return [scrollY, win?.scrollY, win?.document.getElementById('fg-scroller')?.scrollTop].map(v =>
        Math.round(v ?? -1)
      );
    });
  const reset = () =>
    t.page.evaluate(() => {
      scrollTo(0, 30);
      const frame = document.getElementById('fg-frame');
      const win = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
      win?.scrollTo(0, 12);
      win?.document.getElementById('fg-scroller')?.scrollTo(0, 0);
    });
  const seen = [];
  for (const side of [t.ours, t.chrome]) {
    const results = [];
    for (const id of ['fg-scrolled', 'fg-far']) {
      await reset();
      const node = await nodeIn(side, 'fg-frame', id);
      await side.send('DOM.scrollIntoViewIfNeeded', { nodeId: node.nodeId });
      results.push(await positions());
    }
    seen.push(results);
  }
  await reset();
  assert.deepEqual(seen[0], seen[1]);
});
