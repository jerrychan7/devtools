import { bucketNames, openBucket, openCacheOf } from './buckets';

/**
 * What can be compared cheaply of a bucket's IndexedDB and Cache Storage, to see the writes the
 * hooks do not (the page's service worker, other workers, other tabs): its databases with their
 * version, and its caches with the URLs of their requests. What a database holds is not read.
 */
export interface BucketSnapshot {
  databases: Map<string, number>;
  caches: Map<string, Set<string>>;
}

/** The snapshot of each bucket, by name (`''`: the default one). */
export type Snapshot = Map<string, BucketSnapshot>;

/** One difference between two snapshots, as the Storage domain's events tell it. */
export type Change =
  | { kind: 'bucketCreated' | 'bucketDeleted'; bucket: string }
  | { kind: 'idbList' | 'cacheList'; bucket: string }
  | { kind: 'cacheContent'; bucket: string; cacheName: string };

async function snapshotOf(factory: IDBFactory | undefined, storage: CacheStorage | undefined): Promise<BucketSnapshot> {
  const databases = new Map<string, number>();
  // Without `databases()` (Firefox before 126) the databases cannot be listed: the caches still are.
  const listed = typeof factory?.databases === 'function' ? await factory.databases() : [];
  for (const { name, version } of listed) if (name) databases.set(name, version ?? 0);
  const caches = new Map<string, Set<string>>();
  if (!storage) return { databases, caches };
  // Each cache's whole list of requests is read: the API has no cheaper way to tell a change, not
  // even a count. `open()` makes a cache deleted since `keys()` again, and nothing tells it from
  // one still there: `has()` just before narrows that window to a few microtasks.
  for (const name of await storage.keys()) {
    if (!(await storage.has(name))) continue;
    const cache = await openCacheOf(storage, name);
    caches.set(name, new Set((await cache.keys()).map(request => request.url)));
  }
  return { databases, caches };
}

/** Reads the default bucket and every named one. */
export async function takeSnapshot(): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  snapshot.set(
    '',
    await snapshotOf(
      typeof indexedDB === 'undefined' ? undefined : indexedDB,
      typeof caches === 'undefined' ? undefined : caches
    )
  );
  // The names were just listed: each is opened without listing them again.
  for (const name of await bucketNames()) {
    const bucket = await openBucket(name);
    if (bucket) snapshot.set(name, await snapshotOf(bucket.indexedDB, bucket.caches));
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
      const oldUrls = old.caches.get(cacheName) ?? new Set();
      if (!sameSet(oldUrls, urls)) changes.push({ kind: 'cacheContent', bucket, cacheName });
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
