import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['Network.requestWillBeSent', 'Network.loadingFinished']);
  await t.chrome.send('Network.enable');
  await t.ours.send('Network.enable');
});
after(() => env?.close());

describe('Network response bodies', () => {
  // An empty binary body is an empty base64 string, not the bare `data:` of its data: URL.
  test('empty binary body', async () => {
    await t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate("void fetch('/packages/devtools-anywhere/test-support/assets/empty.bin?n=empty')");
    await waitForBoth(t, 'Network.loadingFinished');
    const requestId = async (side: Side) => {
      const sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes('n=empty'));
      assert.ok(sent, 'no request to n=empty');
      return sent.requestId;
    };
    const [oursBody, chromeBody] = await Promise.all([
      t.ours.send('Network.getResponseBody', { requestId: await requestId(t.ours) }),
      t.chrome.send('Network.getResponseBody', { requestId: await requestId(t.chrome) }),
    ]);
    assert.deepEqual(oursBody, chromeBody);
  });
});
