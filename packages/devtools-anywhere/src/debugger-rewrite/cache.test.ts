import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as Modules from './rewrite.ts';
import type * as CacheModule from './cache.ts';

// Bundled: the modules import each other without an extension, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export * from './cache.ts'; export * from './rewrite.ts';",
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const modules = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof Modules & typeof CacheModule;
const { RewriteCache, cacheStore, hashBytes, hashText } = modules;
type RecordStore = CacheModule.RecordStore;

/** A record store in memory, counting its writes; `written` settles on the next one. */
function memoryStore(
  initial?: string
): RecordStore & { record: string | undefined; saves: number; written: Promise<void> } {
  let wrote = () => {};
  const next = () => new Promise<void>(resolve => (wrote = resolve));
  const store = {
    record: initial,
    saves: 0,
    written: next(),
    load: async () => store.record,
    save: async (record: string) => {
      store.saves++;
      store.record = record;
      const done = wrote;
      store.written = next();
      done();
    },
  };
  return store;
}

test('a plan is found for the same URL, hash and charset only', async () => {
  const cache = new RewriteCache();
  assert.equal(await cache.get('/a.js', 'h1', 'utf-8'), undefined, 'a miss before anything is set');
  await cache.set('/a.js', 'h1', 'utf-8', [20, 81], true);
  assert.deepEqual(await cache.get('/a.js', 'h1', 'utf-8'), [20, 81]);
  assert.equal(await cache.get('/a.js', 'h2', 'utf-8'), undefined, 'the content changed');
  assert.equal(await cache.get('/a.js', 'h1', 'windows-1251'), undefined, 'another charset');
  assert.equal(await cache.get('/b.js', 'h1', 'utf-8'), undefined, 'another URL');
  // A new version replaces the old one.
  await cache.set('/a.js', 'h2', 'utf-8', [], true);
  assert.deepEqual(await cache.get('/a.js', 'h2', 'utf-8'), []);
  assert.equal(await cache.get('/a.js', 'h1', 'utf-8'), undefined);
  assert.equal(cache.size, 1);
});

test('the least recently used URL goes first', async () => {
  const cache = new RewriteCache({ max: 2 });
  await cache.set('/a.js', 'a', 'utf-8', [], true);
  await cache.set('/b.js', 'b', 'utf-8', [], true);
  await cache.get('/a.js', 'a', 'utf-8');
  await cache.set('/c.js', 'c', 'utf-8', [], true);
  assert.deepEqual(await cache.get('/a.js', 'a', 'utf-8'), []);
  assert.equal(await cache.get('/b.js', 'b', 'utf-8'), undefined);
  assert.deepEqual(await cache.get('/c.js', 'c', 'utf-8'), []);
});

test('entries outlive the worker in the record, but not no-store ones', async () => {
  const store = memoryStore();
  const first = new RewriteCache({ store });
  await first.set('/a.js', 'a', 'utf-8', [4], true);
  await first.set('/secret.js', 's', 'utf-8', [8], false);
  assert.doesNotMatch(store.record ?? '', /secret/);
  // A restarted worker.
  const second = new RewriteCache({ store });
  assert.deepEqual(await second.get('/a.js', 'a', 'utf-8'), [4]);
  assert.equal(await second.get('/secret.js', 's', 'utf-8'), undefined);
  // A persisted URL served again with no-store is dropped from the record.
  await second.set('/a.js', 'a2', 'utf-8', [], false);
  assert.equal(await new RewriteCache({ store }).get('/a.js', 'a', 'utf-8'), undefined);
  await second.clear();
  assert.equal(second.size, 0);
  assert.equal(await new RewriteCache({ store }).get('/a.js', 'a2', 'utf-8'), undefined);
});

test('a broken, older or missing record is an empty cache', async () => {
  const entry = JSON.stringify([await hashText('/a.js'), 'a', 'utf-8', [3]]);
  // The same entry is found in a record of this format and build.
  const current = new RewriteCache({ store: memoryStore(`{"version":"2:dev","entries":[${entry}]}`) });
  assert.deepEqual(await current.get('/a.js', 'a', 'utf-8'), [3]);
  for (const record of [
    '{',
    `{"version":"1:dev","entries":[${entry}]}`,
    `{"version":0,"entries":[${entry}]}`,
    `{"version":"2:dev","entries":[["${await hashText('/a.js')}",1]]}`,
  ]) {
    const cache = new RewriteCache({ store: memoryStore(record) });
    assert.equal(await cache.get('/a.js', 'a', 'utf-8'), undefined, record);
  }
  const failing = new RewriteCache({
    store: {
      load: () => Promise.reject(new Error('no Cache API')),
      save: () => Promise.reject(new Error('quota')),
    },
  });
  await failing.set('/a.js', 'a', 'utf-8', [2], true);
  assert.deepEqual(await failing.get('/a.js', 'a', 'utf-8'), [2], 'kept in memory');
});

test('writes asked for together make few record writes, the last state written', async () => {
  const store = memoryStore();
  const cache = new RewriteCache({ store });
  await Promise.all(Array.from({ length: 10 }, (_, i) => cache.set(`/${i}.js`, String(i), 'utf-8', [], true)));
  assert.ok(store.saves <= 2, `${store.saves} writes`);
  const restarted = new RewriteCache({ store });
  for (let i = 0; i < 10; i++) assert.deepEqual(await restarted.get(`/${i}.js`, String(i), 'utf-8'), []);
});

test('a record another build wrote is ignored, even one put back after the cache was deleted', async () => {
  const store = memoryStore();
  // The old worker's write, still under way when the new one activated and deleted the cache.
  await new RewriteCache({ store, build: 'old' }).set('/a.js', 'a', 'utf-8', [4], true);
  const current = new RewriteCache({ store, build: 'new' });
  assert.equal(await current.get('/a.js', 'a', 'utf-8'), undefined);
  assert.equal(current.size, 0);
  await current.set('/b.js', 'b', 'utf-8', [6], true);
  assert.deepEqual(await new RewriteCache({ store, build: 'new' }).get('/b.js', 'b', 'utf-8'), [6]);
  assert.equal(await new RewriteCache({ store, build: 'old' }).get('/b.js', 'b', 'utf-8'), undefined);
});

test('the record holds hashes of the URLs, not the URLs', async () => {
  const store = memoryStore();
  const url = 'https://example.test/app.js?token=s3cr3t#frag';
  await new RewriteCache({ store }).set(url, 'h', 'utf-8', [10], true);
  assert.doesNotMatch(store.record ?? '', /s3cr3t|example|app\.js/);
  assert.match(store.record ?? '', new RegExp(await hashText(url)));
  const restarted = new RewriteCache({ store });
  assert.equal(await restarted.get('https://example.test/app.js', 'h', 'utf-8'), undefined, 'another URL');
  assert.deepEqual(await restarted.get(url, 'h', 'utf-8'), [10]);
  // Claimed by the lookup, it is written back under the same hash.
  await restarted.set('/other.js', 'o', 'utf-8', [], true);
  assert.deepEqual(await new RewriteCache({ store }).get(url, 'h', 'utf-8'), [10]);
});

test('evicting a persisted entry rewrites the record', async () => {
  const store = memoryStore();
  const cache = new RewriteCache({ store, max: 2 });
  await cache.set('/a.js', 'a', 'utf-8', [], true);
  await cache.set('/b.js', 'b', 'utf-8', [], true);
  // A memory-only entry pushes out /a.js: the record must lose it too.
  await cache.set('/c.js', 'c', 'utf-8', [], false);
  const restarted = new RewriteCache({ store, max: 2 });
  assert.equal(await restarted.get('/a.js', 'a', 'utf-8'), undefined);
  assert.deepEqual(await restarted.get('/b.js', 'b', 'utf-8'), []);
  // A record over the limit (a smaller limit in a newer build) is trimmed and written back.
  await restarted.set('/d.js', 'd', 'utf-8', [], true);
  const over = memoryStore(store.record);
  const small = new RewriteCache({ store: over, max: 1 });
  assert.equal(small.size, 0);
  const written = over.written;
  await small.get('/none.js', 'n', 'utf-8');
  await written;
  assert.equal(over.saves, 1);
  assert.equal((JSON.parse(over.record ?? '') as { entries: unknown[] }).entries.length, 1);
});

/**
 * A Cache API as the spec has it: a deleted cache is orphaned, so that a handle opened before
 * still works but what it holds is no longer in the storage.
 */
function fakeCaches() {
  const named = new Map<string, Map<string, string>>();
  const handle = (entries: Map<string, string>) => ({
    match: async (key: string) => {
      const text = entries.get(key);
      return text === undefined ? undefined : new Response(text);
    },
    put: async (key: string, response: Response) => {
      entries.set(key, await response.text());
    },
  });
  return {
    named,
    open: async (name: string) => {
      let entries = named.get(name);
      if (!entries) named.set(name, (entries = new Map()));
      return handle(entries);
    },
    delete: async (name: string) => named.delete(name),
  };
}

test("the worker's store keeps one record in its cache, and does not make the cache again once deleted", async t => {
  const fake = fakeCaches();
  Object.defineProperty(globalThis, 'caches', { value: fake, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'caches'));
  const url = 'https://example.test/app.js?token=s3cr3t';
  const cache = new RewriteCache({ store: cacheStore('https://example.test/sw.js'), build: 'b' });
  await cache.set(url, 'h', 'utf-8', [4], true);
  const [[name, entries] = []] = fake.named;
  assert.equal(name, 'devtools-anywhere-service-worker-rewrites');
  assert.deepEqual([...(entries?.keys() ?? [])], ['https://example.test/__devtools-anywhere-rewrites']);
  assert.doesNotMatch([...(entries?.values() ?? [])].join(), /s3cr3t|app\.js/);
  // A worker started later reads it back.
  const restarted = new RewriteCache({ store: cacheStore('https://example.test/sw.js'), build: 'b' });
  assert.deepEqual(await restarted.get(url, 'h', 'utf-8'), [4]);
  // Shell mode ends (or a new worker activates): the cache is deleted while this worker still writes.
  await fake.delete('devtools-anywhere-service-worker-rewrites');
  await cache.set('/b.js', 'b', 'utf-8', [6], true);
  await restarted.set('/c.js', 'c', 'utf-8', [8], true);
  assert.equal(fake.named.size, 0, 'no record put back');
});

test('hashBytes is SHA-256 in hex', async () => {
  assert.equal(
    await hashBytes(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test("the worker's own deletion on activation: the store opens the cache again", async t => {
  const fake = fakeCaches();
  Object.defineProperty(globalThis, 'caches', { value: fake, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'caches'));
  const store = cacheStore('https://example.test/sw.js');
  const cache = new RewriteCache({ store, build: 'b' });
  // The worker loads the record at start, then activates and deletes the cache.
  assert.equal(await cache.get('/a.js', 'a', 'utf-8'), undefined);
  await fake.delete('devtools-anywhere-service-worker-rewrites');
  store.forget();
  await cache.set('/b.js', 'b', 'utf-8', [6], true);
  assert.equal(fake.named.size, 1, 'the record is in a cache again');
});
