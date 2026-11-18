import type { Protocol } from 'devtools-protocol';
import type { CdpSession } from '../../core/session';

/**
 * The page's one storage bucket, the default one: named buckets (`navigator.storageBuckets`) are
 * not tracked. Its id is ours; Chrome's is the browser's own number.
 */
const BUCKET_ID = 'default';

/** A change of the page's IndexedDB or Cache Storage, as the Storage domain's events tell it. */
type StorageWrite =
  | { list: 'idb' | 'cache' }
  | { databaseName: string; objectStoreName: string }
  | { cacheName: string };

/** The sessions tracking something. */
const listeners = new Set<(write: StorageWrite) => void>();
let hooked = false;
/** The names Cache objects were opened with: a Cache does not know its own. */
const cacheNames = new WeakMap<Cache, string>();

const notify = (write: StorageWrite) => listeners.forEach(fn => fn(write));

/** Replaces `proto[name]` with `wrap(original)`. */
function patch<T extends object, K extends keyof T>(proto: T, name: K, wrap: (original: T[K]) => T[K]) {
  proto[name] = wrap(proto[name]);
}

/** The store a write through a cursor changes: the cursor's own or its index's. */
const storeOf = (cursor: IDBCursor) => (cursor.source instanceof IDBIndex ? cursor.source.objectStore : cursor.source);

/**
 * Wraps the writes of IndexedDB and Cache Storage in this window to report them, as Chrome does
 * for each write request (one that is aborted later too). Installed once for all sessions.
 * Writes from workers and other windows are not seen.
 */
function hookWrites() {
  if (hooked) return;
  hooked = true;
  const storeWrite = (store: IDBObjectStore) =>
    notify({ databaseName: store.transaction.db.name, objectStoreName: store.name });
  for (const name of ['put', 'add', 'delete', 'clear'] as const) {
    patch(
      IDBObjectStore.prototype,
      name,
      original =>
        function (this: IDBObjectStore, ...args: unknown[]) {
          const req = Reflect.apply(original, this, args);
          storeWrite(this);
          return req;
        }
    );
  }
  for (const name of ['update', 'delete'] as const) {
    patch(
      IDBCursor.prototype,
      name,
      original =>
        function (this: IDBCursor, ...args: unknown[]) {
          const req = Reflect.apply(original, this, args);
          storeWrite(storeOf(this));
          return req;
        }
    );
  }
  // The list (with its stores' sizes) changes as a write transaction commits, a database is
  // created or upgraded, or one is deleted.
  const listChanged = () => notify({ list: 'idb' });
  patch(
    IDBDatabase.prototype,
    'transaction',
    original =>
      function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        const tx = original.apply(this, args);
        if (tx.mode === 'readwrite') tx.addEventListener('complete', listChanged);
        return tx;
      }
  );
  patch(
    IDBFactory.prototype,
    'open',
    original =>
      function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        const req = original.apply(this, args);
        req.addEventListener('upgradeneeded', () => req.addEventListener('success', listChanged), { once: true });
        return req;
      }
  );
  patch(
    IDBFactory.prototype,
    'deleteDatabase',
    original =>
      function (this: IDBFactory, ...args: Parameters<IDBFactory['deleteDatabase']>) {
        const req = original.apply(this, args);
        req.addEventListener('success', listChanged);
        return req;
      }
  );

  if (typeof caches === 'undefined') return;
  patch(
    CacheStorage.prototype,
    'open',
    original =>
      async function (this: CacheStorage, cacheName: string) {
        const isNew = !(await this.has(cacheName));
        const cache = await original.call(this, cacheName);
        cacheNames.set(cache, cacheName);
        if (isNew) notify({ list: 'cache' });
        return cache;
      }
  );
  patch(
    CacheStorage.prototype,
    'delete',
    original =>
      async function (this: CacheStorage, cacheName: string) {
        const deleted = await original.call(this, cacheName);
        if (deleted) notify({ list: 'cache' });
        return deleted;
      }
  );
  // A cache opened before the hooks has no known name: every cache is reported as changed.
  const cacheWrite = async (cache: Cache) => {
    const known = cacheNames.get(cache);
    for (const cacheName of known === undefined ? await caches.keys() : [known]) notify({ cacheName });
  };
  const reported = <A extends unknown[], R>(original: (this: Cache, ...args: A) => Promise<R>) =>
    async function (this: Cache, ...args: A) {
      const result = await original.apply(this, args);
      if (result !== false) await cacheWrite(this);
      return result;
    };
  patch(Cache.prototype, 'put', reported);
  patch(Cache.prototype, 'add', reported);
  patch(Cache.prototype, 'addAll', reported);
  patch(Cache.prototype, 'delete', reported);
}

/** Whether the page has stored something in IndexedDB or Cache Storage, which makes its bucket. */
async function hasBucket() {
  if (typeof indexedDB !== 'undefined' && (await indexedDB.databases()).length) return true;
  return typeof caches !== 'undefined' && (await caches.keys()).length > 0;
}

/**
 * Storage's tracking commands: the Application panel's IndexedDB and Cache Storage views find the
 * page's bucket through bucket tracking and refresh on the content events.
 */
export function registerStorageTracking(session: CdpSession, storageKey: string) {
  let trackBuckets = false;
  let bucketSent = false;
  let trackIdb = false;
  let trackCache = false;
  const origin = location.origin;
  const ours = (key: { storageKey?: string; origin?: string }) =>
    key.storageKey === storageKey || key.origin === origin;

  const sendBucket = () => {
    if (!trackBuckets || bucketSent) return;
    bucketSent = true;
    session.emit('Storage.storageBucketCreatedOrUpdated', {
      bucketInfo: {
        bucket: { storageKey },
        id: BUCKET_ID,
        expiration: 0,
        quota: 0,
        persistent: false,
        durability: 'relaxed',
      },
    });
  };
  const at = { origin, storageKey, bucketId: BUCKET_ID };
  const onWrite = (write: StorageWrite) => {
    if ('list' in write) {
      if (write.list === 'idb' ? !trackIdb : !trackCache) return;
      sendBucket();
      session.emit(write.list === 'idb' ? 'Storage.indexedDBListUpdated' : 'Storage.cacheStorageListUpdated', at);
    } else if ('cacheName' in write) {
      if (trackCache) session.emit('Storage.cacheStorageContentUpdated', { ...at, cacheName: write.cacheName });
    } else if (trackIdb) {
      session.emit('Storage.indexedDBContentUpdated', { ...at, ...write });
    }
  };
  /** Starts or stops reporting writes as what is tracked changes. */
  const update = () => {
    if (trackBuckets || trackIdb || trackCache) {
      hookWrites();
      listeners.add(onWrite);
    } else listeners.delete(onWrite);
  };
  const track = (set: (on: boolean) => void, on: boolean) => (key: { storageKey?: string; origin?: string }) => {
    // Other storage keys are not the page's to see: tracking them succeeds without events.
    if (!ours(key)) return;
    set(on);
    update();
  };
  const idb = (on: boolean) => (trackIdb = on);
  const cache = (on: boolean) => (trackCache = on);

  session.register('Storage', {
    async setStorageBucketTracking(params: Protocol.Storage.SetStorageBucketTrackingRequest) {
      if (params.storageKey !== storageKey) return;
      trackBuckets = params.enable;
      bucketSent = false;
      update();
      // An existing bucket is reported at once; one made later, with its first database or cache.
      if (trackBuckets && (await hasBucket())) sendBucket();
    },
    trackIndexedDBForOrigin: track(idb, true),
    trackIndexedDBForStorageKey: track(idb, true),
    untrackIndexedDBForOrigin: track(idb, false),
    untrackIndexedDBForStorageKey: track(idb, false),
    trackCacheStorageForOrigin: track(cache, true),
    trackCacheStorageForStorageKey: track(cache, true),
    untrackCacheStorageForOrigin: track(cache, false),
    untrackCacheStorageForStorageKey: track(cache, false),
  });
}
