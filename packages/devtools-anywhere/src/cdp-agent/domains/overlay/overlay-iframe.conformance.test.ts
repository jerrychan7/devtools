// The overlay on nodes of same-origin iframes: highlights drawn in the top page where Chrome
// places the node, and inspect mode picking the node under the mouse inside an iframe.
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
    t = await openPage(env, ['Overlay.inspectNodeRequested']);
    await t.page.setViewport({ width: 800, height: 600 });
    // A rotated iframe, scrolled inside.
    await t.page.evaluate(
      src =>
        new Promise<void>(resolve => {
          const frame = document.createElement('iframe');
          frame.id = 'ov-frame';
          frame.style.cssText =
            'position:absolute;z-index:10;background:#fff;left:300px;top:150px;width:320px;height:300px;border:4px solid;padding:3px;transform:rotate(6deg)';
          frame.onload = () => {
            frame.contentWindow?.scrollTo(0, 10);
            resolve();
          };
          frame.src = src;
          document.body.append(frame);
        }),
      FIXTURE
    );
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('Overlay.enable');
    }
  },
  () => env?.close()
);

function find(node: DomNode, id: string): DomNode | null {
  if ((node.attributes ?? []).some((v, i) => i % 2 === 0 && v === 'id' && node.attributes?.[i + 1] === id)) return node;
  for (const child of [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

async function nodeIn(side: Side, id: string): Promise<DomNode> {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const doc = find(root, 'ov-frame')?.contentDocument;
  const node = doc && find(doc, id);
  assert.ok(node, `#${id}`);
  return node;
}

/** The polygons (or rectangles) of our highlight, as viewport quads. */
const drawnQuads = () =>
  t.page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-devtools-anywhere="overlay"] > div'), d => {
      const r = d.getBoundingClientRect();
      const points = d.querySelector('polygon')?.getAttribute('points');
      return points
        ? points.split(/[ ,]/).map((n, i) => Number(n) + (i % 2 ? r.top : r.left))
        : [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom];
    })
  );

const close = (ours: number[], chrome: number[], what: string) => {
  assert.equal(ours.length, chrome.length, what);
  ours.forEach((v, i) => assert.ok(Math.abs(v - (chrome[i] ?? NaN)) <= 0.5, `${what}[${i}]: ${v} vs ${chrome[i]}`));
};

test("highlightNode draws an iframe's node where Chrome places it, and follows the iframe's scrolling", async () => {
  const ours = await nodeIn(t.ours, 'fg-turned');
  const chrome = await nodeIn(t.chrome, 'fg-turned');
  await t.ours.send('Overlay.highlightNode', { nodeId: ours.nodeId, highlightConfig: {} });
  const check = async (what: string) => {
    const { model } = await t.chrome.send('DOM.getBoxModel', { nodeId: chrome.nodeId });
    const expected = [model.margin, model.border, model.padding, model.content];
    const drawn = await drawnQuads();
    assert.equal(drawn.length, expected.length, what);
    drawn.forEach((q, i) => close(q, expected[i] ?? [], `${what} box ${i}`));
  };
  await check('drawn');
  // Scrolling the iframe moves the node: the highlight is redrawn on the next frame.
  await t.page.evaluate(() => {
    const frame = document.getElementById('ov-frame');
    if (frame instanceof HTMLIFrameElement) frame.contentWindow?.scrollTo(0, 40);
  });
  await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await check('after scrolling');
  await t.ours.send('Overlay.hideHighlight');
});

test('inspect mode picks the node under the mouse in an iframe, like Chrome', async () => {
  const point = await t.page.evaluate(() => {
    const frame = document.getElementById('ov-frame');
    if (frame instanceof HTMLIFrameElement) frame.contentWindow?.scrollTo(0, 10);
    const btn = frame instanceof HTMLIFrameElement ? frame.contentDocument?.getElementById('fg-btn') : null;
    const r = btn?.getBoundingClientRect();
    const f = frame?.getBoundingClientRect();
    // Near the button's center: the rotation moves it by a few pixels at most.
    return r && f ? { x: f.left + 7 + r.left + r.width / 2, y: f.top + 7 + r.top + r.height / 2 } : null;
  });
  assert.ok(point);
  const picked: string[] = [];
  const seen: string[] = [];
  for (const side of [t.chrome, t.ours]) {
    await side.clear();
    // Counted at the iframe's document: the inspector listens at its window, before it.
    await t.page.evaluate(() => {
      const frame = document.getElementById('ov-frame');
      const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
      const counts: string[] = [];
      Reflect.set(window, '__ovSeen', counts);
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'mouseover'])
        doc?.addEventListener(type, () => counts.push(type), true);
    });
    await side.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
    await t.page.mouse.move(point.x, point.y);
    await t.page.mouse.click(point.x, point.y);
    let requested: Protocol.Overlay.InspectNodeRequestedEvent[] = [];
    for (let i = 0; i < 40 && !requested.length; i++) {
      await new Promise(r => setTimeout(r, 25));
      requested = await side.events('Overlay.inspectNodeRequested');
    }
    seen.push(...(await t.page.evaluate(() => String(Reflect.get(window, '__ovSeen')))).split(',').filter(Boolean));
    await side.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    const backendNodeId = requested[0]?.backendNodeId;
    assert.ok(backendNodeId, 'requested');
    const { node } = await side.send('DOM.describeNode', { backendNodeId });
    picked.push(`${node.localName}#${node.attributes?.[node.attributes.indexOf('id') + 1] ?? ''}`);
  }
  assert.deepEqual(picked, ['button#fg-btn', 'button#fg-btn']);
  // The click was the inspector's: the iframe's page saw none of its events, in Chrome or ours.
  assert.deepEqual(seen, []);
  const clicked = await t.page.evaluate(() => {
    const frame = document.getElementById('ov-frame');
    return frame instanceof HTMLIFrameElement ? frame.contentDocument?.activeElement?.id : null;
  });
  assert.notEqual(clicked, 'fg-btn');
});

test('inspect mode picks nodes in an iframe added after it started, like Chrome', async () => {
  const picked: string[] = [];
  for (const side of [t.chrome, t.ours]) {
    await side.clear();
    await side.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
    const point = await t.page.evaluate(
      () =>
        new Promise<{ x: number; y: number }>(resolve => {
          const frame = document.createElement('iframe');
          frame.style.cssText = 'position:absolute;z-index:20;left:20px;top:20px;width:200px;height:100px;border:0';
          frame.onload = () => {
            const r = frame.contentDocument?.getElementById('late-btn')?.getBoundingClientRect();
            resolve({ x: 20 + (r ? r.left + r.width / 2 : 0), y: 20 + (r ? r.top + r.height / 2 : 0) });
          };
          frame.srcdoc =
            '<body style="margin:0"><button id="late-btn" style="margin:20px;width:100px;height:40px">late</button>';
          frame.dataset['late'] = '';
          document.body.append(frame);
        })
    );
    await t.page.mouse.move(point.x, point.y);
    await t.page.mouse.click(point.x, point.y);
    let requested: Protocol.Overlay.InspectNodeRequestedEvent[] = [];
    for (let i = 0; i < 40 && !requested.length; i++) {
      await new Promise(r => setTimeout(r, 25));
      requested = await side.events('Overlay.inspectNodeRequested');
    }
    await side.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    await t.page.evaluate(() => document.querySelector('iframe[data-late]')?.remove());
    const backendNodeId = requested[0]?.backendNodeId;
    assert.ok(backendNodeId, 'requested');
    const { node } = await side.send('DOM.describeNode', { backendNodeId });
    picked.push(`${node.localName}#${node.attributes?.[node.attributes.indexOf('id') + 1] ?? ''}`);
  }
  assert.deepEqual(picked, ['button#late-btn', 'button#late-btn']);
});
