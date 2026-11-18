import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, EventName, Side, TestPage } from '../../../../test-support/conformance.ts';

const EVENTS = [
  'Storage.storageBucketCreatedOrUpdated',
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

test('untracking stops the events', async () => {
  for (const side of [t.ours, t.chrome]) await side.send('Storage.untrackCacheStorageForStorageKey', { storageKey });
  await clear();
  await t.page.evaluate(async () => (await caches.open('existing')).put('/b', new Response('b')));
  await settle();
  assert.deepEqual(await t.ours.events('Storage.cacheStorageContentUpdated'), []);
  assert.deepEqual(await t.chrome.events('Storage.cacheStorageContentUpdated'), []);
});
