// Shell mode by default: the zero-config probe enters it on the first load, falls back to the
// page on its own when the page cannot be framed, and keeps the address bar on the page shown.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;
let url = '';

before(async () => {
  env = await launch();
  url = env.baseUrl + '/tests/e2e/pages/default-shell.html';
});
after(() => env?.close());
beforeEach(async () => {
  await page?.close();
  assert.ok(env);
  // A new page: a new tab, with sessionStorage of its own.
  page = await env.browser.newPage();
});

/** Whether the top-level document is the shell, and the URL of the page shown in it. */
const shellState = () =>
  page.evaluate(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    return {
      inShell: !!document.querySelector('devtools-anywhere[shell]') && frame instanceof HTMLIFrameElement,
      pageUrl: frame instanceof HTMLIFrameElement ? (frame.contentWindow?.location.href ?? '') : location.href,
      topUrl: location.href,
      open: (() => {
        const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
        return !!panel && getComputedStyle(panel).display !== 'none';
      })(),
    };
  });

test('the first load enters shell mode at once, with DevTools hidden', async () => {
  let documents = 0;
  page.on('request', r => {
    if (r.url().startsWith(url)) documents++;
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('devtools-anywhere[shell]'));
  const state = await shellState();
  assert.equal(state.inShell, true);
  assert.equal(state.open, false);
  // The top-level document, then the page in the shell: no reload in between.
  await page.waitForFunction(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    return frame instanceof HTMLIFrameElement && frame.contentDocument?.readyState === 'complete';
  });
  assert.equal(documents, 2);
});

test('the address bar follows the page shown, through history and reloads', async () => {
  await page.goto(url);
  await page.waitForFunction(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    return frame instanceof HTMLIFrameElement && frame.contentDocument?.readyState === 'complete';
  });
  // The page's frame: the main frame's other child is DevTools'.
  const framed = () => {
    const frame = page
      .mainFrame()
      .childFrames()
      .find(f => !f.url().includes('fake-frontend'));
    assert.ok(frame, 'the page frame');
    return frame;
  };
  await framed().evaluate(() => history.pushState(null, '', '?pushed'));
  await page.waitForFunction(() => location.search === '?pushed');
  await framed().evaluate(() => {
    location.hash = 'here';
  });
  await page.waitForFunction(() => location.hash === '#here');
  await framed().evaluate(() => history.back());
  await page.waitForFunction(() => location.search === '?pushed' && location.hash === '');
  // A reload shows the page shown, not the first one.
  await page.reload();
  await page.waitForFunction(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    return frame instanceof HTMLIFrameElement && frame.contentWindow?.location.search === '?pushed';
  });
  assert.equal((await shellState()).inShell, true);
});

test('a page that refuses to be framed is shown on its own, for the rest of the session', async () => {
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
  await page.goto(url);
  await page.waitForFunction(() => window.__pageScriptRan === true, { timeout: 8000 });
  assert.equal((await shellState()).inShell, false);
  await page.reload();
  await page.waitForFunction(() => window.__pageScriptRan === true);
  assert.equal((await shellState()).inShell, false);
});

test('a page that navigates the shell away is shown on its own after a few tries', async () => {
  await page.goto(url + '?bust');
  await page.waitForFunction(
    () => window.__pageScriptRan === true && !document.getElementById('devtools-anywhere-page'),
    {
      timeout: 8000,
    }
  );
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell-refused')), '1');
});

test("the user's choice wins over data-default-shell-mode", async () => {
  await page.goto(env?.baseUrl + '/tests/e2e/pages/zero-config.html');
  // data-default-shell-mode="off" there: the page on its own.
  await page.waitForFunction(() => document.querySelector('devtools-anywhere'));
  assert.equal((await shellState()).inShell, false);
  await page.evaluate(() => localStorage.setItem('devtools-anywhere:shell-mode', 'on'));
  try {
    await page.reload();
    await page.waitForFunction(() => document.querySelector('devtools-anywhere[shell]'));
  } finally {
    await page.evaluate(() => localStorage.removeItem('devtools-anywhere:shell-mode'));
  }
});
