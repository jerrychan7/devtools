import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from './harness.ts';
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
  // Wait for the final event of the marker request itself on both sides: another request (a late
  // Resource Timing report, favicon) can finish first.
  const settled = async (side: Side) => {
    const sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes(marker));
    if (!sent) return false;
    const final: { requestId: string }[] = await side.events(finalEvent);
    return final.some(e => e.requestId === sent.requestId);
  };
  const start = Date.now();
  while (!((await settled(t.ours)) && (await settled(t.chrome)))) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${finalEvent} of ${marker}`);
    await new Promise(r => setTimeout(r, 20));
  }
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

async function enableBoth(params: Protocol.Network.EnableRequest) {
  await Promise.all([t.ours.send('Network.enable', params), t.chrome.send('Network.enable', params)]);
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

  // Bodies of every response type: text as is, binary data as base64, like Chrome.
  for (const [name, expression, marker] of [
    ['fetch of an image', "void fetch('/tests/conformance/assets/pixel.png?n=fetch-png')", 'n=fetch-png'],
    [
      'XHR with responseType blob',
      "(() => { const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=xhr-blob'); x.responseType = 'blob'; x.send() })()",
      'n=xhr-blob',
    ],
    [
      'XHR with responseType arraybuffer',
      "(() => { const x = new XMLHttpRequest(); x.open('GET', '/tests/conformance/assets/pixel.png?n=xhr-ab'); x.responseType = 'arraybuffer'; x.send() })()",
      'n=xhr-ab',
    ],
  ] as const) {
    test(`response body: ${name}`, async () => {
      const { ours, chrome } = await request(expression, marker);
      const [oursBody, chromeBody] = await Promise.all([
        t.ours.send('Network.getResponseBody', { requestId: ours.sent.requestId }),
        t.chrome.send('Network.getResponseBody', { requestId: chrome.sent.requestId }),
      ]);
      assert.deepEqual(oursBody, chromeBody);
    });
  }

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

  test('fetch of a Request with a body', async () => {
    const { ours, chrome } = await request(
      "void fetch(new Request('/api/echo?n=post-request', { method: 'POST', body: 'from a request' }))",
      'n=post-request'
    );
    assert.equal(ours.sent.request.hasPostData, chrome.sent.request.hasPostData);
    const [oursData, chromeData] = await Promise.all([
      t.ours.send('Network.getRequestPostData', { requestId: ours.sent.requestId }),
      t.chrome.send('Network.getRequestPostData', { requestId: chrome.sent.requestId }),
    ]);
    assert.equal(oursData.postData, chromeData.postData);
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

  test('XHR reports the bytes of a multi-byte text body, not its characters', async () => {
    const { ours } = await request(
      "(() => { const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=xhr-utf8&s=' + encodeURIComponent('中文')); x.send() })()",
      'n=xhr-utf8'
    );
    assert.ok(ours.finished);
    const { body } = await t.ours.send('Network.getResponseBody', { requestId: ours.sent.requestId });
    assert.equal(ours.finished.encodedDataLength, Buffer.byteLength(body));
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
    assert.equal(ours.failed.canceled, chrome.failed.canceled);
    // The page cannot see which net error it was, only that there was one.
    assert.match(ours.failed.errorText, /^net::ERR_/);
  });

  for (const [name, expression, marker] of [
    [
      'XHR aborted',
      "(() => { const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=xhr-abort&delay=2000'); x.send(); setTimeout(() => x.abort(), 50) })()",
      'n=xhr-abort',
    ],
    [
      'XHR timed out',
      "(() => { const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=xhr-timeout&delay=2000'); x.timeout = 50; x.send() })()",
      'n=xhr-timeout',
    ],
    [
      'fetch aborted',
      "(() => { const c = new AbortController(); fetch('/api/echo?n=fetch-abort&delay=2000', { signal: c.signal }).catch(() => {}); setTimeout(() => c.abort(), 50) })()",
      'n=fetch-abort',
    ],
  ] as const) {
    test(name, async () => {
      const { ours, chrome } = await request(expression, marker, 'Network.loadingFailed');
      assert.ok(ours.failed && chrome.failed);
      assert.equal(ours.failed.errorText, chrome.failed.errorText);
      assert.equal(ours.failed.canceled, chrome.failed.canceled);
    });
  }

  test('a reused XHR keeps the first request as it was', async () => {
    // Resolves once the second request has finished too.
    const { ours } = await request(
      "new Promise(done => { const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=reuse-1'); x.onload = () => { x.onload = done; x.open('GET', '/missing?n=reuse-2'); x.send() }; x.send() })",
      'n=reuse-1'
    );
    const body = await t.ours.send('Network.getResponseBody', { requestId: ours.sent.requestId });
    // The echo returns the parsed query.
    assert.match(body.body, /"n":"reuse-1"/);
  });

  test('fetch with an invalid URL rejects instead of throwing', async () => {
    const outcome = await t.page.evaluate(() => {
      try {
        return fetch('http://[').then(
          () => 'resolved',
          () => 'rejected'
        );
      } catch {
        return 'threw';
      }
    });
    assert.equal(outcome, 'rejected');
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

  test('the body of a request to another origin known from Resource Timing is not loaded again', async () => {
    assert.ok(env);
    const src = `${env.baseUrl.replace('localhost', '127.0.0.1')}/tests/conformance/assets/pixel.png?n=img-cross`;
    const { ours } = await request(`(() => { new Image().src = ${JSON.stringify(src)} })()`, 'n=img-cross');
    await assert.rejects(
      t.ours.send('Network.getResponseBody', { requestId: ours.sent.requestId }),
      /No data found for resource with given identifier/
    );
  });

  test('the resource tree lists the page resources (Sources panel)', async () => {
    await t.chrome.send('Page.enable');
    // Loads its own resources so the test does not depend on the ones loaded above.
    await t.page.evaluate(() =>
      Promise.all([
        new Promise(onload =>
          document.head.append(
            Object.assign(document.createElement('link'), {
              rel: 'stylesheet',
              onload,
              href: '/tests/conformance/assets/cross.css?n=tree-css',
            })
          )
        ),
        new Promise(onload =>
          document.head.append(
            Object.assign(document.createElement('script'), {
              onload,
              src: '/tests/conformance/assets/resource.js?n=tree-js',
            })
          )
        ),
      ])
    );
    const [ours, chrome] = await Promise.all([
      t.ours.send('Page.getResourceTree'),
      t.chrome.send('Page.getResourceTree'),
    ]);
    for (const marker of ['n=tree-css', 'n=tree-js']) {
      const mine = ours.frameTree.resources.find(r => r.url.includes(marker));
      const theirs = chrome.frameTree.resources.find(r => r.url.includes(marker));
      assert.ok(mine, JSON.stringify(ours.frameTree.resources.map(r => r.url)));
      assert.ok(theirs);
      assert.equal(mine.type, theirs.type);
      assert.equal(mine.mimeType, theirs.mimeType);
    }
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

  // Without maxPostDataSize every body is in requestWillBeSent; past it, only hasPostData is.
  for (const maxPostDataSize of [undefined, 65536]) {
    test(`fetch POST with a 70 KiB body, maxPostDataSize ${maxPostDataSize}`, async () => {
      await enableBoth(maxPostDataSize === undefined ? {} : { maxPostDataSize });
      const marker = `n=post-large-${maxPostDataSize}`;
      const { ours, chrome } = await request(
        `void fetch('/api/echo?${marker}', { method: 'POST', body: 'x'.repeat(70 * 1024) })`,
        marker
      );
      assert.equal(ours.sent.request.postData, chrome.sent.request.postData);
      assert.equal(ours.sent.request.hasPostData, chrome.sent.request.hasPostData);
      const [oursData, chromeData] = await Promise.all([
        t.ours.send('Network.getRequestPostData', { requestId: ours.sent.requestId }),
        t.chrome.send('Network.getRequestPostData', { requestId: chrome.sent.requestId }),
      ]);
      assert.equal(oursData.postData, chromeData.postData);
      await enableBoth({});
    });
  }

  /** getResponseBody's result, or its error message, on both sides. */
  async function bodies(ours: string, chrome: string) {
    const get = (side: Side, requestId: string) =>
      side.send('Network.getResponseBody', { requestId }).then(
        result => result.body.length,
        (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Protocol error \([^)]*\): /, '')
      );
    return { ours: await get(t.ours, ours), chrome: await get(t.chrome, chrome) };
  }

  test('a body over maxResourceBufferSize is not kept', async () => {
    await enableBoth({ maxResourceBufferSize: 1000 });
    const { ours, chrome } = await request(
      "void fetch('/api/echo?n=over-resource', { method: 'POST', body: 'x'.repeat(2000) }).then(r => r.text())",
      'n=over-resource'
    );
    const got = await bodies(ours.sent.requestId, chrome.sent.requestId);
    assert.equal(got.ours, got.chrome);
    await enableBoth({});
  });

  // GET requests: in Chrome a request body counts toward the same buffers.
  test('past maxTotalBufferSize the oldest bodies are evicted', async () => {
    await enableBoth({ maxTotalBufferSize: 3000, maxResourceBufferSize: 2500 });
    const first = await request(
      "void fetch('/api/echo?n=evict-first&pad=' + 'x'.repeat(2000)).then(r => r.text())",
      'n=evict-first'
    );
    const second = await request(
      "void fetch('/api/echo?n=evict-second&pad=' + 'x'.repeat(2000)).then(r => r.text())",
      'n=evict-second'
    );
    const old = await bodies(first.ours.sent.requestId, first.chrome.sent.requestId);
    console.log(JSON.stringify(old));
    assert.equal(old.ours, old.chrome);
    assert.equal(old.ours, 'Request content was evicted from inspector cache');
    const recent = await bodies(second.ours.sent.requestId, second.chrome.sent.requestId);
    console.log(JSON.stringify(recent));
    assert.equal(recent.ours, recent.chrome);
    assert.equal(typeof recent.ours, 'number');
    await enableBoth({});
  });
});
