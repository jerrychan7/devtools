import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

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
    // The acknowledgement may have let one more frame out before the stop: count from there.
    await s.quiet();
    const stopped = (await s.frames()).length;
    assert.ok(stopped <= 3, `at most one frame after the last acknowledgement, got ${stopped}`);
    await s.quiet();
    assert.equal((await s.frames()).length, stopped, 'no frame after stopScreencast');
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

// Screenshots: ours renders the DOM with snapDOM, so only the size and coarse content of the
// image can match Chrome's. A page of its own: it is made long, scrolled and emulated.
test('captureScreenshot without snapDOM reports that it is not available', async () => {
  await assert.rejects(t.ours.send('Page.captureScreenshot', {}), /snapDOM is not configured/);
});

function isScreenshot(r: unknown): r is { data: string; approximate?: unknown } {
  return typeof r === 'object' && r !== null && 'data' in r && typeof r.data === 'string';
}

/** A page 2000 × 3000 CSS pixels with a red box at (10, 520), scrolled to (0, 500). */
async function screenshotPage() {
  assert.ok(env);
  const s = await openPage(env, []);
  await s.page.evaluate(() => {
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;width:2000px;height:3000px;background:#fff';
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:10px;top:520px;width:100px;height:50px;background:rgb(255,0,0)';
    document.body.append(box);
    scrollTo(0, 500);
  });
  const snapdom = env.baseUrl + '/packages/devtools-anywhere/dist/snapdom.js';
  /** Takes a screenshot with ours, with the real snapDOM. */
  const ours = async (params: object) => {
    const shot = await s.page.evaluate(
      (url, p) =>
        window.DevtoolsAnywhere.createCdpSession({ loadSnapdom: () => import(url) }).call('Page.captureScreenshot', p),
      snapdom,
      params
    );
    assert.ok(isScreenshot(shot), JSON.stringify(shot));
    return shot;
  };
  const chrome = (params: object) => s.chrome.send('Page.captureScreenshot', params);
  /** The size of a base64 image and the color at its center, decoded by the page. */
  const look = (data: string) =>
    s.page.evaluate(async d => {
      const img = new Image();
      img.src = 'data:image;base64,' + d;
      await img.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2d context');
      g.drawImage(img, 0, 0);
      const [r, gr, b] = g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data;
      return { width: img.width, height: img.height, center: [r, gr, b] };
    }, data);
  return { s, ours, chrome, look };
}

test('captureScreenshot matches Chrome in size, at the viewport, the whole page and a clip', async () => {
  const { s, ours, chrome, look } = await screenshotPage();
  try {
    const clip = { x: 10, y: 520, width: 100, height: 50, scale: 1 };
    for (const params of [
      {},
      { captureBeyondViewport: true },
      { clip },
      { clip, captureBeyondViewport: true },
      { clip: { ...clip, scale: 2 } },
    ]) {
      const [a, b] = await Promise.all([ours(params), chrome(params)]);
      const [mine, theirs] = await Promise.all([look(a.data), look(b.data)]);
      assert.equal(mine.width, theirs.width, JSON.stringify(params));
      assert.equal(mine.height, theirs.height, JSON.stringify(params));
      // A clip is in page coordinates, with or without captureBeyondViewport: the red box.
      if ('clip' in params) assert.deepEqual(mine.center, theirs.center, JSON.stringify(params));
    }
    assert.deepEqual((await look((await ours({ clip })).data)).center, [255, 0, 0]);
  } finally {
    await s.page.close();
  }
});

test('captureScreenshot has device pixels, encodes as asked and says it is approximate', async () => {
  const { s, ours, chrome, look } = await screenshotPage();
  try {
    await s.chrome.send('Emulation.setDeviceMetricsOverride', {
      width: 400,
      height: 300,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const [a, b] = await Promise.all([ours({}), chrome({})]);
    assert.deepEqual(
      [(await look(a.data)).width, (await look(a.data)).height],
      [(await look(b.data)).width, (await look(b.data)).height]
    );
    assert.equal(a.approximate, true);
    assert.ok(a.data.startsWith('iVBOR'), 'PNG by default');
    assert.ok((await ours({ format: 'jpeg', quality: 50 })).data.startsWith('/9j/'), 'JPEG');
    assert.ok((await ours({ format: 'webp' })).data.startsWith('UklGR'), 'WebP');
  } finally {
    await s.page.close();
  }
});

test('captureScreenshot keeps a long page at full size while the canvas can hold it', async () => {
  const { s, ours, look } = await screenshotPage();
  try {
    await s.page.evaluate(() => (document.body.style.height = '20000px'));
    const { width, height } = await look((await ours({ captureBeyondViewport: true })).data);
    assert.deepEqual([width, height], [2000, 20000]);
  } finally {
    await s.page.close();
  }
});

test('captureScreenshot scales a page too large for a canvas down to fit', async () => {
  const { s, ours, look } = await screenshotPage();
  try {
    // 200000 pixels high, past the longest side a canvas can have (32767 in Chrome).
    await s.page.evaluate(() => (document.body.style.height = '200000px'));
    const { width, height } = await look((await ours({ captureBeyondViewport: true })).data);
    assert.ok(height <= 32767, `${width} × ${height}`);
    assert.ok(Math.abs(width / height - 2000 / 200000) < 0.001, `${width} × ${height}`);
  } finally {
    await s.page.close();
  }
});

test('getLayoutMetrics matches Chrome on a scrolled page', async () => {
  const { s } = await screenshotPage();
  try {
    const [ours, chrome] = await Promise.all([
      s.ours.send('Page.getLayoutMetrics'),
      s.chrome.send('Page.getLayoutMetrics'),
    ]);
    assert.deepEqual(ours, chrome);
  } finally {
    await s.page.close();
  }
});
