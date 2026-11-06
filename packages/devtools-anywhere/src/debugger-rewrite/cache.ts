// What the Service Worker's `debugger` rewrite found in each script it served, so that a script
// served again is not decoded and lexed again (on a 7 MB bundle, 8 ms of decoding and some 60 ms
// of lexing in Chrome, against 4 ms to hash it).
//
// An entry holds, for a URL, the SHA-256 of the script's bytes (as the page gets them, after any
// content coding), the charset they were decoded in, and the plan: the byte offset of each
// `debugger` to replace, empty when there is none (or the script cannot be decoded). The plan
// only depends on the bytes and the charset, so it applies whenever both are the same, whatever
// the response's validators, Vary, content coding or cache headers say: a script that changed has
// another hash and misses. One entry per URL: a new version of the script replaces the old one.
//
// Entries live in memory, the most recently used last, at most MAX_ENTRIES. As the browser stops
// an idle worker after some 30 s, they are also kept in the Cache API, as one JSON record (with
// no script text), written after the response went out and read once when the worker starts:
// a put of the record or a match is about 1 ms, where 300 separate entries would cost 30 ms for
// a `keys()`. Scripts served with `Cache-Control: no-store` stay in memory only, so nothing about
// them is written to disk.

/** Cache API cache holding the record: deleted when the worker activates and when it is unregistered. */
export const REWRITE_CACHE = 'devtools-anywhere-service-worker-rewrites';
/** Scripts remembered, by URL; the least recently used goes first. */
export const MAX_ENTRIES = 256;
/** Bumped when what the record holds, or how the lexer finds the sites, changes. */
const VERSION = 1;

/** The `debugger` sites of a script: byte offset × 2, plus 1 when the call goes before a `;`. */
export type Plan = readonly number[];

interface Entry {
  hash: string;
  charset: string;
  plan: Plan;
  /** Written to the persistent record (not for `no-store` responses). */
  persist: boolean;
}

/** Where the record goes: the Cache API in the worker, anything in tests. */
export interface RecordStore {
  load(): Promise<string | undefined>;
  save(record: string): Promise<void>;
}

/** The record in a Cache API cache, under one synthetic URL of the worker's origin. */
export function cacheStore(base: string): RecordStore {
  const key = new URL('/__devtools-anywhere-rewrites', base).href;
  return {
    async load() {
      const cache = await caches.open(REWRITE_CACHE);
      return (await cache.match(key))?.text();
    },
    async save(record) {
      const cache = await caches.open(REWRITE_CACHE);
      await cache.put(key, new Response(record, { headers: { 'content-type': 'application/json' } }));
    },
  };
}

/** SHA-256 of `bytes`, in hex. */
export async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export class RewriteCache {
  private readonly entries = new Map<string, Entry>();
  private loaded: Promise<void> | undefined;
  /** Writes of the record, one after the other. */
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private readonly store: RecordStore | undefined;
  private readonly max: number;

  constructor(store?: RecordStore, max = MAX_ENTRIES) {
    this.store = store;
    this.max = max;
  }

  /** Reads the record once; a missing, unreadable or older one is an empty cache. */
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const text = await this.store?.load();
        if (!text) return;
        const record = JSON.parse(text) as { version?: unknown; entries?: unknown };
        if (record.version !== VERSION || !Array.isArray(record.entries)) return;
        for (const item of record.entries as unknown[]) {
          if (!Array.isArray(item)) continue;
          const [url, hash, charset, plan] = item as unknown[];
          if (typeof url !== 'string' || typeof hash !== 'string' || typeof charset !== 'string') continue;
          if (!Array.isArray(plan) || !plan.every(n => Number.isInteger(n) && n >= 0)) continue;
          // Entries put while the record loaded are newer.
          if (!this.entries.has(url)) this.entries.set(url, { hash, charset, plan: plan as number[], persist: true });
        }
        this.trim();
      } catch {
        // No Cache API, or a broken record: start empty.
      }
    })());
  }

  /** The plan for `url` when its script had this hash in this charset, else undefined. */
  async get(url: string, hash: string, charset: string): Promise<Plan | undefined> {
    await this.load();
    const entry = this.entries.get(url);
    if (!entry || entry.hash !== hash || entry.charset !== charset) return undefined;
    // Most recently used last.
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry.plan;
  }

  /**
   * Remembers the plan for `url`, replacing what it had; `persist: false` keeps it in memory only.
   * The promise settles once the record is written (the worker keeps itself alive for it).
   */
  async set(url: string, hash: string, charset: string, plan: Plan, persist: boolean): Promise<void> {
    await this.load();
    const old = this.entries.get(url);
    this.entries.delete(url);
    this.entries.set(url, { hash, charset, plan, persist });
    this.trim();
    if (persist || old?.persist) await this.save();
  }

  /** Forgets everything, in memory and in the record. */
  async clear(): Promise<void> {
    await this.load();
    this.entries.clear();
    await this.save();
  }

  get size(): number {
    return this.entries.size;
  }

  private trim() {
    for (const url of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(url);
    }
  }

  /** Writes the record; writes asked for while one is under way make one more after it. */
  private save(): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    if (this.dirty) return this.saving;
    this.dirty = true;
    this.saving = this.saving.then(async () => {
      this.dirty = false;
      const entries = [...this.entries]
        .filter(([, entry]) => entry.persist)
        .map(([url, { hash, charset, plan }]) => [url, hash, charset, plan]);
      try {
        await store.save(JSON.stringify({ version: VERSION, entries }));
      } catch {
        // Storage full or gone: the entries stay in memory.
      }
    });
    return this.saving;
  }
}
