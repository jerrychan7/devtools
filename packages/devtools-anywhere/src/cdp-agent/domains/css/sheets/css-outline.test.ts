import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CssDecl, CssRule, outline as Outline } from './css-outline.ts';
import { lineStarts, offsetAt, positionAt } from './text-lines.ts';

// Bundled: the sources import each other without extensions, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export { outline } from './css-outline.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { outline }: { outline: typeof Outline } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
);

type Shape = string | [string, ...Shape[]];

/**
 * A rule as `[header, ...decls and rules]`: the header is the prelude (`@name prelude` for
 * at-rules, `nested` for nested declarations), with `{` when the block is unclosed and `;` for a
 * blockless at-rule; a declaration is `name=value`, `!` when important, `;` when ended by one, `#`
 * in front for a commented one.
 */
function shape(text: string, r: CssRule): Shape {
  const prelude = text.slice(r.preludeStart, r.preludeEnd);
  let head = r.kind === 'at' ? `@${r.name}${prelude ? ' ' + prelude : ''}` : r.kind === 'nested' ? 'nested' : prelude;
  if (r.kind === 'nested') assert.equal(r.blockStart, -1);
  else if (r.blockStart < 0) head += ';';
  else {
    assert.equal(text[r.blockStart], '{');
    assert.equal(r.blockEnd, r.end);
    if (!r.closed) head += '{';
    else assert.equal(text[r.end - 1], '}');
  }
  const items: { start: number; s: Shape }[] = [
    ...r.decls.map(d => ({ start: d.start, s: decl(text, d) })),
    ...r.rules.map(c => ({ start: c.start, s: shape(text, c) })),
  ];
  return [head, ...items.sort((a, b) => a.start - b.start).map(x => x.s)];
}

function decl(text: string, d: CssDecl): string {
  assert.ok(d.start < d.nameEnd && d.nameEnd <= d.valueStart && d.valueStart <= d.valueEnd && d.valueEnd <= d.end);
  if (d.semicolon) assert.equal(text[d.end - 1], ';');
  return `${d.kind === 'comment' ? '#' : ''}${text.slice(d.start, d.nameEnd)}=${text.slice(d.valueStart, d.valueEnd)}${d.important ? '!' : ''}${d.semicolon ? ';' : ''}`;
}

const parse = (text: string) => outline(text).map(r => shape(text, r));

test('qualified rules and declarations', () => {
  assert.deepEqual(parse('a { color : red ; margin:0 }'), [['a', 'color=red;', 'margin=0']]);
  assert.deepEqual(parse('a,b > c{x:y;;z:w;}'), [['a,b > c', 'x=y;', 'z=w;']]);
  assert.deepEqual(parse('/* c */ a /* d */ { }'), [['a']]);
  assert.deepEqual(parse('a{}b{}'), [['a'], ['b']]);
});

test('ranges of a declaration', () => {
  const text = 'a{ color: red !important ; }';
  const [d] = outline(text)[0]?.decls ?? [];
  assert.ok(d);
  assert.equal(text.slice(d.start, d.end), 'color: red !important ;');
  assert.equal(text.slice(d.valueStart, d.valueEnd), 'red');
  assert.ok(d.important);
  const r = outline(text)[0];
  assert.ok(r);
  assert.equal(text.slice(r.blockStart, r.blockEnd), '{ color: red !important ; }');
  assert.equal(text.slice(r.start, r.end), text);
});

test('!important, any case, with space and comments', () => {
  assert.deepEqual(parse('a{x:1 ! IMPORTANT;y:2!important}'), [['a', 'x=1!;', 'y=2!']]);
  assert.deepEqual(parse('a{x:1 !/**/important}'), [['a', 'x=1!']]);
  assert.deepEqual(parse('a{x:!important}'), [['a', 'x=!']]);
  assert.deepEqual(parse('a{x:1 !importan}'), [['a', 'x=1 !importan']]);
  assert.deepEqual(parse('a{x:important}'), [['a', 'x=important']]);
});

test('values hold strings, url() and blocks with `;` and `}` in them', () => {
  assert.deepEqual(parse('a{content:"};{";b:url(x;})}'), [['a', 'content="};{";', 'b=url(x;})']]);
  assert.deepEqual(parse('a{b:f(;}) [;];c:d}'), [['a', 'b=f(;}) [;];', 'c=d']]);
  assert.deepEqual(parse('a{--x:{a;b};y:z}'), [['a', '--x={a;b};', 'y=z']]);
  assert.deepEqual(parse('a{--x: ;}'), [['a', '--x=;']]);
});

test('at-rules: blockless, with blocks, nested, unknown', () => {
  assert.deepEqual(parse('@import url(a.css) screen; @charset "x";'), [
    ['@import url(a.css) screen;'],
    ['@charset "x";'],
  ]);
  assert.deepEqual(parse('@media (min-width: 1px) { a { b: c } } @font-face { src: x }'), [
    ['@media (min-width: 1px)', ['a', 'b=c']],
    ['@font-face', 'src=x'],
  ]);
  assert.deepEqual(parse('@layer a, b;@layer{a{}}'), [['@layer a, b;'], ['@layer', ['a']]]);
  assert.deepEqual(parse('@foo bar ( ; ) ; x{}'), [['@foo bar ( ; );'], ['x']]);
  assert.deepEqual(parse('@supports (a:b) { @media x { y { z: 1 } } }'), [
    ['@supports (a:b)', ['@media x', ['y', 'z=1']]],
  ]);
  // An at-rule the text ends in.
  assert.deepEqual(parse('@import "a"'), [['@import "a";']]);
});

test('nesting: & rules, rules without &, nested declarations', () => {
  assert.deepEqual(parse('a { color: red; &:hover { x: y } b: c; .d { } e: f }'), [
    ['a', 'color=red;', ['&:hover', 'x=y'], ['nested', 'b=c;'], ['.d'], ['nested', 'e=f']],
  ]);
  assert.deepEqual(parse('a{b:hover{c:d}}'), [['a', ['b:hover', 'c=d']]]);
  assert.deepEqual(parse('a{> b{} c{}}'), [['a', ['> b'], ['c']]]);
  // A group rule in a style rule holds its declarations in nested declarations rules.
  assert.deepEqual(parse('a{@media x{b:c; d{}} e:f}'), [
    ['a', ['@media x', ['nested', 'b=c;'], ['d']], ['nested', 'e=f']],
  ]);
  assert.deepEqual(parse('@media x{a{@supports y{b:c}}}'), [['@media x', ['a', ['@supports y', ['nested', 'b=c']]]]]);
  assert.deepEqual(parse('@font-face{a:b}'), [['@font-face', 'a=b']]);
  const text = 'a{x:1; b{} y:2; z:3}';
  const nested = outline(text)[0]?.rules[1];
  assert.ok(nested);
  assert.equal(text.slice(nested.start, nested.end), 'y:2; z:3');
});

test('commented declarations', () => {
  assert.deepEqual(parse('a{/* x: y; */ z:w; /*q:r!important*/}'), [['a', '#x=y;', 'z=w;', '#q=r!']]);
  assert.deepEqual(parse('a{/* not one */ /* a:b; c:d */ /* x{} */ /**/}'), [['a']]);
  assert.deepEqual(parse('a{b{}/* x:y */}'), [['a', ['b'], ['nested', '#x=y']]]);
  // Not at a declaration's place: in a value, a prelude, the top level.
  assert.deepEqual(parse('/* a:b */ a /*c:d*/ { e: /* f:g */ h }'), [['a', 'e=h']]);
  const text = 'a{ /* x : y ; */ }';
  const [d] = outline(text)[0]?.decls ?? [];
  assert.ok(d);
  assert.equal(text.slice(d.start, d.end), 'x : y ;');
  // A comment the text ends in.
  assert.deepEqual(parse('a{/* x: y'), [['a{', '#x=y']]);
});

test('recovery: invalid content in a block skips to `;` or the matching `}`', () => {
  assert.deepEqual(parse('a{x;y:z}'), [['a', 'y=z']]);
  assert.deepEqual(parse('a{x y z;b:c}'), [['a', 'b=c']]);
  assert.deepEqual(parse('a{1px:x;b:c}'), [['a', 'b=c']]);
  assert.deepEqual(parse('a{(;}x:y;){};b:c}'), [['a', ['(;}x:y;)'], ['nested', 'b=c']]]);
  assert.deepEqual(parse('a{x:y {z} ;b:c}'), [['a', ['x:y'], ['nested', 'b=c']]]);
  assert.deepEqual(parse('a{;;x:y;;}'), [['a', 'x=y;']]);
  assert.deepEqual(parse('a{"bad\n;b:c}'), [['a', 'b=c']]);
  assert.deepEqual(parse('a{x:url(a b);b:c}'), [['a', 'x=url(a b);', 'b=c']]);
});

test('recovery: unclosed blocks run to the end, stray `}` start a prelude', () => {
  assert.deepEqual(parse('a{b:c'), [['a{', 'b=c']]);
  assert.deepEqual(parse('a{b{c:d'), [['a{', ['b{', 'c=d']]]);
  assert.deepEqual(parse('@media x{a{b:c}'), [['@media x{', ['a', 'b=c']]]);
  assert.deepEqual(parse('a{b:c}} d{e:f} g{}'), [['a', 'b=c'], ['} d', 'e=f'], ['g']]);
  assert.deepEqual(parse('} a{}'), [['} a']]);
  assert.deepEqual(parse('a'), []);
  assert.deepEqual(parse('a{} b'), [['a']]);
  // `{` in `(` opens a block `)` does not close.
  assert.deepEqual(parse('a ( { ) } {} b{}'), []);
  assert.deepEqual(parse('a ( { ) } ) {} b{}'), [['a ( { ) } )'], ['b']]);
  assert.deepEqual(parse('a { b: "x'), [['a{', 'b="x']]);
  assert.deepEqual(parse('a { b: (x'), [['a{', 'b=(x']]);
});

test('recovery: preludes that look like custom properties make no rule', () => {
  assert.deepEqual(parse('--x: {a} b{}'), [['b']]);
  assert.deepEqual(parse('--x {a} b{}'), [['--x'], ['b']]);
});

test('CDO and CDC are skipped at the top level only', () => {
  assert.deepEqual(parse('<!-- a{} --> b{}'), [['a'], ['b']]);
  assert.deepEqual(parse('a <!-- {}'), [['a <!--']]);
});

test('offsets to lines and columns', () => {
  const text = 'a\nb\r\nc\rd\fe';
  const starts = lineStarts(text);
  assert.deepEqual(starts, [0, 2, 5, 7, 9]);
  assert.deepEqual(positionAt(starts, 0), { line: 0, column: 0 });
  assert.deepEqual(positionAt(starts, 1), { line: 0, column: 1 });
  assert.deepEqual(positionAt(starts, 3), { line: 1, column: 1 });
  assert.deepEqual(positionAt(starts, 4), { line: 1, column: 2 });
  assert.deepEqual(positionAt(starts, 10), { line: 4, column: 1 });
  assert.equal(offsetAt(starts, 2, 1), 6);
  assert.equal(offsetAt(starts, 9, 0), 9);
  assert.deepEqual(lineStarts(''), [0]);
  // UTF-16 code units: an astral character is two columns.
  assert.deepEqual(positionAt(lineStarts('😀a'), 2), { line: 0, column: 2 });
});
