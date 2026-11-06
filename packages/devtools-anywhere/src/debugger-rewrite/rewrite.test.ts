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
const { RewriteCache, hashBytes, hashText, planOf, rewriteDebugger } = modules;
type RecordStore = CacheModule.RecordStore;
type RewriteCache = CacheModule.RewriteCache;

const URL_A = 'https://example.test/a.js';

function script(body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/javascript; charset=utf-8', ...headers },
  });
}

/** Rewrites with `cache`, waiting for its write like the worker's waitUntil. */
async function rewrite(response: Response, cache?: RewriteCache, url = URL_A): Promise<string> {
  const writes: Promise<unknown>[] = [];
  const out = await rewriteDebugger(response, { cache, url, waitUntil: p => writes.push(p) });
  await Promise.all(writes);
  return out.text();
}

test('debugger statements become calls of the same length, bytes after multi-byte text included', async () => {
  assert.equal(
    await rewrite(script('const é = 1; debugger\nif (a) debugger; else b')),
    'const é = 1; _$dbg();\nif (a) _$dbg() ; else b'
  );
  assert.equal(await rewrite(script('x.debugger = 1')), 'x.debugger = 1');
});

test('a script served again is not lexed again: its plan comes from the cache', async () => {
  const cache = new RewriteCache();
  const source = 'f(); debugger; g()';
  assert.equal(await rewrite(script(source), cache), 'f(); _$dbg() ; g()', 'a miss lexes');
  assert.equal(cache.size, 1);
  const bytes = new TextEncoder().encode(source);
  assert.deepEqual(await cache.get(URL_A, await hashBytes(bytes), 'utf-8'), planOf(bytes, 'utf-8'));
  // Prove the hit uses the plan: plant one that differs from what lexing gives.
  await cache.set(URL_A, await hashBytes(bytes), 'utf-8', [5 * 2], true);
  assert.equal(await rewrite(script(source), cache), 'f(); _$dbg();; g()', 'a hit applies the stored plan');
});

test('a changed script at the same URL misses and replaces the plan', async () => {
  const cache = new RewriteCache();
  assert.equal(await rewrite(script('debugger'), cache), '_$dbg();');
  assert.equal(await rewrite(script('a(); debugger'), cache), 'a(); _$dbg();');
  assert.equal(await rewrite(script('a(); b()'), cache), 'a(); b()');
  assert.equal(cache.size, 1);
  // The same ETag and Last-Modified do not make an old plan apply to new bytes.
  const headers = { etag: '"same"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' };
  assert.equal(await rewrite(script('debugger', headers), cache), '_$dbg();');
  assert.equal(await rewrite(script('xx; debugger', headers), cache), 'xx; _$dbg();');
});

test('responses without validators are cached by their content', async () => {
  const store: RecordStore & { record?: string } = {
    load: async () => store.record,
    save: async record => {
      store.record = record;
    },
  };
  const cache = new RewriteCache({ store });
  await rewrite(script('debugger'), cache);
  assert.match(store.record ?? '', new RegExp(await hashText(URL_A)));
  // no-store: remembered, in memory only.
  await rewrite(script('debugger', { 'cache-control': 'private, no-store' }), cache, 'https://example.test/b.js');
  assert.equal(cache.size, 2);
  assert.doesNotMatch(store.record ?? '', new RegExp(await hashText('https://example.test/b.js')));
});

test('only full 200 responses are remembered; failures pass through untouched', async () => {
  const cache = new RewriteCache();
  assert.equal(await rewrite(script('debugger', {}, 203), cache), '_$dbg();', 'still rewritten');
  assert.equal(await rewrite(script('debugger', {}, 404), cache), 'debugger', 'an error page is left alone');
  assert.equal(await rewrite(script('debugger', { 'content-type': 'text/plain' }), cache), 'debugger');
  assert.equal(await rewrite(script('debugger'), undefined), '_$dbg();', 'no cache');
  assert.equal(cache.size, 0);
});

test('the same bytes in another charset have a plan of their own', async () => {
  const cache = new RewriteCache();
  // 0xA0 is a no-break space (a separator) in windows-1252, and not valid UTF-8 alone.
  const bytes = Uint8Array.from([...new TextEncoder().encode('a;'), 0xa0, ...new TextEncoder().encode('debugger')]);
  const latin = { 'content-type': 'text/javascript; charset=windows-1252' };
  const out = await rewriteDebugger(script(bytes, latin), { cache, url: URL_A });
  assert.deepEqual([...new Uint8Array(await out.arrayBuffer())].slice(3), [...new TextEncoder().encode('_$dbg();')]);
  // As UTF-8 the script cannot be decoded: left as it is, and remembered as such.
  const utf8 = await rewriteDebugger(script(bytes), { cache, url: URL_A });
  assert.deepEqual(new Uint8Array(await utf8.arrayBuffer()), bytes);
  assert.deepEqual(await cache.get(URL_A, await hashBytes(bytes), 'utf-8'), []);
  assert.equal(await cache.get(URL_A, await hashBytes(bytes), 'windows-1252'), undefined, 'one plan per URL');
});
