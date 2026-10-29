// <devtools-anywhere> in the top layer: nothing the page draws covers the panel or the toggler,
// and the page's own popovers keep working.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  await page.goto(env.baseUrl + '/tests/e2e/pages/zero-config.html');
  await page.waitForFunction(() => document.querySelector('devtools-anywhere')?.open === true);
  // A page element at the highest z-index, after the element: without the top layer it would win.
  await page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="cover" style="position:fixed;inset:0;z-index:2147483647;background:rgba(255,0,0,.1)"></div>'
    )
  );
});
after(() => env?.close());

/** The element's part, its box, and what is hit at its center. */
const probe = (selector: string) =>
  page.evaluate(selector => {
    const host = document.querySelector('devtools-anywhere');
    const el = host?.shadowRoot?.querySelector(selector);
    if (!host || !el) throw new Error(`no ${selector}`);
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      inTopLayer: el.matches(':popover-open'),
      hitsElement: hit === host,
      box: [r.left, r.top, r.width, r.height].map(Math.round),
    };
  }, selector);

test('the docked panel is above a page element at the highest z-index, laid out as before', async () => {
  const panel = await probe('.panel');
  assert.equal(panel.inTopLayer, true);
  assert.equal(panel.hitsElement, true);
  const [left = 0, top = 0, width = 0, height = 0] = panel.box;
  assert.equal(left, 0);
  assert.equal(width, 1000);
  assert.equal(top + height, 800);
});

test('docked to a side, the panel keeps its full height', async () => {
  await page.evaluate(() => document.querySelector('devtools-anywhere')?.setAttribute('dock', 'right'));
  const panel = await probe('.panel');
  assert.equal(panel.hitsElement, true);
  const [left = 0, top = 0, width = 0, height = 0] = panel.box;
  assert.equal(top, 0);
  assert.equal(height, 800);
  assert.equal(left + width, 1000);
  await page.evaluate(() => document.querySelector('devtools-anywhere')?.setAttribute('dock', 'bottom'));
});

test('the toggler is above the page too while DevTools is hidden', async () => {
  await page.evaluate(() => document.querySelector('devtools-anywhere')?.removeAttribute('open'));
  const toggler = await probe('.toggler');
  assert.equal(toggler.inTopLayer, true);
  assert.equal(toggler.hitsElement, true);
  // 44px, 16px from the bottom right corner.
  assert.deepEqual(toggler.box, [1000 - 16 - 44, 800 - 16 - 44, 44, 44]);
  assert.equal((await probe('.panel')).inTopLayer, false);
  await page.evaluate(() => document.querySelector('devtools-anywhere')?.setAttribute('open', ''));
});

test("showing and hiding DevTools leaves the page's popovers open", async () => {
  const open = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="page-popover" popover>page</div>');
    const popover = document.getElementById('page-popover');
    if (!popover) throw new Error('no popover');
    popover.showPopover();
    const devtools = document.querySelector('devtools-anywhere');
    devtools?.removeAttribute('open');
    devtools?.setAttribute('open', '');
    return popover.matches(':popover-open');
  });
  assert.equal(open, true);
});
