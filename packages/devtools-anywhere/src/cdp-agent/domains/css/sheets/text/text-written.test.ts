// textWritten() and textRange() (ranges.ts) in Node: the declarations of an inline style's text
// and their ranges, how textParts() splits the text, and the range of the text. The expected
// values at 0:0 are Chrome 157's for the same style attribute (also compared in
// source-text/comments.conformance.test.ts), with `-webkit-foo` for a disabled one, as Node has
// no CSS.supports(); those from another start are worked out by hand from them, as Chrome's
// inline styles start at 0:0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundled: the sources import each other without extensions.
const bundled = await build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'ranges.ts')],
  bundle: true,
  format: 'esm',
  write: false,
});
const { textRange, textWritten } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof import('./ranges.ts');

/** Each declaration as `name|value|text|range`. */
function read(text: string, line = 0, column = 0): string[] {
  return textWritten(text, line, column).map(
    w =>
      `${w.name}|${w.value}|${w.text}|${w.range.startLine}:${w.range.startColumn}-${w.range.endLine}:${w.range.endColumn}`
  );
}

const span = (r: { startLine: number; startColumn: number; endLine: number; endColumn: number }) =>
  `${r.startLine}:${r.startColumn}-${r.endLine}:${r.endColumn}`;

test('a start other than 0:0: columns shift on the first line only (by hand)', () => {
  assert.deepEqual(read('top: 0;\nleft: 1px', 3, 10), ['top|0|top: 0;|3:10-3:17', 'left|1px|left: 1px|4:0-4:9']);
  assert.equal(span(textRange('top: 0;\nleft: 1px', 3, 10)), '3:10-4:9');
  assert.equal(span(textRange('top: 0', 3, 10)), '3:10-3:16');
  assert.equal(span(textRange('', 3, 10)), '3:10-3:10');
});

test('several lines, a declaration after a blank one', () => {
  assert.deepEqual(read('color: red;\n\n  left: 1px;'), [
    'color|red|color: red;|0:0-0:11',
    'left|1px|left: 1px;|2:2-2:12',
  ]);
  assert.equal(span(textRange('color: red;\n\n  left: 1px;', 0, 0)), '0:0-2:12');
});

test('CR LF: lines end at LF, the CR in the line before', () => {
  assert.deepEqual(read('color: red;\r\nleft: 0'), ['color|red|color: red;|0:0-0:11', 'left|0|left: 0|1:0-1:7']);
});

test('outside ASCII and the BMP: columns in UTF-16 code units', () => {
  assert.deepEqual(read('content: "é😀"; top: 0'), [
    'content|"é😀"|content: "é😀";|0:0-0:15',
    'top|0|top: 0|0:16-0:22',
  ]);
});

test('a comment, a string or an escape left open runs to the end of the text', () => {
  assert.deepEqual(read('color:red /* x'), ['color|red /* x|color:red /* x|0:0-0:14']);
  assert.deepEqual(read('content:"abc'), ['content|"abc|content:"abc|0:0-0:12']);
  assert.deepEqual(read('color:a\\'), ['color|a\\|color:a\\|0:0-0:8']);
});

test('a `}` closes nothing; a rule is skipped to the next `;`, a value ends at its `{`', () => {
  assert.deepEqual(read('color:red /* c */ } x'), ['color|red /* c */ } x|color:red /* c */ } x|0:0-0:21']);
  assert.deepEqual(read('color: red; } a { top: 0'), ['color|red|color: red;|0:0-0:11']);
  assert.deepEqual(read('a{top:0} color:red'), []);
  assert.deepEqual(read('@media x{} color:red'), ['color|red|color:red|0:11-0:20']);
  assert.deepEqual(read('color:red /*c*/ a{top:0}'), ['color|red /*c*/ a|color:red /*c*/ a|0:0-0:17']);
  assert.deepEqual(read('color:red; a{top:0} left:1px; /* -webkit-foo: 1 */'), [
    'color|red|color:red;|0:0-0:10',
    '-webkit-foo|1|/* -webkit-foo: 1 */|0:30-0:50',
  ]);
});

test('what textParts() keeps apart, as Chrome reads it', () => {
  // An at-rule with no block, a string in it.
  assert.deepEqual(read('@charset "x"; color: red'), ['color|red|color: red|0:14-0:24']);
  // `;{}` in a string, in a comment, in a comment in a value.
  assert.deepEqual(read('content: ";{}"; top: 0'), [
    'content|";{}"|content: ";{}";|0:0-0:15',
    'top|0|top: 0|0:16-0:22',
  ]);
  assert.deepEqual(read('/* ; { } */ top: 0'), ['top|0|top: 0|0:12-0:18']);
  assert.deepEqual(read('top: 0 /* ; */ ; left: 0'), [
    'top|0 /* ; */|top: 0 /* ; */ ;|0:0-0:16',
    'left|0|left: 0|0:17-0:24',
  ]);
  // A block in a function.
  assert.deepEqual(read('color: f(a {b} c); top: 0'), [
    'color|f(a {b} c)|color: f(a {b} c);|0:0-0:18',
    'top|0|top: 0|0:19-0:25',
  ]);
});

test('blocks end only at the token closing them; one closing none is a token', () => {
  assert.deepEqual(read('color: f( } ; top:0'), ['color|f( } ; top:0|color: f( } ; top:0|0:0-0:19']);
  assert.deepEqual(read('color:[ ) ; top:0'), ['color|[ ) ; top:0|color:[ ) ; top:0|0:0-0:17']);
  assert.deepEqual(read('color: red ] ; top: 0'), ['color|red ]|color: red ] ;|0:0-0:14', 'top|0|top: 0|0:15-0:21']);
  assert.deepEqual(read('color: red ) ; top:0'), ['color|red )|color: red ) ;|0:0-0:14', 'top|0|top:0|0:15-0:20']);
  // A `}` closing no block at the top, then another declaration.
  assert.deepEqual(read('color: 1} ; top:0'), ['color|1}|color: 1} ;|0:0-0:11', 'top|0|top:0|0:12-0:17']);
  assert.deepEqual(read('color:red } ; top: 0'), ['color|red }|color:red } ;|0:0-0:13', 'top|0|top: 0|0:14-0:20']);
});

test('custom properties: blocks in the value; one with a token closing no block is dropped', () => {
  assert.deepEqual(read('--x:{a}; top:0'), ['--x|{a}|--x:{a};|0:0-0:8', 'top|0|top:0|0:9-0:14']);
  assert.deepEqual(read('--x: {a} b; top:0'), ['--x|{a} b|--x: {a} b;|0:0-0:11', 'top|0|top:0|0:12-0:17']);
  assert.deepEqual(read('--x: a {b}; top:0'), ['--x|a {b}|--x: a {b};|0:0-0:11', 'top|0|top:0|0:12-0:17']);
  assert.deepEqual(read('--x: ( } ); top:0'), ['top|0|top:0|0:12-0:17']);
  // Blocks crossing: the first left open runs to the end, and the property is dropped.
  assert.deepEqual(read('--x: f(a{b)c}; top:0'), []);
  assert.deepEqual(read('--x: [ { ] } ; top:0'), []);
});

test('kept for the next call: the same answer until another text or start is read', () => {
  const text = 'color: red; /* -webkit-foo: 1 */';
  const a = textWritten(text, 0, 0);
  const copy = structuredClone(a);
  assert.equal(textWritten(text, 0, 0), a);
  assert.deepEqual(a, copy);
  // Another start: other ranges.
  const moved = textWritten(text, 2, 5);
  assert.notEqual(moved, a);
  assert.equal(span(moved[0]?.range ?? textRange('', 0, 0)), '2:5-2:16');
  // A, B, A: the same answers as first.
  assert.deepEqual(
    textWritten('left: 0', 0, 0).map(w => w.name),
    ['left']
  );
  assert.deepEqual(textWritten(text, 0, 0), copy);
});
