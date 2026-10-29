// Several CDP sessions on one page, as several clients of Chrome: each keeps its own bodies,
// forces its own pseudo-classes, and leaves nothing installed behind per session.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { CDP_BUNDLE, launch, type Env } from '../../test-support/conformance.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await page.addScriptTag({ path: CDP_BUNDLE });
  await page.evaluate(() => {
    window.__sessions = [window.DevtoolsAnywhere.createCdpSession(), window.DevtoolsAnywhere.createCdpSession()];
  });
});
after(() => env?.close());

/** Calls `method` in session `index`; an error comes back as its message. */
const call = (index: number, method: string, params: object = {}) =>
  page.evaluate(
    (index, method, params) => {
      const session = window.__sessions?.[index];
      if (!session) throw new Error(`no session ${index}`);
      return session.call(method, params).catch((e: unknown) => String(e instanceof Error ? e.message : e));
    },
    index,
    method,
    params
  );

/** Fetches `url` in the page and returns the probe's request id for it. */
async function fetchId(url: string): Promise<string> {
  await page.evaluate(url => fetch(url).then(r => r.text()), url);
  return page
    .waitForFunction(
      url => window.__devtoolsAnywhereProbe__?.requests.find(r => r.url.endsWith(url) && r.state === 'done')?.requestId,
      {},
      url
    )
    .then(handle => handle.jsonValue() as Promise<string>);
}

const bodyLength = async (index: number, requestId: string) => {
  const result = await call(index, 'Network.getResponseBody', { requestId });
  return typeof result === 'object' && result && 'body' in result && typeof result.body === 'string'
    ? result.body.length
    : result;
};

test("each session keeps bodies within its own buffer sizes, not the other's", async () => {
  await call(0, 'Network.enable', { maxTotalBufferSize: 3000, maxResourceBufferSize: 2500 });
  await call(1, 'Network.enable', {});
  const big = await fetchId('/api/echo?n=multi-big&pad=' + 'x'.repeat(3000));
  const first = await fetchId('/api/echo?n=multi-first&pad=' + 'x'.repeat(2000));
  const second = await fetchId('/api/echo?n=multi-second&pad=' + 'x'.repeat(2000));
  const evicted = 'Request content was evicted from inspector cache';
  assert.equal(await bodyLength(0, big), evicted, 'over its resource size');
  assert.equal(await bodyLength(0, first), evicted, 'past its total');
  assert.equal(typeof (await bodyLength(0, second)), 'number');
  for (const id of [big, first, second]) assert.equal(typeof (await bodyLength(1, id)), 'number', id);
  await call(0, 'Network.disable');
  await call(1, 'Network.disable');
});
