// The probe's options: a locked shell mode and data-no-toggler.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;
const warnings: string[] = [];

before(async () => {
  env = await launch();
});
after(() => env?.close());
beforeEach(async () => {
  await page?.close();
  assert.ok(env);
  // A new page: a new tab, with sessionStorage of its own.
  page = await env.browser.newPage();
  warnings.length = 0;
  page.on('console', m => {
    if (m.type() === 'warn') warnings.push(m.text());
  });
});

const open = async (name: string) => {
  await page.goto(`${env?.baseUrl}/tests/e2e/pages/${name}`);
  await page.waitForFunction(() => document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe'));
};

/** The global element (or the shell's): where it is, its flags and its frontend's URL. */
const globalState = () =>
  page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    if (!el) throw new Error('no global <devtools-anywhere>');
    return {
      shell: el.hasAttribute('shell'),
      locked: el.hasAttribute('shell-mode-locked'),
      noToggler: el.hasAttribute('no-toggler'),
      frontend: el.shadowRoot?.querySelector('iframe')?.src ?? '',
      stored: localStorage.getItem('devtools-anywhere:shell-mode'),
    };
  });

/** Posts a request to the element from its frontend, as DevTools' lock button does. */
const keepOpen = async (keep: boolean) => {
  const frontend = page.frames().find(f => f.parentFrame() === page.mainFrame() && f.url().includes('fake-frontend'));
  assert.ok(frontend, 'the frontend frame');
  await frontend.evaluate(keep => parent.postMessage({ devtoolsAnywhere: { type: 'keep-open', keep } }, '*'), keep);
  // Time for a reload into or out of the shell to start, if it were to.
  await new Promise(r => setTimeout(r, 500));
};

test("locked off, the user's stored choice and DevTools' requests are ignored", async () => {
  await open('locked-off.html');
  await page.evaluate(() => localStorage.setItem('devtools-anywhere:shell-mode', 'on'));
  try {
    await open('locked-off.html');
    const state = await globalState();
    assert.equal(state.shell, false);
    assert.equal(state.locked, true);
    // Kept, though ignored.
    assert.equal(state.stored, 'on');
    assert.match(state.frontend, /fake-frontend\.html\?shellModeLocked=?#/);
    await page.evaluate(() => {
      window.__pageScriptRan = true;
    });
    // Heeded, this would store 'off' and reload.
    await keepOpen(false);
    assert.equal((await globalState()).stored, 'on');
    assert.equal(await page.evaluate(() => window.__pageScriptRan), true, 'no reload');
  } finally {
    await page.evaluate(() => localStorage.removeItem('devtools-anywhere:shell-mode'));
  }
});

test('locked off, a shell entered before is left', async () => {
  await open('locked-on.html');
  assert.equal((await globalState()).shell, true);
  await open('locked-off.html');
  assert.equal((await globalState()).shell, false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell')), null);
});

test('locked on, the shell is entered whatever the user chose, and stays locked, with data-no-toggler', async () => {
  await open('locked-on.html');
  await page.evaluate(() => localStorage.setItem('devtools-anywhere:shell-mode', 'off'));
  try {
    // A new tab enters the shell again.
    await page.close();
    assert.ok(env);
    page = await env.browser.newPage();
    await open('locked-on.html');
    await page.evaluate(() => document.querySelector('devtools-anywhere')?.show());
    await page.waitForFunction(
      () => document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe')?.src
    );
    const state = await globalState();
    assert.equal(state.shell, true);
    assert.equal(state.locked, true);
    assert.equal(state.noToggler, true);
    assert.equal(state.stored, 'off');
    assert.match(state.frontend, /\?shellModeLocked=?#/);
    // Heeded, this would store 'on' and reload.
    await page.evaluate(() => {
      window.__pageScriptRan = true;
    });
    await keepOpen(true);
    assert.equal((await globalState()).stored, 'off');
    assert.equal(await page.evaluate(() => window.__pageScriptRan), true, 'no reload');
  } finally {
    await page.evaluate(() => localStorage.removeItem('devtools-anywhere:shell-mode'));
  }
});

test('a shell entered before the page was locked takes the lock', async () => {
  await open('default-shell.html');
  assert.equal((await globalState()).locked, false);
  await open('locked-on.html');
  const state = await globalState();
  assert.equal(state.shell, true);
  assert.equal(state.locked, true);
  assert.equal(state.noToggler, true);
});

test('locked on, a page that refuses to be framed is shown on its own', async () => {
  await page.setRequestInterception(true);
  page.on('request', async r => {
    if (!r.isNavigationRequest() || r.frame() === page.mainFrame()) return void r.continue();
    const response = await fetch(r.url());
    await r.respond({
      status: 200,
      headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' },
      body: await response.text(),
    });
  });
  await page.goto(`${env?.baseUrl}/tests/e2e/pages/locked-on.html`);
  await page.waitForFunction(() => document.querySelector('devtools-anywhere'), { timeout: 8000 });
  assert.equal((await globalState()).shell, false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell-refused')), '1');
});
