import { bucketOf, openedQuotas, registerBucketOf } from './buckets';

/**
 * A change of the page's IndexedDB or Cache Storage, as the Storage domain's events tell it, in a
 * bucket (`''`: the default one). `buckets`: a named bucket may have been opened or deleted.
 */
export type StorageWrite =
  | { bucket: string; list: 'idb' | 'cache' }
  | { bucket: string; databaseName: string; objectStoreName: string }
  | { bucket: string; cacheName: string }
  | { buckets: true }
  /** A Cache Storage write has begun: it is reported once done, and a snapshot read meanwhile may miss it. */
  | { pending: true };

/** The sessions tracking something. */
export const listeners = new Set<(write: StorageWrite) => void>();
let hooked = false;
/** The names Cache objects were opened with, and their bucket: a Cache does not know its own. */
const cacheNames = new WeakMap<Cache, { bucket: string | undefined; name: string }>();
/**
 * The bucket of each database opened since the hooks (undefined: not known, see `bucketOf`); one
 * opened before them is taken for the default bucket's.
 */
const databaseBuckets = new WeakMap<IDBDatabase, string | undefined>();
const databaseBucket = (db: IDBDatabase) => (databaseBuckets.has(db) ? databaseBuckets.get(db) : '');

const notify = (write: StorageWrite) => listeners.forEach(fn => fn(write));

/** Replaces `proto[name]` with `wrap(original)`. */
function patch<T extends object, K extends keyof T>(proto: T, name: K, wrap: (original: T[K]) => T[K]) {
  proto[name] = wrap(proto[name]);
}

/** The store a write through a cursor changes: the cursor's own or its index's. */
const storeOf = (cursor: IDBCursor) => (cursor.source instanceof IDBIndex ? cursor.source.objectStore : cursor.source);

/** Remembers which bucket the IndexedDB and Cache Storage a named bucket gives belong to. */
function hookBuckets() {
  const bucketProto: object | undefined = Reflect.get(globalThis, 'StorageBucket')?.prototype;
  if (bucketProto) {
    for (const name of ['indexedDB', 'caches']) {
      const descriptor = Object.getOwnPropertyDescriptor(bucketProto, name);
      const get = descriptor?.get;
      if (!descriptor || !get) continue;
      Object.defineProperty(bucketProto, name, {
        ...descriptor,
        get(this: { name: string }) {
          const store: unknown = Reflect.apply(get, this, []);
          if (store && typeof store === 'object') registerBucketOf(store, this.name);
          return store;
        },
      });
    }
  }
  const managerProto: Record<string, unknown> | undefined = Reflect.get(globalThis, 'StorageBucketManager')?.prototype;
  if (!managerProto) return;
  for (const name of ['open', 'delete']) {
    const original = managerProto[name];
    if (typeof original !== 'function') continue;
    managerProto[name] = async function (this: unknown, ...args: unknown[]) {
      const result: unknown = await Reflect.apply(original, this, args);
      const [bucketName, options] = args;
      if (name === 'open' && typeof bucketName === 'string' && !openedQuotas.has(bucketName)) {
        const quota: unknown = options && typeof options === 'object' ? Reflect.get(options, 'quota') : undefined;
        openedQuotas.set(bucketName, typeof quota === 'number' ? quota : undefined);
      }
      if (name === 'delete' && typeof bucketName === 'string') openedQuotas.delete(bucketName);
      notify({ buckets: true });
      return result;
    };
  }
}

/**
 * Wraps the writes of IndexedDB and Cache Storage in this window to report them, as Chrome does
 * for each write request (one that is aborted later too), in the default bucket and the named ones.
 * Installed once for all sessions. Writes from workers and other windows are not seen here: the
 * sessions compare snapshots for those (`snapshot.ts`).
 */
export function hookWrites() {
  if (hooked) return;
  hooked = true;
  hookBuckets();
  // Writes in a bucket that is not known are left to the snapshots.
  const storeWrite = (store: IDBObjectStore) => {
    const bucket = databaseBucket(store.transaction.db);
    if (bucket !== undefined) notify({ bucket, databaseName: store.transaction.db.name, objectStoreName: store.name });
  };
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
  const listChanged = (bucket: string | undefined) => () => {
    if (bucket !== undefined) notify({ bucket, list: 'idb' });
  };
  patch(
    IDBDatabase.prototype,
    'transaction',
    original =>
      function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
        const tx = original.apply(this, args);
        if (tx.mode === 'readwrite') tx.addEventListener('complete', listChanged(databaseBucket(this)));
        return tx;
      }
  );
  patch(
    IDBFactory.prototype,
    'open',
    original =>
      function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        const req = original.apply(this, args);
        const bucket = bucketOf(this);
        req.addEventListener('success', () => databaseBuckets.set(req.result, bucket), { once: true });
        req.addEventListener('upgradeneeded', () => req.addEventListener('success', listChanged(bucket)), {
          once: true,
        });
        return req;
      }
  );
  patch(
    IDBFactory.prototype,
    'deleteDatabase',
    original =>
      function (this: IDBFactory, ...args: Parameters<IDBFactory['deleteDatabase']>) {
        const req = original.apply(this, args);
        req.addEventListener('success', listChanged(bucketOf(this)));
        return req;
      }
  );

  if (typeof caches === 'undefined') return;
  patch(
    CacheStorage.prototype,
    'open',
    original =>
      async function (this: CacheStorage, cacheName: string) {
        const bucket = bucketOf(this);
        notify({ pending: true });
        const isNew = !(await this.has(cacheName));
        const cache = await original.call(this, cacheName);
        cacheNames.set(cache, { bucket, name: cacheName });
        if (isNew && bucket !== undefined) notify({ bucket, list: 'cache' });
        return cache;
      }
  );
  patch(
    CacheStorage.prototype,
    'delete',
    original =>
      async function (this: CacheStorage, cacheName: string) {
        notify({ pending: true });
        const deleted = await original.call(this, cacheName);
        const bucket = bucketOf(this);
        if (deleted && bucket !== undefined) notify({ bucket, list: 'cache' });
        return deleted;
      }
  );
  // A cache opened before the hooks has no known name: every cache of the default bucket is
  // reported as changed.
  const cacheWrite = async (cache: Cache) => {
    const known = cacheNames.get(cache);
    if (known) {
      if (known.bucket !== undefined) notify({ bucket: known.bucket, cacheName: known.name });
      return;
    }
    for (const cacheName of await caches.keys()) notify({ bucket: '', cacheName });
  };
  const reported = <A extends unknown[], R>(original: (this: Cache, ...args: A) => Promise<R>) =>
    async function (this: Cache, ...args: A) {
      notify({ pending: true });
      const result = await original.apply(this, args);
      if (result !== false) await cacheWrite(this);
      return result;
    };
  patch(Cache.prototype, 'put', reported);
  patch(Cache.prototype, 'add', reported);
  patch(Cache.prototype, 'addAll', reported);
  patch(Cache.prototype, 'delete', reported);
}
