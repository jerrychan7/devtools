// The runs of declarations ranges.ts reads past rules the CSSOM dropped, and what it lists for a
// rule given up as a declaration, on texts outlined here and CSSOM rules made up for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as Ranges from './ranges.ts';
import type * as Outline from '../parse/css-outline.ts';
import type { SheetSource } from './pair.ts';

// Bundled: the sources import each other without extensions, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: [
      "export { runsOf, givenUp } from './ranges.ts';",
      "export { outline, topRules } from '../parse/css-outline.ts';",
      "export { lineStarts } from './text-lines.ts';",
    ].join('\n'),
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { runsOf, givenUp, outline, topRules, lineStarts } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`
)) as typeof Ranges & Pick<typeof Outline, 'outline' | 'topRules'> & { lineStarts: (t: string) => number[] };

/** A made-up CSSOM rule: its children, and the parent `runsOf` reads for nested declarations. */
const rule = (children: CSSRule[] = []): CSSRule => {
  const r = { cssRules: children, parentRule: null } as unknown as CSSRule;
  for (const c of children) Object.assign(c, { parentRule: r });
  return r;
};

/**
 * The source of `text`, whose first rule is paired with a made-up rule holding one child for each
 * of its children `kept` lists (by index among the outline's children).
 */
function source(text: string, kept: number[]) {
  const o = outline(text);
  const top = topRules(o)[0] as number;
  const nodes: number[] = [];
  for (let c = o.firstChild(top); c >= 0; c = o.next(c)) nodes.push(c);
  const children = kept.map(() => rule());
  const parent = rule(children);
  const map = new Map<CSSRule, number>([[parent, top]]);
  kept.forEach((k, i) => map.set(children[i] as CSSRule, nodes[k] as number));
  const s = { text, lines: lineStarts(text), outline: o, nodes: map, topRules: [], topNodes: [], namespaces: '' };
  return { s: s as unknown as SheetSource, o, top, nodes, parent, children };
}

/** The parts of a run as `[kind, text]`: what each part is written as. */
const shape = (text: string, s: SheetSource, run: Ranges.Run | undefined) =>
  run && {
    kept: run.kept,
    parts: run.parts.map(p =>
      'decls' in p ? ['decls', p.decls] : ['dropped', text.slice(s.outline.start(p.dropped), s.outline.end(p.dropped))]
    ),
  };

test('runsOf: no dropped rule, no runs', () => {
  const { s, top, parent } = source('.a{top:0; b{} left:1px}', [0, 1]);
  assert.equal(runsOf(s, top, parent), null);
});

test('runsOf: a dropped rule joins the declarations around it into the rule own run', () => {
  const text = '.a{color:red; x:a {} top:0}';
  const { s, top, nodes, parent } = source(text, []);
  const runs = runsOf(s, top, parent);
  assert.deepEqual(shape(text, s, runs?.get(top)), {
    kept: false,
    parts: [
      ['decls', top],
      ['dropped', 'x:a {}'],
      ['decls', nodes[1]],
    ],
  });
});

test('runsOf: a run ends at a kept rule; nested declarations after one start the next', () => {
  // Children: x:a{}, (top:0;), b{}, x:a{}, (left:1px). The CSSOM keeps b and the last run.
  const text = '.a{x:a{} top:0; b{} y:b{} left:1px}';
  const { s, top, nodes, parent } = source(text, [2, 4]);
  const runs = runsOf(s, top, parent);
  assert.deepEqual(shape(text, s, runs?.get(top)), {
    kept: true,
    parts: [
      ['decls', top],
      ['dropped', 'x:a{}'],
      ['decls', nodes[1]],
    ],
  });
  assert.deepEqual(shape(text, s, runs?.get(nodes[4] as number)), {
    kept: false,
    parts: [
      ['dropped', 'y:b{}'],
      ['decls', nodes[4]],
    ],
  });
});

test('runsOf: dropped at-rules count, `a {{` does not', () => {
  const text = '.a{top:0; @foo; left:1px}';
  const { s, top, parent } = source(text, []);
  assert.equal(shape(text, s, runsOf(s, top, parent)?.get(top))?.parts[1]?.[1], '@foo;');
  const open = source('.a{{ b } top:0}', []);
  assert.equal(runsOf(open.s, open.top, open.parent), null);
});

test('runsOf: rules that no longer pair with the outline (the page changed them) make no runs', () => {
  const { s, top, parent } = source('.a{x:a{} top:0; b{} left:1px}', [2]);
  // A CSSOM rule with no node: inserted by the page.
  (parent.cssRules as unknown as CSSRule[]).unshift(rule());
  assert.equal(runsOf(s, top, parent), null);
});

test('runsOf: worked out once per block and source, again when the CSSOM rules change', () => {
  const { s, top, parent } = source('.a{x:a{} top:0}', []);
  const first = runsOf(s, top, parent);
  assert.ok(first);
  assert.equal(runsOf(s, top, parent), first);
  (parent.cssRules as unknown as CSSRule[]).push(rule());
  assert.equal(runsOf(s, top, parent), null);
});

test('runsOf: as many CSSOM rules as before, but another object, is worked out again', () => {
  // As after the page's deleteRule(0) then insertRule(…, 0): the count is the same.
  const { s, top, parent } = source('.a{x:a{} top:0; b{} left:1px}', [2]);
  const first = runsOf(s, top, parent);
  assert.ok(first);
  (parent.cssRules as unknown as CSSRule[])[0] = rule();
  assert.equal(runsOf(s, top, parent), null);
});

test('givenUp: name, value as written to the `{`, text with the white space before it, or to the style end', () => {
  for (const [text, expected] of [
    ['.a{x:a {}}', { name: 'x', value: 'a', text: 'x:a ' }],
    ['.a{ x: a {}}', { name: 'x', value: 'a', text: 'x: a ' }],
    ['.a{x:a /*c*/ {}}', { name: 'x', value: 'a /*c*/', text: 'x:a /*c*/ ' }],
    ['.a{x : a{}}', { name: 'x', value: 'a', text: 'x : a' }],
    ['.a{/*c*/x:a{}}', { name: 'x', value: 'a', text: 'x:a' }],
    ['.a{x:a b {}}', { name: 'x', value: 'a b', text: 'x:a b ' }],
    // Nothing but comments before the `{`: to the end of the style, here past `{}`.
    ['.a{x:{}}', { name: 'x', value: '{}', text: 'x:{}' }],
    ['.a{x:/*c*/{} top:0}', { name: 'x', value: '/*c*/{} top:0', text: 'x:/*c*/{} top:0' }],
    ['.a{x: /*c*/ {} top:0}', { name: 'x', value: '/*c*/ {} top:0', text: 'x: /*c*/ {} top:0' }],
    ['.a{x: /*c*/ a {} top:0}', { name: 'x', value: '/*c*/ a', text: 'x: /*c*/ a ' }],
    ['.a{!!{}}', null],
    ['.a{b:hover x{}}', { name: 'b', value: 'hover x', text: 'b:hover x' }],
    ['.a{b {}}', null],
  ] as const) {
    const { s, nodes } = source(text, []);
    // The style of `.a`, to the `}`.
    const w = givenUp(s, nodes[0] as number, text.lastIndexOf('}'));
    assert.deepEqual(w && { name: w.name, value: w.value, text: w.text }, expected, text);
    if (w) assert.equal(w.invalid, true);
  }
});
