// Device metrics overrides from clients of a page in shell mode other than the shell's frontend,
// as Chrome applies those of several CDP sessions of one page. Chrome, measured with two sessions
// A and B: the page has one override, the last set (A sets 400x600, B 700x300: 700x300); a
// session's clear, or its detach, clears it when that session's own override is on, whoever set it
// last (A clears: the page's own size, not B's); a session without one clearing or detaching
// changes nothing. The first test checks this in Chrome; the next ones, the shell mirroring it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { frontendRequest, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';
import { CDP_BUNDLE } from '../../packages/devtools-anywhere/test-support/conformance.ts';

let env: Env | undefined;
let page: Page;
/** The page iframe's size without an override, in shell mode. */
let natural = '';

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
});
after(() => env?.close());

const metrics = (width: number, height: number) => ({ width, height, deviceScaleFactor: 1, mobile: false });

test("Chrome: one override, the last set; a session's clear or detach ends it if its own is on", async () => {
  assert.ok(env);
  const chrome = await env.browser.newPage();
  await chrome.setViewport(null);
  await chrome.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  // innerWidth follows the override a frame later.
  const size = async () => {
    await new Promise(r => setTimeout(r, 300));
    return chrome.evaluate(() => `${innerWidth}x${innerHeight}`);
  };
  const natural = await size();
  const [a, b, c] = await Promise.all([
    chrome.createCDPSession(),
    chrome.createCDPSession(),
    chrome.createCDPSession(),
  ]);
  await a.send('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  await b.send('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  assert.equal(await size(), '700x300');
  await a.send('Emulation.clearDeviceMetricsOverride');
  assert.equal(await size(), natural, "A's clear ends B's override too");
  await b.send('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await c.send('Emulation.clearDeviceMetricsOverride');
  assert.equal(await size(), '700x300', 'a session without an override clears nothing');
  await c.detach();
  assert.equal(await size(), '700x300', 'nor does its detach');
  await a.send('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  await b.send('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await a.detach();
  assert.equal(await size(), natural, "A's detach ends B's override too");
  await b.detach();
  await chrome.close();
});

/** Calls `method` in the page's CDP session `index` (in the page iframe); an error comes back as its message. */
const call = (index: number, method: string, params: object = {}) =>
  page.evaluate(
    (index, method, params) => {
      const frame = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page');
      const session = frame?.contentWindow?.__sessions?.[index];
      if (!session) throw new Error(`no session ${index}`);
      return session.call(method, params).then(
        () => 'ok',
        (e: unknown) => String(e instanceof Error ? e.message : e)
      );
    },
    index,
    method,
    params
  );

/** The page iframe's size, once it has followed the override. */
async function pageSize() {
  await new Promise(r => setTimeout(r, 300));
  return page.evaluate(() => {
    const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!view) throw new Error('no page window');
    return `${view.innerWidth}x${view.innerHeight}`;
  });
}

test("in shell mode, the page's other clients set and clear its size as in Chrome", async () => {
  assert.ok(env);
  await page.goto(env.baseUrl + '/tests/e2e/pages/shell-page.html');
  await frontendRequest(page, { type: 'keep-open', keep: true });
  await page.waitForFunction(() => {
    const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!view?.DevtoolsAnywhere) return false;
    view.__sessions ??= [view.DevtoolsAnywhere.createCdpSession(), view.DevtoolsAnywhere.createCdpSession()];
    return true;
  });
  // Where the shell's frontend lays out the page: only then does the shell size it.
  await frontendRequest(page, { type: 'page-bounds', x: 0, y: 0, width: 300, height: 200 });
  natural = await pageSize();
  assert.equal(natural, '300x200');
  assert.equal(await call(0, 'Emulation.setDeviceMetricsOverride', metrics(400, 600)), 'ok');
  assert.equal(await pageSize(), '400x600');
  assert.equal(await call(1, 'Emulation.setDeviceMetricsOverride', metrics(700, 300)), 'ok');
  assert.equal(await pageSize(), '700x300');
  assert.equal(await call(0, 'Emulation.clearDeviceMetricsOverride'), 'ok');
  assert.equal(await pageSize(), natural, "A's clear ends B's override too");
  assert.equal(await call(1, 'Emulation.setDeviceMetricsOverride', metrics(700, 300)), 'ok');
  assert.equal(await call(0, 'Emulation.clearDeviceMetricsOverride'), 'ok');
  assert.equal(await pageSize(), '700x300', 'a client without an override clears nothing');
});

test("in shell mode, a client's session ending ends its override", async () => {
  // Its client gone, the session is reset, as connectFrontend and connectRemote do.
  await page.evaluate(() => {
    const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    view?.__sessions?.[1]?.reset();
  });
  assert.equal(await pageSize(), natural);
});

test('outside shell mode, the page cannot resize itself: the methods say so', async () => {
  assert.ok(env);
  const plain = await env.browser.newPage();
  await plain.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await plain.addScriptTag({ path: CDP_BUNDLE });
  // The responses as a frontend gets them: a server error, as Chrome's when a command cannot be done.
  const responses = await plain.evaluate(async () => {
    const session = window.DevtoolsAnywhere.createCdpSession();
    const received: unknown[] = [];
    session.onMessage(message => received.push(JSON.parse(message)));
    const params = { width: 400, height: 600, deviceScaleFactor: 1, mobile: false };
    await session.dispatch(JSON.stringify({ id: 1, method: 'Emulation.setDeviceMetricsOverride', params }));
    await session.dispatch(JSON.stringify({ id: 2, method: 'Emulation.clearDeviceMetricsOverride', params: {} }));
    return received;
  });
  const error = { code: -32000, message: 'Device metrics can only be overridden in shell mode' };
  assert.deepEqual(responses, [
    { id: 1, error },
    { id: 2, error },
  ]);
  await plain.close();
});
