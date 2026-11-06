/**
 * Checks that the working tree's CSS lexer gives exactly the tokens the lexer at another revision
 * gives: on each material, on every UTF-16 code unit after a set of prefixes, and on random
 * fragments built from the cases tokenizing gets wrong most easily. See README.md.
 *
 *   node lexer-compare.bench.ts --rev <git revision> [--seed <n>]... [--fragments <n>]
 */
import { parseArgs } from 'node:util';
import { loadLexer, type Tokens } from './load-lexer.ts';
import { materials } from './materials.ts';

const { values } = parseArgs({
  options: {
    rev: { type: 'string' },
    seed: { type: 'string', multiple: true, default: ['1', '987654321'] },
    fragments: { type: 'string', default: '1000000' },
  },
});
if (!values.rev) throw new Error('--rev <git revision> is required');
const base = await loadLexer(values.rev);
const work = await loadLexer();

let checked = 0;
function same(text: string): void {
  const a: Tokens = base.tokenize(text);
  const b: Tokens = work.tokenize(text);
  const fail = (what: string) => {
    throw new Error(
      `${what} differ from ${base.label} for ${JSON.stringify(text.length > 200 ? text.slice(0, 200) + '…' : text)}`
    );
  };
  if (a.kinds.length !== b.kinds.length || a.starts.length !== b.starts.length) fail('token counts');
  for (let i = 0; i < a.kinds.length; i++) if (a.kinds[i] !== b.kinds[i]) fail(`kinds at token ${i}`);
  for (let i = 0; i < a.starts.length; i++) if (a.starts[i] !== b.starts[i]) fail(`starts at token ${i}`);
  if (b.starts.length !== b.kinds.length + 1 || b.starts[b.kinds.length] !== text.length) fail('the end');
  checked++;
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
for (const seedArg of values.seed) {
  let s = Number(seedArg) >>> 0 || 1;
  const r = (n: number) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
  for (let i = 0, n = Number(values.fragments); i < n; i++) {
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
console.log(`same tokens as ${base.label} on ${checked} texts (seeds ${values.seed.join(', ')})`);
