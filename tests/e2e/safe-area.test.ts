// Safe areas (a page with viewport-fit=cover on a screen with cutouts): the panel keeps clear of
// them on the screen's edges, never on its inner edge.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { chooseDockSide, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

/** A new page whose screen has safe areas, at `path`. */
async function openWithSafeAreas(path: string): Promise<Page> {
  const opened = await env?.browser.newPage();
  if (!opened) throw new Error('no browser');
  const cdp = await opened.createCDPSession();
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 30, left: 10, bottom: 20, right: 40 } });
  await opened.goto(env?.baseUrl + path);
  return opened;
}

before(async () => {
  env = await launch();
  page = await openWithSafeAreas('/tests/e2e/pages/zero-config.html');
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
  try {
    assert.deepEqual(await padding('undocked'), ['0px', '0px', '0px', '0px']);
  } finally {
    await chooseDockSide(page, 'bottom');
  }
});

test("in the shell, the panel keeps clear of the screen's edges as on its own", async () => {
  const shell = await openWithSafeAreas('/tests/e2e/pages/remote-page.html?local&noRemote&panel');
  try {
    await shell.waitForFunction(() => document.querySelector('devtools-anywhere[data-shell]'));
    assert.deepEqual(await padding('bottom', shell), ['0px', '40px', '20px', '10px']);
  } finally {
    await shell.close();
  }
});

test('an element the page placed, a box in its flow, has no padding', async () => {
  const placed = await openWithSafeAreas('/tests/e2e/pages/custom-element.html');
  try {
    const value = await placed
      .waitForFunction(() => {
        const panel = document.getElementById('placed')?.shadowRoot?.querySelector('.panel');
        return panel?.hasAttribute('data-custom') ? getComputedStyle(panel).padding : null;
      })
      .then(handle => handle.jsonValue());
    assert.equal(value, '0px');
  } finally {
    await placed.close();
  }
});
