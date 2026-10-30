// Safe areas (a page with viewport-fit=cover on a screen with cutouts): the panel keeps clear of
// them on the screen's edges, never on its inner edge.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { chooseDockSide, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 30, left: 10, bottom: 20, right: 40 } });
  await page.goto(env.baseUrl + '/tests/e2e/pages/zero-config.html');
});
after(() => env?.close());

/** The panel's padding (top, right, bottom, left), once docked to `dock`. */
const padding = (dock: string) =>
  page
    .waitForFunction(
      dock => {
        const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
        if (!panel || (panel.getAttribute('data-dock') ?? 'bottom') !== dock || !panel.hasAttribute('data-open'))
          return null;
        const style = getComputedStyle(panel);
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
      },
      {},
      dock
    )
    .then(handle => handle.jsonValue());

test('docked below, the panel keeps clear of the bottom and both sides', async () => {
  assert.deepEqual(await padding('bottom'), ['0px', '40px', '20px', '10px']);
});

test('docked to a side, it keeps clear of the top, the bottom and its own edge', async () => {
  await chooseDockSide(page, 'right');
  assert.deepEqual(await padding('right'), ['30px', '40px', '20px', '0px']);
  await chooseDockSide(page, 'left');
  assert.deepEqual(await padding('left'), ['30px', '0px', '20px', '10px']);
});

test('undocked, the window has no padding', async () => {
  await chooseDockSide(page, 'undocked');
  assert.deepEqual(await padding('undocked'), ['0px', '0px', '0px', '0px']);
  await chooseDockSide(page, 'bottom');
});
