// A shadow host the page removes is collected even though the probe saw its shadow root attached
// (the frame registry watches such roots for iframes, and used to keep them until an iframe
// changed), and a host moved away and back still has iframes added in its shadow tree found.
// Only primitives come back from the page: a handle to an element would keep it alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
  },
  () => env?.close()
);

type Received = { id?: number; method?: string }[];
type TestWindow = Window & { __hostRef?: WeakRef<Element>; __moved?: Element };

const settle = () => page.evaluate(() => new Promise(r => setTimeout(r, 50)));

/** Opens the zero-config page and waits for its frontend to have enabled Page. */
async function openWithProbe(): Promise<void> {
  await page.goto(`${env?.baseUrl}/tests/e2e/pages/zero-config.html`);
  await page.waitForFunction(() => {
    const frame = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
    const received = (frame?.contentWindow as (Window & { received?: Received }) | null | undefined)?.received;
    return !!received?.some(m => m.id === 2);
  });
}

/** How many frames the frontend has heard attached. */
const framesAttached = () =>
  page.evaluate(() => {
    const frame = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
    const received = (frame?.contentWindow as (Window & { received?: Received }) | null | undefined)?.received;
    return (received ?? []).filter(m => m.method === 'Page.frameAttached').length;
  });

/** Inserts a custom element with an open shadow root, removes it, and tells whether it survives GC. */
async function hostSurvives(): Promise<boolean> {
  await page.evaluate(() => {
    customElements.define(
      'gc-host',
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<p>shadow</p>';
        }
      }
    );
    const host = document.createElement('gc-host');
    document.body.append(host);
    (window as TestWindow).__hostRef = new WeakRef(host);
  });
  await settle();
  await page.evaluate(() => {
    (window as TestWindow).__hostRef?.deref()?.remove();
  });
  await settle();
  const session = await page.createCDPSession();
  for (let i = 0; i < 3; i++) await session.send('HeapProfiler.collectGarbage');
  await session.detach();
  return page.evaluate(() => (window as TestWindow).__hostRef?.deref() !== undefined);
}

test('without the probe, a removed shadow host is collected (the measure works)', async () => {
  await page.goto(`${env?.baseUrl}/tests/e2e/pages/no-probe.html`);
  assert.equal(await hostSurvives(), false);
});

test('with the probe, a removed shadow host is collected, no iframe ever inserted', async () => {
  await openWithProbe();
  assert.equal(await hostSurvives(), false);
});

test('a shadow host moved away and back still has iframes added in its shadow tree found', async () => {
  await openWithProbe();
  const before = await framesAttached();
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = '<p>shadow</p>';
    document.body.append(host);
    (window as TestWindow).__moved = host;
  });
  await settle();
  await page.evaluate(() => (window as TestWindow).__moved?.remove());
  await settle();
  await page.evaluate(() => {
    const host = (window as TestWindow).__moved;
    if (host) document.body.append(host);
  });
  await settle();
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.src = 'about:blank';
    (window as TestWindow).__moved?.shadowRoot?.append(iframe);
  });
  await page.waitForFunction(
    before => {
      const frame = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
      const received = (frame?.contentWindow as (Window & { received?: Received }) | null | undefined)?.received;
      return (received ?? []).filter(m => m.method === 'Page.frameAttached').length > before;
    },
    { timeout: 5000 },
    before
  );
});
