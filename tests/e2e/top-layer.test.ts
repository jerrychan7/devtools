// <devtools-anywhere> in the top layer: nothing the page draws covers the panel or the toggler,
// and the page's own popovers keep working.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { chooseDockSide, clickF12, frontendRequest, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  await page.goto(env.baseUrl + '/tests/e2e/pages/zero-config.html');
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });
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
  await chooseDockSide(page, 'right');
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return panel && panel.getBoundingClientRect().top === 0;
  });
  const panel = await probe('.panel');
  assert.equal(panel.hitsElement, true);
  const [left = 0, top = 0, width = 0, height = 0] = panel.box;
  assert.equal(top, 0);
  assert.equal(height, 800);
  assert.equal(left + width, 1000);
  // The dock side is the user's: not an attribute the page reads or sees.
  const dock = await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    el?.setAttribute('dock', 'bottom');
    el?.setAttribute('width', '10px');
    return el?.getAttribute('dock');
  });
  assert.equal(dock, 'bottom');
  assert.deepEqual((await probe('.panel')).box, panel.box);
  await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    el?.removeAttribute('dock');
    el?.removeAttribute('width');
  });
  await chooseDockSide(page, 'bottom');
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return panel && panel.getBoundingClientRect().left === 0 && panel.getBoundingClientRect().top > 0;
  });
  await page.evaluate(() => localStorage.removeItem('devtools-anywhere:dock'));
});

test('the toggler is above the page too while DevTools is hidden', async () => {
  await frontendRequest(page, { type: 'close' });
  // The request is a message the element handles later: wait for the swap into the top layer.
  await page.waitForFunction(() => {
    const root = document.querySelector('devtools-anywhere')?.shadowRoot;
    return (
      !!root?.querySelector('.toggler')?.matches(':popover-open') &&
      !root.querySelector('.panel')?.matches(':popover-open')
    );
  });
  const toggler = await probe('.toggler');
  assert.equal(toggler.inTopLayer, true);
  assert.equal(toggler.hitsElement, true);
  // 44px, 16px from the bottom right corner.
  assert.deepEqual(toggler.box, [1000 - 16 - 44, 800 - 16 - 44, 44, 44]);
  assert.equal((await probe('.panel')).inTopLayer, false);
  await clickF12(page);
});

test("showing and hiding DevTools leaves the page's popovers open", async () => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="page-popover" popover>page</div>');
    document.getElementById('page-popover')?.showPopover();
  });
  await frontendRequest(page, { type: 'close' });
  await clickF12(page);
  assert.equal(await page.evaluate(() => !!document.getElementById('page-popover')?.matches(':popover-open')), true);
});
