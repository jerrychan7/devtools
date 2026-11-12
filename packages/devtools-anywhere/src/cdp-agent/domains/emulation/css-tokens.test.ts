import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as Tokens from './css-tokens.ts';

// Bundled: the modules import each other without an extension, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export * from './css-tokens.ts';",
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { asciiLower, decodeEscapes, mapDeclarations, mapFunctions, splitMediaQueries, trimWhitespace } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof Tokens;

/** Runs mapDeclarations, recording each call of the hook. */
function declarations(block: string, answer: (property: string, value: string) => string | null = () => null) {
  const calls: [string, string][] = [];
  const out = mapDeclarations(block, (property, value) => {
    calls.push([property, value]);
    return answer(property, value);
  });
  return { out, calls };
}

/** Runs mapFunctions, recording each call of the hook as [name, args, whole]. */
function functions(
  text: string,
  names: readonly string[] = ['env'],
  answer: (name: string, args: string) => string | null = () => 'X'
) {
  const calls: [string, string, string][] = [];
  const out = mapFunctions(text, names, (name, args, whole) => {
    calls.push([name, args, whole]);
    return answer(name, args);
  });
  return { out, calls };
}

test('asciiLower lowercases ASCII letters only', () => {
  assert.equal(asciiLower('ENV-AbKÉ'), 'env-abKÉ');
});

test('decodeEscapes: one to six hex digits, and the one whitespace after them, are one code point', () => {
  assert.equal(decodeEscapes('\\61ll'), 'all');
  assert.equal(decodeEscapes('\\61 ll'), 'all');
  assert.equal(decodeEscapes('\\61\tll'), 'all');
  assert.equal(decodeEscapes('\\61\nll'), 'all');
  assert.equal(decodeEscapes('\\61\rll'), 'all');
  assert.equal(decodeEscapes('\\61\r\nll'), 'all');
  assert.equal(decodeEscapes('\\61\fll'), 'all');
  assert.equal(decodeEscapes('\\61  ll'), 'a ll');
  assert.equal(decodeEscapes('\\000061ll'), 'all');
  assert.equal(decodeEscapes('\\0000061ll'), '\u00061ll');
  assert.equal(decodeEscapes('\\1F600'), '\u{1F600}');
  assert.equal(decodeEscapes('\\41g'), 'Ag');
});

test('decodeEscapes: zero, a surrogate or a code point past U+10FFFF is U+FFFD', () => {
  assert.equal(decodeEscapes('\\0'), '\uFFFD');
  assert.equal(decodeEscapes('\\0 a'), '\uFFFDa');
  assert.equal(decodeEscapes('\\D800x'), '\uFFFDx');
  assert.equal(decodeEscapes('\\dfff'), '\uFFFD');
  assert.equal(decodeEscapes('\\110000'), '\uFFFD');
  assert.equal(decodeEscapes('\\10FFFF'), '\u{10FFFF}');
});

test('decodeEscapes: the code points on either side of the surrogates are kept', () => {
  assert.equal(decodeEscapes('\\D7FF'), '\uD7FF');
  assert.equal(decodeEscapes('\\E000'), '\uE000');
});

test('decodeEscapes: another escaped character stands for itself; a backslash at the end is U+FFFD', () => {
  assert.equal(decodeEscapes('a\\,b'), 'a,b');
  assert.equal(decodeEscapes('\\-\\-x'), '--x');
  assert.equal(decodeEscapes('\\\\'), '\\');
  assert.equal(decodeEscapes('\\\u00e9'), '\u00e9');
  assert.equal(decodeEscapes('\\\u{1F600}'), '\u{1F600}');
  assert.equal(decodeEscapes('a\\'), 'a\uFFFD');
});

test('decodeEscapes: an escape is decoded once, and text without a backslash is kept', () => {
  assert.equal(decodeEscapes('\\5c 61'), '\\61');
  assert.equal(decodeEscapes('print'), 'print');
  assert.equal(decodeEscapes(''), '');
});

test('the hook gets each declaration with its property and its trimmed value', () => {
  const block = 'color: red; --X:  Blue !important ;\tBACKGROUND :url(a.png)  ';
  const { out, calls } = declarations(block);
  assert.deepEqual(calls, [
    ['color', 'red'],
    ['--X', 'Blue !important'],
    ['background', 'url(a.png)'],
  ]);
  assert.equal(out, block);
});

test('a returned value replaces only the value; the rest is kept byte for byte', () => {
  const { out, calls } = declarations('  color :\tred /* c */ ;/* d */margin:0;;', property =>
    property === 'color' ? 'green' : null
  );
  assert.deepEqual(calls, [
    ['color', 'red'],
    ['margin', '0'],
  ]);
  assert.equal(out, '  color :\tgreen /* c */ ;/* d */margin:0;;');
});

test('a comment inside a value is part of it; comments around it are not', () => {
  const { calls } = declarations('color: /* a */ red /* b */ !important /* c */');
  assert.deepEqual(calls, [['color', 'red /* b */ !important']]);
});

test('declarations are split at top-level semicolons only', () => {
  const { calls } = declarations(
    'background: url(a;b.png); content: "x;y"; font: f(a;b) /* ; */; --v: {a;b}; color: red'
  );
  assert.deepEqual(calls, [
    ['background', 'url(a;b.png)'],
    ['content', '"x;y"'],
    ['font', 'f(a;b)'],
    ['--v', '{a;b}'],
    ['color', 'red'],
  ]);
});

test('malformed parts are left alone', () => {
  const { out, calls } = declarations('junk; : red; a b: c; color:; color: red; ;', () => 'X');
  assert.deepEqual(calls, [['color', 'red']]);
  assert.equal(out, 'junk; : red; a b: c; color:; color: X; ;');
});

test('a value that is only comments and whitespace is no value', () => {
  const { out, calls } = declarations('color: /* x */ ; margin: 0 /* y */', () => 'X');
  assert.deepEqual(calls, [['margin', '0']]);
  assert.equal(out, 'color: /* x */ ; margin: X /* y */');
});

test('comments before the name and before the colon are skipped', () => {
  const { out, calls } = declarations('/* a */ color /* b */ : red', () => 'blue');
  assert.deepEqual(calls, [['color', 'red']]);
  assert.equal(out, '/* a */ color /* b */ : blue');
});

test('a block that is not closed runs to the end of the list', () => {
  const { calls } = declarations('a: f(b; c: d');
  assert.deepEqual(calls, [['a', 'f(b; c: d']]);
});

test('escaped semicolons and colons in a value do not separate it', () => {
  const { calls } = declarations(
    'content: a\\;b; quotes: a\\:b; color: red; background: url(data:image/png;base64,AA)'
  );
  assert.deepEqual(calls, [
    ['content', 'a\\;b'],
    ['quotes', 'a\\:b'],
    ['color', 'red'],
    ['background', 'url(data:image/png;base64,AA)'],
  ]);
});

test('each call of a name is passed with its name, arguments and whole text', () => {
  const { out, calls } = functions('ENV(a) + env( b )');
  assert.equal(out, 'X + X');
  assert.deepEqual(calls, [
    ['env', 'a', 'ENV(a)'],
    ['env', ' b ', 'env( b )'],
  ]);
});

test('a name that only ends in the name, or starts with it, is another function', () => {
  const { out, calls } = functions('myenv(a) env2(b) url(env(d)) env(e)');
  assert.equal(out, 'myenv(a) env2(b) url(env(d)) X');
  assert.deepEqual(calls, [['env', 'e', 'env(e)']]);
});

test('escaped names are compared as written, not decoded: \\65nv( is not env(', () => {
  const { out, calls } = functions('\\65nv(c) env(d)');
  assert.equal(out, '\\65nv(c) X');
  assert.deepEqual(calls, [['env', 'd', 'env(d)']]);
});

test('a call the hook replaces is not searched; a call it declines is', () => {
  const replaced = functions('env(a, env(b))');
  assert.equal(replaced.out, 'X');
  assert.equal(replaced.calls.length, 1);
  const declined = functions('env(a, env(b))', ['env'], (_name, args) => (args === 'b' ? 'Y' : null));
  assert.equal(declined.out, 'env(a, Y)');
  assert.deepEqual(
    declined.calls.map(([, args]) => args),
    ['a, env(b)', 'b']
  );
});

test('a call inside the arguments of another call is found', () => {
  assert.equal(functions('calc(env(a) + 1px) foo(bar env(b))').out, 'calc(X + 1px) foo(bar X)');
});

test('a call that is not closed runs to the end of the text', () => {
  const { out, calls } = functions('color: env(a, b; c: d');
  assert.equal(out, 'color: X');
  assert.deepEqual(calls, [['env', 'a, b; c: d', 'env(a, b; c: d']]);
});

test('strings, comments and unquoted urls are not calls', () => {
  const { out, calls } = functions('"env(a)" /* env(b) */ url(env(c)) env(d)');
  assert.equal(out, '"env(a)" /* env(b) */ url(env(c)) X');
  assert.deepEqual(calls, [['env', 'd', 'env(d)']]);
});

test('parentheses in strings, comments and escapes do not close a call', () => {
  const { out, calls } = functions('env("a)", /* ) */ b) x env(c\\)d) y');
  assert.equal(out, 'X x X y');
  assert.deepEqual(calls, [
    ['env', '"a)", /* ) */ b', 'env("a)", /* ) */ b)'],
    ['env', 'c\\)d', 'env(c\\)d)'],
  ]);
});

test('a closing token closes only the block it matches', () => {
  const { calls } = functions('env(a[)]) z');
  assert.deepEqual(calls, [['env', 'a[)]', 'env(a[)])']]);
});

test('empty arguments, and a stray closing parenthesis', () => {
  const { out, calls } = functions('a) env() b)');
  assert.equal(out, 'a) X b)');
  assert.deepEqual(calls, [['env', '', 'env()']]);
});

test('the names are matched whatever their case', () => {
  assert.equal(functions('env(a)', ['ENV']).out, 'X');
});

test('a hook that declines, or no names, leave the text as it is', () => {
  assert.equal(
    mapFunctions('env(a) x', ['env'], () => null),
    'env(a) x'
  );
  assert.equal(
    mapFunctions('env(a) x', [], () => 'X'),
    'env(a) x'
  );
});

test('a media query list is split at its top-level commas, parts as written', () => {
  assert.deepEqual(splitMediaQueries('screen, print'), ['screen', ' print']);
  assert.deepEqual(splitMediaQueries('a,b ,c'), ['a', 'b ', 'c']);
  assert.deepEqual(splitMediaQueries(''), ['']);
  assert.deepEqual(splitMediaQueries('a,'), ['a', '']);
});

test('commas in parentheses, functions, brackets, strings, comments, urls and escapes do not split', () => {
  assert.deepEqual(splitMediaQueries('(a: f(1, 2)), "x,y", /* , */ print, a\\,b, url(a,b), [c, d]'), [
    '(a: f(1, 2))',
    ' "x,y"',
    ' /* , */ print',
    ' a\\,b',
    ' url(a,b)',
    ' [c, d]',
  ]);
});

test('a parenthesis that is not closed takes the rest of the list, a stray one does not', () => {
  assert.deepEqual(splitMediaQueries('(a, b'), ['(a, b']);
  assert.deepEqual(splitMediaQueries('a), b'), ['a)', ' b']);
});

test('trimWhitespace removes the whitespace at the ends, and only what CSS takes for whitespace', () => {
  assert.equal(trimWhitespace('  print \t\n'), 'print');
  assert.equal(trimWhitespace('/* a */ print /* b */ '), '/* a */ print /* b */');
  assert.equal(trimWhitespace('print\u00a0'), 'print\u00a0');
  assert.equal(trimWhitespace('\ufeffprint'), '\ufeffprint');
  assert.equal(trimWhitespace('print\u000b'), 'print\u000b');
  assert.equal(trimWhitespace(' \n '), '');
  assert.equal(trimWhitespace(''), '');
});

test('trimWhitespace keeps an escaped space, and the whitespace after a bad string or a backslash', () => {
  assert.equal(trimWhitespace('x\\ '), 'x\\ ');
  assert.equal(trimWhitespace('"a\n'), '"a\n');
  assert.equal(trimWhitespace('a\\\n  '), 'a\\\n  ');
  assert.equal(trimWhitespace('a\\\r\n'), 'a\\\r\n');
});
