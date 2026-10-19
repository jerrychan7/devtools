import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'Network.webSocketCreated',
    'Network.webSocketWillSendHandshakeRequest',
    'Network.webSocketHandshakeResponseReceived',
    'Network.webSocketFrameSent',
    'Network.webSocketFrameReceived',
    'Network.webSocketClosed',
  ]);
  await t.chrome.send('Network.enable');
  await t.ours.send('Network.enable');
});
after(() => env?.close());

interface FrameEvent {
  requestId: string;
  response: { opcode: number; mask: boolean; payloadData: string };
}

/** One side's events for the socket to `marker`, reduced to what must match. */
async function socketEvents(side: Side, marker: string) {
  const created = (await side.events('Network.webSocketCreated')).find(e => e.url.includes(marker));
  assert.ok(created, `no socket to ${marker}`);
  const ofSocket = (e: { requestId: string }) => e.requestId === created.requestId;
  const frames = (list: FrameEvent[]) =>
    list.filter(ofSocket).map(({ response: { opcode, mask, payloadData } }) => ({ opcode, mask, payloadData }));
  return {
    url: created.url,
    handshake: (await side.events('Network.webSocketWillSendHandshakeRequest')).filter(ofSocket).length,
    response: (await side.events('Network.webSocketHandshakeResponseReceived'))
      .filter(ofSocket)
      .map(e => e.response.status),
    sent: frames(await side.events('Network.webSocketFrameSent')),
    received: frames(await side.events('Network.webSocketFrameReceived')),
    closed: (await side.events('Network.webSocketClosed')).filter(ofSocket).length,
  };
}

describe('WebSocket', () => {
  test('text and binary frames echoed, then close', async () => {
    await t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(`(() => {
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/echo?n=echo');
      let n = 0;
      ws.onopen = () => {
        ws.send('hello');
        ws.send(new Uint8Array([1, 2, 3, 250]));
        ws.send(new Blob(['blob']));
      };
      ws.onmessage = () => {
        if (++n === 3) ws.close();
      };
    })()`);
    await waitForBoth(t, 'Network.webSocketClosed');
    const ours = await socketEvents(t.ours, 'n=echo');
    const chrome = await socketEvents(t.chrome, 'n=echo');
    assert.deepEqual(ours, chrome);
    assert.equal(ours.sent.length, 3);
  });

  test('a socket from before Network.enable is replayed', async () => {
    await t.chrome.clear();
    await t.ours.send('Network.disable');
    await t.ours.clear();
    await t.page.evaluate(`new Promise(resolve => {
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/echo?n=early');
      ws.onopen = () => ws.send('early');
      ws.onmessage = () => ws.close();
      ws.onclose = resolve;
    })`);
    await t.ours.send('Network.enable');
    await waitForBoth(t, 'Network.webSocketClosed');
    const ours = await socketEvents(t.ours, 'n=early');
    const chrome = await socketEvents(t.chrome, 'n=early');
    assert.deepEqual(ours, chrome);
  });

  test('the hooked WebSocket keeps its constants and instanceof', async () => {
    const result = await t.page.evaluate(`(() => {
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/echo?n=shape');
      const shape = [ws instanceof WebSocket, WebSocket.OPEN, ws.CLOSED, typeof WebSocket.prototype.send];
      ws.close();
      return shape;
    })()`);
    assert.deepEqual(result, [true, 1, 3, 'function']);
  });
});
