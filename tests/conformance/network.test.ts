import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from './harness.ts';
import type { Env, EventName, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.loadingFailed',
  ]);
  await t.chrome.send('Network.enable');
  await t.ours.send('Network.enable');
});
after(() => env?.close());

const header = (headers: Record<string, unknown>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];

/** Runs `expression` in the page and returns both sides' events for the request to `marker`. */
async function request(expression: string, marker: string, finalEvent: EventName = 'Network.loadingFinished') {
  await t.chrome.clear();
  await t.ours.clear();
  await t.page.evaluate(expression);
  await waitForBoth(t, finalEvent);
  const pick = async (side: Side) => {
    const sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes(marker));
    assert.ok(sent, `no request to ${marker}`);
    const ofRequest = (e: { requestId: string }) => e.requestId === sent.requestId;
    return {
      sent,
      response: (await side.events('Network.responseReceived')).find(ofRequest),
      finished: (await side.events('Network.loadingFinished')).find(ofRequest),
      failed: (await side.events('Network.loadingFailed')).find(ofRequest),
    };
  };
  return { ours: await pick(t.ours), chrome: await pick(t.chrome) };
}

describe('Network', () => {
  test('fetch GET', async () => {
    const { ours, chrome } = await request("void fetch('/api/echo?n=get')", 'n=get');
    assert.equal(ours.sent.type, chrome.sent.type);
    assert.equal(ours.sent.request.method, chrome.sent.request.method);
    assert.equal(ours.sent.request.url, chrome.sent.request.url);
    assert.ok(ours.response && chrome.response);
    assert.equal(ours.response.response.status, chrome.response.response.status);
    assert.equal(ours.response.response.mimeType, chrome.response.response.mimeType);
    assert.equal(ours.response.response.headers['x-echo'], chrome.response.response.headers['x-echo']);

    const [oursBody, chromeBody] = await Promise.all([
      t.ours.send('Network.getResponseBody', { requestId: ours.sent.requestId }),
      t.chrome.send('Network.getResponseBody', { requestId: chrome.sent.requestId }),
    ]);
    assert.deepEqual(oursBody, chromeBody);
  });

  test('fetch POST with a body', async () => {
    const { ours, chrome } = await request(
      "void fetch('/api/echo?n=post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"a\":1}' })",
      'n=post'
    );
    assert.equal(ours.sent.request.method, chrome.sent.request.method);
    assert.equal(ours.sent.request.postData, chrome.sent.request.postData);
    assert.equal(ours.sent.request.hasPostData, chrome.sent.request.hasPostData);
    assert.equal(
      header(ours.sent.request.headers, 'content-type'),
      header(chrome.sent.request.headers, 'content-type')
    );
  });

  test('XHR', async () => {
    const { ours, chrome } = await request(
      "(() => { const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=xhr'); x.send() })()",
      'n=xhr'
    );
    assert.equal(ours.sent.type, chrome.sent.type);
    assert.ok(ours.response && chrome.response);
    assert.equal(ours.response.response.status, chrome.response.response.status);
  });

  test('404', async () => {
    const { ours, chrome } = await request("void fetch('/missing?n=404')", 'n=404');
    assert.ok(ours.response && chrome.response);
    assert.equal(ours.response.response.status, chrome.response.response.status);
    assert.ok(ours.finished && chrome.finished);
  });

  test('network error', async () => {
    const { ours, chrome } = await request(
      "void fetch('http://127.0.0.1:1/?n=refused').catch(() => {})",
      'n=refused',
      'Network.loadingFailed'
    );
    assert.ok(ours.failed, 'ours emits loadingFailed');
    assert.ok(chrome.failed, 'chrome emits loadingFailed');
    assert.equal(ours.failed.type, chrome.failed.type);
  });

  // Requests that cannot be hooked are known from Resource Timing once they finished.
  for (const [name, expression, marker] of [
    ['image', "(() => { const i = new Image(); i.src = '/tests/conformance/assets/pixel.png?n=img' })()", 'n=img'],
    [
      'style sheet',
      "(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/tests/conformance/assets/cross.css?n=css'; document.head.append(l) })()",
      'n=css',
    ],
    [
      'script',
      "(() => { const s = document.createElement('script'); s.src = '/tests/conformance/assets/resource.js?n=js'; document.head.append(s) })()",
      'n=js',
    ],
  ] as const) {
    test(`${name} (Resource Timing)`, async () => {
      const { ours, chrome } = await request(expression, marker);
      assert.ok(ours.sent, 'ours reports the request');
      assert.equal(ours.sent.type, chrome.sent.type);
      assert.equal(ours.sent.request.url, chrome.sent.request.url);
      assert.equal(ours.sent.request.method, chrome.sent.request.method);
      assert.ok(ours.response && chrome.response);
      assert.equal(ours.response.response.status, chrome.response.response.status);
      assert.equal(ours.response.response.mimeType, chrome.response.response.mimeType);
      assert.ok(ours.finished);

      const [oursBody, chromeBody] = await Promise.all([
        t.ours.send('Network.getResponseBody', { requestId: ours.sent.requestId }),
        t.chrome.send('Network.getResponseBody', { requestId: chrome.sent.requestId }),
      ]);
      assert.deepEqual(oursBody, chromeBody);
    });
  }

  test('the resource tree lists the page resources (Sources panel)', async () => {
    const tree = await t.ours.send('Page.getResourceTree');
    const urls = tree.frameTree.resources.map(r => r.url);
    assert.ok(
      urls.some(u => u.includes('n=css')),
      JSON.stringify(urls)
    );
    assert.ok(urls.some(u => u.includes('n=js')));
  });

  test('resource content: text as is, binary as base64 (Sources panel)', async () => {
    await t.chrome.send('Page.enable');
    const { frameTree } = await t.chrome.send('Page.getFrameTree');
    const origin = new URL(t.page.url()).origin;
    // Chrome only knows the content of style sheets loaded while Page is enabled.
    await t.page.evaluate(
      () =>
        new Promise(resolve =>
          document.head.append(
            Object.assign(document.createElement('link'), {
              rel: 'stylesheet',
              onload: resolve,
              href: '/tests/conformance/assets/cross.css?n=content',
            })
          )
        )
    );
    const css = `${origin}/tests/conformance/assets/cross.css?n=content`;
    const [ours, chrome] = await Promise.all([
      t.ours.send('Page.getResourceContent', { frameId: 'any', url: css }),
      t.chrome.send('Page.getResourceContent', { frameId: frameTree.frame.id, url: css }),
    ]);
    assert.deepEqual(ours, chrome);

    // Headless Chrome does not keep image content for Page.getResourceContent; its response
    // body is the same data.
    const { chrome: image } = await request(
      "(() => { const i = new Image(); i.src = '/tests/conformance/assets/pixel.png?n=content' })()",
      'n=content'
    );
    const body = await t.chrome.send('Network.getResponseBody', { requestId: image.sent.requestId });
    const content = await t.ours.send('Page.getResourceContent', { frameId: 'any', url: image.sent.request.url });
    assert.deepEqual(content, { content: body.body, base64Encoded: true });
  });
});
