import type { Protocol } from 'devtools-protocol'
import type { Context } from '../core/context'
import { CdpError } from '../core/server'
import { parseCookies } from './network'

const storageKey = () => location.origin + '/'

// ---- cookies ----

export function setCookie(cookie: Protocol.Network.CookieParam) {
  let text = `${cookie.name}=${cookie.value}; path=${cookie.path || '/'}`
  if (cookie.domain) text += `; domain=${cookie.domain}`
  if (cookie.expires && cookie.expires > 0) text += `; expires=${new Date(cookie.expires * 1000).toUTCString()}`
  if (cookie.secure) text += '; secure'
  if (cookie.sameSite) text += `; samesite=${cookie.sameSite}`
  document.cookie = text
}

function deleteCookie(name: string, path = '/', domain?: string) {
  const expired = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`
  document.cookie = expired
  if (domain) document.cookie = `${expired}; domain=${domain}`
}

function clearCookies() {
  for (const { name } of parseCookies()) deleteCookie(name)
}

// ---- IndexedDB helpers ----

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

/** Opens an existing database; never creates one. */
async function openDatabase(name: string): Promise<IDBDatabase> {
  const names = (await indexedDB.databases()).map(d => d.name)
  if (!names.includes(name)) throw new CdpError(`Database not found: ${name}`)
  return request(indexedDB.open(name))
}

function keyPath(path: string | string[] | null): Protocol.IndexedDB.KeyPath {
  if (path === null) return { type: 'null' }
  if (Array.isArray(path)) return { type: 'array', array: path }
  return { type: 'string', string: path }
}

function toKey(key: Protocol.IndexedDB.Key): IDBValidKey {
  switch (key.type) {
    case 'number':
      return key.number!
    case 'string':
      return key.string!
    case 'date':
      return new Date(key.date!)
    case 'array':
      return (key.array ?? []).map(toKey)
  }
}

function toKeyRange(range?: Protocol.IndexedDB.KeyRange): IDBKeyRange | undefined {
  if (!range) return undefined
  const lower = range.lower && toKey(range.lower)
  const upper = range.upper && toKey(range.upper)
  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper, range.lowerOpen, range.upperOpen)
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, range.lowerOpen)
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, range.upperOpen)
  return undefined
}

async function withStore<T>(databaseName: string, storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>) {
  const db = await openDatabase(databaseName)
  try {
    return await fn(db.transaction(storeName, mode).objectStore(storeName))
  } finally {
    db.close()
  }
}

// ---- Cache Storage helpers ----

function cacheStorage(): CacheStorage {
  if (typeof caches === 'undefined') throw new CdpError('Cache Storage is not available in this context')
  return caches
}

const cacheIdOf = (name: string) => `${location.origin}|${name}`
const cacheNameOf = (cacheId: string) => cacheId.slice(cacheId.indexOf('|') + 1)
const headerList = (headers: Headers) => Array.from(headers, ([name, value]) => ({ name, value }))

function toBase64(buffer: ArrayBuffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function registerStorage(ctx: Context) {
  const { server, objects } = ctx

  // ---- DOMStorage ----

  let domStorageEnabled = false
  let hooked = false
  const storageIdOf = (storage: Storage): Protocol.DOMStorage.StorageId => ({
    securityOrigin: location.origin,
    storageKey: storageKey(),
    isLocalStorage: storage === localStorage,
  })

  /** Reports changes made through the Storage API while the domain is enabled. */
  function hookStorage() {
    if (hooked) return
    hooked = true
    const proto = Storage.prototype
    const { setItem, removeItem, clear } = proto
    proto.setItem = function (this: Storage, key: string, value: string) {
      const oldValue = this.getItem(key)
      setItem.call(this, key, value)
      if (!domStorageEnabled) return
      const storageId = storageIdOf(this)
      if (oldValue === null) server.emit('DOMStorage.domStorageItemAdded', { storageId, key, newValue: String(value) })
      else server.emit('DOMStorage.domStorageItemUpdated', { storageId, key, oldValue, newValue: String(value) })
    }
    proto.removeItem = function (this: Storage, key: string) {
      const existed = this.getItem(key) !== null
      removeItem.call(this, key)
      if (domStorageEnabled && existed) server.emit('DOMStorage.domStorageItemRemoved', { storageId: storageIdOf(this), key })
    }
    proto.clear = function (this: Storage) {
      clear.call(this)
      if (domStorageEnabled) server.emit('DOMStorage.domStorageItemsCleared', { storageId: storageIdOf(this) })
    }
  }

  const storageOf = (id: Protocol.DOMStorage.StorageId) => (id.isLocalStorage ? localStorage : sessionStorage)

  server.register('DOMStorage', {
    enable() {
      domStorageEnabled = true
      hookStorage()
    },
    disable() {
      domStorageEnabled = false
    },
    getDOMStorageItems(params: Protocol.DOMStorage.GetDOMStorageItemsRequest): Protocol.DOMStorage.GetDOMStorageItemsResponse {
      const storage = storageOf(params.storageId)
      return {
        entries: Array.from({ length: storage.length }, (_, i) => {
          const key = storage.key(i)!
          return [key, storage.getItem(key) ?? '']
        }),
      }
    },
    setDOMStorageItem(params: Protocol.DOMStorage.SetDOMStorageItemRequest) {
      storageOf(params.storageId).setItem(params.key, params.value)
    },
    removeDOMStorageItem(params: Protocol.DOMStorage.RemoveDOMStorageItemRequest) {
      storageOf(params.storageId).removeItem(params.key)
    },
    clear(params: Protocol.DOMStorage.ClearRequest) {
      storageOf(params.storageId).clear()
    },
  })

  // ---- IndexedDB ----

  server.register('IndexedDB', {
    enable: () => {},
    disable: () => {},

    async requestDatabaseNames(): Promise<Protocol.IndexedDB.RequestDatabaseNamesResponse> {
      const databases = await indexedDB.databases()
      return { databaseNames: databases.map(d => d.name!).filter(Boolean) }
    },

    async requestDatabase(params: Protocol.IndexedDB.RequestDatabaseRequest): Promise<Protocol.IndexedDB.RequestDatabaseResponse> {
      const db = await openDatabase(params.databaseName)
      try {
        const names = Array.from(db.objectStoreNames)
        const objectStores = names.length
          ? (() => {
              const tx = db.transaction(names, 'readonly')
              return names.map(name => {
                const store = tx.objectStore(name)
                return {
                  name,
                  keyPath: keyPath(store.keyPath),
                  autoIncrement: store.autoIncrement,
                  indexes: Array.from(store.indexNames, indexName => {
                    const index = store.index(indexName)
                    return { name: indexName, keyPath: keyPath(index.keyPath), unique: index.unique, multiEntry: index.multiEntry }
                  }),
                }
              })
            })()
          : []
        return { databaseWithObjectStores: { name: db.name, version: db.version, objectStores } }
      } finally {
        db.close()
      }
    },

    async requestData(params: Protocol.IndexedDB.RequestDataRequest): Promise<Protocol.IndexedDB.RequestDataResponse> {
      return withStore(params.databaseName, params.objectStoreName, 'readonly', store => {
        const source = params.indexName ? store.index(params.indexName) : store
        const cursorRequest = source.openCursor(toKeyRange(params.keyRange))
        const entries: Protocol.IndexedDB.DataEntry[] = []
        let skipped = false
        return new Promise((resolve, reject) => {
          cursorRequest.onerror = () => reject(cursorRequest.error)
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) return resolve({ objectStoreDataEntries: entries, hasMore: false })
            if (!skipped && params.skipCount > 0) {
              skipped = true
              return cursor.advance(params.skipCount)
            }
            skipped = true
            if (entries.length >= params.pageSize) return resolve({ objectStoreDataEntries: entries, hasMore: true })
            entries.push({
              key: objects.wrap(cursor.key, { generatePreview: true, group: 'indexeddb' }),
              primaryKey: objects.wrap(cursor.primaryKey, { generatePreview: true, group: 'indexeddb' }),
              value: objects.wrap((cursor as IDBCursorWithValue).value, { generatePreview: true, group: 'indexeddb' }),
            })
            cursor.continue()
          }
        })
      })
    },

    async getMetadata(params: Protocol.IndexedDB.GetMetadataRequest): Promise<Protocol.IndexedDB.GetMetadataResponse> {
      return withStore(params.databaseName, params.objectStoreName, 'readonly', async store => ({
        entriesCount: await request(store.count()),
        keyGeneratorValue: 0,
      }))
    },

    async clearObjectStore(params: Protocol.IndexedDB.ClearObjectStoreRequest) {
      await withStore(params.databaseName, params.objectStoreName, 'readwrite', store => request(store.clear()))
    },

    async deleteObjectStoreEntries(params: Protocol.IndexedDB.DeleteObjectStoreEntriesRequest) {
      await withStore(params.databaseName, params.objectStoreName, 'readwrite', store =>
        request(store.delete(toKeyRange(params.keyRange)!))
      )
    },

    async deleteDatabase(params: Protocol.IndexedDB.DeleteDatabaseRequest) {
      await request(indexedDB.deleteDatabase(params.databaseName))
    },
  })

  // ---- CacheStorage ----

  server.register('CacheStorage', {
    async requestCacheNames(): Promise<Protocol.CacheStorage.RequestCacheNamesResponse> {
      const names = await cacheStorage().keys()
      return {
        caches: names.map(cacheName => ({
          cacheId: cacheIdOf(cacheName),
          securityOrigin: location.origin,
          storageKey: storageKey(),
          cacheName,
        })),
      }
    },

    async requestEntries(params: Protocol.CacheStorage.RequestEntriesRequest): Promise<Protocol.CacheStorage.RequestEntriesResponse> {
      const cache = await cacheStorage().open(cacheNameOf(params.cacheId))
      let requests = await cache.keys()
      if (params.pathFilter) requests = requests.filter(r => new URL(r.url).pathname.includes(params.pathFilter!))
      const page = requests.slice(params.skipCount ?? 0, (params.skipCount ?? 0) + (params.pageSize ?? requests.length))
      const cacheDataEntries = await Promise.all(
        page.map(async req => {
          const res = await cache.match(req)
          return {
            requestURL: req.url,
            requestMethod: req.method,
            requestHeaders: headerList(req.headers),
            responseTime: Date.parse(res?.headers.get('date') ?? '') || 0,
            responseStatus: res?.status ?? 0,
            responseStatusText: res?.statusText ?? '',
            responseType: (res?.type ?? 'basic') as Protocol.CacheStorage.CachedResponseType,
            responseHeaders: res ? headerList(res.headers) : [],
          }
        })
      )
      return { cacheDataEntries, returnCount: requests.length }
    },

    async requestCachedResponse(
      params: Protocol.CacheStorage.RequestCachedResponseRequest
    ): Promise<Protocol.CacheStorage.RequestCachedResponseResponse> {
      const cache = await cacheStorage().open(cacheNameOf(params.cacheId))
      const res = await cache.match(params.requestURL)
      if (!res) throw new CdpError('Entry not found')
      return { response: { body: toBase64(await res.arrayBuffer()) } }
    },

    async deleteCache(params: Protocol.CacheStorage.DeleteCacheRequest) {
      await cacheStorage().delete(cacheNameOf(params.cacheId))
    },

    async deleteEntry(params: Protocol.CacheStorage.DeleteEntryRequest) {
      const cache = await cacheStorage().open(cacheNameOf(params.cacheId))
      await cache.delete(params.request)
    },
  })

  // ---- Storage ----

  async function clearData(storageTypes: string) {
    const types = new Set(storageTypes.split(',').map(t => t.trim()))
    const all = types.has('all')
    if (all || types.has('local_storage')) {
      localStorage.clear()
      sessionStorage.clear()
    }
    if (all || types.has('cookies')) clearCookies()
    if ((all || types.has('indexeddb')) && typeof indexedDB !== 'undefined') {
      for (const { name } of await indexedDB.databases()) if (name) await request(indexedDB.deleteDatabase(name))
    }
    if ((all || types.has('cache_storage')) && typeof caches !== 'undefined') {
      for (const name of await caches.keys()) await caches.delete(name)
    }
  }

  server.register('Storage', {
    getStorageKeyForFrame: (): Protocol.Storage.GetStorageKeyForFrameResponse => ({ storageKey: storageKey() }),

    async getUsageAndQuota(): Promise<Protocol.Storage.GetUsageAndQuotaResponse> {
      const estimate = (await navigator.storage?.estimate?.()) ?? {}
      return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, overrideActive: false, usageBreakdown: [] }
    },

    clearDataForOrigin: (params: Protocol.Storage.ClearDataForOriginRequest) => clearData(params.storageTypes),
    clearDataForStorageKey: (params: Protocol.Storage.ClearDataForStorageKeyRequest) => clearData(params.storageTypes),

    getCookies: (): Protocol.Storage.GetCookiesResponse => ({ cookies: parseCookies() }),
    setCookies(params: Protocol.Storage.SetCookiesRequest) {
      params.cookies.forEach(setCookie)
    },
    clearCookies,
    getTrustTokens: () => ({ tokens: [] }),
  })

  server.register('Network', {
    getAllCookies: (): Protocol.Network.GetAllCookiesResponse => ({ cookies: parseCookies() }),
    setCookie(params: Protocol.Network.SetCookieRequest): Protocol.Network.SetCookieResponse {
      setCookie(params)
      return { success: true }
    },
    setCookies(params: Protocol.Network.SetCookiesRequest) {
      params.cookies.forEach(setCookie)
    },
    clearBrowserCookies: clearCookies,
  })
}
