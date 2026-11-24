import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, EventName, Side, TestPage } from '../../../../test-support/conformance.ts';

declare global {
  /** Storage buckets, Chromium only: not in TypeScript's DOM types yet. */
  interface Navigator {
    readonly storageBuckets: {
      open(name: string, options?: { quota?: number }): Promise<{ indexedDB: IDBFactory; caches: CacheStorage }>;
      keys(): Promise<string[]>;
      delete(name: string): Promise<void>;
    };
  }
}

const EVENTS = [
  'Storage.storageBucketCreatedOrUpdated',
  'Storage.storageBucketDeleted',
  'Storage.indexedDBListUpdated',
  'Storage.indexedDBContentUpdated',
  'Storage.cacheStorageListUpdated',
  'Storage.cacheStorageContentUpdated',
] as const satisfies EventName[];

let env: Env | undefined;
let t: TestPage;
let storageKey: string;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, [...EVENTS]);
    storageKey = new URL(env.baseUrl).origin + '/';
    // A bucket exists already: tracking reports it at once.
    await t.page.evaluate(() => caches.open('existing').then(() => undefined));
    for (const side of [t.ours, t.chrome]) {
      await side.send('Storage.trackIndexedDBForStorageKey', { storageKey });
      await side.send('Storage.trackCacheStorageForStorageKey', { storageKey });
      await side.send('Storage.setStorageBucketTracking', { storageKey, enable: true });
    }
  },
  () => env?.close()
);

const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
const clear = () => Promise.all([t.ours.clear(), t.chrome.clear()]);
/** One turn of the snapshots' timer and a little more. */
const POLL = 3500;

/**
 * Compares two lists of event lines with their counts: ours has each line Chrome has, none it has
 * not, and no more of one than Chrome (Chrome sends some more than once, such as a list per write).
 */
function sameCounted(ours: string[], chrome: string[]) {
  const count = (lines: string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const [o, c] = [count(ours), count(chrome)];
  assert.deepEqual([...o.keys()].sort(), [...c.keys()].sort());
  for (const [line, n] of o) assert.ok(n <= (c.get(line) ?? 0), `${line}: ours ${n}, Chrome ${c.get(line)}`);
}

/** What each event names, without the bucket ids, which are the implementation's own. */
async function seen(side: Side) {
  const names: string[] = [];
  for (const method of EVENTS) {
    for (const params of await side.events(method)) {
      const { origin, storageKey: key, ...rest }: Record<string, unknown> = { ...params };
      delete rest['bucketId'];
      // Chrome announces the bucket again with writes, ours once while tracking.
      if ('bucketInfo' in rest) continue;
      names.push(`${method} ${JSON.stringify({ origin, key, ...rest })}`);
    }
  }
  return names;
}

/**
 * Runs `write` in the page, waits on both sides for each event it must cause (so that none comes
 * late into the next test), then for the rest to stop coming, and clears them.
 */
async function cleanUp(write: () => Promise<unknown>, ...events: EventName[]) {
  await clear();
  await t.page.evaluate(write);
  for (const event of events) await waitForBoth(t, event, 1, 10_000);
  await settle(800);
  await clear();
}

test('setStorageBucketTracking reports the existing bucket', async () => {
  const [[ours], [chrome]] = await waitForBoth(t, 'Storage.storageBucketCreatedOrUpdated');
  assert.equal(ours?.bucketInfo.bucket.storageKey, chrome?.bucketInfo.bucket.storageKey);
  assert.equal(ours?.bucketInfo.bucket.name, undefined);
});

/** Makes database `name` with a store `s`, version 1, from the page or another tab. */
const makeDatabase = (name: string) =>
  new Promise<void>(resolve => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
  });
const dropDatabase = (name: string) =>
  new Promise(resolve => {
    indexedDB.deleteDatabase(name).onsuccess = resolve;
  });

test('IndexedDB writes', async () => {
  await clear();
  await t.page.evaluate(
    () =>
      new Promise<void>(resolve => {
        const open = indexedDB.open('tracked', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('s');
        open.onsuccess = () => {
          const tx = open.result.transaction('s', 'readwrite');
          tx.objectStore('s').put(1, 'a');
          tx.objectStore('s').delete('b');
          tx.oncomplete = () => {
            const cursorTx = open.result.transaction('s', 'readwrite');
            const cursor = cursorTx.objectStore('s').openCursor();
            cursor.onsuccess = () => cursor.result?.update(2);
            cursorTx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        };
      })
  );
  await waitForBoth(t, 'Storage.indexedDBContentUpdated');
  await settle(800);
  sameCounted(await seen(t.ours), await seen(t.chrome));
  await cleanUp(
    () =>
      new Promise(resolve => {
        indexedDB.deleteDatabase('tracked').onsuccess = resolve;
      }),
    'Storage.indexedDBListUpdated'
  );
});

test('deleting a database updates the list', async () => {
  await t.page.evaluate(makeDatabase, 'to-delete');
  await settle(800);
  await clear();
  await t.page.evaluate(dropDatabase, 'to-delete');
  await waitForBoth(t, 'Storage.indexedDBListUpdated');
  await settle(800);
  sameCounted(await seen(t.ours), await seen(t.chrome));
});

test('Cache Storage writes', async () => {
  await clear();
  await t.page.evaluate(async () => {
    const cache = await caches.open('tracked');
    await cache.put('/a', new Response('a'));
    await cache.delete('/a');
    // Opening an existing cache and deleting a missing one change nothing.
    await caches.open('tracked');
    await caches.delete('missing');
    await caches.delete('tracked');
  });
  await waitForBoth(t, 'Storage.cacheStorageContentUpdated');
  await settle(800);
  sameCounted(await seen(t.ours), await seen(t.chrome));
});

/** The list and Cache Storage events, by bucket name: what snapshots can tell (not a database's content). */
async function seenByBucket(side: Side) {
  const names = new Map<string, string>();
  for (const { bucketInfo } of await side.events('Storage.storageBucketCreatedOrUpdated'))
    names.set(bucketInfo.id, bucketInfo.bucket.name ?? '(default)');
  const lines: string[] = [];
  for (const method of [
    'Storage.indexedDBListUpdated',
    'Storage.cacheStorageListUpdated',
    'Storage.cacheStorageContentUpdated',
  ] as const) {
    for (const params of await side.events(method)) {
      const cacheName = 'cacheName' in params ? params.cacheName : undefined;
      // A bucket not announced since the events were cleared is the default one, reported when
      // tracking began: Chrome announces it again with writes, ours once.
      lines.push(`${method} ${names.get(params.bucketId ?? '') ?? '(default)'} ${cacheName ?? ''}`);
    }
  }
  return lines;
}

/** Waits until `ours` has seen every line Chrome has (the snapshots run on a timer), then compares them. */
async function sameEvents(read: (side: Side) => Promise<string[]>) {
  const chrome = await read(t.chrome);
  let ours = await read(t.ours);
  for (let i = 0; i < 80 && chrome.some(line => !ours.includes(line)); i++) {
    await settle(100);
    ours = await read(t.ours);
  }
  sameCounted(ours, chrome);
}

/** Runs `write` in another tab of the page's origin, which the page's hooks do not see. */
async function inOtherTab(write: () => Promise<unknown>) {
  const other = await t.page.browser().newPage();
  await other.goto(t.page.url());
  await other.evaluate(write);
  await other.close();
}

test('writes made by another tab are reported', async () => {
  await clear();
  await inOtherTab(async () => {
    await (await caches.open('other-tab')).put('/o', new Response('o'));
    await new Promise<void>(resolve => {
      const open = indexedDB.open('other-tab', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('s');
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
    });
  });
  await waitForBoth(t, 'Storage.cacheStorageContentUpdated', 1, 10_000);
  await waitForBoth(t, 'Storage.indexedDBListUpdated', 1, 10_000);
  await sameEvents(seenByBucket);
  await cleanUp(
    async () => {
      await caches.delete('other-tab');
      await new Promise(resolve => {
        indexedDB.deleteDatabase('other-tab').onsuccess = resolve;
      });
    },
    'Storage.cacheStorageListUpdated',
    'Storage.indexedDBListUpdated'
  );
});

test('named buckets: listed, reported and read', async () => {
  await clear();
  await t.page.evaluate(async () => {
    const bucket = await navigator.storageBuckets.open('b1');
    await (await bucket.caches.open('bc')).put('/b', new Response('b'));
    await new Promise<void>(resolve => {
      const open = bucket.indexedDB.open('bdb', 2);
      open.onupgradeneeded = () => open.result.createObjectStore('s');
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
    });
  });
  const [[ours], [chrome]] = await waitForBoth(t, 'Storage.storageBucketCreatedOrUpdated');
  const info = (event: typeof ours) => ({ ...event?.bucketInfo, id: undefined });
  assert.deepEqual(info(ours), info(chrome));
  await sameEvents(seenByBucket);

  const storageBucket = { storageKey, name: 'b1' };
  const [oursNames, chromeNames] = await Promise.all([
    t.ours.send('IndexedDB.requestDatabaseNames', { storageBucket }),
    t.chrome.send('IndexedDB.requestDatabaseNames', { storageBucket }),
  ]);
  assert.deepEqual(oursNames, chromeNames);
  const [oursDb, chromeDb] = await Promise.all([
    t.ours.send('IndexedDB.requestDatabase', { storageBucket, databaseName: 'bdb' }),
    t.chrome.send('IndexedDB.requestDatabase', { storageBucket, databaseName: 'bdb' }),
  ]);
  assert.deepEqual(oursDb, chromeDb);
  const [oursCaches, chromeCaches] = await Promise.all([
    t.ours.send('CacheStorage.requestCacheNames', { storageBucket }),
    t.chrome.send('CacheStorage.requestCacheNames', { storageBucket }),
  ]);
  assert.deepEqual(oursCaches, chromeCaches);
  const cacheId = chromeCaches.caches[0]?.cacheId ?? '';
  const [oursEntries, chromeEntries] = await Promise.all([
    t.ours.send('CacheStorage.requestEntries', { cacheId, skipCount: 0, pageSize: 10 }),
    t.chrome.send('CacheStorage.requestEntries', { cacheId, skipCount: 0, pageSize: 10 }),
  ]);
  assert.deepEqual(
    oursEntries.cacheDataEntries.map(e => e.requestURL),
    chromeEntries.cacheDataEntries.map(e => e.requestURL)
  );
  // The default bucket is still the one without a name.
  const [oursDefault, chromeDefault] = await Promise.all([
    t.ours.send('CacheStorage.requestCacheNames', { storageBucket: { storageKey } }),
    t.chrome.send('CacheStorage.requestCacheNames', { storageBucket: { storageKey } }),
  ]);
  assert.deepEqual(oursDefault, chromeDefault);
  await cleanUp(() => navigator.storageBuckets.delete('b1'), 'Storage.storageBucketDeleted');
});

test('a missing named bucket fails without being made, a missing cache as in Chrome', async () => {
  const storageBucket = { storageKey, name: 'missing' };
  const [ours, chrome] = await Promise.allSettled([
    t.ours.send('CacheStorage.requestCacheNames', { storageBucket }),
    t.chrome.send('CacheStorage.requestCacheNames', { storageBucket }),
  ]);
  assert.equal(ours.status, 'rejected');
  assert.equal(chrome.status, 'rejected');
  assert.equal((await t.page.evaluate(() => navigator.storageBuckets.keys())).includes('missing'), false);

  // Each side on a cache of its own: the page's storage is shared. deleteEntry makes the cache and
  // fails as for a missing entry; requestCachedResponse fails; requestEntries lists it, empty, and
  // makes it when alone. Each made cache changes the list once: a snapshot turn adds nothing.
  const calls = async (side: Side, name: string) => {
    const cacheId = `${storageKey}|${name}`;
    const settled = async (call: Promise<unknown>) =>
      call.then(
        value => value,
        (error: Error) => error.message.replace(/^.*\): /, '').split('\n')[0]
      );
    await clear();
    const failed = [
      await settled(side.send('CacheStorage.deleteEntry', { cacheId, request: `${storageKey}x` })),
      await settled(
        side.send('CacheStorage.requestCachedResponse', { cacheId, requestURL: `${storageKey}x`, requestHeaders: [] })
      ),
    ];
    const made = await t.page.evaluate(n => caches.has(n), name);
    const listed = await settled(side.send('CacheStorage.requestEntries', { cacheId, skipCount: 0, pageSize: 10 }));
    await settle(POLL);
    const events = (await side.events('Storage.cacheStorageListUpdated')).length;
    await clear();
    const alone = `${storageKey}|${name}-alone`;
    const listedAlone = await settled(
      side.send('CacheStorage.requestEntries', { cacheId: alone, skipCount: 0, pageSize: 10 })
    );
    await settle(POLL);
    const eventsAlone = (await side.events('Storage.cacheStorageListUpdated')).length;
    const madeAlone = await t.page.evaluate(n => caches.has(n), `${name}-alone`);
    return { failed, made, listed, events, listedAlone, eventsAlone, madeAlone };
  };
  assert.deepEqual(await calls(t.ours, 'missing-ours'), await calls(t.chrome, 'missing-chrome'));
  assert.equal(await t.page.evaluate(() => caches.has('missing-ours')), true);
  await cleanUp(
    () =>
      Promise.all(
        ['missing-ours', 'missing-chrome', 'missing-ours-alone', 'missing-chrome-alone'].map(n => caches.delete(n))
      ),
    'Storage.cacheStorageListUpdated'
  );
});

test('deleting a named bucket', async () => {
  await t.page.evaluate(async () => {
    await (await (await navigator.storageBuckets.open('to-delete')).caches.open('c')).put('/d', new Response('d'));
  });
  await settle(800);
  await clear();
  // The order of the events across methods, from a session of Chrome's own tracking too.
  const session = await t.page.createCDPSession();
  const chromeOrder: string[] = [];
  for (const method of EVENTS) session.on(method, () => chromeOrder.push(method));
  await session.send('Storage.trackIndexedDBForStorageKey', { storageKey });
  await session.send('Storage.trackCacheStorageForStorageKey', { storageKey });
  await session.send('Storage.setStorageBucketTracking', { storageKey, enable: true });
  await settle(300);
  chromeOrder.length = 0;
  await clear();
  await t.page.evaluate(() => navigator.storageBuckets.delete('to-delete'));
  await waitForBoth(t, 'Storage.storageBucketDeleted', 1, 10_000);
  await settle(800);
  await session.detach();
  const oursOrder = await t.page.evaluate(() =>
    window.__ours.map(e => e.method).filter(method => method.startsWith('Storage.'))
  );
  // The lists come before the deletion; Chrome sends the two lists in either order.
  const shape = (order: string[]) => [...order.slice(0, -1).sort(), order.at(-1)];
  assert.equal(chromeOrder.at(-1), 'Storage.storageBucketDeleted');
  assert.deepEqual(shape(oursOrder), shape(chromeOrder));
});

test('a bucket made by another tab is reported', async () => {
  await clear();
  await inOtherTab(async () => {
    const bucket = await navigator.storageBuckets.open('elsewhere', { quota: 1_000_000 });
    await (await bucket.caches.open('ec')).put('/e', new Response('e'));
  });
  const [[ours], [chrome]] = await waitForBoth(t, 'Storage.storageBucketCreatedOrUpdated', 1, 10_000);
  const info = (event: typeof ours) => ({ ...event?.bucketInfo, id: undefined });
  assert.deepEqual(info(ours), info(chrome));
  await sameEvents(seenByBucket);
  await cleanUp(() => navigator.storageBuckets.delete('elsewhere'), 'Storage.storageBucketDeleted');
});

test('untracking stops the events', async () => {
  for (const side of [t.ours, t.chrome]) await side.send('Storage.untrackCacheStorageForStorageKey', { storageKey });
  await clear();
  await t.page.evaluate(async () => (await caches.open('existing')).put('/b', new Response('b')));
  await inOtherTab(async () => (await caches.open('existing')).put('/c', new Response('c')));
  // Long enough for a turn of the snapshots' timer.
  await settle(POLL);
  assert.deepEqual(await t.ours.events('Storage.cacheStorageContentUpdated'), []);
  assert.deepEqual(await t.chrome.events('Storage.cacheStorageContentUpdated'), []);
  await t.page.evaluate(() => caches.delete('existing'));
});
