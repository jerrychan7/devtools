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
/**
 * The `debugger` statements the working tree's own token list gives, by the rules of
 * debuggerStatementSites: a word `debugger` (escapes decoded) not in a class body, not after `.`
 * or `#`, and not before `:` or a `(` on the same line.
 */
function derivedSites(text: string, module: boolean): { start: number; semicolon: boolean }[] {
  const flat = flatTokens(need(work.entries['tokenize'])(text, module));
  const punct = (k: number, ch: string) => flat[k * 6] === 1 && text[need(flat[k * 6 + 1])] === ch;
  const sites: { start: number; semicolon: boolean }[] = [];
  for (let k = 0; k * 6 < flat.length; k++) {
    const [kind, start, end, , parent] = flat.slice(k * 6, k * 6 + 5) as [number, number, number, number, number];
    if (kind !== 0 || parent === 4 /* Open.ClassBrace */) continue;
    const word = text
      .slice(start, end)
      .replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (escape, braced, plain) => {
        const code = Number.parseInt(typeof braced === 'string' ? braced : String(plain), 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
      });
    if (word !== 'debugger' || (k > 0 && punct(k - 1, '.')) || text[start - 1] === '#') continue;
    if (punct(k + 1, ':') || (punct(k + 1, '(') && flat[(k + 1) * 6 + 5] === 0)) continue;
    sites.push({ start, semicolon: punct(k + 1, ';') });
  }
  return sites;
}

/**
 * Before the fix of `-->` in debugger mode, debuggerStatementSites took `-->` anywhere in a script
 * for a comment. A revision's sites may differ from the working tree's only on a script with `-->`,
 * and only when the working tree's agree with its own token list.
 */
let knownDifferences = 0;
function knownDifference(entry: string, text: string, module: boolean): boolean {
  if (module || !text.includes('-->') || (entry !== 'debuggerStatementSites' && entry !== 'debuggerStatements'))
    return false;
  const derived = derivedSites(text, module);
  const sites = need(work.entries['debuggerStatementSites'])(text, module);
  if (JSON.stringify(sites) !== JSON.stringify(derived)) return false;
  knownDifferences++;
  return true;
}

function same(text: string, entries = ALL, modules = [false, true]): void {
  for (const module of modules) {
    // The working tree's debugger sites against its own token list, whatever the revision.
    if (entries.includes('debuggerStatementSites')) {
      const a = JSON.stringify(derivedSites(text, module));
      const b = JSON.stringify(need(work.entries['debuggerStatementSites'])(text, module));
      if (a !== b)
        throw new Error(
          `debuggerStatementSites (${module ? 'module' : 'script'}) disagrees with the token list for ${JSON.stringify(text.slice(0, 300))}\n  tokens: ${a}\n  sites: ${b}`
        );
    }
    for (const entry of entries) {
      const a = JSON.stringify(need(base.normalized[entry])(text, module));
      const b = JSON.stringify(need(work.normalized[entry])(text, module));
      if (a !== b && !knownDifference(entry, text, module)) {
        const shown = JSON.stringify(text.length > 300 ? text.slice(0, 300) + '…' : text);
        const at = [...a].findIndex((ch, i) => ch !== b[i]);
        throw new Error(
          `${entry} (${module ? 'module' : 'script'}) of the working tree differs from ${base.label} for ${shown}\n` +
            `  ${base.label}: …${a.slice(Math.max(0, at - 80), at + 80)}\n  worktree: …${b.slice(Math.max(0, at - 80), at + 80)}`
        );
      }
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
if (knownDifferences > 0)
  console.log(
    `${knownDifferences.toLocaleString('en')} results differ only where ${base.label} took a \`-->\` not at the start of a line for a comment in debugger mode (fixed since); the working tree's agree with its token list.`
  );
