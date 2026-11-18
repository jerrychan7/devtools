import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['Network.requestWillBeSent', 'Network.loadingFailed', 'Network.loadingFinished']);
    await t.chrome.send('Network.enable');
    await t.ours.send('Network.enable');
  },
  () => env?.close()
);

/** What the page sees of a fetch() and of an XHR, async and synchronous, to `/api/echo?<marker>`. */
const PAGE_REQUESTS = `(async marker => {
  const fetched = await fetch('/api/echo?' + marker + '-fetch').then(r => 'status ' + r.status, e => String(e));
  const xhr = await new Promise(resolve => {
    const x = new XMLHttpRequest();
    x.open('GET', '/api/echo?' + marker + '-xhr');
    x.onerror = () => resolve('error ' + x.readyState + ' ' + x.status);
    x.onload = () => resolve('load ' + x.status);
    x.send();
  });
  const x = new XMLHttpRequest();
  x.open('GET', '/api/echo?' + marker + '-sync', false);
  let sync;
  try {
    x.send();
    sync = 'status ' + x.status;
  } catch (e) {
    sync = e.name;
  }
  return { fetched, xhr, sync };
})`;

/**
 * Has one side alone set something up (the other side's would change the same requests), runs the
 * page's requests to `marker`, then undoes it; returns what the page saw and the side's events.
 */
async function on(
  side: Side,
  setUp: (side: Side) => Promise<unknown>,
  tearDown: (side: Side) => Promise<unknown>,
  marker: string
) {
  await side.clear();
  await setUp(side);
  const seen: unknown = await t.page.evaluate(`${PAGE_REQUESTS}(${JSON.stringify(marker)})`);
  await tearDown(side);
  // Our events are emitted as the requests settle; let the last ones arrive.
  await new Promise(r => setTimeout(r, 100));
  const sent = (await side.events('Network.requestWillBeSent')).filter(e => e.request.url.includes(marker));
  const failed = await side.events('Network.loadingFailed');
  const failures = sent.map(s => {
    const f = failed.find(e => e.requestId === s.requestId);
    return (
      f && {
        type: f.type,
        errorText: f.errorText,
        canceled: f.canceled,
        blockedReason: f.blockedReason,
      }
    );
  });
  return { seen, failures, sent };
}

async function compare(
  setUp: (side: Side) => Promise<unknown>,
  tearDown: (side: Side) => Promise<unknown>,
  marker: string
) {
  const chrome = await on(t.chrome, setUp, tearDown, `${marker}-c`);
  const ours = await on(t.ours, setUp, tearDown, `${marker}-o`);
  assert.deepEqual(ours.seen, chrome.seen);
  assert.deepEqual(ours.failures, chrome.failures);
  return { chrome, ours };
}

/** A request header by name, whatever its case: fetch() gives them lowercased, Chrome as sent. */
const header = (headers: Record<string, unknown> | undefined, name: string) =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

/** The requestWillBeSent of the side's request to `marker`, once it came. */
async function sentTo(side: Side, marker: string) {
  const start = Date.now();
  for (;;) {
    const sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes(marker));
    if (sent || Date.now() - start > 5000) return sent;
    await new Promise(r => setTimeout(r, 20));
  }
}

const ONLINE = {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
};

describe('Network conditions', () => {
  test('setBlockedURLs with wildcards fails fetch() and XHR as blocked', async () => {
    const { chrome } = await compare(
      side => side.send('Network.setBlockedURLs', { urls: ['*blocked-w*'] }),
      side => side.send('Network.setBlockedURLs', { urls: [] }),
      'blocked-w'
    );
    assert.equal(chrome.failures[0]?.blockedReason, 'inspector');
  });

  test('setBlockedURLs with URL patterns: the first match decides', async () => {
    const urlPatterns: Protocol.Network.BlockPattern[] = [
      { urlPattern: '*://*:*/api/echo?blocked-p*-sync', block: false },
      { urlPattern: '*://*:*/api/echo?blocked-p*', block: true },
    ];
    const { chrome } = await compare(
      side => side.send('Network.setBlockedURLs', { urlPatterns }),
      side => side.send('Network.setBlockedURLs', { urlPatterns: [] }),
      'blocked-p'
    );
    assert.equal(chrome.failures[2], undefined);
  });

  test('offline fails requests and the page sees it', async () => {
    const offline = { ...ONLINE, offline: true };
    const state = (side: Side) => async () => {
      await t.page.evaluate(() => {
        const root = document.documentElement;
        // Listened to once, for both sides.
        if (root.dataset['events'] === undefined)
          for (const type of ['online', 'offline'])
            addEventListener(type, () => (root.dataset['events'] += type + ' '));
        root.dataset['events'] = '';
      });
      await side.send('Network.emulateNetworkConditions', offline);
      const during = await t.page.evaluate(() => navigator.onLine);
      await side.send('Network.emulateNetworkConditions', ONLINE);
      await new Promise(r => setTimeout(r, 50));
      return {
        during,
        after: await t.page.evaluate(() => navigator.onLine),
        events: await t.page.evaluate(() => document.documentElement.dataset['events']),
      };
    };
    assert.deepEqual(await state(t.ours)(), await state(t.chrome)());
    await compare(
      side => side.send('Network.emulateNetworkConditions', offline),
      side => side.send('Network.emulateNetworkConditions', ONLINE),
      'offline'
    );
    await compare(
      side =>
        side.send('Network.emulateNetworkConditionsByRule', {
          matchedNetworkConditions: [{ urlPattern: '', ...offline }],
        }),
      side =>
        side.send('Network.emulateNetworkConditionsByRule', {
          matchedNetworkConditions: [],
        }),
      'by-rule'
    );
  });

  test('setExtraHTTPHeaders replaces the request headers of the page', async () => {
    const run = async (side: Side) => {
      await side.clear();
      await side.send('Network.setExtraHTTPHeaders', {
        headers: { 'X-Extra': 'devtools' },
      });
      await t.page.evaluate(() =>
        fetch('/api/echo?extra-headers', {
          headers: { 'X-Extra': 'page', 'X-Own': '1' },
        })
      );
      await side.send('Network.setExtraHTTPHeaders', { headers: {} });
      const headers = (await sentTo(side, 'extra-headers'))?.request.headers;
      return {
        extra: header(headers, 'x-extra'),
        own: header(headers, 'x-own'),
      };
    };
    assert.deepEqual(await run(t.ours), await run(t.chrome));
  });

  test('setCacheDisabled lets requests through', async () => {
    await compare(
      side => side.send('Network.setCacheDisabled', { cacheDisabled: true }),
      side => side.send('Network.setCacheDisabled', { cacheDisabled: false }),
      'no-cache'
    );
  });

  test('throttling is refused', async () => {
    await assert.rejects(
      t.ours.send('Network.emulateNetworkConditions', {
        ...ONLINE,
        latency: 100,
      }),
      /Not supported in the page: /
    );
  });
});

describe('User agent override', () => {
  const read = () =>
    t.page.evaluate(() => ({
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      language: navigator.language,
      userAgentData: JSON.stringify(Reflect.get(navigator, 'userAgentData')),
    }));
  for (const domain of ['Network', 'Emulation'] as const)
    test(`${domain}.setUserAgentOverride changes what the page sees, and clearing it puts it back`, async () => {
      const original = await read();
      const run = async (side: Side) => {
        await side.send(`${domain}.setUserAgentOverride`, {
          userAgent: 'Test/2.5 (X)',
          platform: 'Plat',
          acceptLanguage: 'fr-CA,fr;q=0.9',
        });
        // Only right after an override: Chrome keeps navigator.languages until the next languagechange.
        const during = {
          ...(await read()),
          languages: await t.page.evaluate(() => [...navigator.languages]),
        };
        const brands = {
          brands: [{ brand: 'B', version: '1' }],
          fullVersionList: [],
          platform: 'P',
          platformVersion: '1',
          architecture: 'arm',
          model: '',
          mobile: true,
        };
        await side.send(`${domain}.setUserAgentOverride`, {
          userAgent: 'Test/3',
          userAgentMetadata: brands,
        });
        const meta = await read();
        await side.send(`${domain}.setUserAgentOverride`, { userAgent: '' });
        return { during, meta, after: await read() };
      };
      const ours = await run(t.ours);
      const chrome = await run(t.chrome);
      assert.deepEqual(ours, chrome);
      assert.deepEqual(chrome.after, original);
    });

  test('the user agent goes in the request headers', async () => {
    const run = async (side: Side) => {
      await side.clear();
      await side.send('Network.setUserAgentOverride', {
        userAgent: 'Test/4',
        acceptLanguage: 'de',
      });
      await t.page.evaluate(() => fetch('/api/echo?ua-header'));
      await side.send('Network.setUserAgentOverride', { userAgent: '' });
      const headers = (await sentTo(side, 'ua-header'))?.request.headers;
      return {
        ua: header(headers, 'user-agent'),
        lang: header(headers, 'accept-language'),
      };
    };
    assert.deepEqual(await run(t.ours), await run(t.chrome));
  });
});
