/**
 * Checks that every public entry point of the working tree's JavaScript lexer gives exactly what
 * the lexer at another revision gives, in scripts and in modules: on each material, on real code
 * from node_modules, on the snippets of lexer.test.ts, on every UTF-16 code unit after a set of
 * prefixes, and on random fragments built from the cases lexing gets wrong most easily. See README.md.
 *
 *   node lexer-compare.bench.ts --rev <git revision> [--seed <n>]... [--fragments <n>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { flatTokens, loadLexer, need } from './load-lexer.ts';
import { materials } from './materials.ts';

const { values } = parseArgs({
  options: {
    rev: { type: 'string' },
    seed: { type: 'string', multiple: true, default: ['1', '987654321'] },
    fragments: { type: 'string', default: '200000' },
  },
});
if (values.rev === undefined) throw new Error('--rev <git revision> is required');
const base = await loadLexer(values.rev);
const work = await loadLexer();
const ALL = Object.keys(work.normalized);

let checked = 0;
function same(text: string, entries = ALL, modules = [false, true]): void {
  for (const module of modules)
    for (const entry of entries) {
      const a = JSON.stringify(need(base.normalized[entry])(text, module));
      const b = JSON.stringify(need(work.normalized[entry])(text, module));
      if (a !== b) {
        const shown = JSON.stringify(text.length > 300 ? text.slice(0, 300) + '…' : text);
        const at = [...a].findIndex((ch, i) => ch !== b[i]);
        throw new Error(
          `${entry} (${module ? 'module' : 'script'}) of the working tree differs from ${base.label} for ${shown}\n` +
            `  ${base.label}: …${a.slice(Math.max(0, at - 80), at + 80)}\n  worktree: …${b.slice(Math.max(0, at - 80), at + 80)}`
        );
      }
    }
  checked++;
}

const t0 = performance.now();
const report = (what: string) =>
  console.log(
    `${what}: same (${checked.toLocaleString('en')} texts so far, ${((performance.now() - t0) / 1000).toFixed(0)} s)`
  );

for (const m of materials()) same(m.text);
report('materials');

// Real code: what lexer.test.ts compares with acorn, and the repository's own lexer.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const corpus: string[] = [];
function collect(dir: string, limit: number) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (corpus.length >= limit) return;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path, limit);
    else if (/\.(c|m)?js$/.test(name) && statSync(path).size < 2_000_000) corpus.push(path);
  }
}
collect(join(here, '../../../../../../es-module-lexer.ignore/test/samples'), 40);
collect(join(dirname(require.resolve('acorn/package.json')), 'dist'), 80);
collect(join(dirname(require.resolve('puppeteer-core/package.json')), 'lib/esm'), 400);
for (const file of corpus) same(readFileSync(file, 'utf8'));
same(readFileSync(join(here, '../lexer.ts'), 'utf8'));
report(`${corpus.length} files of real code`);

// The snippets of lexer.test.ts: its string literals, found with the lexer at --rev.
const testSource = readFileSync(join(here, '../lexer.test.ts'), 'utf8');
const flat = flatTokens(need(base.entries['tokenize'])(testSource, true));
let snippets = 0;
for (let i = 0; i < flat.length; i += 6) {
  if (flat[i] !== 2) continue;
  const raw = testSource.slice(flat[i + 1], flat[i + 2]);
  const value = new Function(`return ${raw}`)() as string;
  same(value);
  snippets++;
}
report(`${snippets} snippets of lexer.test.ts`);

// Every code unit, after prefixes that change what it can start, end or continue.
const prefixes = [
  '',
  'a',
  'a /',
  'x = /',
  ')',
  '}',
  '`',
  '`${',
  '"',
  "'",
  '/*',
  '<!-',
  '\n--',
  'class ',
  'debugger',
  '\\u{',
];
for (const prefix of prefixes)
  for (let c = 0; c < 0x10000; c++)
    same(
      prefix + String.fromCharCode(c) + 'x',
      ['tokenize', 'debuggerStatementSites', 'topLevelLexicalNames'],
      [false]
    );
report('every code unit after 16 prefixes');

// Random fragments: xorshift32, so a seed gives the same fragments everywhere.
const pieces = [
  // Strings and templates, escapes and line continuations.
  "'a'",
  '"b\\"c"',
  "'\\\n'",
  '"\\\r\n"',
  "'open",
  '`t`',
  '`a${',
  '}b`',
  '${',
  '`\\``',
  '\\u{61}',
  '\\u0061',
  // Regular expressions and division.
  '/',
  '/=',
  '/re/g',
  '/[/]/',
  '/[\\]]/',
  '/a\\/b/',
  'a / b / c',
  ') /',
  '] /',
  '} /',
  'x++ /',
  'x-- /',
  '1. /',
  '/ 2',
  // Comments, HTML-like comments, hashbang.
  '//c',
  '/*c*/',
  '/*\n*/',
  '<!--',
  '-->',
  '\n-->',
  '#!',
  '#',
  '#debugger',
  // Line terminators and spaces.
  '\n',
  '\r',
  '\r\n',
  ' ',
  ' ',
  ' ',
  '\t',
  '\v',
  '\f',
  ' ',
  '﻿',
  '　',
  ' ',
  ' ',
  // Brackets.
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '{}',
  '()',
  '=>',
  ';',
  ',',
  '.',
  '...',
  ':',
  '?',
  '?.',
  '=',
  '+',
  '-',
  '++',
  '--',
  '!',
  '~',
  // Keywords that change what a `/` or a `{` is, and what the queries look for.
  'class',
  'class A',
  'extends',
  'let',
  'const',
  'var',
  'debugger',
  'd\\u0065bugger',
  'return',
  'new',
  'new.target',
  'target',
  'for',
  'of',
  'if',
  'while',
  'typeof',
  'break',
  'continue',
  'yield',
  'await',
  'case',
  'else',
  'do',
  'in',
  'instanceof',
  'void',
  'delete',
  'throw',
  'catch',
  'finally',
  'function',
  'async',
  'export',
  'default',
  'import',
  // Names and numbers.
  'a',
  'b',
  'x1',
  '$',
  '_',
  '0',
  '1e3',
  '.5',
  'é',
  '中',
  '😀',
  '\ud800',
  'ǅ',
];
const count = Number(values.fragments);
for (const seedText of values.seed) {
  let seed = Number(seedText) >>> 0 || 1;
  const next = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
  for (let n = 0; n < count; n++) {
    let s = '';
    const length = next() % 40;
    for (let k = 0; k < length; k++) {
      const r = next();
      if (r % 8 === 0) s += ' ';
      else if (r % 31 === 0) s += String.fromCharCode(next() % 0x10000);
      s += pieces[(r >>> 4) % pieces.length];
    }
    same(s);
  }
  report(`${count.toLocaleString('en')} random fragments, seed ${seedText}`);
}
console.log(`All ${checked.toLocaleString('en')} texts give the same results as ${base.label}.`);
