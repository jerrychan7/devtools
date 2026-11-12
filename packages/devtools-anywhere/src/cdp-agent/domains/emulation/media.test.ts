import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Protocol } from 'devtools-protocol';
import { build } from 'esbuild';
import type * as Media from './media.ts';

// Bundled: the modules import each other without an extension, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export * from './media.ts';",
    resolveDir: dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { mediaRewrite, rewriteMediaQuery } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof Media;

type Params = Protocol.Emulation.SetEmulatedMediaRequest;

/** What a feature that holds becomes, and one that does not. */
const TRUE = '(min-width: 0px)';
const FALSE = '(not (min-width: 0px))';
/** The type that the types other than the emulated one become. */
const NO_TYPE = 'devtools-anywhere-none';

function rewriter(params: Params): (text: string) => string {
  const rewrite = mediaRewrite(params);
  assert.ok(rewrite, 'the params emulate something');
  return rewrite;
}

/** Checks the rewrite of each input against its output. */
function expectRewrites(params: Params, pairs: readonly (readonly [string, string])[]) {
  const rewrite = rewriter(params);
  for (const [input, output] of pairs) assert.equal(rewrite(input), output, `rewrite of ${JSON.stringify(input)}`);
}

// Plain queries and features.

test('an emulated media type: that type becomes all, the other types match nothing', () => {
  expectRewrites({ media: 'print' }, [
    ['print', 'all'],
    ['PRINT', 'all'],
    ['all', 'all'],
    ['screen', NO_TYPE],
    [' print ', 'all'],
    ['print, screen', `all, ${NO_TYPE}`],
    ['screen,print', `${NO_TYPE}, all`],
    ['print and (color)', 'all and (color)'],
    ['SCREEN AND (COLOR)', `${NO_TYPE} AND (COLOR)`],
    ['not screen and (color)', `not ${NO_TYPE} and (color)`],
    ['only print', 'only all'],
    ['not print', 'not all'],
    ['only screen', `only ${NO_TYPE}`],
    ['not all and (monochrome)', 'not all and (monochrome)'],
    ['(color)', '(color)'],
    ['(min-width: 600px)', '(min-width: 600px)'],
    ['', ''],
    ['screen and (color), print and (min-width: 1px)', `${NO_TYPE} and (color), all and (min-width: 1px)`],
  ]);
});

test('an emulated screen: screen becomes all', () => {
  expectRewrites({ media: 'screen' }, [
    ['screen', 'all'],
    ['print, screen', `${NO_TYPE}, all`],
  ]);
});

test('a feature with a value holds when the emulated value is that value', () => {
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['(prefers-color-scheme: dark)', TRUE],
    ['(prefers-color-scheme: light)', FALSE],
    ['(PREFERS-COLOR-SCHEME: DARK)', TRUE],
    ['( prefers-color-scheme : dark )', TRUE],
    ['(prefers-color-scheme:dark)', TRUE],
    ['(min-width: 600px) and (prefers-color-scheme: dark)', `(min-width: 600px) and ${TRUE}`],
    ['not (prefers-color-scheme: dark)', `not ${TRUE}`],
    ['(prefers-color-scheme: dark) and (prefers-color-scheme: light)', `${TRUE} and ${FALSE}`],
    ['((prefers-color-scheme: dark))', `(${TRUE})`],
  ]);
});

test('a feature without a value holds unless its value is none or no-preference', () => {
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'light' }] }, [['(prefers-color-scheme)', TRUE]]);
  expectRewrites({ features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, [
    ['(prefers-reduced-motion)', FALSE],
    ['(prefers-reduced-motion: no-preference)', TRUE],
    ['(prefers-reduced-motion: reduce)', FALSE],
  ]);
  expectRewrites({ features: [{ name: 'forced-colors', value: 'active' }] }, [
    ['(forced-colors)', TRUE],
    ['(forced-colors: none)', FALSE],
  ]);
});

test('prefers-reduced-transparency is emulated like the others', () => {
  expectRewrites({ features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] }, [
    ['(prefers-reduced-transparency)', FALSE],
    ['(prefers-reduced-transparency: no-preference)', TRUE],
    ['(prefers-reduced-transparency: reduce)', FALSE],
  ]);
});

test('prefers-reduced-data is not emulated: its queries are left to the browser', () => {
  for (const value of ['reduce', 'no-preference']) {
    const params = { features: [{ name: 'prefers-reduced-data', value }] };
    assert.equal(mediaRewrite(params), null, value);
    assert.equal(rewriteMediaQuery('(prefers-reduced-data: reduce)', params), '(prefers-reduced-data: reduce)', value);
    assert.equal(rewriteMediaQuery('(prefers-reduced-data)', params), '(prefers-reduced-data)', value);
  }
  assert.equal(
    rewriteMediaQuery('(prefers-reduced-data: reduce) and (prefers-color-scheme: dark)', {
      features: [
        { name: 'prefers-reduced-data', value: 'reduce' },
        { name: 'prefers-color-scheme', value: 'dark' },
      ],
    }),
    `(prefers-reduced-data: reduce) and ${TRUE}`
  );
});

test('color-gamut: a screen that shows p3 shows srgb too', () => {
  expectRewrites({ features: [{ name: 'color-gamut', value: 'p3' }] }, [
    ['(color-gamut: srgb)', TRUE],
    ['(color-gamut: p3)', TRUE],
    ['(color-gamut: rec2020)', FALSE],
  ]);
});

test('a value the feature does not have is unknown, so the browser decides it', () => {
  // Unknown is neither true nor false: `not` of it is not true, and `or` with a true condition is true.
  expectRewrites({ features: [{ name: 'color-gamut', value: 'p3' }] }, [
    ['(color-gamut: display-p3)', '(color-gamut: display-p3)'],
    ['not (color-gamut: display-p3)', 'not (color-gamut: display-p3)'],
    ['(color-gamut: display-p3) or (color)', '(color-gamut: display-p3) or (color)'],
  ]);
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['(prefers-color-scheme: blue)', '(prefers-color-scheme: blue)'],
    ['not (prefers-color-scheme: no-preference)', 'not (prefers-color-scheme: no-preference)'],
    ['(prefers-color-scheme: blue) and (prefers-color-scheme: dark)', `(prefers-color-scheme: blue) and ${TRUE}`],
  ]);
});

test('color-gamut under rec2020 holds for every gamut, and under srgb for srgb alone', () => {
  expectRewrites({ features: [{ name: 'color-gamut', value: 'rec2020' }] }, [
    ['(color-gamut: srgb)', TRUE],
    ['(color-gamut: p3)', TRUE],
    ['(color-gamut: rec2020)', TRUE],
  ]);
  expectRewrites({ features: [{ name: 'color-gamut', value: 'srgb' }] }, [
    ['(color-gamut: srgb)', TRUE],
    ['(color-gamut: p3)', FALSE],
    ['(color-gamut: rec2020)', FALSE],
  ]);
});

test('prefers-contrast with a value, and a feature value is compared without case', () => {
  expectRewrites({ features: [{ name: 'prefers-contrast', value: 'more' }] }, [
    ['(prefers-contrast: more)', TRUE],
    ['(prefers-contrast: less)', FALSE],
    ['(prefers-contrast)', TRUE],
  ]);
  expectRewrites({ features: [{ name: 'Prefers-Color-Scheme', value: 'DARK' }] }, [
    ['(prefers-color-scheme: dark)', TRUE],
  ]);
});

test('features that are not emulated, and ranges, are left alone', () => {
  const rewrite = rewriter({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  for (const query of [
    '(prefers-reduced-motion: reduce)',
    '(prefers-color-scheme-x: dark)',
    '(prefers-color-scheme > dark)',
    '(prefers-color-scheme: dark light)',
    '(prefers-color-scheme: calc(dark))',
    '(prefers-color-scheme: "dark")',
    '(prefers-color-scheme: dark !important)',
    '(prefers-color-scheme: var(--x))',
  ]) {
    assert.equal(rewrite(query), query, query);
  }
});

test('a feature value that is not an emulated value is ignored, and nothing emulated gives no rewrite', () => {
  assert.equal(mediaRewrite({ features: [{ name: 'prefers-color-scheme', value: 'blue' }] }), null);
  assert.equal(mediaRewrite({}), null);
  assert.equal(mediaRewrite({ media: '' }), null);
  assert.equal(mediaRewrite({ features: [] }), null);
  assert.equal(mediaRewrite({ features: [{ name: 'no-such-feature', value: 'x' }] }), null);
});

test('a media type and a feature together, and several features', () => {
  const rewrite = rewriter({ media: 'print', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  assert.equal(rewrite('screen and (prefers-color-scheme: light)'), `${NO_TYPE} and ${TRUE}`);
  assert.equal(rewrite('print and (prefers-color-scheme: dark)'), `all and ${FALSE}`);
  expectRewrites(
    {
      features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    },
    [['(prefers-color-scheme: dark) and (prefers-reduced-motion: reduce)', `${TRUE} and ${TRUE}`]]
  );
});

// Where the text is read as CSS reads it: comments are not parts of a query, the words of a query are
// decoded (escapes included), a value that is not one identifier is left alone, and a block that is open
// at the end of the query is closed there.

test('a comment is not a query, a feature or a type', () => {
  expectRewrites({ media: 'print' }, [
    ['screen /* print */', `${NO_TYPE} /* print */`],
    ['print /* x */', 'all /* x */'],
    ['not/**/screen', `not/**/${NO_TYPE}`],
    ['/* (print) */ screen', `/* (print) */ ${NO_TYPE}`],
    ['screen /* a, b */, print', `${NO_TYPE} /* a, b */, all`],
  ]);
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['(prefers-color-scheme: dark /* x */)', TRUE],
    ['/* (prefers-color-scheme: dark) */ (color)', '/* (prefers-color-scheme: dark) */ (color)'],
  ]);
});

test('an escaped character is part of its name, not a delimiter', () => {
  expectRewrites({ media: 'print' }, [['a\\,print', NO_TYPE]]);
});

test('CSS escapes are decoded before a word is compared: \\61ll is all', () => {
  expectRewrites({ media: 'print' }, [
    ['\\61ll', 'all'],
    ['\\61 ll', 'all'],
    ['pr\\69nt', 'all'],
    ['\\50RINT and (color)', 'all and (color)'],
    ['not \\70rint', 'not all'],
    ['\\6eot screen', `\\6eot ${NO_TYPE}`],
    ['print \\61nd (color)', 'all \\61nd (color)'],
    ['\\6fnly print', '\\6fnly all'],
  ]);
  // Hex digits are greedy: \65e is one escape, so this is scr, U+065E and n, not screen.
  expectRewrites({ media: 'screen' }, [
    ['scr\\65 en', 'all'],
    ['scr\\65en', NO_TYPE],
  ]);
});

test('CSS escapes in a feature name and value are decoded too', () => {
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['(prefers-color-schem\\65: dark)', TRUE],
    ['(\\70refers-color-scheme: d\\61rk)', TRUE],
    ['(prefers-color-scheme: \\6c ight)', FALSE],
    // The escaped colon is a character of the name, so this is another feature.
    ['(prefers-color-scheme\\3a dark)', '(prefers-color-scheme\\3a dark)'],
  ]);
  expectRewrites({ features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, [
    ['(\\70refers-reduced-motion)', FALSE],
  ]);
});

test('the parts of a list are trimmed as CSS trims them, so that no part reads into the next', () => {
  expectRewrites({ media: 'print' }, [
    ['"a\n, print', '"a\n, all'],
    ['print ', NO_TYPE],
    ['﻿print', NO_TYPE],
    ['print\u000b', 'print\u000b'],
    ['  print  ,  screen  ', `all, ${NO_TYPE}`],
  ]);
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['x\\ , (prefers-color-scheme: dark)', `x\\ , ${TRUE}`],
    ['a\\\n, (prefers-color-scheme: dark)', `a\\\n, ${TRUE}`],
  ]);
});

test('layer is a keyword, not a media type, so a query with it is left to the browser', () => {
  expectRewrites({ media: 'print' }, [
    ['layer', 'layer'],
    ['not layer', 'not layer'],
    ['only layer', 'only layer'],
    ['print, layer', 'all, layer'],
  ]);
});

test('a feature value that is not a single identifier is left alone', () => {
  expectRewrites({ features: [{ name: 'prefers-contrast', value: 'more' }] }, [
    ['(prefers-contrast: 1)', '(prefers-contrast: 1)'],
    ['not (prefers-contrast: 1)', 'not (prefers-contrast: 1)'],
  ]);
});

test('names and values compare ASCII letters only: a Kelvin sign is not a k', () => {
  // The sign lowercases to k in Unicode, but it is not an ASCII letter: the value is not `dark`, so it is
  // a value the feature does not have, and is left to the browser.
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['(prefers-color-scheme: dar\u{212A})', '(prefers-color-scheme: dar\u{212A})'],
  ]);
});

test('a block left open at the end of the query is closed there, as CSS closes it', () => {
  expectRewrites({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, [
    ['(prefers-color-scheme: dark', TRUE],
    ['(prefers-color-scheme', TRUE],
    ['(prefers-color-scheme: light', FALSE],
  ]);
});

test('a feature name that is an Object.prototype property is an unknown feature', () => {
  assert.equal(mediaRewrite({ features: [{ name: 'constructor', value: 'x' }] }), null);
  assert.equal(mediaRewrite({ features: [{ name: '__proto__', value: 'x' }] }), null);
});

test('rewriteMediaQuery rewrites a query list, and returns it unchanged when nothing is emulated', () => {
  assert.equal(
    rewriteMediaQuery('print, screen and (prefers-color-scheme: dark)', {
      media: 'print',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    }),
    `all, ${NO_TYPE} and ${TRUE}`
  );
  assert.equal(rewriteMediaQuery('  screen ,(color)  ', {}), '  screen ,(color)  ');
  assert.equal(rewriteMediaQuery('(prefers-color-scheme: dark)', { media: '' }), '(prefers-color-scheme: dark)');
});
