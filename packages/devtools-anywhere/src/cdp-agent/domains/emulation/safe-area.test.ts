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
const { safeAreaRewrite } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof SafeArea;

type Insets = Parameters<typeof safeAreaRewrite>[0];

function rewriter(insets: Insets): (text: string) => string {
  const rewrite = safeAreaRewrite(insets);
  assert.ok(rewrite, 'the insets set something');
  return rewrite;
}

/** Checks the rewrite of each input against its output. */
function expectRewrites(insets: Insets, pairs: readonly (readonly [string, string])[]) {
  const rewrite = rewriter(insets);
  for (const [input, output] of pairs) assert.equal(rewrite(input), output, `rewrite of ${JSON.stringify(input)}`);
}

// Plain env() calls.

test('a set inset replaces its env(), fallback included, with its length in px', () => {
  expectRewrites({ top: 10, left: 3, bottom: 0, right: 5.5, topMax: 20, leftMax: 4, bottomMax: 6, rightMax: 8 }, [
    ['padding: env(safe-area-inset-top, 7px)', 'padding: 10px'],
    ['env(safe-area-inset-top)', '10px'],
    ['env(safe-area-inset-left) env(safe-area-inset-bottom) env(safe-area-inset-right)', '3px 0px 5.5px'],
    ['env(safe-area-max-inset-top, 1px)', '20px'],
    ['env(safe-area-max-inset-left)', '4px'],
    ['env(safe-area-max-inset-bottom)', '6px'],
    ['env(safe-area-max-inset-right)', '8px'],
    ['env(safe-area-inset-top,7px)', '10px'],
    ['env(safe-area-inset-top, env(safe-area-inset-bottom))', '10px'],
  ]);
});

test('an inset that is not set keeps its real value', () => {
  expectRewrites({ top: 10 }, [
    ['env(safe-area-inset-bottom)', 'env(safe-area-inset-bottom)'],
    ['env(safe-area-max-inset-top)', 'env(safe-area-max-inset-top)'],
    ['env(safe-area-max-inset-left)', 'env(safe-area-max-inset-left)'],
    ['margin: env(safe-area-inset-bottom) 0 0', 'margin: env(safe-area-inset-bottom) 0 0'],
  ]);
});

test('a function around env(), and spacing and case in the name', () => {
  expectRewrites({ top: 10 }, [
    ['calc(env(safe-area-inset-top) + 1px)', 'calc(10px + 1px)'],
    ['ENV(SAFE-AREA-INSET-TOP)', '10px'],
    ['env( safe-area-inset-top )', '10px'],
    ['ENV( SAFE-AREA-INSET-TOP , 7px )', '10px'],
  ]);
});

test('an env() in the fallback of an env() that is not replaced is replaced', () => {
  expectRewrites({ top: 10 }, [
    ['env(safe-area-inset-bottom, env(safe-area-inset-top))', 'env(safe-area-inset-bottom, 10px)'],
    ['env(safe-area-inset-top, env(safe-area-inset-bottom))', '10px'],
  ]);
});

test('each occurrence is replaced, and the text around it kept', () => {
  expectRewrites({ top: 10 }, [
    [
      'padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); ' +
        'color: red; margin-top: env(safe-area-inset-top, 2px)',
      'padding: 10px 0 env(safe-area-inset-bottom); color: red; margin-top: 10px',
    ],
  ]);
});

test('a fallback that is not closed is replaced up to the end of the text', () => {
  expectRewrites({ top: 10 }, [['env(safe-area-inset-top, 1px', '10px']]);
});

test('an inset of zero is set', () => {
  expectRewrites({ left: 0 }, [['env(safe-area-inset-left, 4px)', '0px']]);
});

test('an argument that is not the inset name, alone or before a fallback, is left alone', () => {
  expectRewrites({ top: 10 }, [
    ['env(safe-area-inset-topx)', 'env(safe-area-inset-topx)'],
    ['env(safe-area-inset-top foo)', 'env(safe-area-inset-top foo)'],
    ['env(other, safe-area-inset-top)', 'env(other, safe-area-inset-top)'],
    ['env(other)', 'env(other)'],
  ]);
});

test('no inset set gives no rewrite, and text without env() is unchanged', () => {
  assert.equal(safeAreaRewrite({}), null);
  expectRewrites({ top: 10 }, [['color: red', 'color: red']]);
});

// Where the text is read as CSS reads it: an env() in a comment, a string or an unquoted url() is not a
// call, a name that only ends in env is not env(), and a comment or a string in a fallback does not end
// the call early. An env() left open at the end of the text is closed there, as CSS closes it.

test('a comment inside env() is not read as the end of the argument', () => {
  expectRewrites({ top: 10 }, [['env(safe-area-inset-top /* ) */)', '10px']]);
});

test('a comment that mentions env() is not replaced', () => {
  expectRewrites({ top: 10 }, [
    [
      '/* env(safe-area-inset-top) */ padding: env(safe-area-inset-top)',
      '/* env(safe-area-inset-top) */ padding: 10px',
    ],
  ]);
});

test('a string that mentions env() is not replaced', () => {
  expectRewrites({ top: 10 }, [['content: "env(safe-area-inset-top)"', 'content: "env(safe-area-inset-top)"']]);
});

test('a parenthesis in a string or a comment of the fallback does not end the env()', () => {
  expectRewrites({ top: 10 }, [
    ['env(safe-area-inset-top, ")") x', '10px x'],
    ['env(safe-area-inset-top, /* ( */ 1px) x', '10px x'],
  ]);
});

test('env() in an unquoted url() is part of the url', () => {
  expectRewrites({ top: 10 }, [
    ['background: url(env(safe-area-inset-top))', 'background: url(env(safe-area-inset-top))'],
  ]);
});

test('a function whose name ends in env is not env()', () => {
  expectRewrites({ top: 10 }, [['myenv(safe-area-inset-top)', 'myenv(safe-area-inset-top)']]);
});

test('an env() that is not closed at the end of the text is closed there', () => {
  expectRewrites({ top: 10 }, [['padding: env(safe-area-inset-top', 'padding: 10px']]);
});

test('an escaped character in the name is compared as written, not decoded', () => {
  expectRewrites({ top: 10 }, [['env(safe-area-inset-\\74 op)', 'env(safe-area-inset-\\74 op)']]);
});
