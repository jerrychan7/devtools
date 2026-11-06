// loose.ts against Chrome: each selector below with the selectorText Chrome 157.0.8103.39 gives it,
// measured in headless Chrome (puppeteer-core) with
//   const s = new CSSStyleSheet(); s.replaceSync(selector + '{}'); s.cssRules[0].selectorText
// To add a case, measure it the same way and copy Chrome's answer here.
// A selector and Chrome's come out the same through loose(); selectors that differ do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundled: the sources import each other without extensions.
const bundled = await build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'loose.ts')],
  bundle: true,
  format: 'esm',
  write: false,
});
const { atName, loose, reescape, serializeIdent, serializeString } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof import('./loose.ts');

/** Written with escapes => Chrome's selectorText. */
const ESCAPES: [string, string][] = [
  ['.a\\:b', '.a\\:b'],
  ['.\\31 0', '.\\31 0'],
  ['.\\31 a', '.\\31 a'],
  ['\\61', 'a'],
  ['.\\66oo', '.foo'],
  ['.\\66 oo', '.foo'],
  ['.A\\42', '.AB'],
  ['#\\31 23', '#\\31 23'],
  ['.a\\ b', '.a\\ b'],
  ['.\\-', '.\\-'],
  ['.\\2D', '.\\-'],
  ['.\\2d x', '.-x'],
  ['.-\\31', '.-\\31 '],
  ['.\\-1', '.-\\31 '],
  ['.\\--x', '.--x'],
  ['.\\-\\-a', '.--a'],
  ['.\\_', '._'],
  ['.\\31', '.\\31 '],
  ['.\\30', '.\\30 '],
  ['.a\\.b', '.a\\.b'],
  ['.a\\,b', '.a\\,b'],
  ['.a\\(b', '.a\\(b'],
  ['.\\{', '.\\{'],
  ['.\\@x', '.\\@x'],
  ['.\\ ', '.\\ '],
  ['.\\"', '.\\"'],
  ['.\\E9 t', '.ét'],
  ['.\\00e9', '.é'],
  ['.\\0', '.\uFFFD'],
  ['.\\D800', '.\uFFFD'],
  ['.\\110000', '.\uFFFD'],
  ['.\\😀', '.😀'],
  ['.\\7F', '.\\7f '],
  ['.\\1', '.\\1 '],
  ['.\\9', '.\\9 '],
  ['.\\a', '.\\a '],
  ['.a\\\tb', '.a\\9 b'],
  ['.\\31 \\32', '.\\31 2'],
  ['.\\31  .x', '.\\31  .x'],
  ['.\\31  a', '.\\31  a'],
  ['a\\:hover', 'a\\:hover'],
  ['a:\\6e ot(b)', 'a:not(b)'],
  ['a:\\4e ot(b)', 'a:not(b)'],
  ['a:\\48 over', 'a:hover'],
  ['a::\\62 efore', 'a::before'],
  [':not(.\\31)', ':not(.\\31 )'],
  [':is(.a\\:b, .\\31 x)', ':is(.a\\:b, .\\31 x)'],
  [':host(.\\31)', ':host(.\\31 )'],
  [':lang(\\65 n)', ':lang(en)'],
  [':dir(\\6c tr)', ':dir(ltr)'],
  ['::part(\\61)', '::part(a)'],
  [':state(\\61)', ':state(a)'],
  [':nth-child(2\\6e+1)', ':nth-child(2n+1)'],
  [':nth-child(2\\6E +1)', ':nth-child(2n+1)'],
  [':nth-child(\\6f dd)', ':nth-child(2n+1)'],
  [':nth-child(2n+1 of .\\31)', ':nth-child(2n+1 of .\\31 )'],
  ['&.\\31', '&.\\31 '],
  ['.\\31 &', '.\\31 &'],
  ['[a\\:b="x\\"y"]', '[a\\:b="x\\"y"]'],
  ['[a=x\\ y]', '[a="x y"]'],
  ['[a="\\61"]', '[a="a"]'],
  ["[a='\\'']", '[a="\'"]'],
  ['[\\61 =b]', '[a="b"]'],
  ['[a=\\62]', '[a="b"]'],
  ['[a="x\\a y"]', '[a="x\\a y"]'],
  ['[a="x\\\ny"]', '[a="xy"]'],
  ['[a="\\7F"]', '[a="\\7f "]'],
  ['[a|=\\62\\ c]', '[a|="b c"]'],
];

/** Written without escapes => Chrome's selectorText: whitespace. */
const SPACES: [string, string][] = [
  ['a  >  b', 'a > b'],
  ['a>b', 'a > b'],
  ['a   b', 'a b'],
  ['a\tb', 'a b'],
  [' a , b ', 'a, b'],
  ['a+b', 'a + b'],
  [':is( a , b )', ':is(a, b)'],
  [':is(a) b', ':is(a) b'],
  ['a [x]', 'a [x]'],
  ['a[ x = "y" ]', 'a[x="y"]'],
  ['[x ^= y]', '[x^="y"]'],
  ['[x |= y]', '[x|="y"]'],
  ['a *', 'a *'],
  ['a /* c */ b', 'a b'],
  ['[x="a  b"]', '[x="a  b"]'],
  ['[x="a>b"]', '[x="a>b"]'],
];

/** Selectors that differ, and must not pair (Chrome serializes each pair differently). */
const DIFFERENT: [string, string][] = [
  ['.a b', '.ab'],
  ['.a .b', '.a.b'],
  ['.a\\ x', '.a\\b x'],
  ['.\\31  a', '.\\31 a'],
  ['.\\31  .x', '.\\31 .x'],
  [':is(a) b', ':is(a)b'],
  ['a [x]', 'a[x]'],
  ['a *', 'a*'],
  ['[x="a b"]', '[x="ab"]'],
  ['.a\\:b', '.a:b'],
  ['&.x', '& .x'],
  ['.\\31 0', '.\\310'],
  [':nth-child(2n+1 of .a .b)', ':nth-child(2n+1 of .a.b)'],
];

test("a selector with escapes is loosened as Chrome's selectorText is", () => {
  for (const [written, chrome] of ESCAPES) assert.equal(loose(written), loose(chrome), written);
});

test("whitespace: a selector is loosened as Chrome's selectorText is", () => {
  for (const [written, chrome] of SPACES) assert.equal(loose(written), loose(chrome), written);
});

test('selectors that differ are loosened apart', () => {
  for (const [a, b] of DIFFERENT) assert.notEqual(loose(a), loose(b), `${a} / ${b}`);
});

test("Chrome's selectorText is written again as it is: escapes kept, spaces where it has them", () => {
  for (const [, chrome] of ESCAPES) assert.equal(reescape(chrome), chrome, chrome);
});

// Compared only, escapes end with NUL, which is no CSS: idempotent written out.
test('reescape is idempotent', () => {
  for (const [written] of [...ESCAPES, ...SPACES, ...DIFFERENT])
    assert.equal(reescape(reescape(written)), reescape(written), written);
});

test('an attribute value is quoted only in brackets: `=` elsewhere is left alone', () => {
  assert.equal(reescape('[a=\\62]'), '[a="b"]');
  assert.equal(reescape('style(--\\78  = \\79)'), 'style(--x = y)');
});

test('serialize an identifier and a string, after CSSOM §2.1', () => {
  assert.equal(serializeIdent('1a'), '\\31 a');
  assert.equal(serializeIdent('-1'), '-\\31 ');
  assert.equal(serializeIdent('-'), '\\-');
  assert.equal(serializeIdent('--a'), '--a');
  assert.equal(serializeIdent('a:b c'), 'a\\:b\\ c');
  assert.equal(serializeString('a"\\\x7f'), '"a\\"\\\\\\7f "');
});

test('at-rule names: escapes consumed (`@\\6d edia` is @media)', () => {
  assert.equal(atName('\\6d edia'), 'media');
  assert.equal(atName('-webkit-\\6b eyframes'), '-webkit-keyframes');
  assert.equal(atName('media'), 'media');
});
