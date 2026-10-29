// A <devtools-anywhere> the page places itself: a box in its flow, DevTools loaded at once,
// shown and hidden by the page's CSS, never in shell mode, and only told about its togglers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
});
after(() => env?.close());

const url = () => `${env?.baseUrl}/tests/e2e/pages/custom-element.html`;

/** The frontend of the element `selector` (in `frame`), once it has loaded and connected. */
async function frontendOf(selector: string, frame: Page | Frame = page): Promise<Frame> {
  for (let start = Date.now(); ;) {
    const handle = await frame.$(selector);
    const inner = await (await handle?.$('pierce/iframe'))?.contentFrame();
    if (inner && (await inner.evaluate(() => (window.received ?? []).length > 0).catch(() => false))) return inner;
    assert.ok(Date.now() - start < 5000, `the frontend of ${selector}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** What a frontend has been told, from the page's console. */
const logged = (frontend: Frame, text: string) =>
  frontend.evaluate(
    text =>
      (window.received ?? []).some(
        m => m.method === 'Runtime.consoleAPICalled' && JSON.stringify(m.params).includes(text)
      ),
    text
  );

const waitLogged = async (frontend: Frame, text: string) => {
  for (let start = Date.now(); !(await logged(frontend, text));) {
    assert.ok(Date.now() - start < 5000, `logged ${text}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

test("it loads DevTools at once, with the probe's URL, in the page's flow and sized by its CSS", async () => {
  await page.goto(url());
  const frontend = await frontendOf('#placed');
  assert.match(frontend.url(), /fake-frontend\.html\?shellModeLocked=?#.*keep=0/, 'no way into shell mode');
  const box = await page.evaluate(() => {
    const el = document.getElementById('placed');
    const before = document.getElementById('before');
    const after = document.getElementById('after');
    const toggler = el?.shadowRoot?.querySelector('.toggler');
    if (!el || !before || !after || !toggler) throw new Error('no elements');
    return {
      display: getComputedStyle(el).display,
      height: el.getBoundingClientRect().height,
      between:
        before.getBoundingClientRect().bottom <= el.getBoundingClientRect().top &&
        el.getBoundingClientRect().bottom <= after.getBoundingClientRect().top,
      toggler: getComputedStyle(toggler).display,
    };
  });
  assert.deepEqual(box, { display: 'block', height: 300, between: true, toggler: 'none' });
});

test('its own URL wins; its other attributes do nothing; hidden, it stays loaded', async () => {
  await page.goto(url());
  const frontend = await frontendOf('#own-url');
  assert.match(frontend.url(), /fake-frontend\.html\?own=?&shellModeLocked/);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.getElementById('own-url') as Element).display),
    'none'
  );
  // Hidden by the page's CSS, DevTools keeps receiving the page's output.
  await page.evaluate(() => {
    const el = document.getElementById('placed');
    if (el) el.style.display = 'none';
    console.log('while hidden');
  });
  await waitLogged(await frontendOf('#placed'), 'while hidden');
  await waitLogged(frontend, 'while hidden');
  await page.evaluate(() => document.getElementById('own-url')?.removeAttribute('hidden'));
  const shown = await page.evaluate(() => {
    const el = document.getElementById('own-url');
    const panel = el?.shadowRoot?.querySelector('.panel');
    return { display: el && getComputedStyle(el).display, panel: panel && getComputedStyle(panel).position };
  });
  assert.deepEqual(shown, { display: 'block', panel: 'static' }, 'no dock side');
});

test('a toggler naming it only fires devtools-toggle-request; the global toggler is not about it', async () => {
  await page.goto(url());
  await frontendOf('#placed');
  await page.waitForFunction(() => document.getElementById('global')?.getAttribute('aria-expanded'));
  const result = await page.evaluate(() => {
    const placed = document.getElementById('placed');
    if (!placed) throw new Error('no #placed');
    let requests = 0;
    placed.addEventListener('devtools-toggle-request', () => requests++);
    const height = placed.getBoundingClientRect().height;
    document.getElementById('request')?.click();
    const afterRequest = requests;
    document.getElementById('global')?.click();
    return {
      afterRequest,
      requests,
      height: placed.getBoundingClientRect().height === height,
      expanded: document.getElementById('request')?.getAttribute('aria-expanded') ?? null,
      global: document.getElementById('global')?.getAttribute('aria-expanded') ?? null,
    };
  });
  assert.deepEqual(result, { afterRequest: 1, requests: 1, height: true, expanded: null, global: 'true' });
});

test("its DevTools' requests to dock or keep the page in shell mode are ignored", async () => {
  await page.goto(url());
  const frontend = await frontendOf('#placed');
  await page.evaluate(() => {
    window.__pageScriptRan = true;
  });
  await frontend.evaluate(() => {
    parent.postMessage({ devtoolsAnywhere: { type: 'dock', side: 'right' } }, '*');
    parent.postMessage({ devtoolsAnywhere: { type: 'keep-open', keep: true } }, '*');
    parent.postMessage({ devtoolsAnywhere: { type: 'close' } }, '*');
  });
  await new Promise(r => setTimeout(r, 500));
  const state = await page.evaluate(() => ({
    ran: window.__pageScriptRan,
    shell: sessionStorage.getItem('devtools-anywhere:shell'),
    stored: localStorage.getItem('devtools-anywhere:shell-mode'),
    height: document.getElementById('placed')?.getBoundingClientRect().height,
  }));
  assert.deepEqual(state, { ran: true, shell: null, stored: null, height: 300 });
});

test("in the shell's page, it works as on its own", async () => {
  await page.goto(url());
  // The user opens the global DevTools and turns shell mode on with its lock button.
  await page.waitForFunction(() => document.getElementById('global')?.getAttribute('aria-expanded'));
  await page.evaluate(() => document.getElementById('global')?.click());
  const global = await frontendOf('html > devtools-anywhere');
  const reloaded = page.waitForNavigation();
  await global.evaluate(() => parent.postMessage({ devtoolsAnywhere: { type: 'keep-open', keep: true } }, '*'));
  await reloaded;
  await page.evaluate(() => localStorage.removeItem('devtools-anywhere:shell-mode'));
  await page.waitForFunction(() => document.querySelector('devtools-anywhere[shell]'));
  const framed = await page.waitForFrame(f => f.url().includes('custom-element.html') && f !== page.mainFrame());
  const frontend = await frontendOf('#placed', framed);
  await framed.evaluate(() => console.log('in the shell'));
  await waitLogged(frontend, 'in the shell');
  const requests = await framed.evaluate(() => {
    let count = 0;
    document.getElementById('placed')?.addEventListener('devtools-toggle-request', () => count++);
    document.getElementById('request')?.click();
    return count;
  });
  assert.equal(requests, 1);
});

test("::part(iframe) styles the iframe of an element the page placed, not that of the probe's", async () => {
  // Out of the shell the previous test entered.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(url());
  await frontendOf('#placed');
  await page.waitForFunction(() => document.querySelector('html > devtools-anywhere'));
  const borders = await page.evaluate(() => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>devtools-anywhere::part(iframe) { border: 3px solid rgb(255, 0, 0); }</style>'
    );
    const border = (el: Element | null) => {
      const frame = el?.shadowRoot?.querySelector('iframe');
      return frame ? getComputedStyle(frame).borderTopWidth : null;
    };
    return {
      placed: border(document.getElementById('placed')),
      global: border(document.querySelector('html > devtools-anywhere')),
    };
  });
  assert.deepEqual(borders, { placed: '3px', global: '0px' });
});
