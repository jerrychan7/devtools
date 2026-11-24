import { CdpError } from '../../core/session';

/**
 * Named storage buckets (`navigator.storageBuckets`, Chromium only). Each has its own IndexedDB and
 * Cache Storage; the default bucket is the window's `indexedDB` and `caches`. A bucket is named here
 * by its name, the default one by `''`.
 */
export interface StorageBucket {
  readonly name: string;
  readonly indexedDB: IDBFactory;
  readonly caches: CacheStorage;
  persisted(): Promise<boolean>;
  expires(): Promise<number | null>;
  estimate(): Promise<StorageEstimate>;
}

interface StorageBucketManager {
  open(name: string): Promise<StorageBucket>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<void>;
}

/** The page's bucket manager, where the browser has one. */
export const bucketManager = (): StorageBucketManager | undefined =>
  (Reflect.get(navigator, 'storageBuckets') as StorageBucketManager | undefined) ?? undefined;

/**
 * The manager's `open()` as the bundle found it, before the agent's hooks wrap it (`hooks.ts`), for
 * the agent's own calls. A page's wrapper put there before the bundle loaded is the one taken.
 */
const managerProto: StorageBucketManager | undefined = Reflect.get(globalThis, 'StorageBucketManager')?.prototype;
const managerOpen = managerProto?.open;
const managerKeys = managerProto?.keys;

/**
 * The quota each bucket was opened with in this window since the hooks (none: opened without one).
 * The page cannot read it back: a bucket's `estimate()` gives a quota of the browser's own then.
 */
export const openedQuotas = new Map<string, number | undefined>();

/**
 * `CacheStorage.prototype.open` as the bundle found it, before the agent's hooks wrap it, for the
 * agent's own reads: the hooks do not report them, nor does a wrapper the page puts there later
 * see them. A page's wrapper put there before the bundle loaded is the one taken.
 */
const cacheOpen: CacheStorage['open'] | undefined =
  typeof CacheStorage === 'undefined' ? undefined : CacheStorage.prototype.open;
// The same for the reads the snapshots make every few seconds (`snapshot.ts`): a page's wrapper
// put there later neither sees them nor breaks them.
const cacheStorageKeys = typeof CacheStorage === 'undefined' ? undefined : CacheStorage.prototype.keys;
const cacheStorageHas = typeof CacheStorage === 'undefined' ? undefined : CacheStorage.prototype.has;
const cacheKeys = typeof Cache === 'undefined' ? undefined : Cache.prototype.keys;
const factoryDatabases: IDBFactory['databases'] | undefined =
  typeof IDBFactory === 'undefined' ? undefined : IDBFactory.prototype.databases;

/** Opens a cache through the browser's own `open()`. */
export const openCacheOf = (storage: CacheStorage, name: string): Promise<Cache> =>
  Reflect.apply(cacheOpen ?? storage.open, storage, [name]);
/** The names of a Cache Storage's caches, through the browser's own `keys()`. */
export const cacheNamesOf = (storage: CacheStorage): Promise<string[]> =>
  Reflect.apply(cacheStorageKeys ?? storage.keys, storage, []);
/** Whether a Cache Storage has a cache, through the browser's own `has()`. */
export const hasCacheOf = (storage: CacheStorage, name: string): Promise<boolean> =>
  Reflect.apply(cacheStorageHas ?? storage.has, storage, [name]);
/** The requests of a cache, through the browser's own `keys()`. */
export const requestsOf = (cache: Cache): Promise<readonly Request[]> =>
  Reflect.apply(cacheKeys ?? cache.keys, cache, []);
/** The databases of a factory, through the browser's own `databases()`; none where it has none (Firefox before 126). */
export const databasesOf = async (factory: IDBFactory): Promise<IDBDatabaseInfo[]> => {
  const databases = factoryDatabases ?? factory.databases;
  return typeof databases === 'function' ? Reflect.apply(databases, factory, []) : [];
};

/**
 * The names of the page's named buckets: none without the API, or where the page may not use it
 * (an opaque origin throws a SecurityError).
 */
export async function bucketNames(): Promise<string[]> {
  try {
    const manager = bucketManager();
    return manager ? await Reflect.apply(managerKeys ?? manager.keys, manager, []) : [];
  } catch {
    return [];
  }
}

/**
 * Opens a bucket known to exist through the browser's own `open()`, which would make a missing one.
 * The call is made before the first `await`: a caller can start several in the same turn.
 */
export async function openBucket(name: string): Promise<StorageBucket | undefined> {
  const manager = bucketManager();
  if (!manager) return undefined;
  const bucket: StorageBucket = await Reflect.apply(managerOpen ?? manager.open, manager, [name]);
  registerBucketOf(bucket.indexedDB, name);
  registerBucketOf(bucket.caches, name);
  return bucket;
}

/** The bucket each IndexedDB factory and Cache Storage of a named bucket belongs to (`registerBucketOf`). */
const bucketOfStore = new WeakMap<object, string>();

/**
 * The bucket of an IndexedDB factory or Cache Storage: `''` for the window's own, undefined for one
 * of a named bucket the page took before the agent could tell which (`hooks.ts`).
 */
export const bucketOf = (store: object): string | undefined =>
  bucketOfStore.get(store) ??
  (store === Reflect.get(globalThis, 'indexedDB') || store === Reflect.get(globalThis, 'caches') ? '' : undefined);
export const registerBucketOf = (store: object, name: string) => bucketOfStore.set(store, name);

/**
 * A named bucket that exists. `open()` would create a missing one, so the names are read first;
 * one deleted between the two calls is made again, which the API leaves no way to avoid.
 */
export async function existingBucket(name: string): Promise<StorageBucket | undefined> {
  return (await bucketNames()).includes(name) ? openBucket(name) : undefined;
}

/** The IndexedDB of a bucket (`''` or none: the default one). */
export async function indexedDBOf(name = ''): Promise<IDBFactory> {
  if (!name) return indexedDB;
  const bucket = await existingBucket(name);
  if (!bucket) throw new CdpError(`Storage bucket not found: ${name}`);
  return bucket.indexedDB;
}

/** The Cache Storage of a bucket (`''` or none: the default one), failing as Chrome does for a missing bucket. */
export async function cachesOf(name = ''): Promise<CacheStorage> {
  if (typeof caches === 'undefined') throw new CdpError('Cache Storage is not available in this context');
  if (!name) return caches;
  const bucket = await existingBucket(name);
  if (!bucket) throw new CdpError("Couldn't retreive caches");
  return bucket.caches;
}
