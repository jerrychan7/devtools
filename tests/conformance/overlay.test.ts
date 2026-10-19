import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';
import type { Env, TestPage } from './harness.ts';

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
  await t.page.setViewport({ width: 800, height: 600 });
  assert.equal(await label(), null);
});
