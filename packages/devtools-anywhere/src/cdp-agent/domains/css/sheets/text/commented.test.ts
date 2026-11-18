// commented.ts in Node, where there is no CSS: what reportedComment() decides without asking
// CSS.supports() (vendor prefixes, custom properties with no value), and that cssSupports() then
// says no rather than throwing. Which declarations parse is compared with Chrome in
// source-text/comments.conformance.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundled: the sources import each other without extensions.
const bundled = await build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'commented.ts')],
  bundle: true,
  format: 'esm',
  write: false,
});
const { cssSupports, reportedComment, useCssNatives } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof import('./commented.ts');

test('no CSS: cssSupports says no, and only what needs no CSS.supports is reported', () => {
  assert.equal(cssSupports('color', 'red'), false);
  assert.equal(reportedComment('color', 'red'), false);
});

test('vendor prefixes: lower case only, whatever the value', () => {
  for (const name of ['-webkit-foo', '-moz-foo', '-ms-foo', '-o-foo', '-webkit-'])
    assert.equal(reportedComment(name, ')'), true, name);
  for (const name of ['-WEBKIT-FOO', '-Webkit-foo', '-khtml-foo', '-x-foo', '-epub-foo', '-foo-bar'])
    assert.equal(reportedComment(name, '1'), false, name);
});

test('custom properties: one with no value or only white space is reported', () => {
  for (const value of ['', ' ', '\t\n']) assert.equal(reportedComment('--x', value), true, JSON.stringify(value));
  assert.equal(reportedComment('--x', '1'), false);
  // Escaped: `\2d-x` is `--x`.
  assert.equal(reportedComment('\\2d-x', ''), true);
});

// Last: the natives it gives stay set for the module (useCssNatives has no undoing), which the
// tests above, run first and in order, rely on not being.
test('the natives given are called on their CSS, with the name unescaped', () => {
  const calls: unknown[][] = [];
  const fakeCss = { supports: () => false } as unknown as typeof CSS;
  useCssNatives({
    CSS: fakeCss,
    supports: function (this: unknown, ...args: unknown[]) {
      calls.push([this, ...args]);
      return true;
    } as (typeof CSS)['supports'],
  });
  assert.equal(reportedComment('col\\6f r', 'red'), true);
  assert.deepEqual(calls, [[fakeCss, 'color', 'red']]);
});
