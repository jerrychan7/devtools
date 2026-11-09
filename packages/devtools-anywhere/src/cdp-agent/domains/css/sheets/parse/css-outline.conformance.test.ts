// css-outline.ts against Chrome's parser: the rules outline() finds in a sheet are the ones CSSOM
// keeps, in order, once those CSSOM drops for their selector or prelude are left out. Which ones
// those are is asked of Chrome too, by parsing each rule's text alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../../../../../../test-support/conformance.ts';
import type { Env } from '../../../../../../test-support/conformance.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CssRule, dashed as Dashed, outlineTree as Outline } from './css-outline.ts';

// Bundled: the sources import each other without extensions, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: "export { outlineTree as outline, dashed } from './css-outline.ts';",
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { outline, dashed }: { outline: typeof Outline; dashed: typeof Dashed } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
);

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
  },
  () => env?.close()
);

/** Each rule as CSSOM serializes it, nested rules in it as a tree. */
type Tree = [string, Tree[]];

/** Chrome's rules of `text` and, for each of `parts`, of its text alone. */
function cssom(text: string, parts: string[]): Promise<{ whole: Tree[]; alone: Tree[][] }> {
  return page.evaluate(
    (text, parts) => {
      const walk = (rules: CSSRuleList): Tree[] =>
        Array.from(rules, r => {
          const kids = 'cssRules' in r && r.cssRules instanceof CSSRuleList ? walk(r.cssRules) : [];
          return [r.constructor.name, kids];
        });
      const parse = (t: string) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(t);
        return walk(sheet.cssRules);
      };
      return { whole: parse(text), alone: parts.map(parse) };
    },
    text,
    parts
  );
}

const ours = (r: CssRule): Tree[] => r.rules.map(c => [c.kind, ours(c)]);

async function check(text: string, nested = true) {
  const rules = outline(text);
  const { whole, alone } = await cssom(
    text,
    rules.map(r => text.slice(r.start, r.end))
  );
  // Each rule alone parses to at most one rule, and together they are the sheet's.
  for (const a of alone) assert.ok(a.length <= 1, JSON.stringify(a));
  assert.deepEqual(
    alone.flat().map(t => t[0]),
    whole.map(t => t[0])
  );
  // Nested rules: as many, at each level, as CSSOM keeps of the rules it keeps. Only for texts
  // whose nested rules and declarations are all valid: CSSOM drops nested rules with invalid
  // selectors, and makes no nested declarations rule of a run of invalid declarations.
  const kept = rules.filter((_, i) => alone[i]?.length);
  // The kinds too: a run of declarations taken for a nested style rule, or the other way round,
  // would be as many rules.
  assert.deepEqual(
    kept.map(r => r.kind),
    whole.map(([name]) => kindOf(name))
  );
  if (!nested) return rules.length;
  const shape = (t: Tree[]): unknown => t.map(([name, kids]) => [kindOf(name), shape(kids)]);
  kept.forEach((r, i) =>
    assert.deepEqual(
      shape(ours(r)),
      shape(whole[i]?.[1] ?? []),
      `${text.slice(r.start, r.end)}\n${JSON.stringify(whole[i])}`
    )
  );
  return rules.length;
}

/**
 * The outline's kind of a rule of Chrome's, by its constructor's name, or the kind itself. A
 * keyframe (`from {}`, `50% {}`) is a qualified rule in the syntax, as the outline takes it.
 */
const kindOf = (name: string): string =>
  name === 'CSSStyleRule' || name === 'CSSKeyframeRule' || name === 'qualified'
    ? 'qualified'
    : name === 'CSSNestedDeclarations' || name === 'nested'
      ? 'nested'
      : 'at';

test("Chrome's user agent style sheet", async () => {
  const text = readFileSync(new URL('../../user-agent/html.css', import.meta.url), 'utf8');
  assert.ok((await check(text, false)) > 250);
});

test('error recovery', async () => {
  await check(`
    a { color: red } } b { x: y }
    c { d: "unclosed
      ; e: f }
    g { h: url(a b); i: j }
    @media screen { k { l: m } } } n {}
    @font-face { font-family: x; src: url(a.woff) }
    --custom: { a } o { p: q }
    @import url(x);
    r { s: t ( } ) u ; v: w } }
    <!-- x { y: z } -->
    @supports (display: grid) { @media (min-width: 1px) { a { b: c } } }
    @layer a, b;
    @keyframes k { from { top: 0 } 50% { top: 1px } to { top: 2px } }
    z { a: b
  `);
});

test('nesting', async () => {
  await check(`
    a { color: red; &:hover { color: blue } margin: 0; .b { c: d } padding: 0 }
    e { > f { g: h } @media screen { color: red; i { j: k } } top: 0 }
    n { o:hover { p: q } left: 0; }
    t { u: v; w { } right: 0; }
    @media print { a { b { c { d: e } } } }
    @supports (x: y) { a { @layer l { top: 0 } } }
  `);
});

/**
 * Where a rule's text `a{…}` is put: as it is, nested, in nested declarations, and each of those
 * in @media, @supports and @layer.
 */
const places = (text: string): string[] => {
  const inner = text.slice(text.indexOf('{') + 1, text.endsWith('}') ? -1 : undefined);
  const three = [text, `p { color: red; ${text} }`, `p { q {} ${inner} }`];
  return [
    ...three,
    ...three.map(t => `@media all { ${t} }`),
    ...three.map(t => `@supports (top:0) { ${t} }`),
    ...three.map(t => `@layer l { ${t} }`),
  ];
};

/** Each `--x` of `t` Chrome keeps, with its priority; and whether any style holds `top`. */
function chromeCustom(t: string): Promise<{ found: [string, string][]; top: boolean }> {
  return page.evaluate(t => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(t);
    const found: [string, string][] = [];
    let top = false;
    const look = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        const style = 'style' in r ? (r.style as CSSStyleDeclaration) : undefined;
        if (style && Array.from(style).includes('--x'))
          found.push([style.getPropertyValue('--x').trim(), style.getPropertyPriority('--x')]);
        if (style && Array.from(style).includes('top')) top = true;
        if ('cssRules' in r && r.cssRules instanceof CSSRuleList) look(r.cssRules);
      }
    };
    look(sheet.cssRules);
    return { found, top };
  }, t);
}

/** The outline's declarations of `t` that pass `keep`, wherever they are. */
function oursDecls(t: string, keep: (d: CssRule['decls'][number]) => boolean): CssRule['decls'] {
  const list: CssRule['decls'] = [];
  const collect = (rules: CssRule[]) => {
    for (const r of rules) {
      list.push(...r.decls.filter(d => d.kind === 'decl' && keep(d)));
      collect(r.rules);
    }
  };
  collect(outline(t));
  return list;
}

test("`{}` blocks in a custom property's value, at the top, nested and in conditions", async () => {
  // The text; the custom property's value and priority Chrome reads, `dropped` where it drops
  // the declaration, `none` where the name is no custom property's; whether to put it in places().
  type Expected = [string, string] | 'dropped' | 'none';
  const cases: [string, Expected, boolean][] = [
    ['a { --x: {} b { c: d } e: f }', ['{} b { c: d } e: f', ''], true],
    ['a{--x:{a} b; top:0}', ['{a} b', ''], true],
    ['a { --x: a {} ; top: 0}', ['a {}', ''], true],
    ['a { --x: {} b !important; top: 0 }', ['{} b', 'important'], true],
    ['a { --x: {a} !important; top: 0 }', ['{a}', 'important'], true],
    ['a{--x:{}}', ['{}', ''], true],
    // Escaped names, which Chrome takes for `--x`, or not (`\2da` is `ڪ`).
    ['a{\\2d-x:{a} b;top:0}', ['{a} b', ''], true],
    ['a{\\-\\-x:{a} b;top:0}', ['{a} b', ''], true],
    ['a{-\\-x:{a} b;top:0}', ['{a} b', ''], true],
    ['a{\\2d\\2dx:{a} b;top:0}', ['{a} b', ''], true],
    ['a{\\2D\\2D x:{a} b;top:0}', ['{a} b', ''], true],
    ['a{\\2da-x:{a} b;top:0}', 'none', true],
    // An unclosed `(` takes the rest of the text into the value, which Chrome drops: one
    // declaration still, that pairs with none.
    ['a{--x:{a} (b;top:0}', 'dropped', true],
    // A block left open runs to the end of the text: not put in other rules, which it would take.
    ['a{--x:{ b', ['{ b', ''], false],
    ['p { q {} --x:{ b', ['{ b', ''], false],
    ['@media all { a{--x:{ b', ['{ b', ''], false],
  ];
  for (const [text, expected, wrap] of cases) {
    for (const t of wrap ? places(text) : [text]) {
      // Nested rules compared only where the CSSOM keeps the declarations (see check): not where
      // it drops one, or a rule given up as one (`\2da-x:{a} b`, a rule with an invalid selector).
      await check(t, typeof expected !== 'string');
      const chrome = await chromeCustom(t);
      const ours = oursDecls(t, d => dashed(t, d.start, d.nameEnd));
      if (expected === 'none' || expected === 'dropped') assert.deepEqual(chrome.found, [], t);
      else {
        assert.deepEqual(chrome.found, [expected], t);
        assert.deepEqual(
          ours.map(d => [t.slice(d.valueStart, d.valueEnd), d.important]),
          [[expected[0], expected[1] === 'important']],
          t
        );
      }
      if (expected === 'none') {
        assert.deepEqual(ours, [], t);
        // Ours has it as a declaration of its own name, given up at its `{` (then a rule).
        const name = text.slice(text.indexOf('{') + 1, text.indexOf(':'));
        assert.ok(
          outline(t).some(function has(r: CssRule): boolean {
            return t.slice(r.preludeStart, r.preludeEnd).startsWith(name) || r.rules.some(has);
          }),
          t
        );
      }
      if (expected === 'dropped') {
        // `top:0` is in the value on both sides, which runs to the end of the text.
        assert.equal(chrome.top, false, t);
        assert.deepEqual(
          oursDecls(t, d => t.startsWith('top', d.start)),
          [],
          t
        );
        assert.equal(ours.length, 1, t);
        assert.equal(ours[0]?.valueEnd, t.trimEnd().length, t);
      }
    }
  }
});

test('in Chrome, `top` after `x:a {}` belongs to the style rule or the nested declarations', async () => {
  // `x:a {}` is a rule with an invalid selector, which the CSSOM drops. Only the premise of how
  // the CSS domain reads it is checked here: `top:0` after it is the style rule's own in Chrome,
  // or of the nested declarations after `q {}`, though the outline makes it a nested run after
  // `x:a {}` either way. Reading it so (sheets/text/ranges.ts, runsOf) is compared with Chrome in
  // source-text/ranges.conformance.test.ts.
  const expected = ['CSSStyleRule', 'CSSStyleRule', 'CSSNestedDeclarations'];
  const all = places('a{x:a {} ; top:0}');
  // The three places, then each of them in three conditions.
  assert.equal(all.length, 12);
  for (const [i, t] of all.entries()) {
    await check(t, false);
    const chrome = await page.evaluate(t => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(t);
      const holders: string[] = [];
      const look = (rules: CSSRuleList) => {
        for (const r of Array.from(rules)) {
          const style = 'style' in r ? (r.style as CSSStyleDeclaration) : undefined;
          if (style && Array.from(style).includes('top')) holders.push(r.constructor.name);
          if ('cssRules' in r && r.cssRules instanceof CSSRuleList) look(r.cssRules);
        }
      };
      look(sheet.cssRules);
      return holders;
    }, t);
    assert.deepEqual(chrome, [expected[i % 3]], t);
  }
});

test('a prelude that starts like an escaped custom property declaration makes no rule', async () => {
  for (const t of ['\\2d-x: {a} b{}', '\\-\\-x: {a} b{}', '\\2e-x: {a} b{}', '\\2d-x /**/ : {a} b{}']) await check(t);
});
