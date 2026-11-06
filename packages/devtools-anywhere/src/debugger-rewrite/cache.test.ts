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
const { RewriteCache, hashBytes } = modules;
type RecordStore = CacheModule.RecordStore;

/** A record store in memory, counting its writes. */
function memoryStore(initial?: string): RecordStore & { record: string | undefined; saves: number } {
  const store = {
    record: initial,
    saves: 0,
    load: async () => store.record,
    save: async (record: string) => {
      store.saves++;
      store.record = record;
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
  const cache = new RewriteCache(undefined, 2);
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
  const first = new RewriteCache(store);
  await first.set('/a.js', 'a', 'utf-8', [4], true);
  await first.set('/secret.js', 's', 'utf-8', [8], false);
  assert.doesNotMatch(store.record ?? '', /secret/);
  // A restarted worker.
  const second = new RewriteCache(store);
  assert.deepEqual(await second.get('/a.js', 'a', 'utf-8'), [4]);
  assert.equal(await second.get('/secret.js', 's', 'utf-8'), undefined);
  // A persisted URL served again with no-store is dropped from the record.
  await second.set('/a.js', 'a2', 'utf-8', [], false);
  assert.equal(await new RewriteCache(store).get('/a.js', 'a', 'utf-8'), undefined);
  await second.clear();
  assert.equal(second.size, 0);
  assert.equal(await new RewriteCache(store).get('/a.js', 'a2', 'utf-8'), undefined);
});

test('a broken, older or missing record is an empty cache', async () => {
  for (const record of [
    '{',
    '{"version":0,"entries":[["/a.js","a","utf-8",[]]]}',
    '{"version":1,"entries":[["/a.js",1]]}',
  ]) {
    const cache = new RewriteCache(memoryStore(record));
    assert.equal(await cache.get('/a.js', 'a', 'utf-8'), undefined, record);
  }
  const failing = new RewriteCache({
    load: () => Promise.reject(new Error('no Cache API')),
    save: () => Promise.reject(new Error('quota')),
  });
  await failing.set('/a.js', 'a', 'utf-8', [2], true);
  assert.deepEqual(await failing.get('/a.js', 'a', 'utf-8'), [2], 'kept in memory');
});

test('writes asked for together make few record writes, the last state written', async () => {
  const store = memoryStore();
  const cache = new RewriteCache(store);
  await Promise.all(Array.from({ length: 10 }, (_, i) => cache.set(`/${i}.js`, String(i), 'utf-8', [], true)));
  assert.ok(store.saves <= 2, `${store.saves} writes`);
  const restarted = new RewriteCache(store);
  for (let i = 0; i < 10; i++) assert.deepEqual(await restarted.get(`/${i}.js`, String(i), 'utf-8'), []);
});

test('hashBytes is SHA-256 in hex', async () => {
  assert.equal(
    await hashBytes(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});
