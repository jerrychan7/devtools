// data-devtools-anywhere-toggle: any element of the page opens and closes the global
// <devtools-anywhere>, in the page itself and from the page inside the shell.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { frontendRequest, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;
const warnings: string[] = [];

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  page.on('console', m => {
    if (m.type() === 'warn') warnings.push(m.text());
  });
});
after(() => env?.close());

/** Whether DevTools is open, and each toggler's aria-expanded. */
const state = (frame: Page | Frame = page) =>
  frame.evaluate(() => ({
    open: (() => {
      const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
      return !!panel && getComputedStyle(panel).display !== 'none';
    })(),
    expanded: Object.fromEntries(
      [...document.querySelectorAll('[data-devtools-anywhere-toggle]')].map(el => [
        el.id,
        el.getAttribute('aria-expanded'),
      ])
    ),
  }));

const click = (selector: string, frame: Page | Frame = page) =>
  frame.evaluate(selector => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`no ${selector}`);
    el.click();
  }, selector);

/** Loads the page on its own, out of the shell, with DevTools hidden. */
async function load() {
  await page.goto(env?.baseUrl + '/tests/e2e/pages/toggle-page.html');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('devtools-anywhere')?.isConnected);
}

/**
 * Closes DevTools with its own × button, and waits for the element to have handled it: the
 * request is a message, handled after this returns.
 */
async function close() {
  await frontendRequest(page, { type: 'close' });
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return !panel || getComputedStyle(panel).display === 'none';
  });
}

test('togglers start with aria-expanded of their element', async () => {
  await load();
  assert.deepEqual(await state(), {
    open: false,
    expanded: { first: 'false', second: 'false', missing: null },
  });
});

test('the togglers toggle the element, which shows only in their aria-expanded', async () => {
  await load();
  await page.evaluate(() => {
    window.__toggles = [];
    const el = document.querySelector('devtools-anywhere');
    // No toggle event: the state is the togglers' aria-expanded.
    el?.addEventListener('toggle', () => window.__toggles?.push('toggle event'));
    new MutationObserver(() =>
      window.__toggles?.push(document.getElementById('first')?.getAttribute('aria-expanded') ?? '')
    ).observe(document.getElementById('first') as Element, { attributeFilter: ['aria-expanded'] });
  });
  // A click inside the toggler counts too.
  await click('#second span');
  assert.deepEqual(await state(), { open: true, expanded: { first: 'true', second: 'true', missing: null } });
  await click('#first');
  assert.deepEqual(await state(), { open: false, expanded: { first: 'false', second: 'false', missing: null } });
  // DevTools' own close button too.
  await click('#first');
  await close();
  await page.waitForFunction(() => document.getElementById('first')?.getAttribute('aria-expanded') === 'false');
  assert.deepEqual(await page.evaluate(() => window.__toggles), ['true', 'false', 'true', 'false']);
});

test('a toggler added later works, and follows the element', async () => {
  await load();
  await page.evaluate(() =>
    document.body.insertAdjacentHTML('beforeend', '<button id="late" data-devtools-anywhere-toggle>late</button>')
  );
  await click('#late');
  assert.deepEqual(await state(), {
    open: true,
    expanded: { first: 'true', second: 'true', missing: null, late: 'true' },
  });
  await close();
  await page.waitForFunction(() => document.getElementById('late')?.getAttribute('aria-expanded') === 'false');
});

test('a label toggler toggles once, though its control is clicked too', async () => {
  await load();
  await page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<label id="label" data-devtools-anywhere-toggle><input type="checkbox" /><span>label</span></label>'
    )
  );
  await click('#label span');
  assert.equal((await state()).open, true);
  await click('#label input');
  assert.equal((await state()).open, false);
});

test('the togglers follow the element when it is attached again', async () => {
  await load();
  await click('#first');
  await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    if (!el) throw new Error('no <devtools-anywhere>');
    el.remove();
    document.querySelectorAll('[data-devtools-anywhere-toggle]').forEach(t => t.removeAttribute('aria-expanded'));
    document.documentElement.append(el);
  });
  assert.deepEqual(await state(), { open: true, expanded: { first: 'true', second: 'true', missing: null } });
});

test('hidden, DevTools is told, to leave inspect mode', async () => {
  await load();
  await click('#first');
  const frontend = await page.waitForFrame(f => f.parentFrame() === page.mainFrame() && /frontend/.test(f.url()));
  await frontend.waitForFunction(() => (window.received ?? []).length > 0);
  assert.deepEqual(await frontend.evaluate(() => window.notices), []);
  await click('#first');
  await frontend.waitForFunction(() => (window.notices ?? []).length > 0);
  assert.deepEqual(await frontend.evaluate(() => window.notices), [{ devtoolsAnywhere: { type: 'hidden' } }]);
});

test('a toggler without its element only warns, once', async () => {
  await load();
  warnings.length = 0;
  const seen = (text: string) =>
    new Promise<void>(resolve => {
      const check = () => {
        if (!warnings.some(w => w.includes(text))) return;
        page.off('console', check);
        resolve();
      };
      page.on('console', check);
      check();
    });
  await click('#missing');
  await seen('"nowhere"');
  await click('#missing');
  // Console events arrive in order: once this one is in, a second warning would be too.
  const mark = seen('toggler mark');
  await page.evaluate(() => console.warn('toggler mark'));
  await mark;
  assert.equal((await state()).open, false);
  assert.equal(warnings.filter(w => w.includes('"nowhere"')).length, 1);
});

/** The page's frame inside the shell. */
const framed = () => {
  const frame = page
    .mainFrame()
    .childFrames()
    .find(f => f.url().includes('toggle-page'));
  assert.ok(frame, 'the page frame');
  return frame;
};
/** Waits for the page in the shell to load, a document other than the one started at `after`. */
const pageReady = (after = 0) =>
  page.waitForFunction(
    after => {
      const frame = document.getElementById('devtools-anywhere-page');
      const win = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
      return !!win?.DevtoolsAnywhere && win.document.readyState === 'complete' && win.performance.timeOrigin !== after;
    },
    {},
    after
  );
/** Loads the page in the shell (DevTools' lock button), with DevTools hidden. */
async function loadShell() {
  await load();
  await click('#first');
  const reloaded = page.waitForNavigation();
  await frontendRequest(page, { type: 'keep-open', keep: true });
  await reloaded;
  // Not remembered for the next tests.
  await page.evaluate(() => localStorage.removeItem('devtools-anywhere:shell-mode'));
  await page.waitForFunction(() => document.querySelector('devtools-anywhere[data-shell]'));
  await pageReady();
  await close();
  await framed().waitForFunction(() => document.getElementById('first')?.getAttribute('aria-expanded') === 'false');
}

test("in the shell, the page's togglers toggle the shell's element and follow it", async () => {
  await loadShell();
  assert.deepEqual((await state(framed())).expanded, { first: 'false', second: 'false', missing: null });
  // A missing id controls nothing there either: it only warns.
  warnings.length = 0;
  const warned = new Promise<void>(resolve => {
    const check = () => {
      if (!warnings.some(w => w.includes('"nowhere"'))) return;
      page.off('console', check);
      resolve();
    };
    page.on('console', check);
  });
  await click('#missing', framed());
  await warned;
  assert.equal((await state()).open, false);
  await click('#first', framed());
  assert.equal((await state()).open, true);
  assert.deepEqual((await state(framed())).expanded, { first: 'true', second: 'true', missing: null });
  // Closed from the shell (DevTools' × button), the page's togglers follow, through an event
  // from the shell's window.
  await close();
  await framed().waitForFunction(() => document.getElementById('first')?.getAttribute('aria-expanded') === 'false');
  assert.deepEqual((await state(framed())).expanded, { first: 'false', second: 'false', missing: null });
});

test("the page's listener on the shell's element goes with the page", async () => {
  await loadShell();
  // Tracks the shell element's state listeners from now on.
  await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    if (!el) throw new Error('no <devtools-anywhere>');
    const listeners = new Set<unknown>();
    window.__toggleListeners = listeners;
    // Own properties, in place of EventTarget's methods.
    const track = (name: 'addEventListener' | 'removeEventListener', tracked: (listener: unknown) => void) => {
      const original = el[name];
      Object.defineProperty(el, name, {
        value: (type: string, listener: unknown, options: unknown) => {
          if (type === 'devtools-anywhere-state') tracked(listener);
          Reflect.apply(original, el, [type, listener, options]);
        },
      });
    };
    track('addEventListener', listener => listeners.add(listener));
    track('removeEventListener', listener => listeners.delete(listener));
  });
  for (let i = 0; i < 2; i++) {
    const started = await framed().evaluate(() => performance.timeOrigin);
    await page.evaluate(() => {
      const frame = document.getElementById('devtools-anywhere-page');
      if (!(frame instanceof HTMLIFrameElement)) throw new Error('no page frame');
      frame.contentWindow?.location.reload();
    });
    await pageReady(started);
  }
  // The second page's listener was removed when the third came, which follows the shell.
  assert.equal(await page.evaluate(() => window.__toggleListeners?.size), 1);
  await click('#first', framed());
  assert.equal((await state(framed())).expanded['first'], 'true');
});
