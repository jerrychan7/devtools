import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as ColorScheme from './color-scheme.ts';

// Bundled: the modules import each other without an extension, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export * from './color-scheme.ts';",
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { schemeDeclarations, schemeValue } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof ColorScheme;

// What Chrome reads is checked in the conformance tests; here every value counts as read.
const dark = schemeValue('dark', () => true);
const light = schemeValue('light', () => true);

test('a value naming both schemes is the preference alone', () => {
  assert.equal(dark('light dark'), 'dark');
  assert.equal(dark('dark light'), 'dark');
  assert.equal(light('light dark'), 'light');
  assert.equal(light('dark light'), 'light');
  assert.equal(dark('light dark light dark'), 'dark');
  assert.equal(dark(' light   dark '), ' dark ');
  assert.equal(dark('LIGHT Dark'), 'dark');
  assert.equal(light('light/**/dark'), 'light');
  assert.equal(dark('light /* a */ dark'), 'dark');
  // An escaped keyword is the keyword it spells (CSS compares it decoded).
  assert.equal(dark('\\6c ight dark'), 'dark');
});

test('only keeps its place, and the other names are kept', () => {
  assert.equal(dark('only light dark'), 'only dark');
  assert.equal(light('only dark light'), 'only light');
  assert.equal(dark('light dark only'), 'dark only');
  assert.equal(dark('light dark foo'), 'dark foo');
  assert.equal(dark('foo light dark'), 'foo dark');
  assert.equal(light('only foo light dark'), 'only foo light');
});

test('a value naming one scheme, or normal, is left as it is', () => {
  for (const value of ['light', 'dark', 'only light', 'only dark', 'normal', 'light only', 'foo', 'light light']) {
    assert.equal(dark(value), value, value);
  }
});

test('a value Chrome does not read is left as it is, and so is a rewrite Chrome would not read', () => {
  const reads = schemeValue('dark', value => !value.includes('x') && !value.includes('!'));
  assert.equal(reads('light dark x'), 'light dark x');
  assert.equal(reads('light dark !important'), 'light dark !important');
  assert.equal(reads('light dark'), 'dark');
  // The rewrite gives `dark`, which this reader does not take: the value is kept.
  const refuses = schemeValue('dark', value => value !== 'dark');
  assert.equal(refuses('light dark'), 'light dark');
});

test('the color-scheme declarations of a block are rewritten, with their priority kept', () => {
  const block = schemeDeclarations(dark);
  assert.equal(block('color-scheme: light dark; color: red'), 'color-scheme: dark; color: red');
  assert.equal(block('color: light dark; color-scheme: only light dark'), 'color: light dark; color-scheme: only dark');
  assert.equal(block('color-scheme: light dark !important'), 'color-scheme: dark !important');
  assert.equal(block('color-scheme: light dark!important'), 'color-scheme: dark!important');
  assert.equal(block('color-scheme: light dark !/**/important'), 'color-scheme: dark !/**/important');
  assert.equal(block('COLOR-SCHEME: light dark'), 'COLOR-SCHEME: dark');
  assert.equal(block('color-scheme: light dark /* kept */; color: red'), 'color-scheme: dark /* kept */; color: red');
  // Other properties, custom ones included, and single or normal values are not.
  assert.equal(block('--color-scheme: light dark'), '--color-scheme: light dark');
  assert.equal(block('color: light dark'), 'color: light dark');
  assert.equal(block('color-scheme: normal'), 'color-scheme: normal');
});

test('a value with a function is left as it is: the names in its arguments are not schemes', () => {
  assert.equal(dark('var(--a, light) dark'), 'var(--a, light) dark');
  assert.equal(dark('light dark var(--b)'), 'light dark var(--b)');
  assert.equal(dark('only light dark var(--b)'), 'only light dark var(--b)');
});

test('a run of comments after the ! is part of the priority, and a * in a comment does not end it', () => {
  const blockOf = schemeDeclarations(dark);
  assert.equal(
    blockOf('color-scheme: light dark !/* a */ /* b */important'),
    'color-scheme: dark !/* a */ /* b */important'
  );
  assert.equal(blockOf('color-scheme: light dark !/* * / */important'), 'color-scheme: dark !/* * / */important');
  assert.equal(blockOf('color-scheme: light dark !/***/important'), 'color-scheme: dark !/***/important');
});

test('a no-break space is part of a name, not a blank before !important', () => {
  const blockOf = schemeDeclarations(dark);
  assert.equal(blockOf('color-scheme: light dark !important'), 'color-scheme: light dark !important');
});
