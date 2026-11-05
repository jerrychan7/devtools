// Geometry of nodes in same-origin iframes against Chrome's: box models, content quads and
// scrolling in the top viewport (through the iframes' position, border, padding, scrolling and
// transforms), and hit testing into the iframes' documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;

const FIXTURE = '/packages/devtools-anywhere/test-support/frame-geometry.html';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
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
  },
  () => env?.close()
);

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

/**
 * The id (or name) of the node at a point as one side reports it, and its frame: the index of the
 * frame id among those this side reported so far.
 */
async function nodeAt(side: Side, x: number, y: number, frameIds: string[]) {
  try {
    const { backendNodeId, frameId } = await side.send('DOM.getNodeForLocation', { x, y });
    const { node } = await side.send('DOM.describeNode', { backendNodeId });
    const at = (node.attributes ?? []).indexOf('id');
    if (frameId && !frameIds.includes(frameId)) frameIds.push(frameId);
    return { node: at >= 0 ? node.attributes?.[at + 1] : node.nodeName, frame: frameIds.indexOf(frameId ?? '') };
  } catch (e) {
    return { error: e instanceof Error ? e.message.replace(/^.*: /, '') : String(e) };
  }
}

test('DOM.getNodeForLocation looks into iframes', async () => {
  // Like Chrome's, the point is in the top document (scrolled by 30px), not in its viewport.
  // Points on the plain iframe (in its document, its border and
  // its padding, its iframe), on the transformed one and on the top page.
  const points = await t.page.evaluate(() => {
    const out: [number, number][] = [];
    const center = (el: Element | null | undefined, frame?: Element) => {
      const r = el?.getBoundingClientRect();
      const f = frame?.getBoundingClientRect();
      if (r)
        out.push([
          Math.round(r.left + r.width / 2 + (f ? f.left + 12 : 0)),
          Math.round(r.top + r.height / 2 + (f ? f.top + 12 : 0)),
        ]);
    };
    const frame = document.getElementById('fg-frame');
    const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    center(doc?.getElementById('fg-btn'), frame ?? undefined);
    center(doc?.getElementById('fg-scrolled'), frame ?? undefined);
    const r = frame?.getBoundingClientRect();
    if (r)
      out.push([Math.round(r.left + 2), Math.round(r.top + 100)], [Math.round(r.left + 9), Math.round(r.top + 100)]);
    const inner = doc?.getElementById('fg-inner');
    const ir = inner?.getBoundingClientRect();
    if (r && ir) out.push([Math.round(r.left + 12 + ir.left + 20), Math.round(r.top + 12 + ir.top + 15)]);
    out.push([560, 300], [500, 230], [5, 580]);
    return out.map(([x, y]): [number, number] => [x + scrollX, y + scrollY]);
  });
  const frameIds: [string[], string[]] = [[], []];
  for (const [x, y] of points) {
    const [ours, chrome] = await Promise.all([nodeAt(t.ours, x, y, frameIds[0]), nodeAt(t.chrome, x, y, frameIds[1])]);
    assert.deepEqual(ours, chrome, `at ${x}, ${y}`);
  }
});

test('DOM.scrollIntoViewIfNeeded scrolls the iframes and scroll containers holding the node', async () => {
  // In the top page: a scroller holding a node in a shadow tree, far down and right in it; a node
  // past the right edge; one partly below the bottom edge.
  await t.page.evaluate(() => {
    const scroller = document.createElement('div');
    scroller.id = 'fg-top-scroller';
    scroller.style.cssText = 'position:absolute;left:700px;top:40px;width:80px;height:60px;overflow:auto';
    const host = document.createElement('div');
    host.style.cssText = 'width:400px;height:400px';
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<div id="fg-shadowed" style="margin:300px 0 0 250px;width:30px;height:20px"></div>';
    scroller.append(host);
    const wide = document.createElement('div');
    wide.id = 'fg-wide';
    wide.style.cssText = 'position:absolute;left:1400px;top:300px;width:40px;height:20px';
    const partial = document.createElement('div');
    partial.id = 'fg-partial';
    partial.style.cssText = 'position:absolute;left:700px;top:600px;width:40px;height:80px';
    document.body.append(scroller, wide, partial);
  });
  const positions = () =>
    t.page.evaluate(() => {
      const values = [scrollX, scrollY];
      const top = document.getElementById('fg-top-scroller');
      values.push(top?.scrollLeft ?? -1, top?.scrollTop ?? -1);
      for (const id of ['fg-frame', 'fg-turned-frame']) {
        const frame = document.getElementById(id);
        const win = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
        const scroller = win?.document.getElementById('fg-scroller');
        values.push(win?.scrollX ?? -1, win?.scrollY ?? -1, scroller?.scrollLeft ?? -1, scroller?.scrollTop ?? -1);
      }
      return values.map(v => Math.round(v));
    });
  const reset = () =>
    t.page.evaluate(() => {
      scrollTo(0, 30);
      document.getElementById('fg-top-scroller')?.scrollTo(0, 0);
      for (const id of ['fg-frame', 'fg-turned-frame']) {
        const frame = document.getElementById(id);
        const win = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
        win?.scrollTo(0, 12);
        win?.document.getElementById('fg-scroller')?.scrollTo(0, 0);
      }
    });
  const cases: { frame?: string; id: string; rect?: Protocol.DOM.Rect }[] = [
    { frame: 'fg-frame', id: 'fg-scrolled' },
    { frame: 'fg-frame', id: 'fg-far' },
    { frame: 'fg-turned-frame', id: 'fg-scrolled' },
    { frame: 'fg-turned-frame', id: 'fg-far' },
    { id: 'fg-shadowed' },
    { id: 'fg-wide' },
    { id: 'fg-partial' },
    { id: 'fg-partial', rect: { x: 0, y: 70, width: 10, height: 10 } },
  ];
  const seen: number[][][] = [];
  for (const side of [t.ours, t.chrome]) {
    const results = [];
    for (const { frame, id, rect } of cases) {
      await reset();
      let node: DomNode | null | undefined;
      if (frame) node = await nodeIn(side, frame, id);
      else {
        const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
        node = find(root, hasId(id));
      }
      assert.ok(node, `#${id}`);
      await side.send('DOM.scrollIntoViewIfNeeded', { nodeId: node.nodeId, ...(rect && { rect }) });
      results.push(await positions());
    }
    seen.push(results);
  }
  await t.page.evaluate(() => {
    for (const id of ['fg-top-scroller', 'fg-wide', 'fg-partial']) document.getElementById(id)?.remove();
  });
  await reset();
  assert.deepEqual(seen[0], seen[1]);
});
