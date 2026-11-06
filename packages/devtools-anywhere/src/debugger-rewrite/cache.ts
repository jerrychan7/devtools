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
// them is written to disk. The record holds the SHA-256 of each URL, not the URL, so that a token
// in a query string is not written to disk; entries read back are found by hashing the URL looked
// up, while a lookup in memory stays by URL.
//
// The record carries the build that made it: a worker of another build (maybe another lexer)
// ignores it. The new worker also deletes the cache when it activates, and the page when shell mode
// ends. A worker opens the cache once and keeps that handle (dropped only after its own deletion
// on activation, made maybe after the handle was opened): once another deletes the cache, it is
// orphaned, so what a worker still finishing (its `waitUntil`) writes afterwards goes nowhere
// instead of making the cache again.
import { REWRITE_CACHE } from '../shell-messages';

/** Scripts remembered, by URL; the least recently used goes first. */
export const MAX_ENTRIES = 256;
/** Bumped when what the record holds changes; the build is added to it. */
const FORMAT = 2;

/** The `debugger` sites of a script: byte offset × 2, plus 1 when the call goes before a `;`. */
export type Plan = readonly number[];

interface Entry {
  hash: string;
  charset: string;
  plan: Plan;
  /** Written to the persistent record (not for `no-store` responses). */
  persist: boolean;
  /** SHA-256 of the URL: what the record holds instead of it. */
  urlHash: string;
}

/** Where the record goes: the Cache API in the worker, anything in tests. */
export interface RecordStore {
  load(): Promise<string | undefined>;
  save(record: string): Promise<void>;
}

/**
 * The record in a Cache API cache, under one synthetic URL of the worker's origin. The cache is
 * opened once: deleted after that, it is not made again by this store.
 */
export function cacheStore(base: string): RecordStore & { forget(): void } {
  const key = new URL('/__devtools-anywhere-rewrites', base).href;
  let opened: Promise<Cache> | undefined;
  const open = () => {
    if (!opened) {
      opened = caches.open(REWRITE_CACHE);
      // A failed open is tried again next time.
      opened.catch(() => (opened = undefined));
    }
    return opened;
  };
  return {
    /** Drops the handle, for a deletion this worker made itself: the next use makes the cache again. */
    forget() {
      opened = undefined;
    },
    async load() {
      const cache = await open();
      return (await cache.match(key))?.text();
    },
    async save(record) {
      const cache = await open();
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

/** SHA-256 of `text` in UTF-8, in hex. */
export const hashText = (text: string): Promise<string> => hashBytes(new TextEncoder().encode(text));

export interface RewriteCacheOptions {
  /** Where the record goes; none to keep entries in memory only. */
  store?: RecordStore | undefined;
  /** The build: a record another build made is ignored. */
  build?: string | undefined;
  max?: number | undefined;
}

export class RewriteCache {
  /** Entries by URL, the least recently used first. */
  private readonly entries = new Map<string, Entry>();
  /** Entries read back from the record, by URL hash, until a lookup of their URL claims them. */
  private readonly restored = new Map<string, Entry>();
  private loaded: Promise<void> | undefined;
  /** Writes of the record, one after the other. */
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private readonly store: RecordStore | undefined;
  private readonly version: string;
  private readonly max: number;

  constructor({ store, build = 'dev', max = MAX_ENTRIES }: RewriteCacheOptions = {}) {
    this.store = store;
    this.version = `${FORMAT}:${build}`;
    this.max = max;
  }

  /** Reads the record once; a missing, unreadable or other build's one is an empty cache. */
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const text = await this.store?.load();
        if (!text) return;
        const record = JSON.parse(text) as { version?: unknown; entries?: unknown };
        if (record.version !== this.version || !Array.isArray(record.entries)) return;
        for (const item of record.entries as unknown[]) {
          if (!Array.isArray(item)) continue;
          const [urlHash, hash, charset, plan] = item as unknown[];
          if (typeof urlHash !== 'string' || typeof hash !== 'string' || typeof charset !== 'string') continue;
          if (!Array.isArray(plan) || !plan.every(n => Number.isInteger(n) && n >= 0)) continue;
          this.restored.set(urlHash, { hash, charset, plan: plan as number[], persist: true, urlHash });
        }
        // Entries put while the record loaded are newer.
        for (const entry of this.entries.values()) this.restored.delete(entry.urlHash);
        if (this.trim()) void this.save();
      } catch {
        // No Cache API, or a broken record: start empty.
      }
    })());
  }

  /** The entry of `url`, claiming the one read back from the record. */
  private async entry(url: string): Promise<Entry | undefined> {
    let entry = this.entries.get(url);
    if (!entry && this.restored.size > 0) {
      const urlHash = await hashText(url);
      entry = this.restored.get(urlHash);
      if (entry) {
        this.restored.delete(urlHash);
        this.entries.set(url, entry);
      }
    }
    return entry;
  }

  /** The plan for `url` when its script had this hash in this charset, else undefined. */
  async get(url: string, hash: string, charset: string): Promise<Plan | undefined> {
    await this.load();
    const entry = await this.entry(url);
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
    const old = await this.entry(url);
    const urlHash = old?.urlHash ?? (await hashText(url));
    this.entries.delete(url);
    this.entries.set(url, { hash, charset, plan, persist, urlHash });
    const evicted = this.trim();
    if (persist || old?.persist || evicted) await this.save();
  }

  /** Forgets everything, in memory and in the record. */
  async clear(): Promise<void> {
    await this.load();
    this.entries.clear();
    this.restored.clear();
    await this.save();
  }

  get size(): number {
    return this.entries.size + this.restored.size;
  }

  /** Drops the least recently used entries past `max`, unclaimed ones first; true if a persisted one went. */
  private trim(): boolean {
    let persisted = false;
    for (const map of [this.restored, this.entries])
      for (const [key, entry] of map) {
        if (this.size <= this.max) return persisted;
        map.delete(key);
        persisted ||= entry.persist;
      }
    return persisted;
  }

  /** Writes the record; writes asked for while one is under way make one more after it. */
  private save(): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    if (this.dirty) return this.saving;
    this.dirty = true;
    this.saving = this.saving.then(async () => {
      // Lets the other writes asked for in this turn join this one.
      await new Promise(resolve => setTimeout(resolve, 0));
      this.dirty = false;
      const entries = [...this.restored.values(), ...this.entries.values()]
        .filter(entry => entry.persist)
        .map(({ urlHash, hash, charset, plan }) => [urlHash, hash, charset, plan]);
      try {
        await store.save(JSON.stringify({ version: this.version, entries }));
      } catch {
        // Storage full or gone: the entries stay in memory.
      }
    });
    return this.saving;
  }
}
