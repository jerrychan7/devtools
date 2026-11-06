import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { tokenize as tokenizeTs } from './css-lexer.ts';
import { LEXER_WASM } from './css-lexer-wasm-bytes.ts';
import { build } from './wasm-gen/lexer.ts';

type WasmModule = typeof import('./css-lexer-wasm.ts');

// Bundled: the sources import each other without extensions, which Node does not resolve. Each
// call evaluates a new copy, with its own compiled module or its own failure to compile.
const bundled = await bundle({
  stdin: {
    contents: "export * from './css-lexer-wasm.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
let copies = 0;
const load = async (): Promise<WasmModule> =>
  import(
    `data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0]?.text ?? ''}\n// ${copies++}`).toString('base64')}`
  );

const texts = [
  '',
  'a',
  '.btn-1, .card .title:not(.x) { font: 14px/1.5 "Helvetica Neue", sans-serif; width: calc(100% - 2rem) }',
  '@media (min-width: 600px) { a { background: url( x.png ) } } <!-- --> /* c */ #id -1e+3px +.5% --x:\\31 a;',
  'a { b: url(a b); c: "x\\\n y"; d: "bad\n; e: \\fffff z; content: "é" } é\0\r\n\f\\',
  '/* unclosed',
];
/** Long enough for `tokenize` to use the module, ASCII and not. */
const long = texts.join('\n').repeat(40);

test('the generated module is that of wasm-gen/lexer.ts', () => {
  assert.equal(LEXER_WASM, Buffer.from(build()).toString('base64'), 'run `node wasm-gen/lexer.ts`');
});

test('the same tokens as the TypeScript lexer, copied in as bytes or as UTF-16', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  // ASCII in chunks of 0x4000 code units: past ASCII in a later chunk, at the very end, and a
  // surrogate pair split across two chunks, after ASCII chunks to widen in place.
  const ascii = 'a { b: c } .d-1 '.repeat(0x1000);
  const chunked = [`${ascii}é${ascii}`, `${ascii}\u{1f600}`, `${ascii.slice(0, 0x4000 * 2 - 1)}\u{1f600}${ascii}`];
  for (const text of [...texts, long, long.replace(/é/g, 'e'), 'x'.repeat(200000), ...chunked]) {
    const expected = tokenizeTs(text);
    for (const wide of [false, true]) {
      const at = mod.copyIn(w, text, wide);
      assert.equal(at.narrow, !wide && !/[^\0-\x7f]/.test(text));
      const got = mod.copyOut(w, at, mod.lex(w, at));
      assert.deepEqual([...got.kinds], [...expected.kinds], JSON.stringify(text.slice(0, 80)));
      assert.deepEqual([...got.starts], [...expected.starts]);
    }
    assert.deepEqual(mod.tokenize(text), expected);
  }
});

test('a large text has an instance of its own, and the shared memory does not grow', async () => {
  const mod = await load();
  const w = mod.wasmExports();
  assert.ok(w);
  mod.tokenize(long);
  const before = w.m.buffer.byteLength;
  const large = 'a { b: c } .d-1 '.repeat(Math.ceil(mod.OWN_INSTANCE_LENGTH / 16));
  assert.ok(large.length >= mod.OWN_INSTANCE_LENGTH);
  assert.deepEqual(mod.tokenize(large), tokenizeTs(large));
  assert.equal(w.m.buffer.byteLength, before);
});

test('falls back to the TypeScript lexer where WebAssembly does not compile', async t => {
  // As under a CSP without 'wasm-unsafe-eval', where compiling throws.
  t.mock.method(WebAssembly, 'Module', function () {
    throw new WebAssembly.CompileError('Refused to compile or instantiate WebAssembly module');
  });
  const mod = await load();
  assert.equal(mod.wasmAvailable(), false);
  assert.deepEqual(mod.tokenize(long), tokenizeTs(long));
});
