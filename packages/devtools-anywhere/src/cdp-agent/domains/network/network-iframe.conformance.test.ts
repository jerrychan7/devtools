// Requests of same-origin iframes, against Chrome's: their frame, loader and document URL, the
// iframe's own document request, navigations, srcdoc iframes and requests made before the agent
// heard of a document. Ids differ between the two sides: they are compared by how they relate.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

type Sent = Protocol.Network.RequestWillBeSentEvent;

const BASE = '/packages/devtools-anywhere/test-support/';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.webSocketCreated',
    'Network.webSocketFrameSent',
    'Network.webSocketFrameReceived',
  ]);
  await t.chrome.send('Network.enable');
  await t.ours.send('Network.enable');
});
after(() => env?.close());

/** Waits until both sides have finished every request whose URL contains one of `markers`. */
async function settle(...markers: string[]) {
  const done = async (side: Side) => {
    const sent = await side.events('Network.requestWillBeSent');
    const finished = new Set((await side.events('Network.loadingFinished')).map(e => e.requestId));
    return markers.every(m => sent.some(e => e.request.url.includes(m) && finished.has(e.requestId)));
  };
  const start = Date.now();
  while (!((await done(t.ours)) && (await done(t.chrome)))) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${markers.join(', ')}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

/** The requests to `marker` on one side. */
async function sentTo(side: Side, marker: string): Promise<Sent[]> {
  return (await side.events('Network.requestWillBeSent')).filter(e => e.request.url.includes(marker));
}

async function one(side: Side, marker: string): Promise<Sent> {
  const found = await sentTo(side, marker);
  assert.equal(found.length, 1, `requests to ${marker}`);
  const [sent] = found;
  assert.ok(sent);
  return sent;
}

/** Adds an iframe and waits for it to load. */
const addFrame = (id: string, init: string) =>
  t.page.evaluate(
    `new Promise(r => { const f = document.createElement('iframe'); f.id = ${JSON.stringify(id)}; ${init}; f.onload = r; document.body.append(f); })`
  );

/** Runs `code` in the iframe `id`'s window. */
const inFrame = (id: string, code: string) =>
  t.page.evaluate(`document.getElementById(${JSON.stringify(id)}).contentWindow.eval(${JSON.stringify(code)})`);

const relative = (url: string) => url.replace(/^\w+:\/\/[^/]+/, '');

describe('Network in same-origin iframes', () => {
  test("an iframe's document and its fetch, XHR and beacon carry its frame and loader", async () => {
    await t.page.evaluate("void fetch('/api/echo?n=top-ref')");
    await addFrame('a', `f.src = '${BASE}frame-child.html?n=a-doc'`);
    await inFrame(
      'a',
      `fetch('/api/echo?n=a-fetch');
       const x = new XMLHttpRequest(); x.open('GET', '/api/echo?n=a-xhr'); x.send();
       navigator.sendBeacon('/api/echo?n=a-beacon', 'b');`
    );
    await settle('n=top-ref', 'n=a-doc', 'n=a-fetch', 'n=a-xhr', 'n=a-beacon');
    for (const side of [t.ours, t.chrome]) {
      const top = await one(side, 'n=top-ref');
      const doc = await one(side, 'n=a-doc');
      assert.equal(doc.type, 'Document');
      assert.notEqual(doc.frameId, top.frameId, "the iframe's document is its own frame's");
      assert.notEqual(doc.loaderId, top.loaderId);
      assert.equal(doc.documentURL, doc.request.url);
      for (const [marker, type] of [
        ['n=a-fetch', 'Fetch'],
        ['n=a-xhr', 'XHR'],
        ['n=a-beacon', 'Ping'],
      ] as const) {
        const sent = await one(side, marker);
        assert.equal(sent.type, type, marker);
        assert.equal(sent.frameId, doc.frameId, marker);
        assert.equal(sent.loaderId, doc.loaderId, marker);
        assert.equal(sent.documentURL, doc.request.url, marker);
      }
      const fetched = await one(side, 'n=a-fetch');
      assert.equal(fetched.initiator.type, 'script');
      const response = (await side.events('Network.responseReceived')).find(e => e.requestId === fetched.requestId);
      assert.equal(response?.frameId, doc.frameId);
      assert.equal(response?.loaderId, doc.loaderId);
    }
  });

  test('getResponseBody of an iframe request', async () => {
    const [ours, chrome] = await Promise.all([one(t.ours, 'n=a-fetch'), one(t.chrome, 'n=a-fetch')]);
    assert.deepEqual(
      await t.ours.send('Network.getResponseBody', { requestId: ours.requestId }),
      await t.chrome.send('Network.getResponseBody', { requestId: chrome.requestId })
    );
  });

  test('a navigated iframe: a new loader, the same frame', async () => {
    await t.page.evaluate(
      `new Promise(r => { const f = document.getElementById('a'); f.onload = r; f.src = '${BASE}frame-other.html?n=a-nav'; })`
    );
    await inFrame('a', "fetch('/api/echo?n=a-after-nav')");
    await settle('n=a-nav', 'n=a-after-nav');
    for (const side of [t.ours, t.chrome]) {
      const first = await one(side, 'n=a-doc');
      const doc = await one(side, 'n=a-nav');
      const after = await one(side, 'n=a-after-nav');
      assert.equal(doc.type, 'Document');
      assert.equal(doc.frameId, first.frameId);
      assert.notEqual(doc.loaderId, first.loaderId);
      assert.equal(after.frameId, first.frameId);
      assert.equal(after.loaderId, doc.loaderId);
      assert.equal(relative(after.documentURL), `${BASE}frame-other.html?n=a-nav`);
    }
  });

  test("requests of an iframe document's first scripts", async () => {
    await addFrame('early', `f.src = '${BASE}frame-network.html'`);
    await settle('frame-network.html', 'n=early-fetch', 'n=early-xhr', 'n=early-img');
    for (const side of [t.ours, t.chrome]) {
      const doc = await one(side, 'frame-network.html');
      for (const [marker, type] of [
        ['n=early-fetch', 'Fetch'],
        ['n=early-xhr', 'XHR'],
        ['n=early-img', 'Image'],
      ] as const) {
        const sent = await one(side, marker);
        assert.equal(sent.type, type, marker);
        assert.equal(sent.frameId, doc.frameId, marker);
        assert.equal(sent.loaderId, doc.loaderId, marker);
        assert.equal(sent.documentURL, doc.request.url, marker);
      }
    }
  });

  test('a srcdoc iframe: about:srcdoc documentURL, no document request', async () => {
    await addFrame(
      'sd',
      `f.srcdoc = '<script>fetch("/api/echo?n=sd-fetch")<' + '/script><img src="${BASE}assets/pixel.png?n=sd-img">'`
    );
    await settle('n=sd-fetch', 'n=sd-img');
    for (const side of [t.ours, t.chrome]) {
      assert.deepEqual(await sentTo(side, 'about:'), []);
      const fetched = await one(side, 'n=sd-fetch');
      const image = await one(side, 'n=sd-img');
      assert.equal(fetched.documentURL, 'about:srcdoc');
      assert.equal(image.documentURL, 'about:srcdoc');
      assert.equal(fetched.loaderId, image.loaderId);
      assert.equal(fetched.frameId, image.frameId);
      assert.notEqual(fetched.frameId, (await one(side, 'n=top-ref')).frameId);
    }
  });

  test('the documents of an <object> and an <embed>: one request each, of their frame', async () => {
    await t.page.evaluate(`new Promise(r => {
      const o = document.createElement('object');
      o.data = '${BASE}frame-child.html?n=object-doc';
      const e = document.createElement('embed');
      e.src = '${BASE}frame-child.html?n=embed-doc';
      let loaded = 0;
      o.onload = e.onload = () => ++loaded === 2 && r();
      document.body.append(o, e);
    })`);
    await settle('n=object-doc', 'n=embed-doc');
    for (const side of [t.ours, t.chrome]) {
      const top = await one(side, 'n=top-ref');
      for (const marker of ['n=object-doc', 'n=embed-doc']) {
        const doc = await one(side, marker);
        assert.equal(doc.type, 'Document', marker);
        assert.notEqual(doc.frameId, top.frameId, marker);
      }
    }
  });

  test('an <object> and an <embed> showing an image: a request of the page', async () => {
    await t.page.evaluate(`(() => {
      const o = document.createElement('object');
      o.data = '${BASE}assets/pixel.png?n=object-img';
      const e = document.createElement('embed');
      e.src = '${BASE}assets/pixel.png?n=embed-img';
      document.body.append(o, e);
    })()`);
    await settle('n=object-img', 'n=embed-img');
    for (const side of [t.ours, t.chrome]) {
      const top = await one(side, 'n=top-ref');
      for (const marker of ['n=object-img', 'n=embed-img']) {
        const image = await one(side, marker);
        assert.equal(image.frameId, top.frameId, marker);
      }
    }
    for (const marker of ['n=object-img', 'n=embed-img']) {
      assert.equal((await one(t.ours, marker)).type, (await one(t.chrome, marker)).type, marker);
    }
  });

  test('a WebSocket opened in an iframe, its binary frames from that realm', async () => {
    // The ArrayBuffer and Blob sent, and the Blob echoed, are the iframe's, not the top page's.
    await inFrame(
      'a',
      `const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/echo?n=a-ws');
       ws.onopen = () => { ws.send(new Uint8Array([1, 2, 250]).buffer); ws.send(new Blob(['blob'])); };`
    );
    const start = Date.now();
    const socket = async (side: Side) => {
      const created = (await side.events('Network.webSocketCreated')).filter(e => e.url.includes('n=a-ws'));
      const ofSocket = (e: { requestId: string }) => e.requestId === created[0]?.requestId;
      const frames = (list: Protocol.Network.WebSocketFrameSentEvent[]) =>
        list.filter(ofSocket).map(({ response: { opcode, payloadData } }) => ({ opcode, payloadData }));
      return {
        created,
        sent: frames(await side.events('Network.webSocketFrameSent')),
        received: frames(await side.events('Network.webSocketFrameReceived')),
      };
    };
    const ready = async (side: Side) => (await socket(side)).received.length >= 2;
    while (!((await ready(t.ours)) && (await ready(t.chrome)))) {
      if (Date.now() - start > 5000) throw new Error('timed out waiting for the echoed frames');
      await new Promise(r => setTimeout(r, 20));
    }
    const [ours, chrome] = [await socket(t.ours), await socket(t.chrome)];
    assert.equal(ours.created.length, 1);
    assert.equal(ours.created[0]?.url, chrome.created[0]?.url);
    assert.equal(ours.created[0]?.initiator?.type, chrome.created[0]?.initiator?.type);
    assert.deepEqual(ours.sent, chrome.sent);
    assert.deepEqual(ours.received, chrome.received);
    // Binary frames; as in Chrome, the Blob sent is reported without its payload, the buffer with it.
    assert.deepEqual(
      ours.sent.map(f => f.opcode),
      [2, 2]
    );
    assert.equal(ours.sent[0]?.payloadData, 'AQL6');
  });
});
