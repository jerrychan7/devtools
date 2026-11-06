/**
 * Times the CSS lexer on each material, counts the code units it reads, and measures the memory of
 * its result. See README.md.
 *
 *   node --expose-gc lexer.bench.ts [--rev <git revision>]... [--runs <n>]
 *
 * Each `--rev` adds a row for the lexer at that revision; the working tree's and a read-only floor
 * are always measured. Without `--expose-gc` the memory columns are left out.
 */
import { parseArgs } from 'node:util';
import { loadLexer, readOnly, type Lexer } from './load-lexer.ts';
import { materials } from './materials.ts';

const { values } = parseArgs({
  options: { rev: { type: 'string', multiple: true, default: [] }, runs: { type: 'string', default: '1' } },
});
const runs = Number(values.runs);
const gc = (globalThis as { gc?: () => void }).gc;

const mats = await materials();
const lexers: Lexer[] = [await loadLexer(), ...(await Promise.all(values.rev.map(rev => loadLexer(rev))))];
const counting = [
  await loadLexer(undefined, true),
  ...(await Promise.all(values.rev.map(rev => loadLexer(rev, true)))),
];

/** Median and minimum of `rounds` timed runs, after warming up. */
function time(lexer: Lexer, text: string): [number, number] {
  const rounds = Math.max(20, Math.min(600, Math.round(2e7 / text.length)));
  for (let i = 0; i < 20; i++) lexer.tokenize(text);
  const ts: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const a = performance.now();
    lexer.tokenize(text);
    ts.push(performance.now() - a);
  }
  ts.sort((a, b) => a - b);
  return [ts[ts.length >> 1] ?? NaN, ts[0] ?? NaN];
}

const heap = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

/**
 * Bytes per token the result keeps once garbage is collected, and bytes per token one run adds to
 * the heap before any collection (its result and its garbage): the most of five runs.
 */
function memory(lexer: Lexer, text: string, tokens: number): [number, number] {
  if (!gc) return [NaN, NaN];
  // Ten results are kept at once so that the heap's own noise weighs a tenth as much; collected
  // twice, as a first collection can leave garbage that a second one still finds.
  gc();
  gc();
  const before = heap();
  const kept = Array.from({ length: 10 }, () => lexer.tokenize(text));
  gc();
  gc();
  const retained = (heap() - before) / kept.length;
  let peak = 0;
  for (let i = 0; i < 5; i++) {
    gc();
    const start = heap();
    lexer.tokenize(text);
    peak = Math.max(peak, heap() - start);
  }
  void kept;
  return [retained / tokens, peak / tokens];
}

const ms = (n: number) => (n < 1 ? n.toFixed(3) : n.toFixed(1));
console.log(
  `Node ${process.version}, ${process.platform} ${process.arch}${gc ? '' : ' (no --expose-gc: memory not measured)'}`
);
for (let run = 1; run <= runs; run++) {
  if (runs > 1) console.log(`\nrun ${run} of ${runs}`);
  for (const m of mats) {
    console.log(`\n${m.name}: ${m.about}, ${m.text.length} code units`);
    console.log('  lexer             tokens    median ms   min ms   reads/unit   B/token kept   B/token alloc');
    for (const [i, lexer] of [...lexers, readOnly].entries()) {
      const tokens = lexer.tokenize(m.text).kinds.length;
      const [median, min] = time(lexer, m.text);
      const counter = counting[i];
      let reads = '';
      if (counter) {
        const before = counter.reads();
        counter.tokenize(m.text);
        reads = ((counter.reads() - before) / m.text.length).toFixed(2);
      }
      const [kept, peak] = lexer === readOnly ? [NaN, NaN] : memory(lexer, m.text, tokens);
      console.log(
        `  ${lexer.label.padEnd(16)} ${String(tokens).padStart(7)}   ${ms(median).padStart(9)}  ${ms(min).padStart(7)}   ${reads.padStart(10)}   ${(Number.isNaN(kept) ? '' : kept.toFixed(2)).padStart(12)}   ${(Number.isNaN(peak) ? '' : peak.toFixed(2)).padStart(12)}`
      );
    }
  }
}
