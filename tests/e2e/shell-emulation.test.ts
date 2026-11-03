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

const base = metrics(400, 600);
/** Params Chrome rejects, one check each, and ones it takes. */
const checked: object[] = [
  { ...base, width: -1 },
  { ...base, height: 10000001 },
  { ...base, width: 1.5 },
  { ...base, width: '4' },
  { height: 600, deviceScaleFactor: 1, mobile: false },
  { width: 400, height: 600, mobile: false },
  { ...base, mobile: 'x' },
  { ...base, deviceScaleFactor: -1 },
  { ...base, scale: 0 },
  { ...base, scale: 10.1 },
  { ...base, scale: 10 },
  { ...base, screenWidth: -1 },
  { ...base, screenHeight: 100000000 },
  { ...base, positionX: -1 },
  { ...base, positionX: 100 },
  { ...base, screenWidth: 500, screenHeight: 700, positionX: 100, positionY: 100 },
  { ...base, screenOrientation: { type: 'portraitPrimary', angle: 360 } },
  { ...base, screenOrientation: { type: 'bogus', angle: 0 } },
  { ...base, screenOrientation: { type: 'landscapePrimary', angle: 90 } },
  { ...base, displayFeature: { orientation: 'vertical', offset: -1, maskLength: 1 } },
  { ...base, displayFeature: { orientation: 'bogus', offset: 1, maskLength: 1 } },
  { ...base, displayFeature: { orientation: 'vertical', offset: 399, maskLength: 2 } },
  { ...base, displayFeature: { orientation: 'horizontal', offset: 10, maskLength: 2 } },
  { ...base, displayFeature: { orientation: 'horizontal', offset: 599, maskLength: 2 } },
  { ...base, width: 0, displayFeature: { orientation: 'vertical', offset: 1, maskLength: 1 } },
  { ...base, displayFeature: { orientation: 'vertical', offset: 1 } },
  { ...base, displayFeature: { orientation: 'vertical', offset: 1.5, maskLength: 1 } },
  { ...base, displayFeature: { orientation: 1, offset: 1, maskLength: 1 } },
  { ...base, screenOrientation: { type: 'portraitPrimary' } },
  { ...base, screenOrientation: { angle: 0 } },
  { ...base, screenOrientation: { type: 'portraitPrimary', angle: 1.5 } },
  { ...base, screenOrientation: { type: 5, angle: 0 } },
  { ...base, screenOrientation: { type: 'bogus' } },
  { ...base, screenOrientation: 5 },
  { ...base, screenOrientation: null },
  { ...base, viewport: { x: 0, y: 0, width: 10, height: 10 } },
  { ...base, viewport: { width: 'a', x: 'b', y: 0, height: 1, scale: 1 } },
  { ...base, viewport: { x: 'b' } },
  { ...base, viewport: { y: 0 } },
  { ...base, viewport: { x: -1.5, y: -1, width: -10, height: 10, scale: -1, zoom: 'a' } },
  { ...base, viewport: 1 },
  { ...base, screenOrientation: { type: 5 }, viewport: { x: 'b' } },
  { ...base, devicePosture: { type: 'folded' } },
  { ...base, devicePosture: {} },
  { ...base, devicePosture: { type: 1 } },
  { ...base, dontSetVisibleSize: 'x' },
  { ...base, scrollbarType: 'bogus' },
  { ...base, scrollbarType: 1 },
];
/** An error as compared: Chrome's deserialization details end with a position, which is left out. */
interface Response {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}
const errorOf = (error: unknown) =>
  error === undefined || error === null ? 'ok' : JSON.stringify(error).replace(/ at position \d+/, '');

test("in shell mode, the page's clients check device metrics as Chrome does", async () => {
  assert.ok(env);
  const chrome = await env.browser.newPage();
  await chrome.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  // Chrome's raw responses, with their codes and data, over the browser's own connection.
  const socket = new WebSocket(env.browser.wsEndpoint());
  await new Promise(resolve => (socket.onopen = resolve));
  const answers = new Map<number, (message: Response) => void>();
  socket.onmessage = event => {
    const message: Response = JSON.parse(String(event.data));
    if (typeof message.id === 'number') answers.get(message.id)?.(message);
  };
  let seq = 0;
  const raw = (method: string, params: object, sessionId?: string) =>
    new Promise<Response>(resolve => {
      answers.set(++seq, resolve);
      socket.send(JSON.stringify({ id: seq, method, params, sessionId }));
    });
  const listed = await raw('Target.getTargets', {});
  const infos: unknown = Reflect.get(listed.result ?? {}, 'targetInfos');
  const info = Array.isArray(infos) ? infos.find(t => Reflect.get(t, 'url') === chrome.url()) : undefined;
  const attached = await raw('Target.attachToTarget', { targetId: Reflect.get(info, 'targetId'), flatten: true });
  const sessionId = String(Reflect.get(attached.result ?? {}, 'sessionId'));
  const expected: string[] = [];
  for (const params of checked) {
    expected.push(errorOf((await raw('Emulation.setDeviceMetricsOverride', params, sessionId)).error));
    await raw('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  }
  socket.close();
  await chrome.close();
  const actual = await page.evaluate(async checked => {
    const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    const session = view?.__sessions?.[0];
    if (!session) throw new Error('no session');
    const received: unknown[] = [];
    const off = session.onMessage(message => received.push(JSON.parse(message)));
    let id = 1000;
    for (const params of checked) {
      await session.dispatch(JSON.stringify({ id: ++id, method: 'Emulation.setDeviceMetricsOverride', params }));
      await session.dispatch(JSON.stringify({ id: ++id, method: 'Emulation.clearDeviceMetricsOverride' }));
    }
    off();
    return received.filter((_, index) => index % 2 === 0).map(message => Reflect.get(Object(message), 'error'));
  }, checked);
  assert.deepEqual(actual.map(errorOf), expected);
  assert.equal(await pageSize(), natural);
});

test("in shell mode, setting the same override again does nothing, the same as Chrome's", async () => {
  // Measured in Chrome: the same whatever the key order, with omitted fields as their defaults
  // (scale 1, screen size 0, one view coordinate alone); different with both view coordinates,
  // or a screen orientation, given.
  const same: object[] = [
    { mobile: false, deviceScaleFactor: 1, height: 600, width: 400 },
    { ...base, scale: 1 },
    { ...base, screenWidth: 0, screenHeight: 0 },
    { ...base, screenWidth: 0, positionX: 0 },
    { ...base, dontSetVisibleSize: true },
    { ...base, devicePosture: { type: 'continuous' } },
  ];
  const different: object[] = [
    { ...base, positionX: 0, positionY: 0, screenWidth: 0, screenHeight: 0 },
    { ...base, screenOrientation: { type: 'portraitPrimary', angle: 0 } },
    { ...base, mobile: true },
  ];
  for (const [variants, size] of [
    [same, '700x300'],
    [different, '400x600'],
  ] as const) {
    for (const variant of variants) {
      assert.equal(await call(0, 'Emulation.setDeviceMetricsOverride', base), 'ok');
      assert.equal(await call(1, 'Emulation.setDeviceMetricsOverride', metrics(700, 300)), 'ok');
      assert.equal(await call(0, 'Emulation.setDeviceMetricsOverride', variant), 'ok');
      assert.equal(await pageSize(), size, JSON.stringify(variant));
      await call(0, 'Emulation.clearDeviceMetricsOverride');
      await call(1, 'Emulation.clearDeviceMetricsOverride');
    }
  }
});

test('in shell mode, nested fields are the same to Chrome by their known fields, in any order', async () => {
  // Measured in Chrome, set twice by A while B's override is on: the same (a no-op) or not.
  const viewport = { x: 0, y: 0, width: 400, height: 600, scale: 1 };
  const pairs: [object, object, boolean][] = [
    [{ viewport }, { viewport: { scale: 1, height: 600, width: 400, y: 0, x: 0 } }, true],
    [{ viewport }, { viewport: { ...viewport, zoom: 2 } }, true],
    [{ viewport }, { viewport: { ...viewport, x: 1 } }, false],
    [
      { screenOrientation: { type: 'portraitPrimary', angle: 0 } },
      { screenOrientation: { angle: 0, type: 'portraitPrimary' } },
      true,
    ],
    [
      { displayFeature: { orientation: 'vertical', offset: 1, maskLength: 1 } },
      { displayFeature: { maskLength: 1, offset: 1, orientation: 'vertical' } },
      true,
    ],
    [{}, { devicePosture: { type: 'continuous' } }, true],
    [{}, { devicePosture: { type: 'folded' } }, false],
  ];
  for (const [first, again, same] of pairs) {
    assert.equal(await call(0, 'Emulation.setDeviceMetricsOverride', { ...base, ...first }), 'ok');
    assert.equal(await call(1, 'Emulation.setDeviceMetricsOverride', metrics(700, 300)), 'ok');
    assert.equal(await call(0, 'Emulation.setDeviceMetricsOverride', { ...base, ...again }), 'ok');
    assert.equal(await pageSize(), same ? '700x300' : '400x600', JSON.stringify([first, again]));
    await call(0, 'Emulation.clearDeviceMetricsOverride');
    await call(1, 'Emulation.clearDeviceMetricsOverride');
  }
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
