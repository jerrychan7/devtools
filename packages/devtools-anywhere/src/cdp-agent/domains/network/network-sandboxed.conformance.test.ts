// Requests of a sandboxed iframe (no allow-same-origin, on the page's origin) merged into the
// page's agent (core/frames/merged-frames.ts), against Chrome, which keeps the iframe in the page's
// target: its fetch, XHR and WebSocket on the page's session, each once, of the iframe's frame and
// document loader; its document request once, by the page; bodies asked by request id; cookies the
// page's. Ids differ between the two sides: they are compared by how they relate.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif/oopif.ts';
import {
  chromeSide,
  get,
  type MergedSide,
  oursSide,
  type Received,
} from '../../../../test-support/oopif/merged-sides.ts';

const ASSET = '/packages/devtools-anywhere/test-support/assets/frame.css';

let env: Env | undefined;
const sides: { name: string; side: MergedSide; frameId: string }[] = [];

/** The sandboxed frame's id, from the page's frame tree. */
async function sandboxedFrameId(side: MergedSide): Promise<string> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const id = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  assert.equal(typeof id, 'string');
  return String(id);
}

/** Runs `expression` (awaited) in the sandboxed frame's latest execution context. */
async function runInFrame(side: MergedSide, frameId: string, expression: string) {
  const created = (await side.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  const reply = await side.send('Runtime.evaluate', {
    expression,
    contextId: get(created?.params['context'], 'id'),
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(get(reply, 'exceptionDetails'), undefined, JSON.stringify(reply));
}

before(async () => {
  env = await launchOopif();
  const chrome = await chromeSide(env);
  const ours = await oursSide(env);
  for (const [name, side] of [
    ['chrome', chrome],
    ['ours', ours],
  ] as const) {
    const frameId = await sandboxedFrameId(side);
    sides.push({ name, side, frameId });
    await runInFrame(
      side,
      frameId,
      `(async () => {
        await (await fetch('${ASSET}?sbfetch')).text();
        await new Promise(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '${ASSET}?sbxhr');
          xhr.onloadend = resolve;
          xhr.send('posted');
        });
        await new Promise(resolve => {
          const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/echo?n=sbws');
          ws.onopen = () => ws.send('hi');
          ws.onmessage = () => ws.close();
          ws.onclose = resolve;
        });
      })()`
    );
    // Settled: no event for a while.
    for (let seen = -1, now = 0; seen !== now; await new Promise(r => setTimeout(r, 300))) {
      seen = now;
      now = (await side.events()).length;
    }
  }
});
after(async () => {
  for (const { side } of sides) await side.close();
  await env?.close();
});

/** The requests whose URL's path and query (not the page's, which has the iframe's) has `marker`. */
const sentTo = (events: Received[], marker: string) =>
  events.filter(e => {
    if (e.method !== 'Network.requestWillBeSent') return false;
    const url = new URL(String(get(e.params['request'], 'url')));
    return !url.pathname.endsWith('frame-link-parent.html') && (url.pathname + url.search).includes(marker);
  });

/** Per side: what the requests of the sandboxed frame look like, ids reduced to how they relate. */
async function shapes() {
  const all = [];
  for (const { side, frameId } of sides) {
    const events = await side.events();
    const documents = sentTo(events, 'sandboxed-child.html').filter(e => e.params['type'] === 'Document');
    const loaderId = documents[0]?.params['loaderId'];
    const shape = (e: Received) => ({
      type: e.params['type'],
      frame: e.params['frameId'] === frameId ? 'sandboxed' : e.params['frameId'],
      loader: e.params['loaderId'] === loaderId ? 'document' : e.params['loaderId'],
      method: get(e.params['request'], 'method'),
    });
    const sockets = events.filter(
      e => e.method === 'Network.webSocketCreated' && String(e.params['url']).includes('sbws')
    );
    const socketId = sockets[0]?.params['requestId'];
    all.push({
      documents: documents.map(shape),
      fetch: sentTo(events, 'sbfetch').map(shape),
      xhr: sentTo(events, 'sbxhr').map(shape),
      sockets: sockets.length,
      socketEvents: events
        .filter(e => e.method.startsWith('Network.webSocket') && e.params['requestId'] === socketId)
        .map(e => e.method),
    });
  }
  return all;
}

test("the sandboxed frame's requests: each once, of its frame and document loader, as in Chrome", async () => {
  const [chrome, ours] = await shapes();
  assert.deepEqual(chrome, {
    documents: [{ type: 'Document', frame: 'sandboxed', loader: 'document', method: 'GET' }],
    fetch: [{ type: 'Fetch', frame: 'sandboxed', loader: 'document', method: 'GET' }],
    xhr: [{ type: 'XHR', frame: 'sandboxed', loader: 'document', method: 'POST' }],
    sockets: 1,
    socketEvents: [
      'Network.webSocketCreated',
      'Network.webSocketWillSendHandshakeRequest',
      'Network.webSocketHandshakeResponseReceived',
      'Network.webSocketFrameSent',
      'Network.webSocketFrameReceived',
      'Network.webSocketClosed',
    ],
  });
  assert.deepEqual(ours, chrome);
});

test("Network.getResponseBody and getRequestPostData of the sandboxed frame's requests, as in Chrome", async () => {
  const results = [];
  for (const { side } of sides) {
    const events = await side.events();
    const [fetched] = sentTo(events, 'sbfetch');
    const [posted] = sentTo(events, 'sbxhr');
    results.push({
      body: await side.send('Network.getResponseBody', { requestId: fetched?.params['requestId'] }),
      postData: await side.send('Network.getRequestPostData', { requestId: posted?.params['requestId'] }),
    });
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(get(results[0]?.body, 'base64Encoded'), false);
  assert.deepEqual(results[0]?.postData, { postData: 'posted', base64Encoded: false });
});

test("Network.getCookies answers with the page's cookies, as in Chrome", async () => {
  for (const { name, side } of sides) {
    const page = await side.send('Page.getFrameTree');
    const url = String(get(get(get(page, 'frameTree'), 'frame'), 'url'));
    // A cookie of each side's own: the two share the browser's cookies.
    await side.send('Network.setCookie', { name: `sandboxed-${name}`, value: '1', url });
    const reply = await side.send('Network.getCookies');
    const cookies = get(reply, 'cookies');
    const names = (Array.isArray(cookies) ? cookies : []).map(c => String(get(c, 'name')));
    assert.ok(names.includes(`sandboxed-${name}`), `${name}: ${names.join(', ')}`);
  }
});
