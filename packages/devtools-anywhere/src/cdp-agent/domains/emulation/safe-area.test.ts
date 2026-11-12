import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as SafeArea from './safe-area.ts';

// Bundled: the modules import each other without an extension, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export * from './safe-area.ts';",
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { isEmulationProperty, safeAreaCss, safeAreaRewrite, unwrapSafeArea } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof SafeArea;

/** Checks the rewrite of each input against its output. */
function expectRewrites(pairs: readonly (readonly [string, string])[]) {
  for (const [input, output] of pairs)
    assert.equal(safeAreaRewrite(input), output, `rewrite of ${JSON.stringify(input)}`);
}

// Every safe-area env() call becomes var(--da-sai-*, env(…)) with the call's arguments as written, whichever
// insets the emulation sets: the custom property is what changes, and the env() is what a side not set keeps.

test('each env() of a safe area inset is wrapped, fallback included, with its arguments as written', () => {
  expectRewrites([
    ['padding: env(safe-area-inset-top, 7px)', 'padding: var(--da-sai-top, env(safe-area-inset-top, 7px))'],
    ['env(safe-area-inset-top)', 'var(--da-sai-top, env(safe-area-inset-top))'],
    [
      'env(safe-area-inset-left) env(safe-area-inset-bottom) env(safe-area-inset-right)',
      'var(--da-sai-left, env(safe-area-inset-left)) var(--da-sai-bottom, env(safe-area-inset-bottom)) ' +
        'var(--da-sai-right, env(safe-area-inset-right))',
    ],
    ['env(safe-area-max-inset-top, 1px)', 'var(--da-sai-max-top, env(safe-area-max-inset-top, 1px))'],
    ['env(safe-area-max-inset-left)', 'var(--da-sai-max-left, env(safe-area-max-inset-left))'],
    ['env(safe-area-max-inset-bottom)', 'var(--da-sai-max-bottom, env(safe-area-max-inset-bottom))'],
    ['env(safe-area-max-inset-right)', 'var(--da-sai-max-right, env(safe-area-max-inset-right))'],
    ['env(safe-area-inset-top,7px)', 'var(--da-sai-top, env(safe-area-inset-top,7px))'],
  ]);
});

test('an inset not set is wrapped too, so that its value stays the real one', () => {
  expectRewrites([
    ['env(safe-area-inset-bottom)', 'var(--da-sai-bottom, env(safe-area-inset-bottom))'],
    ['margin: env(safe-area-inset-bottom) 0 0', 'margin: var(--da-sai-bottom, env(safe-area-inset-bottom)) 0 0'],
  ]);
});

test('a function around env(), and spacing and case in the name and arguments', () => {
  expectRewrites([
    ['calc(env(safe-area-inset-top) + 1px)', 'calc(var(--da-sai-top, env(safe-area-inset-top)) + 1px)'],
    ['ENV(SAFE-AREA-INSET-TOP)', 'var(--da-sai-top, env(SAFE-AREA-INSET-TOP))'],
    ['env( safe-area-inset-top )', 'var(--da-sai-top, env( safe-area-inset-top ))'],
    ['ENV( SAFE-AREA-INSET-TOP , 7px )', 'var(--da-sai-top, env( SAFE-AREA-INSET-TOP , 7px ))'],
  ]);
});

test('the fallback of a replaced env() is kept as written, and an env() in another call is replaced', () => {
  expectRewrites([
    [
      'env(safe-area-inset-top, env(safe-area-inset-bottom))',
      'var(--da-sai-top, env(safe-area-inset-top, env(safe-area-inset-bottom)))',
    ],
    [
      'env(safe-area-inset-bottom, env(safe-area-inset-top))',
      'var(--da-sai-bottom, env(safe-area-inset-bottom, env(safe-area-inset-top)))',
    ],
    ['env(other, env(safe-area-inset-top))', 'env(other, var(--da-sai-top, env(safe-area-inset-top)))'],
  ]);
});

test('each occurrence is wrapped, and the text around it kept', () => {
  expectRewrites([
    [
      'padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); ' +
        'color: red; margin-top: env(safe-area-inset-top, 2px)',
      'padding: var(--da-sai-top, env(safe-area-inset-top)) 0 var(--da-sai-bottom, env(safe-area-inset-bottom)); ' +
        'color: red; margin-top: var(--da-sai-top, env(safe-area-inset-top, 2px))',
    ],
  ]);
});

test('a fallback that is not closed is wrapped up to the end of the text', () => {
  expectRewrites([['env(safe-area-inset-top, 1px', 'var(--da-sai-top, env(safe-area-inset-top, 1px))']]);
});

test('an argument that is not the inset name, alone or before a fallback, is left alone', () => {
  expectRewrites([
    ['env(safe-area-inset-topx)', 'env(safe-area-inset-topx)'],
    ['env(safe-area-inset-top foo)', 'env(safe-area-inset-top foo)'],
    ['env(other, safe-area-inset-top)', 'env(other, safe-area-inset-top)'],
    ['env(other)', 'env(other)'],
    ['color: red', 'color: red'],
  ]);
});

// Where the text is read as CSS reads it: an env() in a comment, a string or an unquoted url() is not a
// call, a name that only ends in env is not env(), and a comment or a string in a fallback does not end
// the call early. An env() left open at the end of the text is closed there, as CSS closes it.

test('a comment inside env() is not read as the end of the argument', () => {
  expectRewrites([['env(safe-area-inset-top /* ) */)', 'var(--da-sai-top, env(safe-area-inset-top /* ) */))']]);
});

test('a comment that mentions env() is not wrapped', () => {
  expectRewrites([
    [
      '/* env(safe-area-inset-top) */ padding: env(safe-area-inset-top)',
      '/* env(safe-area-inset-top) */ padding: var(--da-sai-top, env(safe-area-inset-top))',
    ],
  ]);
});

test('a string that mentions env() is not wrapped', () => {
  expectRewrites([['content: "env(safe-area-inset-top)"', 'content: "env(safe-area-inset-top)"']]);
});

test('a parenthesis in a string or a comment of the fallback does not end the env()', () => {
  expectRewrites([
    ['env(safe-area-inset-top, ")") x', 'var(--da-sai-top, env(safe-area-inset-top, ")")) x'],
    ['env(safe-area-inset-top, /* ( */ 1px) x', 'var(--da-sai-top, env(safe-area-inset-top, /* ( */ 1px)) x'],
  ]);
});

test('env() in an unquoted url() is part of the url', () => {
  expectRewrites([['background: url(env(safe-area-inset-top))', 'background: url(env(safe-area-inset-top))']]);
});

test('a function whose name ends in env is not env()', () => {
  expectRewrites([['myenv(safe-area-inset-top)', 'myenv(safe-area-inset-top)']]);
});

test('an env() that is not closed at the end of the text is closed there', () => {
  expectRewrites([['padding: env(safe-area-inset-top', 'padding: var(--da-sai-top, env(safe-area-inset-top))']]);
});

test('an escaped character in the name is compared as written, not decoded', () => {
  expectRewrites([['env(safe-area-inset-\\74 op)', 'env(safe-area-inset-\\74 op)']]);
});

// The rewrite of a rewritten text is the text itself, and a page's own var() is only searched inside.

test('rewriting a rewritten text changes nothing', () => {
  for (const text of [
    'padding: env(safe-area-inset-top, 7px) env(safe-area-max-inset-right)',
    'calc(env(safe-area-inset-top) + var(--x, env(safe-area-inset-left)))',
    'env(other, safe-area-inset-top) env(safe-area-inset-top, env(safe-area-inset-bottom))',
  ]) {
    const once = safeAreaRewrite(text);
    assert.equal(safeAreaRewrite(once), once, `second rewrite of ${JSON.stringify(text)}`);
  }
});

test("a var() of the emulation's is kept, and a page's var() with an env() fallback has the env() wrapped", () => {
  expectRewrites([
    ['var(--da-sai-top, env(safe-area-inset-top))', 'var(--da-sai-top, env(safe-area-inset-top))'],
    ['var(--x, env(safe-area-inset-top))', 'var(--x, var(--da-sai-top, env(safe-area-inset-top)))'],
  ]);
});

// The inverse: what the browser gives back for a rewritten declaration, as the page wrote it.

test('unwrapping a rewritten text gives back the calls as written', () => {
  for (const text of [
    'padding: env(safe-area-inset-top, 7px)',
    'env(safe-area-inset-top)',
    'calc(env(safe-area-inset-top) + 1px)',
    'padding: env(safe-area-max-inset-right, 2px) env(safe-area-inset-left, env(safe-area-inset-top))',
    'padding: env(safe-area-inset-top, 7px); margin: 0',
  ]) {
    assert.equal(unwrapSafeArea(safeAreaRewrite(text)), text, `unwrapped ${JSON.stringify(text)}`);
  }
});

test('unwrapping leaves the other var() calls alone', () => {
  assert.equal(unwrapSafeArea('var(--x, 5px)'), 'var(--x, 5px)');
  assert.equal(unwrapSafeArea('var(--da-sai-top, 5px)'), 'var(--da-sai-top, 5px)');
  assert.equal(
    unwrapSafeArea('var(--x, var(--da-sai-top, env(safe-area-inset-top)))'),
    'var(--x, env(safe-area-inset-top))'
  );
  assert.equal(unwrapSafeArea('color: red'), 'color: red');
});

// The custom properties the emulation sets, on :root.

test('the style sheet sets a custom property for each inset set, in px, and none for the others', () => {
  assert.equal(safeAreaCss({}), null);
  assert.equal(safeAreaCss({ top: 5 }), ':root{--da-sai-top:5px}');
  assert.equal(safeAreaCss({ rightMax: 0, bottom: -3 }), ':root{--da-sai-bottom:-3px;--da-sai-max-right:0px}');
  assert.equal(
    safeAreaCss({ top: 1, topMax: 2, left: 3, leftMax: 4, bottom: 5, bottomMax: 6, right: 7, rightMax: 8 }),
    ':root{--da-sai-top:1px;--da-sai-max-top:2px;--da-sai-left:3px;--da-sai-max-left:4px;' +
      '--da-sai-bottom:5px;--da-sai-max-bottom:6px;--da-sai-right:7px;--da-sai-max-right:8px}'
  );
});

test('an inset that is not an int32 is an invalid parameter, as Chrome fails it', () => {
  for (const insets of [{ top: 5.5 }, { left: 2147483648 }, { bottom: Number.NaN }, { right: -2147483649 }]) {
    assert.throws(() => safeAreaCss(insets), { code: -32602, message: /must be an int32/ }, JSON.stringify(insets));
  }
  assert.equal(
    safeAreaCss({ top: 2147483647, left: -2147483648 }),
    ':root{--da-sai-top:2147483647px;--da-sai-left:-2147483648px}'
  );
});

test("the custom properties of the emulation are told apart from the page's", () => {
  assert.equal(isEmulationProperty('--da-sai-top'), true);
  assert.equal(isEmulationProperty('--da-sai-max-right'), true);
  assert.equal(isEmulationProperty('--cust'), false);
  assert.equal(isEmulationProperty('--da-other'), false);
});
