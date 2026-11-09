// The vision deficiency mask and the embedded panel: as in Chrome, whose DevTools window is not
// filtered, the panel stays above the mask, also when the page opens top-layer elements later,
// and putting it back on top leaves typing in DevTools alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;
let frontend: Frame;

const RED = 'rgb(200, 40, 40)';

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(env.baseUrl + '/tests/e2e/pages/zero-config.html');
    await page.waitForFunction(() => {
      const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
      return !!panel && getComputedStyle(panel).display !== 'none';
    });
    for (let start = Date.now(); ;) {
      const found = page.frames().find(f => f.url().includes('fake-frontend.html'));
      if (found && (await found.evaluate(() => document.readyState === 'complete'))) {
        frontend = found;
        break;
      }
      assert.ok(Date.now() - start < 5000, 'the fake frontend');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // The same color on both sides, so that a filter shows on either.
    await page.evaluate(red => {
      document.documentElement.style.background = red;
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="pop" popover="manual" style="inset:0 auto auto 0;width:100px;height:100px;margin:0;border:0;background:${red}"></div>`
      );
    }, RED);
    await frontend.evaluate(red => {
      document.documentElement.style.background = red;
      document.body.insertAdjacentHTML('beforeend', '<input id="input" style="position:fixed;right:0;bottom:0">');
    }, RED);
  },
  () => env?.close()
);

let nextId = 1000;

/** Sends a CDP command from the fake frontend, as the real one does, and waits for its answer. */
async function send(method: string, params: object) {
  const id = nextId++;
  await frontend.evaluate(
    (id, method, params) => parent.postMessage(JSON.stringify({ id, method, params }), '*'),
    id,
    method,
    params
  );
  const answer = await frontend.waitForFunction(
    id => (Reflect.get(window, 'received') as { id?: number }[]).find(m => m.id === id),
    {},
    id
  );
  assert.equal(JSON.stringify(await answer.jsonValue()).includes('"error"'), false);
}

/** The page's color at (x, y), and the panel's at the middle of its frame. */
async function colors() {
  const box = await page.evaluate(() => {
    const frame = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
    const r = frame?.getBoundingClientRect();
    return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
  });
  assert.ok(box);
  const shot = await page.screenshot({ encoding: 'base64' });
  return page.evaluate(
    async (data, box) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const g = canvas.getContext('2d');
      g?.drawImage(img, 0, 0);
      const at = (x: number, y: number) => Array.from(g?.getImageData(x, y, 1, 1).data ?? []);
      return { page: at(40, 40), panel: at(box.x, box.y) };
    },
    shot,
    box
  );
}

const waitFrames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

test('the panel is not filtered, the page is, also under a popover the page opens later', async () => {
  const plain = await colors();
  assert.deepEqual(plain.page, plain.panel);
  await send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  try {
    await waitFrames();
    const seen = await colors();
    assert.notDeepEqual(seen.page, plain.page);
    assert.deepEqual(seen.panel, plain.panel);
    await page.evaluate(() => document.getElementById('pop')?.showPopover());
    await waitFrames();
    const later = await colors();
    assert.deepEqual(later.page, seen.page, 'the popover is under the mask');
    assert.deepEqual(later.panel, plain.panel, 'the panel is above it');
  } finally {
    await page.evaluate(() => document.getElementById('pop')?.hidePopover());
    await send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
    await waitFrames();
  }
  assert.deepEqual(await colors(), plain);
});

test('typing in the panel goes on while the page opens a popover', async () => {
  await send('Emulation.setEmulatedVisionDeficiency', { type: 'deuteranopia' });
  try {
    await waitFrames();
    await frontend.focus('#input');
    await page.keyboard.type('ab');
    await frontend.evaluate(() => (document.getElementById('input') as HTMLInputElement).setSelectionRange(1, 1));
    await page.evaluate(() => document.getElementById('pop')?.showPopover());
    await waitFrames();
    await page.keyboard.type('cd');
    const state = await frontend.evaluate(() => {
      const input = document.getElementById('input') as HTMLInputElement;
      return { value: input.value, focused: document.activeElement === input && document.hasFocus() };
    });
    assert.deepEqual(state, { value: 'acdb', focused: true });
  } finally {
    await page.evaluate(() => document.getElementById('pop')?.hidePopover());
    await send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('the panel of an element removed and inserted again goes above the mask again', async () => {
  const old = frontend;
  await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    el?.remove();
    if (el) document.body.append(el);
  });
  // Its frontend loads again: found, and given the page's color again.
  for (let start = Date.now(); ;) {
    const found = page.frames().find(f => f !== old && !f.detached && f.url().includes('fake-frontend.html'));
    if (found && (await found.evaluate(() => document.readyState === 'complete'))) {
      frontend = found;
      break;
    }
    assert.ok(Date.now() - start < 5000, 'the fake frontend again');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await frontend.evaluate(red => {
    document.documentElement.style.background = red;
  }, RED);
  await send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  try {
    await page.evaluate(() => document.getElementById('pop')?.showPopover());
    await waitFrames();
    const seen = await colors();
    assert.deepEqual(seen.panel, [200, 40, 40, 255], 'the panel is above the mask');
    assert.notDeepEqual(seen.page, seen.panel, 'the page is under it');
  } finally {
    await page.evaluate(() => document.getElementById('pop')?.hidePopover());
    await send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});
