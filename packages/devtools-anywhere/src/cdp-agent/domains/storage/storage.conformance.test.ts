import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import { diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

type Commands = ProtocolMapping.Commands;

let env: Env | undefined;
let t: TestPage;
let origin: string;
let storageKey: string;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'DOMStorage.domStorageItemAdded',
    'DOMStorage.domStorageItemUpdated',
    'DOMStorage.domStorageItemRemoved',
  ]);
  origin = new URL(env.baseUrl).origin;
  storageKey = origin + '/';
  await t.page.evaluate(async () => {
    localStorage.clear();
    localStorage.setItem('a', '1');
    localStorage.setItem('b', 'two');
    sessionStorage.setItem('s', 'session');
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('db1', 3);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore('users', { keyPath: 'id' });
        store.createIndex('byName', 'name', { unique: false });
        open.result.createObjectStore('plain', { autoIncrement: true });
      };
      open.onsuccess = () => {
        const tx = open.result.transaction('users', 'readwrite');
        tx.objectStore('users').put({ id: 1, name: 'ann' });
        tx.objectStore('users').put({ id: 2, name: 'bob' });
        tx.objectStore('users').put({ id: 3, name: 'cid' });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
      open.onerror = () => reject(open.error);
    });
    const cache = await caches.open('c1');
    await cache.put('/cached?x=1', new Response('hello', { headers: { 'content-type': 'text/plain' } }));
  });
});
after(() => env?.close());

const both = <M extends keyof Commands>(method: M, ...params: Commands[M]['paramsType']) =>
  Promise.all([t.ours.send(method, ...params), t.chrome.send(method, ...params)]);
const local = () => ({ storageKey, isLocalStorage: true });

describe('DOMStorage', () => {
  test('getDOMStorageItems', async () => {
    await Promise.all([t.ours.send('DOMStorage.enable'), t.chrome.send('DOMStorage.enable')]);
    const [ours, chrome] = await both('DOMStorage.getDOMStorageItems', { storageId: local() });
    assert.deepEqual(ours.entries.sort(), chrome.entries.sort());
  });

  for (const [name, expression, event] of [
    ['item added', "localStorage.setItem('c', '3')", 'DOMStorage.domStorageItemAdded'],
    ['item updated', "localStorage.setItem('c', '4')", 'DOMStorage.domStorageItemUpdated'],
    ['item removed', "localStorage.removeItem('c')", 'DOMStorage.domStorageItemRemoved'],
  ] as const) {
    test(name, async () => {
      await t.chrome.clear();
      await t.ours.clear();
      await t.page.evaluate(expression);
      const [[ours], [chrome]] = await waitForBoth(t, event);
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
  }

  test('setDOMStorageItem and removeDOMStorageItem (Application panel edits)', async () => {
    await both('DOMStorage.setDOMStorageItem', { storageId: local(), key: 'edit', value: 'v1' });
    let [ours, chrome] = await both('DOMStorage.getDOMStorageItems', { storageId: local() });
    assert.deepEqual(ours.entries.sort(), chrome.entries.sort());
    assert.equal(await t.page.evaluate(() => localStorage.getItem('edit')), 'v1');

    await both('DOMStorage.removeDOMStorageItem', { storageId: local(), key: 'edit' });
    [ours, chrome] = await both('DOMStorage.getDOMStorageItems', { storageId: local() });
    assert.deepEqual(ours.entries.sort(), chrome.entries.sort());
    assert.equal(await t.page.evaluate(() => localStorage.getItem('edit')), null);
  });

  test('changes made by another tab are reported', async () => {
    await t.ours.clear();
    // What the browser dispatches when another tab of the origin sets an item.
    await t.page.evaluate(() =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'other', oldValue: null, newValue: 'x', storageArea: localStorage })
      )
    );
    // Events reach the test asynchronously; Chrome does not report a synthetic event.
    let events = await t.ours.events('DOMStorage.domStorageItemAdded');
    for (let i = 0; !events.length && i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      events = await t.ours.events('DOMStorage.domStorageItemAdded');
    }
    assert.deepEqual(events, [{ storageId: { ...local(), securityOrigin: origin }, key: 'other', newValue: 'x' }]);
  });
});

describe('IndexedDB', () => {
  test('requestDatabaseNames', async () => {
    const [ours, chrome] = await both('IndexedDB.requestDatabaseNames', { storageKey });
    assert.deepEqual(ours.databaseNames, chrome.databaseNames);
  });

  test('requestDatabase', async () => {
    const [ours, chrome] = await both('IndexedDB.requestDatabase', { storageKey, databaseName: 'db1' });
    const sort = (db: Protocol.IndexedDB.DatabaseWithObjectStores) => ({
      ...db,
      objectStores: [...db.objectStores].sort((x, y) => x.name.localeCompare(y.name)),
    });
    assert.deepEqual(sort(ours.databaseWithObjectStores), sort(chrome.databaseWithObjectStores));
  });

  test('requestData with paging', async () => {
    const params = { storageKey, databaseName: 'db1', objectStoreName: 'users', skipCount: 1, pageSize: 1 };
    const [ours, chrome] = await both('IndexedDB.requestData', params);
    assert.equal(ours.hasMore, chrome.hasMore);
    assert.deepEqual(diffSubset(ours.objectStoreDataEntries, chrome.objectStoreDataEntries), []);
  });

  test('requestData through an index with a key range', async () => {
    const params: Protocol.IndexedDB.RequestDataRequest = {
      storageKey,
      databaseName: 'db1',
      objectStoreName: 'users',
      indexName: 'byName',
      skipCount: 0,
      pageSize: 10,
      keyRange: { lower: { type: 'string', string: 'b' }, lowerOpen: false, upperOpen: false },
    };
    const [ours, chrome] = await both('IndexedDB.requestData', params);
    assert.deepEqual(
      ours.objectStoreDataEntries.map(e => e.key.value),
      chrome.objectStoreDataEntries.map(e => e.key.value)
    );
  });

  test('getMetadata', async () => {
    const params = { storageKey, databaseName: 'db1', objectStoreName: 'users' };
    const [ours, chrome] = await both('IndexedDB.getMetadata', params);
    assert.equal(ours.entriesCount, chrome.entriesCount);
  });

  test('getMetadata reports the key generator of an autoIncrement store', async () => {
    await t.page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('db1');
          open.onsuccess = () => {
            const tx = open.result.transaction('plain', 'readwrite');
            tx.objectStore('plain').add('first');
            tx.objectStore('plain').add('second');
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
          open.onerror = () => reject(open.error);
        })
    );
    const params = { storageKey, databaseName: 'db1', objectStoreName: 'plain' };
    const [ours, chrome] = await both('IndexedDB.getMetadata', params);
    assert.equal(ours.keyGeneratorValue, chrome.keyGeneratorValue);
  });
});

describe('CacheStorage', () => {
  test('requestCacheNames', async () => {
    const [ours, chrome] = await both('CacheStorage.requestCacheNames', { storageKey });
    assert.deepEqual(
      ours.caches.map(c => c.cacheName),
      chrome.caches.map(c => c.cacheName)
    );
  });

  test('requestEntries', async () => {
    const [{ caches: oc }, { caches: cc }] = await both('CacheStorage.requestCacheNames', { storageKey });
    assert.ok(oc[0] && cc[0]);
    const [ours, chrome] = await Promise.all([
      t.ours.send('CacheStorage.requestEntries', { cacheId: oc[0].cacheId, skipCount: 0, pageSize: 10 }),
      t.chrome.send('CacheStorage.requestEntries', { cacheId: cc[0].cacheId, skipCount: 0, pageSize: 10 }),
    ]);
    assert.equal(ours.returnCount, chrome.returnCount);
    const pick = (e: Protocol.CacheStorage.DataEntry) => ({
      url: e.requestURL,
      method: e.requestMethod,
      status: e.responseStatus,
    });
    assert.deepEqual(ours.cacheDataEntries.map(pick), chrome.cacheDataEntries.map(pick));
  });

  test('requestCachedResponse', async () => {
    const [{ caches: oc }, { caches: cc }] = await both('CacheStorage.requestCacheNames', { storageKey });
    assert.ok(oc[0] && cc[0]);
    const url = `${origin}/cached?x=1`;
    const [ours, chrome] = await Promise.all([
      t.ours.send('CacheStorage.requestCachedResponse', {
        cacheId: oc[0].cacheId,
        requestURL: url,
        requestHeaders: [],
      }),
      t.chrome.send('CacheStorage.requestCachedResponse', {
        cacheId: cc[0].cacheId,
        requestURL: url,
        requestHeaders: [],
      }),
    ]);
    assert.equal(ours.response.body, chrome.response.body);
  });
});

describe('Storage and cookies', () => {
  test('getCookies after setCookie', async () => {
    await t.ours.send('Network.setCookie', { name: 'k', value: 'v', url: origin });
    const [ours, chrome] = await Promise.all([
      t.ours.send('Network.getCookies'),
      t.chrome.send('Network.getCookies', { urls: [origin] }),
    ]);
    const pick = (list: Protocol.Network.GetCookiesResponse) => list.cookies.map(c => `${c.name}=${c.value}`).sort();
    assert.deepEqual(pick(ours), pick(chrome));
  });

  test('setCookie reports failure for a cookie the page cannot set', async () => {
    const ours = await t.ours.send('Network.setCookie', { name: 'secret', value: 'v', url: origin, httpOnly: true });
    assert.equal(ours.success, false);
    assert.equal(await t.page.evaluate(() => document.cookie.includes('secret=')), false);
  });

  test('setCookie takes its default path from the url', async () => {
    const url = await t.page.evaluate(() => location.href);
    const ours = await t.ours.send('Network.setCookie', { name: 'here', value: 'v', url });
    assert.equal(ours.success, true);
    assert.equal(await t.page.evaluate(() => document.cookie.includes('here=v')), true);
    await t.ours.send('Network.deleteCookies', { name: 'here', url });
    assert.equal(await t.page.evaluate(() => document.cookie.includes('here=')), false);
  });

  test('getUsageAndQuota', async () => {
    const [ours, chrome] = await both('Storage.getUsageAndQuota', { origin });
    assert.ok(ours.quota > 0);
    // Usage differs between the two measurements; the shape must not.
    assert.deepEqual(Object.keys(ours).sort(), Object.keys(chrome).sort());
    for (const key of ['usage', 'quota', 'overrideActive'] as const) assert.equal(typeof ours[key], typeof chrome[key]);
    assert.ok(Array.isArray(ours.usageBreakdown));
  });

  test('clearCookies removes cookies set on a sub-path', async () => {
    const name = 'deep';
    await t.page.evaluate(n => {
      const path = location.pathname.replace(/[^/]*$/, '');
      document.cookie = `${n}=1; path=${path}`;
    }, name);
    await t.ours.send('Storage.clearCookies');
    assert.equal(await t.page.evaluate(n => document.cookie.includes(`${n}=`), name), false);
  });

  test('deleteCookies with a url removes a cookie set on its path', async () => {
    const url = await t.page.evaluate(() => {
      document.cookie = `scoped=1; path=${location.pathname.replace(/[^/]*$/, '')}`;
      return location.href;
    });
    await t.ours.send('Network.deleteCookies', { name: 'scoped', url });
    assert.equal(await t.page.evaluate(() => document.cookie.includes('scoped=')), false);
  });

  test('deleteCookies removes a cookie that setCookie set from the same url', async () => {
    const url = await t.page.evaluate(() => location.href);
    const { success } = await t.ours.send('Network.setCookie', { name: 'fromUrl', value: '1', url });
    assert.equal(success, true);
    assert.equal(await t.page.evaluate(() => document.cookie.includes('fromUrl=')), true);
    await t.ours.send('Network.deleteCookies', { name: 'fromUrl', url });
    assert.equal(await t.page.evaluate(() => document.cookie.includes('fromUrl=')), false);
  });

  test('deleteDatabase returns while the page holds a connection', async () => {
    await t.page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('held');
          // Kept open on purpose, like a page that uses the database.
          open.onsuccess = () => {
            Reflect.set(window, 'heldDb', open.result);
            resolve();
          };
          open.onerror = () => reject(open.error);
        })
    );
    await t.ours.send('IndexedDB.deleteDatabase', { storageKey, databaseName: 'held' });
    // Closing it lets the queued deletion finish, so later tests see no database.
    await t.page.evaluate(() => {
      const db = Reflect.get(window, 'heldDb');
      if (db instanceof IDBDatabase) db.close();
    });
  });

  test('clearDataForOrigin clears local storage and IndexedDB, and only them', async () => {
    await t.page.evaluate(async () => {
      sessionStorage.setItem('kept', '1');
      await (await caches.open('kept')).put('/kept', new Response('kept'));
    });
    await t.ours.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' });
    const state = await t.page.evaluate(async () => ({
      local: localStorage.length,
      databases: (await indexedDB.databases()).length,
      session: sessionStorage.getItem('kept'),
      cache: await caches.has('kept'),
    }));
    assert.deepEqual(state, { local: 0, databases: 0, session: '1', cache: true });
  });
});
