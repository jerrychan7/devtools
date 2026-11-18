/**
 * Times the JavaScript lexer's public entry points on each material, for the working tree and for
 * any older revisions, and reports code units read and memory. See README.md.
 *
 *   node --expose-gc lexer.bench.ts [--rev <git revision>]... [--entry <name>]... [--material <name>]... [--runs <n>]
 */
import { parseArgs } from 'node:util';
import { type Entry, type Lexer, loadLexer, need, readOnly } from './load-lexer.ts';
import { materials } from './materials.ts';

const { values } = parseArgs({
  options: {
    rev: { type: 'string', multiple: true, default: [] },
    entry: {
      type: 'string',
      multiple: true,
      default: ['tokenize', 'debuggerStatementSites', 'topLevelLexicalNames', 'returnOutsideFunction', 'repl'],
    },
    material: { type: 'string', multiple: true },
    runs: { type: 'string', default: '1' },
  },
});

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) console.warn('Run with --expose-gc for the memory columns.');

const revs = values.rev;
// One at a time: a lexer's files are written to its directory, then imported from there.
const timed: Lexer[] = [];
const counted: Lexer[] = [];
for (const rev of [undefined, ...revs]) timed.push(await loadLexer(rev));
for (const rev of [undefined, ...revs]) counted.push(await loadLexer(rev, true));

const mb = (bytes: number) => (bytes / 1e6).toFixed(2);
const ms = (t: number) => (t >= 10 ? t.toFixed(1) : t >= 1 ? t.toFixed(2) : t.toFixed(3));

interface Time {
  median: number;
  min: number;
}

/**
 * Median and minimum of each function's time on `text`. The functions take turns sample by sample,
 * so that a busy machine slows them all alike.
 */
function time(fs: Entry[], text: string): Time[] {
  // About 50 MB of text per function, at least 10 samples; a short text runs 100 times per sample.
  const inner = text.length < 10_000 ? 100 : 1;
  const samples = Math.max(10, Math.min(2000, Math.ceil(5e7 / text.length / inner)));
  for (const f of fs) for (let i = 0; i < Math.min(samples, 20); i++) for (let k = 0; k < inner; k++) f(text, false);
  const t: number[][] = fs.map(() => []);
  for (let i = 0; i < samples; i++)
    fs.forEach((f, j) => {
      // A large text's garbage would be collected during the next sample: start each one clean.
      if (gc && text.length >= 1e6) gc();
      const a = performance.now();
      for (let k = 0; k < inner; k++) f(text, false);
      need(t[j]).push((performance.now() - a) / inner);
    });
  return t.map(s => {
    s.sort((a, b) => a - b);
    return { median: need(s[s.length >> 1]), min: need(s[0]) };
  });
}

/** The JS heap and the typed arrays' buffers, which live outside it. */
const used = () => {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};

/** Memory growth over one call before any collection (most of three), and what its result keeps. */
function memory(f: Entry, text: string): { alloc: string; kept: string } {
  if (!gc) return { alloc: '', kept: '' };
  let alloc = 0;
  let kept = 0;
  // Typed arrays' buffers are freed after their collection: collect twice to see them gone.
  const collect = () => {
    gc();
    gc();
  };
  for (let i = 0; i < 3; i++) {
    collect();
    const h0 = used();
    let result: unknown = f(text, false);
    alloc = Math.max(alloc, used() - h0);
    collect();
    kept = Math.max(kept, used() - h0);
    if (result === Symbol.iterator) console.log(result);
    result = undefined;
  }
  return { alloc: mb(alloc), kept: mb(Math.max(0, kept)) };
}

for (let run = 0; run < Number(values.runs); run++) {
  for (const m of materials()) {
    if (values.material && !values.material.includes(m.name)) continue;
    console.log(`\n## ${m.name}: ${m.text.length.toLocaleString('en')} code units (${m.about})\n`);
    console.log('| Entry | Lexer | median ms | min ms | reads/unit | MB alloc | MB kept |');
    console.log('| --- | --- | --: | --: | --: | --: | --: |');
    for (const entry of values.entry) {
      const fs = timed.map(l => need(l.entries[entry]));
      const times = time(fs, m.text);
      timed.forEach((lexer, l) => {
        const c = need(counted[l]);
        const before = c.reads();
        need(c.entries[entry])(m.text, false);
        const reads = ((c.reads() - before) / m.text.length).toFixed(2);
        const { alloc, kept } = memory(need(fs[l]), m.text);
        const { median, min } = need(times[l]);
        console.log(
          `| ${l === 0 ? entry : ''} | ${lexer.label} | ${ms(median)} | ${ms(min)} | ${reads} | ${alloc} | ${kept} |`
        );
      });
    }
    const [floor] = time([readOnly], m.text) as [Time];
    console.log(`| read-only floor | | ${ms(floor.median)} | ${ms(floor.min)} | 1.00 | | |`);
  }
}
