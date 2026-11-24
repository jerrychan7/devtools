import type { Protocol } from 'devtools-protocol';
import { windowOf } from '../../core/natives';
import type { CdpSession } from '../../core/session';
import { bucketNames, cacheNamesOf, databasesOf, existingBucket, openedQuotas } from './buckets';
import { hookWrites, listeners, writesInFlight, type StorageWrite } from './hooks';
import { diff, takeSnapshot, type Change, type Snapshot } from './snapshot';

/**
 * How often the buckets are compared with their last snapshot while something is tracked, besides
 * when the window gets the focus or becomes visible: writes elsewhere show within this time.
 */
const POLL_MS = 3000;
/** How long after the page's own writes their area is compared, so that a run of writes makes one read. */
const SETTLE_MS = 300;

/**
 * Whether the page has stored something in IndexedDB or Cache Storage, which makes its bucket.
 * Where the page may not use them (an opaque origin throws a SecurityError) it has not.
 */
async function hasBucket() {
  try {
    if (typeof indexedDB !== 'undefined' && (await databasesOf(indexedDB)).length) return true;
    return typeof caches !== 'undefined' && (await cacheNamesOf(caches)).length > 0;
  } catch {
    return false;
  }
}

/** The key under which a change the hooks reported is kept from being reported again by the snapshots. */
function keyOf(change: Exclude<StorageWrite, { buckets: true } | { pending: boolean }> | Change): string {
  if ('list' in change) return `${change.list}|${change.bucket}`;
  if ('databaseName' in change) return '';
  if ('cacheName' in change) return `cache|${change.bucket}|${change.cacheName}`;
  if (change.kind === 'idbList') return `idb|${change.bucket}`;
  if (change.kind === 'cacheList') return `cache|${change.bucket}`;
  return '';
}

/**
 * Storage's tracking commands: the Application panel's IndexedDB and Cache Storage views find the
 * page's buckets through bucket tracking and refresh on the content events. Writes this window
 * makes are reported as they are made (`hooks.ts`); those made elsewhere, by comparing snapshots
 * (`snapshot.ts`) on a timer and when the window gets the focus or becomes visible.
 */
export function registerStorageTracking(session: CdpSession, storageKey: string) {
  let trackBuckets = false;
  let trackIdb = false;
  let trackCache = false;
  const origin = location.origin;
  const ours = (key: { storageKey?: string; origin?: string }) =>
    key.storageKey === storageKey || key.origin === origin;
  const active = () => trackBuckets || trackIdb || trackCache;

  /** Bucket ids by bucket name (`''`: the default one): numbers as in Chrome, a new one for a bucket made again. */
  const ids = new Map<string, string>();
  let nextId = 1;
  const idOf = (bucket: string) => {
    let id = ids.get(bucket);
    if (id === undefined) ids.set(bucket, (id = String(nextId++)));
    return id;
  };
  /** The buckets reported since bucket tracking was turned on. */
  const sent = new Set<string>();
  /** Events go out in turn: some wait for what a bucket says of itself. */
  let queue = Promise.resolve();
  const inTurn = (fn: () => unknown) => {
    queue = queue.then(fn).then(
      () => {},
      () => {}
    );
  };

  async function bucketInfo(name: string): Promise<Protocol.Storage.StorageBucketInfo | undefined> {
    const info = { id: idOf(name), expiration: 0, quota: 0, persistent: false, durability: 'relaxed' as const };
    if (!name) return { bucket: { storageKey }, ...info };
    const bucket = await existingBucket(name).catch(() => undefined);
    if (!bucket) return undefined;
    // A bucket deleted meanwhile rejects these: it is not reported (its deletion is, if it was).
    const read = await Promise.all([
      bucket.expires(),
      bucket.persisted(),
      bucket.estimate(),
      navigator.storage.estimate(),
    ]).catch(() => undefined);
    if (!read) return undefined;
    const [expires, persistent, own, all] = read;
    // Chrome says the quota the bucket was opened with, 0 for none. For one opened elsewhere it is
    // not known: the bucket's estimate gives it, or a cap of the browser's own.
    const quota = openedQuotas.has(name)
      ? (openedQuotas.get(name) ?? 0)
      : own.quota !== undefined && own.quota < (all.quota ?? Infinity)
        ? own.quota
        : 0;
    // Chrome says `relaxed` whatever durability the bucket was opened with.
    return { ...info, bucket: { storageKey, name }, expiration: expires ? expires / 1000 : 0, quota, persistent };
  }
  const sendBucket = async (name: string) => {
    if (!trackBuckets || sent.has(name)) return;
    sent.add(name);
    const info = await bucketInfo(name);
    if (info) session.emit('Storage.storageBucketCreatedOrUpdated', { bucketInfo: info });
    else sent.delete(name);
  };
  /**
   * The named buckets whose deletion was reported, until a snapshot sees them made again. A write
   * queued before the deletion is not reported then: its bucket's id is gone, and a new one would
   * name a bucket the client was never told of. One made again in between has its lists reported
   * by the snapshot that sees it.
   */
  const deleted = new Set<string>();
  const at = (bucket: string) => ({ origin, storageKey, bucketId: idOf(bucket) });
  const sendList = async (list: 'idb' | 'cache', bucket: string) => {
    if ((list === 'idb' ? !trackIdb : !trackCache) || deleted.has(bucket)) return;
    await sendBucket(bucket);
    session.emit(list === 'idb' ? 'Storage.indexedDBListUpdated' : 'Storage.cacheStorageListUpdated', at(bucket));
  };
  const sendCache = (bucket: string, cacheName: string) => {
    if (trackCache && !deleted.has(bucket))
      session.emit('Storage.cacheStorageContentUpdated', { ...at(bucket), cacheName });
  };

  // ---- writes elsewhere: snapshots ----

  let snapshot: Snapshot | undefined;
  /** The changes the hooks reported since the last snapshot, which it must not report again. */
  const reported = new Set<string>();
  /** Counts the hooks' reports, a write's start and end included: a snapshot read while one came is not used. */
  let writes = 0;
  /** Whether a snapshot was dropped for a write in flight: read again once none is. */
  let waiting = false;
  let checking = false;
  let again = false;
  /** Whether a check after the page's own writes is waiting (`SETTLE_MS`). */
  let settling = false;
  const checkSoon = () => {
    if (settling) return;
    settling = true;
    Reflect.apply(windowOf().timeout, globalThis, [
      () => {
        settling = false;
        // Tracking may have stopped meanwhile: no read then.
        if (active()) void check();
      },
      SETTLE_MS,
    ]);
  };

  const report = (change: Change) => {
    switch (change.kind) {
      case 'bucketCreated':
        deleted.delete(change.bucket);
        return sendBucket(change.bucket);
      case 'bucketDeleted':
        if (trackBuckets) session.emit('Storage.storageBucketDeleted', { bucketId: idOf(change.bucket) });
        ids.delete(change.bucket);
        sent.delete(change.bucket);
        if (change.bucket) deleted.add(change.bucket);
        return;
      case 'idbList':
        return sendList('idb', change.bucket);
      case 'cacheList':
        return sendList('cache', change.bucket);
      case 'cacheContent':
        return sendCache(change.bucket, change.cacheName);
    }
  };

  /** Compares the buckets with the last snapshot and reports what changed; the first one is only kept. */
  async function check() {
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    // A page writing all the time gets a few reads, then the timer's next turn.
    let rounds = 0;
    try {
      do {
        again = false;
        const before = writes;
        const now = await takeSnapshot(trackCache).catch(() => undefined);
        if (!now || !active()) break;
        // Read while a write of this window was in flight, it may have it or not, and the hook
        // reports it once done: it is read again when none is. Read while the hooks reported a
        // write, it may not have that write: read again.
        if (writesInFlight() > 0) {
          waiting = true;
          break;
        }
        if (writes !== before) {
          again = true;
          continue;
        }
        const last = snapshot;
        snapshot = now;
        if (last) {
          for (const change of diff(last, now)) {
            if (!reported.has(keyOf(change))) inTurn(() => report(change));
          }
        }
        reported.clear();
      } while (again && ++rounds < 5);
    } finally {
      checking = false;
    }
  }

  /** Bumped to stop the timer it was started with. */
  let timer = 0;
  const tick = (run: number) => () => {
    if (run !== timer) return;
    // A hidden page is compared again as it becomes visible.
    if (document.visibilityState !== 'hidden') void check();
    Reflect.apply(windowOf().timeout, globalThis, [tick(run), POLL_MS]);
  };
  // The top page's window and document are meant: its storage is the one tracked.
  const onFocus = () => void check();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  const listen = (on: boolean) => {
    const fn = on ? windowOf().listen : windowOf().unlisten;
    Reflect.apply(fn, window, ['focus', onFocus]);
    Reflect.apply(fn, document, ['visibilitychange', onVisible]);
  };

  // ---- writes of this window: hooks ----

  const onWrite = (write: StorageWrite) => {
    if ('buckets' in write) return void check();
    writes++;
    if ('pending' in write) {
      if (!write.pending && waiting && !writesInFlight()) {
        waiting = false;
        checkSoon();
      }
      return;
    }
    const key = keyOf(write);
    if (key) {
      reported.add(key);
      // Compared soon, so the mark does not hide for long a write made elsewhere in the same place.
      checkSoon();
    }
    const { bucket } = write;
    if ('list' in write) inTurn(() => sendList(write.list, bucket));
    else if ('cacheName' in write) inTurn(() => sendCache(bucket, write.cacheName));
    else {
      const { databaseName, objectStoreName } = write;
      // Checked when its turn comes: tracking may have stopped, or the client gone, meanwhile.
      inTurn(() => {
        if (trackIdb && !deleted.has(bucket))
          session.emit('Storage.indexedDBContentUpdated', { ...at(bucket), databaseName, objectStoreName });
      });
    }
  };
  /** Starts or stops reporting writes as what is tracked changes. */
  const update = () => {
    if (active()) {
      hookWrites();
      if (listeners.has(onWrite)) return;
      listeners.add(onWrite);
      listen(true);
      Reflect.apply(windowOf().timeout, globalThis, [tick(++timer), POLL_MS]);
      void check();
    } else if (listeners.delete(onWrite)) {
      listen(false);
      timer++;
      snapshot = undefined;
      waiting = false;
      reported.clear();
    }
  };
  const track = (set: (on: boolean) => void, on: boolean) => (key: { storageKey?: string; origin?: string }) => {
    // Other storage keys are not the page's to see: tracking them succeeds without events.
    if (!ours(key)) return;
    set(on);
    update();
  };
  // A client that goes leaves nothing tracked: the next one starts afresh.
  session.onReset(() => {
    trackBuckets = trackIdb = trackCache = false;
    sent.clear();
    ids.clear();
    deleted.clear();
    nextId = 1;
    update();
  });
  const idb = (on: boolean) => (trackIdb = on);
  const cache = (on: boolean) => (trackCache = on);

  session.register('Storage', {
    async setStorageBucketTracking(params: Protocol.Storage.SetStorageBucketTrackingRequest) {
      if (params.storageKey !== storageKey) return;
      trackBuckets = params.enable;
      sent.clear();
      update();
      if (!trackBuckets) return;
      // The existing buckets are reported at once, the default one if something is stored in it;
      // those made later, as they are seen.
      const names = [...((await hasBucket()) ? [''] : []), ...(await bucketNames())];
      for (const name of names) inTurn(() => sendBucket(name));
      await queue;
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
