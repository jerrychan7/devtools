// The probe's options: a locked shell mode, data-no-toggler, and the global <devtools-anywhere>
// the probe mounts under <html>, whatever the page has.
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
  await page.waitForFunction(() =>
    document
      .querySelector('devtools-anywhere[data-shell], html > devtools-anywhere')
      ?.shadowRoot?.querySelector('iframe')
  );
};

/**
 * The global element (or the shell's), as the user finds it: in the shell or not, with or
 * without the F12 button while closed, the lock button hidden (the frontend's URL asks for it).
 */
const globalState = () =>
  page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere[data-shell], html > devtools-anywhere');
    if (!el) throw new Error('no global <devtools-anywhere>');
    const panel = el.shadowRoot?.querySelector('.panel');
    const toggler = el.shadowRoot?.querySelector('.toggler');
    const frontend = el.shadowRoot?.querySelector('iframe')?.src ?? '';
    return {
      shell: el.hasAttribute('data-shell'),
      inHtml: el.parentElement === document.documentElement,
      shown: !!panel && getComputedStyle(panel).display !== 'none',
      togglerShown: !!toggler && getComputedStyle(toggler).display !== 'none',
      locked: /[?&]shellModeLocked/.test(frontend),
      frontend,
      stored: localStorage.getItem('devtools-anywhere:shell-mode'),
    };
  });

/** Opens DevTools with the page's toggler, in the shell's page frame when in the shell. */
async function openDevtools() {
  const frame =
    page
      .mainFrame()
      .childFrames()
      .find(f => f.url().includes('/pages/')) ?? page.mainFrame();
  await frame.waitForFunction(() => document.getElementById('toggle')?.getAttribute('aria-expanded'));
  await frame.evaluate(() => document.getElementById('toggle')?.click());
  await page.waitForFunction(() =>
    /fake-frontend/.test(
      document
        .querySelector('devtools-anywhere[data-shell], html > devtools-anywhere')
        ?.shadowRoot?.querySelector('iframe')?.src ?? ''
    )
  );
}

/**
 * Posts a request to the element from its frontend, as DevTools' lock button does, and waits for
 * the element to have handled it: a second message, posted after it, has reached the page.
 */
const keepOpen = async (keep: boolean) => {
  // The global element's frontend, not that of the page's own element.
  const iframe = await page.$('devtools-anywhere[data-shell], html > devtools-anywhere');
  const frontend = await (await iframe?.$('pierce/iframe'))?.contentFrame();
  assert.ok(frontend, 'the frontend frame');
  // Wrapped, so that the handle comes back before the message does.
  const handled = await page.evaluateHandle(() => ({
    done: new Promise<void>(resolve =>
      addEventListener('message', e => e.data === 'probe-options:handled' && resolve())
    ),
  }));
  await frontend.evaluate(keep => {
    parent.postMessage({ devtoolsAnywhere: { type: 'keep-open', keep } }, '*');
    parent.postMessage('probe-options:handled', '*');
  }, keep);
  await handled.evaluate(h => h.done);
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
    // Heeded, this would store 'off' (the page is not in the shell, there is nothing to leave).
    await keepOpen(false);
    assert.equal((await globalState()).stored, 'on');
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
    assert.equal((await globalState()).togglerShown, false, 'data-no-toggler');
    await openDevtools();
    const state = await globalState();
    assert.equal(state.shell, true);
    assert.equal(state.locked, true);
    assert.equal(state.stored, 'off');
    assert.match(state.frontend, /\?shellModeLocked=?#/);
    // Heeded, this would store 'on' before anything else: kept 'off', the request was ignored.
    await keepOpen(true);
    assert.equal((await globalState()).stored, 'off');
  } finally {
    await page.evaluate(() => localStorage.removeItem('devtools-anywhere:shell-mode'));
  }
});

/** Whether the page in the shell shows the F12 button (the shell element's, see mountShellToggler). */
async function pageTogglerShown() {
  const frame = page
    .mainFrame()
    .childFrames()
    .find(f => f.url().includes('/pages/'));
  assert.ok(frame);
  // Its togglers work once the bundle has run in the page, which mounts the button.
  await frame.waitForFunction(() => document.getElementById('toggle')?.getAttribute('aria-expanded'));
  return frame.evaluate(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none';
  });
}

test('a shell entered before the page was locked takes the lock', async () => {
  await open('default-shell.html');
  assert.equal(await pageTogglerShown(), true);
  await openDevtools();
  assert.equal((await globalState()).locked, false);
  await open('locked-on.html');
  assert.equal(await pageTogglerShown(), false);
  assert.equal((await globalState()).togglerShown, false);
  await openDevtools();
  const state = await globalState();
  assert.equal(state.shell, true);
  assert.equal(state.locked, true);
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
  await page.waitForFunction(() => document.querySelector('html > devtools-anywhere'), { timeout: 8000 });
  assert.equal((await globalState()).shell, false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell-refused')), '1');
});

test("the probe mounts its element under <html>, beside the page's own", async () => {
  await open('locked-off.html');
  const elements = await page.evaluate(() =>
    [...document.querySelectorAll('devtools-anywhere')].map(el => `${el.parentElement?.localName}#${el.id}`)
  );
  assert.deepEqual(elements, ['body#own', 'html#']);
  assert.equal((await globalState()).inHtml, true);
});

test('a second global element only warns and does nothing, even once the first is gone', async () => {
  await open('zero-config.html');
  /** Mounts another global element, open, and says whether it shows and loads anything. */
  const mountAnother = () =>
    page.evaluate(() => {
      const el = window.DevtoolsAnywhere.createGlobalElement({
        frontend: '/tests/e2e/frontends/fake-frontend.html',
        open: true,
      });
      if (!el) throw new Error('no element');
      document.documentElement.append(el);
      return {
        shown: getComputedStyle(el).display !== 'none',
        frontend: el.shadowRoot?.querySelector('iframe')?.getAttribute('src') ?? null,
      };
    });
  assert.deepEqual(await mountAnother(), { shown: false, frontend: null });
  // Before the first in the document, it is skipped: a toggler without a value hides the first.
  const first = await page.evaluate(() => {
    const [global, other] = document.querySelectorAll('html > devtools-anywhere');
    if (!global || !other) throw new Error('no global elements');
    document.documentElement.insertBefore(other, global);
    document.body.insertAdjacentHTML('beforeend', '<button id="first" data-devtools-anywhere-toggle>first</button>');
    document.getElementById('first')?.click();
    const panel = global.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });
  assert.equal(first, false);
  await page.evaluate(() => document.querySelector('html > devtools-anywhere:not([style])')?.remove());
  assert.deepEqual(await mountAnother(), { shown: false, frontend: null });
  assert.equal(warnings.filter(w => w.includes('global <devtools-anywhere>')).length, 2);
  // Nor is it a toggler's target.
  const toggled = await page.evaluate(() => {
    let fired = 0;
    for (const el of document.querySelectorAll('devtools-anywhere'))
      el.addEventListener('devtools-anywhere-state', () => fired++);
    document.body.insertAdjacentHTML('beforeend', '<button id="t" data-devtools-anywhere-toggle>t</button>');
    const button = document.getElementById('t');
    button?.click();
    return { fired, expanded: button?.getAttribute('aria-expanded') ?? null };
  });
  assert.deepEqual(toggled, { fired: 0, expanded: null });
});

test('a page that registers <devtools-anywhere> itself gets no global element, and a warning', async () => {
  await page.evaluateOnNewDocument(() => customElements.define('devtools-anywhere', class extends HTMLElement {}));
  await page.goto(`${env?.baseUrl}/tests/e2e/pages/zero-config.html`);
  for (let start = Date.now(); !warnings.some(w => w.includes('registered by the page'));) {
    assert.ok(Date.now() - start < 5000, 'a warning');
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(await page.evaluate(() => document.querySelector('html > devtools-anywhere')), null);
  assert.equal(warnings.filter(w => w.includes('registered by the page')).length, 1);
});
