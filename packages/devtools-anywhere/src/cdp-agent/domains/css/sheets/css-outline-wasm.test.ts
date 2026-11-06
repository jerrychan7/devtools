import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { materials } from './bench/materials.ts';
import { fragment, outlineDiff, random } from './bench/outline-fragments.ts';
import type { CssOutline } from './css-outline.ts';

type Module = typeof import('./css-outline-wasm.ts') &
  Pick<typeof import('./css-lexer-wasm.ts'), 'wasmExports' | 'wasmAvailable' | 'OWN_INSTANCE_LENGTH'> & {
    outlineTs: typeof import('./css-outline.ts').outline;
  };

// Bundled, as css-lexer-wasm.test.ts does: each call evaluates a new copy, with its own compiled
// module or its own failure to compile. (The module's freshness is checked there.)
const bundled = await bundle({
  stdin: {
    contents: [
      "export * from './css-outline-wasm.ts';",
      "export { wasmExports, wasmAvailable, OWN_INSTANCE_LENGTH } from './css-lexer-wasm.ts';",
      "export { outline as outlineTs } from './css-outline.ts';",
    ].join('\n'),
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
let copies = 0;
const load = async (): Promise<Module> =>
  import(
    `data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0]?.text ?? ''}\n// ${copies++}`).toString('base64')}`
  );

const show = (text: string) => JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
const same = (text: string, got: CssOutline, expected: CssOutline) =>
  assert.equal(outlineDiff(got, expected), '', show(text));

test('the same outline as css-outline.ts on the four materials, as bytes and as UTF-16', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  for (const m of await materials(true)) {
    const expected = mod.outlineTs(m.text);
    same(m.text, mod.outlineWasm(w, m.text), expected);
    same(m.text, mod.outline(m.text), expected);
    // Not ASCII: copied in as UTF-16.
    const wide = `${m.text}\n/* é */`;
    same(wide, mod.outlineWasm(w, wide), mod.outlineTs(wide));
  }
});

test('the same outline as css-outline.ts on random fragments', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  // Fixed seeds: a failure is the same on every run. bench/outline-wasm.bench.ts runs more.
  for (const seed of [1, 987654321]) {
    const r = random(seed);
    for (let i = 0; i < 20000; i++) {
      const text = fragment(r);
      // Whatever the length: short texts are compared too, though `outline` keeps them in TypeScript.
      same(text, mod.outlineWasm(w, text), mod.outlineTs(text));
    }
  }
});

test('brackets nested deep take memory, not the call stack', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  for (const n of [1000, 100000, 1000000]) {
    for (const text of [
      `a { b: ${'('.repeat(n)} } c { d: e }`,
      `a { b: ${'f(['.repeat(n)}${')]'.repeat(n)}; c: d }`,
      `@media ${'['.repeat(n)} { a { b: c } }`,
      `/* b: ${'('.repeat(n)} */`,
      `a { /* b: ${'('.repeat(n)} */ }`,
    ]) {
      same(text, mod.outlineWasm(w, text), mod.outlineTs(text));
      same(text, mod.outline(text), mod.outlineTs(text));
    }
  }
});

test('blocks nested too deep for the call stack fall back to css-outline.ts', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  // Deep enough for the module's stack, which overflows before JavaScript's.
  let n = 1000;
  for (; n < 1e7; n *= 2) {
    try {
      mod.outlineWasm(w, `${'a{'.repeat(n)}b:c`);
    } catch (e) {
      assert.ok(e instanceof RangeError, String(e));
      break;
    }
  }
  assert.ok(n < 1e7, 'the module never overflowed');
  const text = `${'a{'.repeat(n)}b:c`;
  let expected: CssOutline | Error;
  try {
    expected = mod.outlineTs(text);
  } catch (e) {
    expected = e as Error;
  }
  if (expected instanceof Error) assert.throws(() => mod.outline(text), RangeError);
  else same(text, mod.outline(text), expected);
  // The instance is still good after the overflow.
  const after = 'a { b: c } @media x { d { e: f } }'.repeat(4);
  same(after, mod.outlineWasm(w, after), mod.outlineTs(after));
});

test('memory that cannot grow falls back to css-outline.ts', async t => {
  const mod = await load();
  assert.ok(mod.wasmAvailable());
  t.mock.method(WebAssembly.Memory.prototype, 'grow', function () {
    throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
  });
  const text = 'a { b: c } .d-1 { e: f; /* g: h */ }\n'.repeat(20000);
  same(text, mod.outline(text), mod.outlineTs(text));
});

test('a large text has an instance of its own, and the shared memory does not grow', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  const small = 'a { b: c } .d-1 { e: f }\n'.repeat(100);
  mod.outline(small);
  const before = w.m.buffer.byteLength;
  const large = 'a { b: c } .d-1 { e: f }\n'.repeat(Math.ceil(mod.OWN_INSTANCE_LENGTH / 25));
  same(large, mod.outline(large), mod.outlineTs(large));
  assert.equal(w.m.buffer.byteLength, before);
});

test('falls back to css-outline.ts where WebAssembly does not compile', async t => {
  // As under a CSP without 'wasm-unsafe-eval', where compiling throws.
  t.mock.method(WebAssembly, 'Module', function () {
    throw new WebAssembly.CompileError('Refused to compile or instantiate WebAssembly module');
  });
  const mod = await load();
  const text = 'a { b: c } @media x { d { e: f; /* g: h */ } }'.repeat(10);
  same(text, mod.outline(text), mod.outlineTs(text));
  assert.equal(mod.wasmAvailable(), false);
});
