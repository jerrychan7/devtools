// The names style writes are checked against (cssom-watch.ts): the descriptors taken as known
// names in any rule, and the properties @position-try takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';

type Module = typeof import('./cssom-watch.ts');

// Bundled: the sources import each other without extensions, which Node does not resolve.
const bundled = await bundle({
  stdin: {
    contents: "export * from './cssom-watch.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
// What the module reads of the DOM when loaded, outside a page.
for (const name of ['Node', 'Element', 'CSSStyleSheet', 'CSSRule', 'CSSStyleDeclaration'])
  (globalThis as Record<string, unknown>)[name] ??= class {};
const { knownProperty, positionTryTakes, useCssNatives }: Module = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
);

/** What CSS.supports(name, 'inherit') says in Chrome for the names used here. */
const PROPERTIES = new Set(['color', 'size', 'margin-left', 'left', 'display', 'width']);
const calls: string[] = [];
useCssNatives({
  CSS: {} as typeof CSS,
  supports: ((name: string) => {
    calls.push(name);
    return PROPERTIES.has(name.toLowerCase());
  }) as (typeof CSS)['supports'],
});

const DESCRIPTORS = [
  'src',
  'unicode-range',
  'font-display',
  'ascent-override',
  'descent-override',
  'line-gap-override',
  'size-adjust',
  'syntax',
  'inherits',
  'initial-value',
  'base-palette',
  'override-colors',
  'system',
  'symbols',
  'additive-symbols',
  'negative',
  'prefix',
  'suffix',
  'range',
  'pad',
  'speak-as',
  'fallback',
  'page-orientation',
  'navigation',
  'types',
];

const POSITION_TRY = [
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'inset-block',
  'inset-block-start',
  'inset-block-end',
  'inset-inline',
  'inset-inline-start',
  'inset-inline-end',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-block-start',
  'margin-block-end',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'block-size',
  'inline-size',
  'min-block-size',
  'min-inline-size',
  'max-block-size',
  'max-inline-size',
  'align-self',
  'justify-self',
  'place-self',
  'position-anchor',
  'position-area',
  'inset-area',
];

/** The name in ASCII upper case. */
const upper = (name: string) => name.toUpperCase();

test('descriptors are known names, in any ASCII case, without asking CSS.supports', () => {
  calls.length = 0;
  for (const name of DESCRIPTORS) {
    assert.equal(knownProperty(name), true, name);
    assert.equal(knownProperty(upper(name)), true, upper(name));
  }
  assert.deepEqual(calls, []);
});

test('other names are known as CSS.supports says, custom properties always', () => {
  calls.length = 0;
  // Handed to CSS.supports (the stand-in above): this checks the forwarding only, not what
  // Chrome answers (`size` is @page's descriptor and a property, known through it).
  for (const name of ['color', 'size', 'margin-left', 'COLOR']) assert.equal(knownProperty(name), true, name);
  assert.deepEqual(calls, ['color', 'size', 'margin-left', 'COLOR']);
  // Neither a property nor a descriptor: not in the list, as Chrome 157.0.8103.39 does not count
  // them.
  for (const name of ['foo', 'marks', 'bleed', 'font-named-instance', '-internal-visited-color'])
    assert.equal(knownProperty(name), false, name);
  // Not a name a property could have: not asked.
  calls.length = 0;
  for (const name of [' color ', 'col\\or', '']) assert.equal(knownProperty(name), false, JSON.stringify(name));
  assert.deepEqual(calls, []);
  // `--` alone is no custom property's name.
  assert.equal(knownProperty('--'), false);
  for (const name of ['--x', '--Any-Thing']) assert.equal(knownProperty(name), true, name);
});

test('@position-try takes the listed properties only, in any ASCII case', () => {
  for (const name of POSITION_TRY) {
    assert.equal(positionTryTakes(name), true, name);
    assert.equal(positionTryTakes(upper(name)), true, upper(name));
  }
  for (const name of ['color', 'display', 'src', 'foo', '--x', 'inset-blocks', ' left'])
    assert.equal(positionTryTakes(name), false, name);
});
