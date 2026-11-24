import { bucketNames, cacheNamesOf, databasesOf, hasCacheOf, openBucket, openCacheOf, requestsOf } from './buckets';

/**
 * What can be compared cheaply of a bucket's IndexedDB and Cache Storage, to see the writes the
 * hooks do not (the page's service worker, other workers, other tabs): its databases with their
 * version, and its caches with the URLs of their requests. What a database holds is not read.
 */
export interface BucketSnapshot {
  databases: Map<string, number>;
  /** Each cache's request URLs; undefined where they were not read (Cache Storage not tracked). */
  caches: Map<string, Set<string> | undefined>;
}

/** The snapshot of each bucket, by name (`''`: the default one). */
export type Snapshot = Map<string, BucketSnapshot>;

/** One difference between two snapshots, as the Storage domain's events tell it. */
export type Change =
  | { kind: 'bucketCreated' | 'bucketDeleted'; bucket: string }
  | { kind: 'idbList' | 'cacheList'; bucket: string }
  | { kind: 'cacheContent'; bucket: string; cacheName: string };

/**
 * The browser's own methods are called (`buckets.ts`): a page's wrapper neither sees these reads,
 * made every few seconds, nor breaks them. `contents`: whether each cache's requests are read.
 */
async function snapshotOf(
  factory: IDBFactory | undefined,
  storage: CacheStorage | undefined,
  contents: boolean
): Promise<BucketSnapshot> {
  const databases = new Map<string, number>();
  // Without `databases()` (Firefox before 126) the databases cannot be listed: the caches still are.
  for (const { name, version } of factory ? await databasesOf(factory) : [])
    if (name) databases.set(name, version ?? 0);
  const caches = new Map<string, Set<string> | undefined>();
  if (!storage) return { databases, caches };
  for (const name of await cacheNamesOf(storage)) {
    if (!contents) {
      caches.set(name, undefined);
      continue;
    }
    // Each cache's whole list of requests is read: the API has no cheaper way to tell a change, not
    // even a count. `open()` makes a cache deleted since `keys()` again, and nothing tells it from
    // one still there: `has()` just before narrows that window to a few microtasks.
    if (!(await hasCacheOf(storage, name))) continue;
    const cache = await openCacheOf(storage, name);
    caches.set(name, new Set((await requestsOf(cache)).map(request => request.url)));
  }
  return { databases, caches };
}

/** Reads the default bucket and every named one; each cache's requests only if `contents`. */
export async function takeSnapshot(contents: boolean): Promise<Snapshot> {
  // The named buckets are all opened in the turn their names come in, before anything is read:
  // `open()` makes a missing bucket, so one deleted elsewhere while earlier ones were read would be
  // made again, every few seconds. What is left is the time between the browser answering `keys()`
  // and these `open()` calls reaching it, which the API leaves no way to close.
  const names = await bucketNames();
  const opened = names.map(name => openBucket(name).catch(() => undefined));
  const snapshot: Snapshot = new Map();
  snapshot.set(
    '',
    await snapshotOf(
      typeof indexedDB === 'undefined' ? undefined : indexedDB,
      typeof caches === 'undefined' ? undefined : caches,
      contents
    )
  );
  for (const [i, name] of names.entries()) {
    const bucket = await opened[i];
    if (bucket) snapshot.set(name, await snapshotOf(bucket.indexedDB, bucket.caches, contents));
  }
  return snapshot;
}

const sameKeys = <K, V>(a: Map<K, V>, b: Map<K, V>, same: (x: V, y: V) => boolean) =>
  a.size === b.size && [...a].every(([key, value]) => b.has(key) && same(value, b.get(key) as V));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(url => b.has(url));
const isEmpty = (bucket: BucketSnapshot | undefined) => !bucket || (!bucket.databases.size && !bucket.caches.size);

/**
 * The changes from `before` to `after`, in the order Chrome sends their events: a bucket's
 * creation before its lists, a cache's list before its content, a bucket's deletion after its lists.
 * The default bucket is created by its first database or cache.
 */
export function diff(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  const empty: BucketSnapshot = { databases: new Map(), caches: new Map() };
  for (const [bucket, now] of after) {
    const was = before.get(bucket);
    if (bucket ? !was : isEmpty(was) && !isEmpty(now)) changes.push({ kind: 'bucketCreated', bucket });
    const old = was ?? empty;
    if (!sameKeys(old.caches, now.caches, () => true)) changes.push({ kind: 'cacheList', bucket });
    for (const [cacheName, urls] of now.caches) {
      // Contents not read on either side are not compared; a new cache's are, against none.
      const oldUrls = old.caches.has(cacheName) ? old.caches.get(cacheName) : new Set<string>();
      if (urls && oldUrls && !sameSet(oldUrls, urls)) changes.push({ kind: 'cacheContent', bucket, cacheName });
    }
    if (!sameKeys(old.databases, now.databases, (x, y) => x === y)) changes.push({ kind: 'idbList', bucket });
  }
  for (const bucket of before.keys()) {
    if (after.has(bucket)) continue;
    // Chrome tells both lists, empty or not.
    changes.push({ kind: 'cacheList', bucket }, { kind: 'idbList', bucket });
    changes.push({ kind: 'bucketDeleted', bucket });
  }
  return changes;
}
