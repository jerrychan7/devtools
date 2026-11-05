// A fetch in a same-origin iframe given a Request or body made by another frame, against Chrome's:
// such objects are not instanceof the iframe window's classes, yet are sent as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['Network.requestWillBeSent', 'Network.loadingFinished']);
    await t.chrome.send('Network.enable');
    await t.ours.send('Network.enable');
  },
  () => env?.close()
);

const MARKERS = ['n=cross-req', 'n=cross-params', 'n=cross-blob'];

/** Waits until both sides have finished every request whose URL contains one of `MARKERS`. */
async function settle() {
  const done = async (side: Side) => {
    const sent = await side.events('Network.requestWillBeSent');
    const finished = new Set((await side.events('Network.loadingFinished')).map(e => e.requestId));
    return MARKERS.every(m => sent.some(e => e.request.url.includes(m) && finished.has(e.requestId)));
  };
  const start = Date.now();
  while (!((await done(t.ours)) && (await done(t.chrome)))) {
    if (Date.now() - start > 5000) throw new Error('timed out waiting for the requests');
    await new Promise(r => setTimeout(r, 20));
  }
}

/** What the request to `marker` was reported as, its host left out. */
async function shape(side: Side, marker: string) {
  const found = (await side.events('Network.requestWillBeSent')).filter(e => e.request.url.includes(marker));
  assert.equal(found.length, 1, `requests to ${marker}`);
  const request = found[0]?.request;
  assert.ok(request);
  return {
    url: request.url.replace(/^\w+:\/\/[^/]+/, ''),
    method: request.method,
    cross: request.headers['x-cross'],
    postData: request.postData,
  };
}

test("an iframe's fetch given the parent's Request, URLSearchParams and Blob", async () => {
  await t.page.evaluate(`new Promise(r => {
    const f = document.createElement('iframe');
    f.src = '/packages/devtools-anywhere/test-support/frame-child.html';
    f.onload = () => {
      const w = f.contentWindow;
      void w.fetch(new Request('/api/echo?n=cross-req', { method: 'POST', headers: { 'x-cross': '1' }, body: 'req-body' }));
      void w.fetch('/api/echo?n=cross-params', { method: 'POST', body: new URLSearchParams('p=1') });
      void w.fetch('/api/echo?n=cross-blob', { method: 'POST', body: new Blob(['blob-body']) });
      r();
    };
    document.body.append(f);
  })`);
  await settle();
  for (const marker of MARKERS) assert.deepEqual(await shape(t.ours, marker), await shape(t.chrome, marker), marker);
  // As in Chrome, a Request's body is not in requestWillBeSent: postData is left out.
  assert.deepEqual(await shape(t.ours, 'n=cross-req'), {
    url: '/api/echo?n=cross-req',
    method: 'POST',
    cross: '1',
    postData: undefined,
  });
  assert.equal((await shape(t.ours, 'n=cross-params')).postData, 'p=1');
});
