/**
 * Checks that the working tree's CSS lexer gives exactly the tokens the lexer at another revision
 * gives: on each material, on every UTF-16 code unit after a set of prefixes, and on random
 * fragments built from the cases tokenizing gets wrong most easily. See README.md.
 *
 *   node lexer-compare.bench.ts --rev <git revision> [--wasm] [--seed <n>]... [--fragments <n>]
 *
 * With `--wasm`, the lexer checked is the WebAssembly one (css-lexer-wasm.ts) instead of the
 * working tree's TypeScript one, on every text whatever its length, once with ASCII texts copied
 * in as bytes and once with every text copied in as UTF-16.
 */
import { parseArgs } from 'node:util';
import { loadLexer, loadWasmLexers, type Lexer, type Tokens } from './load-lexer.ts';
import { materials } from './materials.ts';

const { values } = parseArgs({
  options: {
    rev: { type: 'string' },
    seed: { type: 'string', multiple: true, default: ['1', '987654321'] },
    fragments: { type: 'string', default: '1000000' },
    wasm: { type: 'boolean', default: false },
  },
});
if (!values.rev) throw new Error('--rev <git revision> is required');
const base = await loadLexer(values.rev);
const works: Lexer[] = values.wasm
  ? (await loadWasmLexers()).filter(l => l.label === 'wasm' || l.label === 'wasm utf16')
  : [await loadLexer()];

let checked = 0;
function same(text: string): void {
  for (const work of works) sameAs(work, text);
  checked++;
}
function sameAs(work: Lexer, text: string): void {
  const a: Tokens = base.tokenize(text);
  const b: Tokens = work.tokenize(text);
  const fail = (what: string) => {
    throw new Error(
      `${what} of ${work.label} differ from ${base.label} for ${JSON.stringify(text.length > 200 ? text.slice(0, 200) + '…' : text)}`
    );
  };
  if (a.kinds.length !== b.kinds.length || a.starts.length !== b.starts.length) fail('token counts');
  for (let i = 0; i < a.kinds.length; i++) if (a.kinds[i] !== b.kinds[i]) fail(`kinds at token ${i}`);
  for (let i = 0; i < a.starts.length; i++) if (a.starts[i] !== b.starts[i]) fail(`starts at token ${i}`);
  if (b.starts.length !== b.kinds.length + 1 || b.starts[b.kinds.length] !== text.length) fail('the end');
}

for (const m of await materials()) same(m.text);

// Every code unit, alone and after prefixes that change what it can start or continue.
const prefixes = ['', 'a', '-', '--', '\\', '#', '@', '.', '+', '1', '1e', 'url(', '"', '/*', '<!-', 'u'];
for (const prefix of prefixes) for (let c = 0; c < 0x10000; c++) same(prefix + String.fromCharCode(c) + 'x');

// Random fragments: xorshift32, so a seed gives the same fragments everywhere.
const pieces = [
  'url(',
  'URL( ',
  'uRl(',
  'var(--a)',
  '-->',
  '<!--',
  '/*',
  '*/',
  '\\',
  '\\\n',
  '\\0',
  '\\fffff ',
  '1e+',
  '.5',
  '+.',
  '-.',
  '--',
  '-\\',
  '-1',
  '@-',
  '#-',
  '#\\',
  '\r\n',
  '\f',
  'ab',
  '0x',
  'U+',
  '"',
  "'",
  '%',
];
const fragments = Number(values.fragments);
if (!Number.isInteger(fragments) || fragments < 1) {
  throw new Error(`--fragments wants a positive integer, got ${values.fragments}`);
}
for (const seedArg of values.seed) {
  // xorshift32 stays at 0 forever, so a seed must be an integer that is not 0 modulo 2^32.
  let s = Number(seedArg) >>> 0;
  if (!Number.isInteger(Number(seedArg)) || s === 0) throw new Error(`--seed wants a nonzero integer, got ${seedArg}`);
  const r = (n: number) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
  for (let i = 0; i < fragments; i++) {
    let t = '';
    for (let j = r(40); j > 0; j--) {
      const m = r(10);
      if (m < 4) t += String.fromCharCode(r(128));
      else if (m < 5) t += String.fromCharCode(r(0x10000));
      else if (m < 6) t += String.fromCharCode(0xd800 + r(0x800));
      else t += pieces[r(pieces.length)];
    }
    same(t);
  }
}
console.log(
  `${works.map(w => w.label).join(' and ')}: same tokens as ${base.label} on ${checked} texts (seeds ${values.seed.join(', ')})`
);
