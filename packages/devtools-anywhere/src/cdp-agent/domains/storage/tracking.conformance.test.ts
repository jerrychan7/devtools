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

const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const clear = () => Promise.all([t.ours.clear(), t.chrome.clear()]);

/** What each event names, without the bucket ids, which are the implementation's own. */
async function seen(side: Side) {
  const names: string[] = [];
  for (const method of EVENTS) {
    for (const params of await side.events(method)) {
      const { origin, storageKey: key, ...rest }: Record<string, unknown> = { ...params };
      delete rest['bucketId'];
      if ('bucketInfo' in rest) rest['bucketInfo'] = 'bucket';
      names.push(`${method} ${JSON.stringify({ origin, key, ...rest })}`);
    }
  }
  return [...new Set(names)].sort();
}

test('setStorageBucketTracking reports the existing bucket', async () => {
  const [[ours], [chrome]] = await waitForBoth(t, 'Storage.storageBucketCreatedOrUpdated');
  assert.equal(ours?.bucketInfo.bucket.storageKey, chrome?.bucketInfo.bucket.storageKey);
  assert.equal(ours?.bucketInfo.bucket.name, undefined);
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
  await settle();
  assert.deepEqual(await seen(t.ours), await seen(t.chrome));
});

test('deleting a database updates the list', async () => {
  await clear();
  await t.page.evaluate(
    () =>
      new Promise(resolve => {
        indexedDB.deleteDatabase('tracked').onsuccess = resolve;
      })
  );
  await waitForBoth(t, 'Storage.indexedDBListUpdated');
  await settle();
  assert.deepEqual(await seen(t.ours), await seen(t.chrome));
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
  await settle();
  assert.deepEqual(await seen(t.ours), await seen(t.chrome));
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
  return [...new Set(lines)].sort();
}

/** Waits until `ours` has seen every line Chrome has (the snapshots run on a timer), then compares them. */
async function sameEvents(read: (side: Side) => Promise<string[]>) {
  const chrome = await read(t.chrome);
  let ours = await read(t.ours);
  for (let i = 0; i < 80 && chrome.some(line => !ours.includes(line)); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    ours = await read(t.ours);
  }
  assert.deepEqual(ours, chrome);
}

test('writes made by another tab are reported', async () => {
  await clear();
  const other = await t.page.browser().newPage();
  await other.goto(t.page.url());
  await other.evaluate(async () => {
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
  await other.close();
  await waitForBoth(t, 'Storage.cacheStorageContentUpdated', 1, 10_000);
  await waitForBoth(t, 'Storage.indexedDBListUpdated', 1, 10_000);
  await sameEvents(seenByBucket);
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
});

test('a missing named bucket fails without being made', async () => {
  const storageBucket = { storageKey, name: 'missing' };
  const [ours, chrome] = await Promise.allSettled([
    t.ours.send('CacheStorage.requestCacheNames', { storageBucket }),
    t.chrome.send('CacheStorage.requestCacheNames', { storageBucket }),
  ]);
  assert.equal(ours.status, 'rejected');
  assert.equal(chrome.status, 'rejected');
  assert.deepEqual(await t.page.evaluate(() => navigator.storageBuckets.keys()), ['b1']);
});

test('deleting a named bucket', async () => {
  await clear();
  await t.page.evaluate(() => navigator.storageBuckets.delete('b1'));
  await waitForBoth(t, 'Storage.storageBucketDeleted', 1, 10_000);
  const [ours, chrome] = await Promise.all([
    t.ours.events('Storage.storageBucketDeleted'),
    t.chrome.events('Storage.storageBucketDeleted'),
  ]);
  assert.equal(ours.length, chrome.length);
});

test('a bucket made by another tab is reported', async () => {
  await clear();
  const other = await t.page.browser().newPage();
  await other.goto(t.page.url());
  await other.evaluate(async () => {
    const bucket = await navigator.storageBuckets.open('elsewhere', { quota: 1_000_000 });
    await (await bucket.caches.open('ec')).put('/e', new Response('e'));
  });
  await other.close();
  const [[ours], [chrome]] = await waitForBoth(t, 'Storage.storageBucketCreatedOrUpdated', 1, 10_000);
  const info = (event: typeof ours) => ({ ...event?.bucketInfo, id: undefined });
  assert.deepEqual(info(ours), info(chrome));
  await sameEvents(seenByBucket);
  await t.page.evaluate(() => navigator.storageBuckets.delete('elsewhere'));
});

test('untracking stops the events', async () => {
  for (const side of [t.ours, t.chrome]) await side.send('Storage.untrackCacheStorageForStorageKey', { storageKey });
  await clear();
  await t.page.evaluate(async () => (await caches.open('existing')).put('/b', new Response('b')));
  await settle();
  assert.deepEqual(await t.ours.events('Storage.cacheStorageContentUpdated'), []);
  assert.deepEqual(await t.chrome.events('Storage.cacheStorageContentUpdated'), []);
});
