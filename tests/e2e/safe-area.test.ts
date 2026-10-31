// Safe areas (a page with viewport-fit=cover on a screen with cutouts): the panel keeps clear of
// them on the screen's edges, never on its inner edge.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { chooseDockSide, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

interface Insets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}
const INSETS: Insets = { top: 30, left: 10, bottom: 20, right: 40 };

/** Gives the screen of `target` safe areas, as a phone with cutouts (or one turned) does. */
async function setSafeAreas(target: Page, insets: Insets) {
  const cdp = await target.createCDPSession();
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { ...insets } });
}

/** A new page whose screen has safe areas, at `path`. */
async function openWithSafeAreas(path: string): Promise<Page> {
  const opened = await env?.browser.newPage();
  if (!opened) throw new Error('no browser');
  await setSafeAreas(opened, INSETS);
  await opened.goto(env?.baseUrl + path);
  return opened;
}

before(async () => {
  env = await launch();
  page = await openWithSafeAreas('/tests/e2e/pages/zero-config.html');
});
after(() => env?.close());

/** The panel's padding (top, right, bottom, left) in `target`, once docked to `dock` and equal to `expected` if given. */
const padding = (dock: string, target: Page = page, expected?: string[]) =>
  target
    .waitForFunction(
      (dock, expected) => {
        const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
        if (!panel || (panel.getAttribute('data-dock') ?? 'bottom') !== dock || !panel.hasAttribute('data-open'))
          return null;
        const style = getComputedStyle(panel);
        const value = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
        return !expected || value.join() === expected.join() ? value : null;
      },
      {},
      dock,
      expected
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

test('when the safe areas change, as when the phone turns, the panel follows', async () => {
  await chooseDockSide(page, 'bottom');
  await setSafeAreas(page, { top: 0, left: 44, bottom: 21, right: 44 });
  try {
    const turned = ['0px', '44px', '21px', '44px'];
    assert.deepEqual(await padding('bottom', page, turned), turned);
  } finally {
    await setSafeAreas(page, INSETS);
  }
});

// The two tests below also passed before the panel kept clear of every edge: they guard what
// must stay without padding, rather than show the safe areas are kept clear of.
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
