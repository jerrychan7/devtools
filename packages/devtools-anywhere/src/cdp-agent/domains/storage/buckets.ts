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

/** The manager's `open()`, taken before the hooks wrap it (`hooks.ts`), for the agent's own calls. */
const managerOpen: StorageBucketManager['open'] | undefined = Reflect.get(globalThis, 'StorageBucketManager')?.prototype
  ?.open;

/**
 * The quota each bucket was opened with in this window since the hooks (none: opened without one).
 * The page cannot read it back: a bucket's `estimate()` gives a quota of the browser's own then.
 */
export const openedQuotas = new Map<string, number | undefined>();

/** The names of the page's named buckets, none without the API. */
export async function bucketNames(): Promise<string[]> {
  return (await bucketManager()?.keys()) ?? [];
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
  const manager = bucketManager();
  if (!manager || !(await manager.keys()).includes(name)) return undefined;
  const bucket: StorageBucket = await Reflect.apply(managerOpen ?? manager.open, manager, [name]);
  registerBucketOf(bucket.indexedDB, name);
  registerBucketOf(bucket.caches, name);
  return bucket;
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
