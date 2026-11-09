// A <devtools-anywhere> the page removes can be garbage collected, with its panel and its
// frontend's iframe: nothing of ours (listeners on the page's window, media queries, module
// state) keeps it alive. Every evaluate returns plain values: a handle to a node would itself be
// held by DevTools and keep the element alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

declare global {
  interface Window {
    gcRefs?: WeakRef<object>[];
    gcKeep?: unknown;
  }
}

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
  },
  () => env?.close()
);

/**
 * Collects garbage a few times, then tells which of window.gcRefs are still alive. Until
 * `within` ms have passed, tries again while one is: what the removal started (the frontend's
 * iframe unloading, its last messages) may hold the element for a moment, a leak for good.
 */
async function alive(within = 0): Promise<boolean[]> {
  const cdp = await page.createCDPSession();
  try {
    for (const start = Date.now(); ;) {
      for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
      const states = await page.evaluate(() => (window.gcRefs ?? []).map(ref => ref.deref() !== undefined));
      if (!states.includes(true) || Date.now() - start >= within) return states;
      await new Promise(r => setTimeout(r, 250));
    }
  } finally {
    await cdp.detach();
  }
}

/** Waits until the element `selector` has its frontend loaded, then removes it, keeping weak references. */
async function removeOnceLoaded(selector: string) {
  await page.waitForFunction(
    selector => {
      const frame = document.querySelector(selector)?.shadowRoot?.querySelector('iframe');
      return !!frame?.contentWindow?.received?.length;
    },
    {},
    selector
  );
  await page.evaluate(selector => {
    const el = document.querySelector(selector);
    const panel = el?.shadowRoot?.querySelector('.panel');
    const frame = el?.shadowRoot?.querySelector('iframe');
    if (!el || !panel || !frame) throw new Error('no element');
    window.gcRefs = [new WeakRef(el), new WeakRef(panel), new WeakRef(frame)];
    el.remove();
    return true;
  }, selector);
  // Let what the removal starts (the iframe unloading, timers) settle.
  await new Promise(r => setTimeout(r, 300));
}

test('the measure: without the probe, a removed element is collected, and a kept one is not', async () => {
  await page.goto(env?.baseUrl + '/tests/e2e/pages/no-probe.html');
  await page.evaluate(() => {
    const make = () => {
      const el = document.createElement('div');
      el.append(document.createElement('iframe'));
      document.body.append(el);
      return el;
    };
    const dropped = make();
    const kept = make();
    window.gcRefs = [new WeakRef(dropped), new WeakRef(kept)];
    window.gcKeep = kept;
    dropped.remove();
    kept.remove();
    return true;
  });
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(await alive(), [false, true]);
});

test('an element the page placed is collected once removed', async () => {
  await page.goto(env?.baseUrl + '/tests/e2e/pages/custom-element.html');
  await removeOnceLoaded('#placed');
  assert.deepEqual(await alive(3000), [false, false, false], 'element, panel, frontend iframe');
});

/** The global element's grip: its middle and size, and the panel's height. */
const gripState = () =>
  page.evaluate(() => {
    const root = document.querySelector('devtools-anywhere')?.shadowRoot;
    const grip = root?.querySelector<HTMLElement>('[title="Drag to resize"]');
    const panel = root?.querySelector('.panel');
    if (!grip || !panel) throw new Error('no grip');
    const box = grip.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height, panel: panel.clientHeight };
  });

/** Waits for the grip to be `height` px across its edge. */
const waitGrip = (height: number) =>
  page.waitForFunction(
    height => {
      const root = document.querySelector('devtools-anywhere')?.shadowRoot;
      return root?.querySelector<HTMLElement>('[title="Drag to resize"]')?.offsetHeight === height;
    },
    { timeout: 3000 },
    height
  );

test('the global element put back still follows the pointer and resizes by its grip', async () => {
  await page.goto(env?.baseUrl + '/tests/e2e/pages/zero-config.html');
  await page.evaluate(() => {
    localStorage.setItem('devtools-anywhere:dock', 'bottom');
    return true;
  });
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel'));
  await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    if (!el) throw new Error('no element');
    el.remove();
    document.body.append(el);
    return true;
  });
  const cdp = await page.createCDPSession();
  try {
    assert.equal((await gripState()).height, 12, 'for a mouse');
    // A touch screen from now on: the grip grows for a finger, then shrinks back.
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await waitGrip(20);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await waitGrip(12);
  } finally {
    await cdp.detach();
  }
  const before = await gripState();
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x, before.y - 60, { steps: 4 });
  await page.mouse.up();
  const after = await gripState();
  assert.ok(after.panel - before.panel >= 50, `panel ${before.panel} -> ${after.panel}`);
});
