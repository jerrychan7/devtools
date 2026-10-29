// The built DevTools frontend (packages/devtools-frontend) offers no way out of shell mode when
// the page locks it: no toggle for keeping DevTools open, and no action on the info bar that says
// it is on. Skipped when the frontend has not been built.
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

let env: Env | undefined;

before(async () => {
  if (built) env = await launch();
});
after(() => env?.close());

async function waitFor(check: () => Promise<boolean>, what: string, timeout = 15000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Whether the frontend has a toolbar item whose label starts with `label` (inside shadow DOM). */
const hasLabel = (page: Page, label: string) =>
  page.evaluate(label => {
    const find = (root: Document | ShadowRoot): boolean =>
      !!root.querySelector(`[aria-label^="${label}"]`) ||
      Array.from(root.querySelectorAll('*')).some(el => !!el.shadowRoot && find(el.shadowRoot));
    return find(document);
  }, label);

/** Whether the frontend has a button reading exactly `text`, such as an info bar's action. */
const hasButton = (page: Page, text: string) =>
  page.evaluate(text => {
    const find = (root: Document | ShadowRoot): boolean =>
      Array.from(root.querySelectorAll('button, devtools-button')).some(b => b.textContent?.trim() === text) ||
      Array.from(root.querySelectorAll('*')).some(el => !!el.shadowRoot && find(el.shadowRoot));
    return find(document);
  }, text);

/** Whether the frontend's text, including shadow DOM, contains `text`. */
const hasText = (page: Page, text: string) =>
  page.evaluate(text => {
    const find = (root: Document | ShadowRoot): boolean =>
      (root === document ? document.documentElement.textContent : root.textContent)?.includes(text) ||
      Array.from(root.querySelectorAll('*')).some(el => !!el.shadowRoot && find(el.shadowRoot));
    return find(document);
  }, text);

/** Opens the frontend on its own at `query` and `hash`, once its main toolbar is there. */
async function open(query: string, hash: string): Promise<Page> {
  if (!env) throw new Error('no browser');
  const page = await env.browser.newPage();
  await page.goto(`${env.baseUrl}/packages/devtools-frontend/dist/anywhere_app.html${query}${hash}`);
  await waitFor(() => hasLabel(page, 'Reload page'), 'the toolbar');
  return page;
}

/** Shell mode's info bar, once it is in. The bar goes in after the toolbar, in a later task. */
const KEPT_OPEN = 'DevTools stays open across reloads';

test('the toggle shows when keeping DevTools open is available', { skip }, async () => {
  const page = await open('', '#?keep=1');
  assert.equal(await hasLabel(page, 'Keep DevTools open'), true);
  await page.close();
});

test('another query parameter does not hide the toggle', { skip }, async () => {
  const page = await open('?other=1', '#?keep=1');
  assert.equal(await hasLabel(page, 'Keep DevTools open'), true);
  await page.close();
});

test('the toggle is hidden when shell mode is locked, whatever the value', { skip }, async () => {
  const page = await open('?shellModeLocked', '#?keep=1');
  assert.equal(await hasLabel(page, 'Keep DevTools open'), false);
  await page.close();
  const zero = await open('?shellModeLocked=0', '#?keep=1');
  assert.equal(await hasLabel(zero, 'Keep DevTools open'), false);
  await zero.close();
});

test('in shell mode, the toggle and the info bar both offer to stop', { skip }, async () => {
  const page = await open('', '#?keep=1&shell=1');
  await waitFor(() => hasText(page, KEPT_OPEN), 'the info bar');
  assert.equal(await hasLabel(page, 'Stop keeping DevTools open'), true);
  assert.equal(await hasButton(page, 'Stop keeping open'), true);
  await page.close();
});

test('in locked shell mode, the info bar shows without a way to stop', { skip }, async () => {
  const page = await open('?shellModeLocked', '#?keep=1&shell=1');
  await waitFor(() => hasText(page, KEPT_OPEN), 'the info bar');
  assert.equal(await hasLabel(page, 'Stop keeping DevTools open'), false);
  assert.equal(await hasButton(page, 'Stop keeping open'), false);
  await page.close();
});

// Last: the setting it stores in the frontend's origin would hide the info bar in the tests above.
test('the info bar\'s "Don\'t show again" keeps it away after a reload, not the toggle', { skip }, async () => {
  const page = await open('', '#?keep=1&shell=1');
  try {
    await waitFor(() => hasText(page, KEPT_OPEN), 'the info bar');
    await page.evaluate(() => {
      const find = (root: Document | ShadowRoot): HTMLElement | null => {
        for (const el of root.querySelectorAll('*')) {
          if (
            el.matches('button, devtools-button') &&
            el.textContent?.trim() === 'Don’t show again' &&
            el instanceof HTMLElement
          )
            return el;
          const inShadow = el.shadowRoot && find(el.shadowRoot);
          if (inShadow) return inShadow;
        }
        return null;
      };
      const button = find(document);
      if (!button) throw new Error('no "Don’t show again" button');
      button.click();
    });
    await waitFor(async () => !(await hasText(page, KEPT_OPEN)), 'the info bar to close');
    await page.reload();
    await waitFor(() => hasLabel(page, 'Reload page'), 'the toolbar');
    // The bar would go in a task after the toolbar.
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await hasText(page, KEPT_OPEN), false);
    assert.equal(await hasLabel(page, 'Stop keeping DevTools open'), true);
  } finally {
    await page.evaluate(() => localStorage.clear());
    await page.close();
  }
});
