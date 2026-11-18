/**
 * The WebAssembly outline (../css-outline-wasm.ts) against css-outline.ts's:
 *
 *   node --expose-gc outline-wasm.bench.ts [--fragments <n>] [--chrome]
 *
 * Checks every field of both outlines on the four materials and on `--fragments` random fragments
 * per seed (200,000 by default), then reports time, allocation (with --expose-gc), wasm memory per
 * code unit and the module's size. With `--chrome`, also times both in headless Chrome
 * (puppeteer-core, the installed Chrome).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cacheDir, materials } from './materials.ts';
import { fragment, outlineDiff, random } from './outline-fragments.ts';

const { values } = parseArgs({
  options: { fragments: { type: 'string', default: '200000' }, chrome: { type: 'boolean', default: false } },
});

const ENTRY = [
  "export { outline, outlineWasm } from '../css-outline-wasm';",
  "export { outline as outlineTs } from '../css-outline';",
  "export { wasmExports, ownInstance } from '../css-lexer-wasm';",
].join('\n');
type B = typeof import('../css-outline-wasm.ts') &
  Pick<typeof import('../css-lexer-wasm.ts'), 'wasmExports' | 'ownInstance'> & {
    outlineTs: typeof import('../css-outline.ts').outline;
  };

const { build } = await import('esbuild');
mkdirSync(cacheDir, { recursive: true });
const bundle = (format: 'esm' | 'iife', outfile: string) =>
  build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true,
    format,
    globalName: '__B',
    platform: 'neutral',
    outfile,
    logLevel: 'error',
  });
const esm = `${cacheDir}outline-wasm.mjs`;
await bundle('esm', esm);
const B = (await import(pathToFileURL(esm).href)) as B;
const w = B.wasmExports();
if (!w) throw new Error('the module did not compile');
const mats = await materials();

let checked = 0;
const check = (text: string) => {
  // Short texts too, though `outline` keeps them in TypeScript.
  const diff = outlineDiff(B.outlineWasm(w, text), B.outlineTs(text));
  if (diff) throw new Error(`${diff} for ${JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}…` : text)}`);
  checked++;
};
for (const m of mats) check(m.text);
const fragments = Number(values.fragments);
if (!Number.isInteger(fragments) || fragments < 1) {
  throw new Error(`--fragments wants a positive integer, got ${values.fragments}`);
}
for (const seed of [1, 987654321]) {
  const r = random(seed);
  for (let i = 0; i < fragments; i++) check(fragment(r));
}
console.log(`same outline on ${checked} texts (4 materials, ${fragments} fragments for each of seeds 1, 987654321)`);

const time = (f: () => unknown, text: string) => {
  const runs = Math.max(20, Math.min(400, Math.round(3e7 / text.length)));
  for (let i = 0; i < 20; i++) f();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  return t[t.length >> 1] as number;
};
const gc = (globalThis as { gc?: () => void }).gc;
/** Bytes one call adds to the heap and to array buffers before any collection, the most of five. */
const alloc = (f: () => unknown) => {
  if (!gc) return NaN;
  let most = 0;
  for (let k = 0; k < 5; k++) {
    gc();
    const a = process.memoryUsage();
    f();
    const b = process.memoryUsage();
    most = Math.max(most, b.heapUsed - a.heapUsed + (b.arrayBuffers - a.arrayBuffers));
  }
  return most;
};
/** Where the text starts in the module's memory: what is before is the lexer's tables. */
const IN = 0x20000;
const rows = [
  '| Material | TS ms | wasm ms | TS alloc MB | wasm alloc MB | wasm B/unit |',
  '| --- | --: | --: | --: | --: | --: |',
];
for (const m of mats) {
  const t = m.text;
  // Memory a new instance grows to for this text alone.
  const fresh = B.ownInstance();
  B.outlineWasm(fresh, t);
  rows.push(
    `| ${m.name} | ${time(() => B.outlineTs(t), t).toFixed(3)} | ${time(() => B.outline(t), t).toFixed(3)} | ` +
      `${(alloc(() => B.outlineTs(t)) / 1e6).toFixed(2)} | ${(alloc(() => B.outline(t)) / 1e6).toFixed(2)} | ` +
      `${((fresh.m.buffer.byteLength - IN) / t.length).toFixed(1)} |`
  );
}
console.log(`Node ${process.version}\n${rows.join('\n')}`);

const wasmBytes = (file: string) =>
  Buffer.from(
    readFileSync(new URL(file, import.meta.url), 'utf8').match(/'([A-Za-z0-9+/=]{100,})'/)?.[1] ?? '',
    'base64'
  ).length;
console.log(`module: ${wasmBytes('../css-wasm-bytes.ts')} bytes`);

if (values.chrome) {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage();
  const iife = `${cacheDir}outline-wasm.iife.js`;
  await bundle('iife', iife);
  await page.evaluate(`${readFileSync(iife, 'utf8')};globalThis.__B = __B;`);
  const out = ['| Material | TS ms | wasm ms |', '| --- | --: | --: |'];
  for (const m of mats) {
    const [ts, wasm] = (await page.evaluate((text: string) => {
      const B = (globalThis as unknown as { __B: B }).__B;
      const time = (f: () => unknown) => {
        const runs = Math.max(20, Math.min(400, Math.round(3e7 / text.length)));
        for (let i = 0; i < 20; i++) f();
        const t: number[] = [];
        for (let i = 0; i < runs; i++) {
          const a = performance.now();
          f();
          t.push(performance.now() - a);
        }
        t.sort((x, y) => x - y);
        return t[t.length >> 1] as number;
      };
      return [time(() => B.outlineTs(text)), time(() => B.outline(text))];
    }, m.text)) as [number, number];
    out.push(`| ${m.name} | ${ts.toFixed(3)} | ${wasm.toFixed(3)} |`);
  }
  console.log(`Chrome ${await browser.version()}\n${out.join('\n')}`);
  await browser.close();
}
