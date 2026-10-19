import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { diffSubset, launch, openPage, waitForBoth } from './harness.mjs'

let env
let t
let origin
let storageKey

before(async () => {
  env = await launch()
  t = await openPage(env, [
    'DOMStorage.domStorageItemAdded',
    'DOMStorage.domStorageItemUpdated',
    'DOMStorage.domStorageItemRemoved',
  ])
  origin = new URL(env.baseUrl).origin
  storageKey = origin + '/'
  await t.page.evaluate(async () => {
    localStorage.clear()
    localStorage.setItem('a', '1')
    localStorage.setItem('b', 'two')
    sessionStorage.setItem('s', 'session')
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('db1', 3)
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore('users', { keyPath: 'id' })
        store.createIndex('byName', 'name', { unique: false })
        open.result.createObjectStore('plain', { autoIncrement: true })
      }
      open.onsuccess = () => {
        const tx = open.result.transaction('users', 'readwrite')
        tx.objectStore('users').put({ id: 1, name: 'ann' })
        tx.objectStore('users').put({ id: 2, name: 'bob' })
        tx.objectStore('users').put({ id: 3, name: 'cid' })
        tx.oncomplete = () => {
          open.result.close()
          resolve()
        }
      }
      open.onerror = () => reject(open.error)
    })
    const cache = await caches.open('c1')
    await cache.put('/cached?x=1', new Response('hello', { headers: { 'content-type': 'text/plain' } }))
  })
})
after(() => env?.close())

const both = (method, params) => Promise.all([t.ours.send(method, params), t.chrome.send(method, params)])
const local = () => ({ storageKey, isLocalStorage: true })

describe('DOMStorage', () => {
  test('getDOMStorageItems', async () => {
    await Promise.all([t.ours.send('DOMStorage.enable'), t.chrome.send('DOMStorage.enable')])
    const [ours, chrome] = await both('DOMStorage.getDOMStorageItems', { storageId: local() })
    assert.deepEqual(ours.entries.sort(), chrome.entries.sort())
  })

  for (const [name, expression, event] of [
    ['item added', "localStorage.setItem('c', '3')", 'DOMStorage.domStorageItemAdded'],
    ['item updated', "localStorage.setItem('c', '4')", 'DOMStorage.domStorageItemUpdated'],
    ['item removed', "localStorage.removeItem('c')", 'DOMStorage.domStorageItemRemoved'],
  ]) {
    test(name, async () => {
      t.chrome.clear()
      await t.ours.clear()
      await t.page.evaluate(expression)
      const [[ours], [chrome]] = await waitForBoth(t, event)
      assert.deepEqual(diffSubset(ours, chrome), [])
    })
  }
})

describe('IndexedDB', () => {
  test('requestDatabaseNames', async () => {
    const [ours, chrome] = await both('IndexedDB.requestDatabaseNames', { storageKey })
    assert.deepEqual(ours.databaseNames, chrome.databaseNames)
  })

  test('requestDatabase', async () => {
    const [ours, chrome] = await both('IndexedDB.requestDatabase', { storageKey, databaseName: 'db1' })
    const sort = db => ({ ...db, objectStores: [...db.objectStores].sort((x, y) => x.name.localeCompare(y.name)) })
    assert.deepEqual(sort(ours.databaseWithObjectStores), sort(chrome.databaseWithObjectStores))
  })

  test('requestData with paging', async () => {
    const params = { storageKey, databaseName: 'db1', objectStoreName: 'users', skipCount: 1, pageSize: 1 }
    const [ours, chrome] = await both('IndexedDB.requestData', params)
    assert.equal(ours.hasMore, chrome.hasMore)
    assert.deepEqual(diffSubset(ours.objectStoreDataEntries, chrome.objectStoreDataEntries), [])
  })

  test('requestData through an index with a key range', async () => {
    const params = {
      storageKey,
      databaseName: 'db1',
      objectStoreName: 'users',
      indexName: 'byName',
      skipCount: 0,
      pageSize: 10,
      keyRange: { lower: { type: 'string', string: 'b' }, lowerOpen: false, upperOpen: false },
    }
    const [ours, chrome] = await both('IndexedDB.requestData', params)
    assert.deepEqual(
      ours.objectStoreDataEntries.map(e => e.key.value),
      chrome.objectStoreDataEntries.map(e => e.key.value)
    )
  })

  test('getMetadata', async () => {
    const params = { storageKey, databaseName: 'db1', objectStoreName: 'users' }
    const [ours, chrome] = await both('IndexedDB.getMetadata', params)
    assert.equal(ours.entriesCount, chrome.entriesCount)
  })
})

describe('CacheStorage', () => {
  test('requestCacheNames', async () => {
    const [ours, chrome] = await both('CacheStorage.requestCacheNames', { storageKey })
    assert.deepEqual(
      ours.caches.map(c => c.cacheName),
      chrome.caches.map(c => c.cacheName)
    )
  })

  test('requestEntries', async () => {
    const [{ caches: oc }, { caches: cc }] = await both('CacheStorage.requestCacheNames', { storageKey })
    const [ours, chrome] = await Promise.all([
      t.ours.send('CacheStorage.requestEntries', { cacheId: oc[0].cacheId, skipCount: 0, pageSize: 10 }),
      t.chrome.send('CacheStorage.requestEntries', { cacheId: cc[0].cacheId, skipCount: 0, pageSize: 10 }),
    ])
    assert.equal(ours.returnCount, chrome.returnCount)
    const pick = e => ({ url: e.requestURL, method: e.requestMethod, status: e.responseStatus })
    assert.deepEqual(ours.cacheDataEntries.map(pick), chrome.cacheDataEntries.map(pick))
  })

  test('requestCachedResponse', async () => {
    const [{ caches: oc }, { caches: cc }] = await both('CacheStorage.requestCacheNames', { storageKey })
    const url = `${origin}/cached?x=1`
    const [ours, chrome] = await Promise.all([
      t.ours.send('CacheStorage.requestCachedResponse', { cacheId: oc[0].cacheId, requestURL: url, requestHeaders: [] }),
      t.chrome.send('CacheStorage.requestCachedResponse', { cacheId: cc[0].cacheId, requestURL: url, requestHeaders: [] }),
    ])
    assert.equal(ours.response.body, chrome.response.body)
  })
})

describe('Storage and cookies', () => {
  test('getCookies after setCookie', async () => {
    await t.ours.send('Network.setCookie', { name: 'k', value: 'v', url: origin })
    const [ours, chrome] = await Promise.all([t.ours.send('Network.getCookies'), t.chrome.send('Network.getCookies', { urls: [origin] })])
    const pick = list => list.cookies.map(c => `${c.name}=${c.value}`).sort()
    assert.deepEqual(pick(ours), pick(chrome))
  })

  test('getUsageAndQuota', async () => {
    const ours = await t.ours.send('Storage.getUsageAndQuota', { origin })
    assert.ok(ours.quota > 0)
  })

  test('clearDataForOrigin clears local storage and IndexedDB', async () => {
    await t.ours.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb' })
    const state = await t.page.evaluate(async () => ({
      local: localStorage.length,
      databases: (await indexedDB.databases()).length,
    }))
    assert.deepEqual(state, { local: 0, databases: 0 })
  })
})
