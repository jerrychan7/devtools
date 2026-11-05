// css-outline.ts against Chrome's parser: the rules outline() finds in a sheet are the ones CSSOM
// keeps, in order, once those CSSOM drops for their selector or prelude are left out. Which ones
// those are is asked of Chrome too, by parsing each rule's text alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env } from '../../../../../test-support/conformance.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CssRule, outline as Outline } from './css-outline.ts';

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
  if (!nested) return rules.length;
  const shape = (t: Tree[]): unknown => t.map(([, kids]) => shape(kids));
  const kept = rules.filter((_, i) => alone[i]?.length);
  kept.forEach((r, i) =>
    assert.deepEqual(
      shape(ours(r)),
      shape(whole[i]?.[1] ?? []),
      `${text.slice(r.start, r.end)}\n${JSON.stringify(whole[i])}`
    )
  );
  return rules.length;
}

test("Chrome's user agent style sheet", async () => {
  const text = readFileSync(new URL('../user-agent/html.css', import.meta.url), 'utf8');
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
