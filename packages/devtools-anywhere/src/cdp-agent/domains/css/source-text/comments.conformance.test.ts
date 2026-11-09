// Comments in a style block that read as a declaration, compared with Chrome: Blink reports one
// as a disabled property only when the declaration in it parses (a property it knows, with a
// valid value), with what that means for custom properties, `!important`, shorthands, var(),
// case, vendor prefixes, semicolons and white space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both, nodeId, style } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

let seq = 0;

/** `.cmN { <block> }` on an element: our rules and text are Chrome's. */
async function same(block: string) {
  const cls = `cm${++seq}`;
  await sameRules(`.${cls} { ${block} }\n.${cls} { top: 1px }`, cls);
}

/** `css` with an element of class `cls`: our rules, in number and with their ranges, are Chrome's. */
async function sameRules(css: string, cls: string) {
  const at = await addStyle(t, css, `<p class="${cls}">x</p>`);
  const { ours, chrome } = await both(t, `${at} .${cls}`);
  assert.equal(ours.text, chrome.text);
  assert.ok(chrome.rules.length);
  assert.equal(ours.rules.length, chrome.rules.length);
  assert.deepEqual(ours.rules, chrome.rules);
}

const sides = () =>
  [
    ['ours', t.ours],
    ['chrome', t.chrome],
  ] as const satisfies readonly (readonly [string, Side])[];

/** The written properties of a style, without the longhands it holds. */
const declared = (s: ReturnType<typeof style>) =>
  s.properties
    .filter(p => p.range !== undefined)
    .map(({ name, value, disabled, parsedOk }) => ({ name, value, disabled, parsedOk }));

test('notes, unknown properties and invalid values: only a valid declaration is disabled', () =>
  same(`/* note: see ticket */ /* TODO: fix */ /* color: red; */ /* colr: red */ /* color: 12px */ margin: 0`));

test('custom properties', () =>
  same(
    `/* --x: 1 */ /* --y: {a} */ /* --z: ) */ /* --w:  */ /* --v: a!important */ /* --b: !important */ /* --a:; */ color: red`
  ));

test('!important', () =>
  same(
    `/* color: red !important */ /* color: 12px !important */ /* color: red ! IMPORTANT */ /* color: red !important x */ /* color: !important */ top: 0`
  ));

test('shorthands', () =>
  same(
    `/* margin: 1px 2px */ /* background: red url(x.png) no-repeat */ /* font: 12px serif */ /* margin: red */ /* font: bold */ top: 0`
  ));

test('var() values', () =>
  same(
    `/* color: var(--a) */ /* margin: var(--a) 1px */ /* color: var(--a, red) */ /* color: var(a) */ /* color: var( */ top: 0`
  ));

test('case and vendor prefixes', () =>
  same(
    `/* COLOR: RED */ /* Color: red */ /* -webkit-box-shadow: 0 0 1px red */ /* -webkit-appearance: none */ /* -moz-appearance: none */ /* -webkit-foo: 1 */ /* -WEBKIT-USER-SELECT: none */ top: 0`
  ));

test('semicolons and white space', () =>
  same(`/*color:red;;*/ /*  color :  red  ;  */ /* color: red; margin: 1px */ /* color: red; garbage */ /*
  color:
  red
*/ top: 0`));

test('CSS-wide keywords and functions', () =>
  same(
    `/* color: inherit */ /* margin: revert-layer */ /* width: calc(1px + 2px) */ /* width: calc(1px + red) */ /* content: "a;b" */ /* color: attr(x) */ /* width: 1px !ie */ top: 0`
  ));

test('comments between declarations keep the cssId pairing and ranges of the others', () =>
  same(`color: red; /* colr: red */ margin: 0; /* color: 12px */ padding: 1px; /* color: blue */ top: 2px`));

test('vendor prefixes Blink keeps whatever the value, lower case only', () =>
  same(
    `/* -webkit-foo: ) */ /* -moz-foo: 1 */ /* -ms-foo: */ /* -o-foo: 1 !important x */ /* -webkit-: 1 */ /* -webkit-box-shadow: 12 */ /* -WEBKIT-FOO: 1 */ /* -khtml-foo: 1 */ /* -internal-foo: 1 */ /* -x-foo: 1 */ /* -epub-caption-side: top */ /* -webkit-foo: 1; color: red */ top: 0`
  ));

test('escaped names and unknown prefixes', () => same(`/* col\\6f r: red */ /* -foo-bar: 1 */ /* \\2d-x: 1 */ top: 0`));

test(
  'a comment opening in a custom property value',
  { todo: 'Chrome gives `--x:/**/` the value `/*`, the outline none (css-outline.ts)' },
  () => same(`/* --x:/**/ */ top: 0`)
);

test('two rules of one selector differing only in their comments pair in order', () => {
  const cls = `cm${++seq}`;
  return sameRules(
    `.${cls} { /* color: 12px */ top: 0 }\n.${cls} { /* color: red */ top: 0 }\n.${cls} { /* colr: red */ top: 0 }`,
    cls
  );
});

test('declarations not in comments: invalid ones are still reported, parsedOk false', () =>
  same(`colr: red; color: 12px; /* color: 12px */ top: 0`));

test('keyframes: the same comments are disabled as in a rule, whatever a keyframe ignores', async () => {
  await addStyle(
    t,
    `@keyframes cmk { 0% { /* animation-name: x */ /* color: red !important */ /* top: 1px */ /* colr: 1 */ /* top: red */ left: 0 } }`,
    `<p id="cmk" style="animation: cmk 100s">x</p>`
  );
  const [ours, chrome] = await Promise.all(
    sides().map(async ([, side]) => {
      const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, '#cmk') });
      const k = res.cssKeyframesRules?.find(r => r.animationName.text === 'cmk')?.keyframes[0];
      return k && style(k.style);
    })
  );
  assert.ok(chrome);
  assert.deepEqual(ours, chrome);
});

test('inline styles: the style attribute and setStyleTexts report the same comments as a rule', async () => {
  const comments = '/* foo: bar */ /* color: 12px */ /* color: blue */ /* -webkit-foo: ) */ /* --x: */ /* colr: red */';
  await addStyle(t, '', `<p id="cmi1" style="color: red; ${comments}">x</p><p id="cmi2">y</p>`);
  const [ours, chrome] = await Promise.all(
    sides().map(async ([, side]) => {
      const attr = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, '#cmi1') });
      const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, '#cmi2') });
      assert.ok(attr.inlineStyle && inlineStyle?.styleSheetId && inlineStyle.range);
      const { styles } = await side.send('CSS.setStyleTexts', {
        edits: [{ styleSheetId: inlineStyle.styleSheetId, range: inlineStyle.range, text: `color: red; ${comments}` }],
      });
      const again = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, '#cmi2') });
      assert.ok(styles[0] && again.inlineStyle);
      return [attr.inlineStyle, styles[0], again.inlineStyle].map(s => declared(style(s)));
    })
  );
  assert.deepEqual(ours, chrome);
});

test('the page replacing CSS.supports and window.CSS changes nothing', async () => {
  await t.page.evaluate(() => {
    const w = window as unknown as { CSS: unknown; savedCss?: unknown; savedSupports?: unknown };
    w.savedCss = w.CSS;
    w.savedSupports = CSS.supports;
    CSS.supports = () => false;
    w.CSS = { supports: () => false };
  });
  try {
    await same(`/* color: red */ /* color: 12px */ /* margin: 1px 2px */ /* colr: red */ top: 0`);
  } finally {
    await t.page.evaluate(() => {
      const w = window as unknown as { CSS: unknown; savedCss: { supports: unknown }; savedSupports: unknown };
      w.CSS = w.savedCss;
      w.savedCss.supports = w.savedSupports;
    });
  }
});
