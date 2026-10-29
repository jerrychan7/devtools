import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
});
after(() => env?.close());

/** Chrome draws its overlay outside the page, so only ours is checked. */
const label = () =>
  t.page.evaluate(() => document.querySelector('[data-devtools-anywhere="viewport-size"]')?.textContent ?? null);

test('the viewport size shows briefly after a resize when enabled', async () => {
  await t.page.setViewport({ width: 800, height: 600 });
  assert.equal(await label(), null);
  await t.ours.send('Overlay.setShowViewportSizeOnResize', { show: true });
  await t.page.setViewport({ width: 640, height: 480 });
  // The resize event arrives asynchronously.
  for (let i = 0; i < 20 && !(await label()); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(await label(), '640px × 480px');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(await label(), null);
  await t.ours.send('Overlay.setShowViewportSizeOnResize', { show: false });
  // Wait for the resize to reach the page, or the check passes before it could fail.
  const resized = t.page.evaluate(() => new Promise(r => addEventListener('resize', r, { once: true })));
  await t.page.setViewport({ width: 800, height: 600 });
  await resized;
  assert.equal(await label(), null);
});

/** Boxes drawn by highlightNode: margin, border, padding, content, then the info label. */
const highlightBoxes = () =>
  t.page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-devtools-anywhere="overlay"] > div'), d => {
      const r = d.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height];
    })
  );

const quadRect = (q: number[]) => {
  const [left = 0, top = 0, , , right = 0, bottom = 0] = q;
  return [left, top, right - left, bottom - top];
};

test('highlightNode draws the box model, hideHighlight removes it', async () => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.box' });
  const { model } = await t.ours.send('DOM.getBoxModel', { nodeId });
  await t.ours.send('Overlay.highlightNode', { nodeId, highlightConfig: {} });
  const boxes = await highlightBoxes();
  assert.deepEqual(boxes.slice(0, 4), [model.margin, model.border, model.padding, model.content].map(quadRect));
  await t.ours.send('Overlay.hideHighlight');
  assert.deepEqual(await highlightBoxes(), []);
});

test('highlightRect and highlightQuad draw one box', async () => {
  await t.ours.send('Overlay.highlightRect', { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(await highlightBoxes(), [[10, 20, 30, 40]]);
  await t.ours.send('Overlay.highlightQuad', { quad: [5, 6, 25, 6, 25, 16, 5, 16] });
  assert.deepEqual(await highlightBoxes(), [[5, 6, 20, 10]]);
  await t.ours.send('Overlay.hideHighlight');
  assert.deepEqual(await highlightBoxes(), []);
});

test('inspect mode swallows the click and requests the clicked node', async () => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#app' });
  const { node } = await t.ours.send('DOM.describeNode', { nodeId });
  await t.page.evaluate(() => {
    let clicks = 0;
    addEventListener('click', () => (document.body.dataset['clicks'] = String(++clicks)));
  });
  await t.ours.clear();
  await t.ours.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
  await t.page.click('#app');
  assert.deepEqual(await t.ours.events('Overlay.inspectNodeRequested'), [{ backendNodeId: node.backendNodeId }]);
  const clicks = () => t.page.evaluate(() => document.body.dataset['clicks'] ?? '0');
  assert.equal(await clicks(), '0');
  await t.ours.send('Overlay.setInspectMode', { mode: 'none' });
  await t.page.click('#app');
  assert.equal(await clicks(), '1');
  assert.equal((await t.ours.events('Overlay.inspectNodeRequested')).length, 1);
});

test('highlightNode shows the info label only when showInfo is true', async () => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.box' });
  await t.ours.send('Overlay.highlightNode', { nodeId, highlightConfig: {} });
  assert.equal((await highlightBoxes()).length, 4);
  await t.ours.send('Overlay.highlightNode', { nodeId, highlightConfig: { showInfo: true } });
  assert.equal((await highlightBoxes()).length, 5);
  await t.ours.send('Overlay.hideHighlight');
});

test('inspect mode requests the hovered node and swallows touches', async () => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#app' });
  await t.ours.clear();
  await t.ours.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
  await t.page.hover('#app');
  let requested: unknown[] = [];
  for (let i = 0; i < 20 && !requested.length; i++) {
    await new Promise(r => setTimeout(r, 50));
    requested = await t.ours.events('Overlay.nodeHighlightRequested');
  }
  assert.deepEqual(requested, [{ nodeId }]);
  const touch = () =>
    t.page.evaluate(() =>
      ['touchstart', 'touchmove', 'touchend'].map(type => {
        const app = document.getElementById('app');
        const event = new TouchEvent(type, { bubbles: true, cancelable: true });
        app?.dispatchEvent(event);
        return event.defaultPrevented;
      })
    );
  assert.deepEqual(await touch(), [true, true, true]);
  await t.ours.send('Overlay.setInspectMode', { mode: 'none' });
  assert.deepEqual(await touch(), [false, false, false]);
});

test('highlightNode follows a rotated element and labels its layout size', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="ov-rot" style="position:absolute;left:200px;top:200px;width:60px;height:30px;transform:rotate(45deg)"></div>'
    )
  );
  const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#ov-rot' });
  const { model } = await t.ours.send('DOM.getBoxModel', { nodeId });
  await t.ours.send('Overlay.highlightNode', { nodeId, highlightConfig: { showInfo: true } });
  // Polygon points are relative to their box; shifted back they are viewport points.
  const drawn = await t.page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-devtools-anywhere="overlay"] > div'), d => {
      const r = d.getBoundingClientRect();
      const points = d.querySelector('polygon')?.getAttribute('points');
      return {
        quad: points ? points.split(/[ ,]/).map((n, i) => Number(n) + (i % 2 ? r.top : r.left)) : null,
        text: d.textContent,
      };
    })
  );
  const quads = drawn.flatMap(d => (d.quad ? [d.quad] : []));
  const expected = [model.margin, model.border, model.padding, model.content];
  assert.equal(quads.length, expected.length);
  // A rotated quad is not axis-aligned, so these points differ from any rectangle's.
  quads.forEach((quad, i) => {
    const want = expected[i] ?? [];
    assert.equal(quad.length, want.length);
    quad.forEach((n, j) => assert.ok(Math.abs(n - (want[j] ?? NaN)) < 0.5, `quad ${i} point ${j}: ${n} vs ${want[j]}`));
  });
  assert.notEqual(model.border[1], model.border[3]);
  const info = drawn.find(d => !d.quad);
  assert.match(info?.text ?? '', /60 × 30$/);
  await t.ours.send('Overlay.hideHighlight');
});

test('highlightQuad outlines a rotated quad', async () => {
  await t.ours.send('Overlay.highlightQuad', {
    quad: [20, 10, 40, 30, 20, 50, 0, 30],
    color: { r: 255, g: 0, b: 0, a: 0.5 },
    outlineColor: { r: 0, g: 0, b: 255 },
  });
  const drawn = await t.page.evaluate(() => {
    const div = document.querySelector<HTMLElement>('[data-devtools-anywhere="overlay"] > div');
    const polygon = div?.querySelector('polygon');
    const r = div?.getBoundingClientRect();
    return {
      box: r ? [r.left, r.top, r.width, r.height] : null,
      points: polygon?.getAttribute('points'),
      fill: polygon ? getComputedStyle(polygon).fill : null,
      stroke: polygon ? getComputedStyle(polygon).stroke : null,
    };
  });
  assert.deepEqual(drawn, {
    box: [0, 10, 40, 40],
    points: '20,0 40,20 20,40 0,20',
    fill: 'rgba(255, 0, 0, 0.5)',
    stroke: 'rgb(0, 0, 255)',
  });
  await t.ours.send('Overlay.hideHighlight');
});
