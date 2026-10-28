import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.chrome.send('Page.enable');
});
after(() => env?.close());

test('getAppManifest without a manifest', async () => {
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getAppManifest'), t.chrome.send('Page.getAppManifest')]);
  assert.equal(ours.url, chrome.url);
  assert.equal(ours.data, chrome.data);
});

test('getAppManifest returns the linked manifest (Application panel)', async () => {
  await t.page.evaluate(() =>
    document.head.append(
      Object.assign(document.createElement('link'), {
        rel: 'manifest',
        href: '/packages/devtools-anywhere/test-support/assets/manifest.json',
      })
    )
  );
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getAppManifest'), t.chrome.send('Page.getAppManifest')]);
  assert.ok(chrome.data);
  assert.equal(ours.url, chrome.url);
  assert.equal(ours.data, chrome.data);
  assert.deepEqual(ours.errors, chrome.errors);
});

// The screencast is ours alone: Chrome renders frames itself and keeps two in flight, ours
// renders the DOM with snapDOM one frame at a time. A stand-in snapDOM keeps frames fast.
test('startScreencast without snapDOM reports that it is not available', async () => {
  await assert.rejects(t.ours.send('Page.startScreencast', {}), /snapDOM is not configured/);
});

/** A CDP session whose snapDOM is a stand-in recording the scales it renders at. */
async function screencastServer() {
  await t.page.evaluate(() => {
    const frames: { sessionId: number; data: string; deviceWidth: number }[] = [];
    const scales: number[] = [];
    const session = window.DevtoolsAnywhere.createCdpSession({
      loadSnapdom: async () => ({
        snapdom: async () => ({
          async toCanvas({ scale }) {
            scales.push(scale);
            return Object.assign(document.createElement('canvas'), {
              width: Math.round(innerWidth * scale),
              height: Math.round(innerHeight * scale),
            });
          },
        }),
      }),
    });
    session.onMessage(m => {
      const msg: {
        method?: string;
        params: { sessionId: number; data: string; metadata: { deviceWidth: number } };
      } = JSON.parse(m);
      if (msg.method === 'Page.screencastFrame')
        frames.push({
          sessionId: msg.params.sessionId,
          data: msg.params.data,
          deviceWidth: msg.params.metadata.deviceWidth,
        });
    });
    window.__screencast = { session, frames, scales };
  });
  const call = (method: string, params: object = {}) =>
    t.page.evaluate((m, p) => window.__screencast?.session.call(m, p), method, params);
  const frames = () => t.page.evaluate(() => window.__screencast?.frames.slice() ?? []);
  /** Waits until `count` frames were sent. */
  const waitForFrames = async (count: number) => {
    const start = Date.now();
    while ((await frames()).length < count) {
      if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${count} screencast frames`);
      await new Promise(r => setTimeout(r, 50));
    }
    return frames();
  };
  /** Longer than the shortest time between two frames (500 ms), so a frame would have come. */
  const quiet = () => new Promise(r => setTimeout(r, 1500));
  return { call, frames, waitForFrames, quiet };
}

test('the screencast sends the next frame only once the previous one is acknowledged', async () => {
  const s = await screencastServer();
  try {
    await s.call('Page.startScreencast');
    const [first] = await s.waitForFrames(1);
    assert.ok(first);
    await s.quiet();
    assert.equal((await s.frames()).length, 1, 'no frame before the acknowledgement');
    await s.call('Page.screencastFrameAck', { sessionId: first.sessionId });
    await s.waitForFrames(2);
  } finally {
    await s.call('Page.stopScreencast');
  }
});

test('the screencast ignores acknowledgements of an earlier session, and stops', async () => {
  const s = await screencastServer();
  try {
    await s.call('Page.startScreencast');
    const [first] = await s.waitForFrames(1);
    assert.ok(first);
    // Starting again starts a new session, whose first frame needs no acknowledgement.
    await s.call('Page.startScreencast');
    const second = (await s.waitForFrames(2))[1];
    assert.ok(second);
    assert.notEqual(second.sessionId, first.sessionId);
    await s.call('Page.screencastFrameAck', { sessionId: first.sessionId });
    await s.quiet();
    assert.equal((await s.frames()).length, 2, 'the old session is not acknowledged');

    await s.call('Page.screencastFrameAck', { sessionId: second.sessionId });
    await s.call('Page.stopScreencast');
    await s.quiet();
    assert.equal((await s.frames()).length, 2, 'no frame after stopScreencast');
  } finally {
    await s.call('Page.stopScreencast');
  }
});

test('the screencast scales frames to maxWidth, and encodes them as asked', async () => {
  const s = await screencastServer();
  const width = await t.page.evaluate(() => innerWidth);
  try {
    await s.call('Page.startScreencast', { format: 'png', maxWidth: Math.round(width / 2) });
    const [png] = await s.waitForFrames(1);
    assert.ok(png);
    assert.equal(png.deviceWidth, width, 'the metadata has the size of the page');
    const scale = await t.page.evaluate(() => window.__screencast?.scales[0]);
    assert.ok(scale !== undefined && Math.abs(scale - Math.round(width / 2) / width) < 1e-9, String(scale));
    assert.ok(png.data.startsWith('iVBOR'), 'PNG');

    await s.call('Page.startScreencast', { format: 'jpeg', quality: 50 });
    const jpeg = (await s.waitForFrames(2))[1];
    assert.ok(jpeg?.data.startsWith('/9j/'), 'JPEG');
  } finally {
    await s.call('Page.stopScreencast');
  }
});
