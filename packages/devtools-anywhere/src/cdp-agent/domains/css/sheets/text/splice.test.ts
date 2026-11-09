// splice.ts `respliced` and the CssOutline methods it uses (`stretch`, `relink`), on CSSOM rules
// stood in for: after each edit the outline, from the top-level rules down, is field for field
// that of the new text outlined anew, and only the records of the rule edited are dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as Outline from '../parse/css-outline.ts';
import type * as Pair from './pair.ts';
import type * as Splice from './splice.ts';

// Bundled: the sources import each other without extensions, which Node does not resolve.
const bundled = await build({
  stdin: {
    contents: [
      "export { outline, ruleObject, ROOT } from '../parse/css-outline.ts';",
      "export { pair } from './pair.ts';",
      "export { deadDeclarations, respliced } from './splice.ts';",
    ].join('\n'),
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
// realm.ts reads Node's prototype when loaded; no node is made here.
const g = globalThis as { Node?: unknown };
g.Node ??= class {
  get nodeType() {
    return 0;
  }
};
const m: {
  outline: typeof Outline.outline;
  ruleObject: typeof Outline.ruleObject;
  ROOT: number;
  pair: typeof Pair.pair;
  respliced: typeof Splice.respliced;
  deadDeclarations: typeof Splice.deadDeclarations;
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? '').toString('base64')}`);

type Source = NonNullable<ReturnType<typeof m.pair>>;
const SHEET = { sheet: true };
const protos = new Map<string, object>();
/** A CSSOM rule stood in for: its kind (toStringTag), selector or name, and rules. */
function rule(tag: string, props: Record<string, unknown>, kids: CSSRule[] = []): CSSRule {
  let proto = protos.get(tag);
  if (!proto) protos.set(tag, (proto = Object.create(null, { [Symbol.toStringTag]: { value: tag } }) as object));
  const r = Object.create(proto) as Record<string, unknown>;
  Object.assign(r, props, { parentStyleSheet: SHEET });
  if (tag !== 'CSSStyleRule' || kids.length) r['cssRules'] = kids;
  return r as unknown as CSSRule;
}
const style = (selectorText: string, kids: CSSRule[] = []) => rule('CSSStyleRule', { selectorText }, kids);
const media = (kids: CSSRule[]) => rule('CSSMediaRule', {}, kids);
const layer = (kids: CSSRule[]) => rule('CSSLayerBlockRule', {}, kids);

/** The top-level rules of a source, from its outline, as objects. */
const tree = (s: Source) => s.topNodes.map(n => m.ruleObject(s.text, s.outline, n));
/** Those of `text` outlined anew. */
function fresh(text: string) {
  const o = m.outline(text);
  const out = [];
  for (let r = o.firstChild(m.ROOT); r >= 0; r = o.next(r)) out.push(m.ruleObject(text, o, r));
  return out;
}

/** Replaces the first `find` after `after` by `by` in the source, as CSS.setStyleTexts would. */
function edit(s: Source, after: string, find: string, by: string): Source | null {
  const start = s.text.indexOf(find, s.text.indexOf(after));
  assert.ok(start >= 0, after);
  return m.respliced(s, start, start + find.length, by);
}

const CSS = `@layer a {
  @media screen {
    .x { color: red }
    .y { color: red; top: 1px }
    .z { color: red }
  }
  @media print { .p { top: 0 } }
}
.after { color: red }
`;
function cssom() {
  const [x, y, z, p, after] = ['.x', '.y', '.z', '.p', '.after'].map(s => style(s)) as CSSRule[];
  const rules = [layer([media([x, y, z] as CSSRule[]), media([p] as CSSRule[])]), after as CSSRule];
  return { rules, x, y, z, p, after };
}

test('respliced: the rule edited, first, in the middle and last of its group, outlined alone', () => {
  const { rules, x, y, z, p, after } = cssom();
  let s = m.pair(CSS, rules) as Source;
  assert.ok(s);
  const steps: [string, string, string, CSSRule][] = [
    ['.y', 'red', 'navy', y as CSSRule],
    ['.x', 'red', 'rebeccapurple', x as CSSRule],
    ['.z', 'color: red', 'top: 2px', z as CSSRule],
    ['.p', 'top: 0', 'top: 10px; left: 1px', p as CSSRule],
  ];
  steps.forEach(([at, find, by, edited], i) => {
    const next = edit(s, at, find, by);
    assert.ok(next, at);
    s = next;
    assert.deepEqual(tree(s), fresh(s.text), at);
    // Only the rule edited is dead: one record each time.
    assert.equal(s.outline.dead, i + 1, at);
    for (const [r, sel] of [
      [edited, at],
      [after, '.after'],
    ] as const)
      assert.equal(s.outline.start(s.nodes.get(r as CSSRule) as number), s.text.indexOf(`${sel} {`), sel);
  });
});

test('respliced: a rule in it the CSSOM replaced loses its pair', () => {
  const css = '@media screen {\n  .n { color: red; & .in { left: 1px } }\n  .m { top: 0 }\n}\n';
  const inner = style('& .in');
  const n = style('.n', [inner]);
  const rules = [media([n, style('.m')])];
  const s = m.pair(css, rules) as Source;
  assert.equal(s.nodes.has(inner), true);
  // The edit left the CSSOM a new nested rule in place of the old one.
  const renewed = style('& .in');
  (n as unknown as { cssRules: CSSRule[] }).cssRules = [renewed];
  const next = edit(s, '.n', 'left: 1px', 'left: 22px');
  assert.ok(next);
  assert.equal(next.nodes.has(inner), false);
  assert.equal(next.outline.start(next.nodes.get(renewed) as number), next.text.indexOf('& .in'));
  assert.deepEqual(tree(next), fresh(next.text));
  assert.equal(next.outline.dead, 2);
});

test('CssOutline.relink: in place of the first rule and of one in the middle; refused elsewhere', () => {
  const text = '@media x{.a{}.b{}.c{}}';
  const o = m.outline(text);
  const group = o.firstChild(m.ROOT);
  const a = o.firstChild(group);
  const bb = o.next(a);
  const cc = o.next(bb);
  const alone = (t: string) => m.outline(t);
  const A = alone('.A{}');
  const copyA = o.graft(A, A.firstChild(m.ROOT), 9);
  assert.equal(o.relink(group, 0, a, copyA), false);
  assert.equal(o.relink(group, -1, bb, copyA), false);
  assert.equal(o.relink(group, -1, a, copyA), true);
  assert.equal(o.firstChild(group), copyA);
  assert.equal(o.next(copyA), bb);
  const B = alone('.B{}');
  const copyB = o.graft(B, B.firstChild(m.ROOT), 13);
  assert.equal(o.relink(group, copyA, bb, copyB), true);
  assert.equal(o.next(copyA), copyB);
  assert.equal(o.next(copyB), cc);
  assert.equal(o.next(cc), -1);
  // The text the records now tell: `.A{}.B{}.c{}`, each where it was.
  assert.deepEqual(m.ruleObject('@media x{.A{}.B{}.c{}}', o, group), fresh('@media x{.A{}.B{}.c{}}')[0]);
  // A dead record keeps its links: `a` still links to `bb`, but is no longer before it.
  o.markDead(a);
  const C = alone('.C{}');
  assert.equal(o.relink(group, a, cc, o.graft(C, C.firstChild(m.ROOT), 17)), false);
  o.markDead(bb);
  assert.equal(o.relink(group, copyB, cc, o.graft(C, C.firstChild(m.ROOT), 17)), true);
});

test('CssOutline.stretch: the end and the block end move, not the start', () => {
  const o = m.outline('@media x{.a{}} .b{}');
  const group = o.firstChild(m.ROOT);
  const before = m.ruleObject('', o, group);
  o.stretch(group, 3);
  const after = m.ruleObject('', o, group);
  assert.deepEqual(
    [after.start, after.preludeStart, after.blockStart, after.end, after.blockEnd],
    [before.start, before.preludeStart, before.blockStart, before.end + 3, before.blockEnd + 3]
  );
  // A rule without a block keeps none.
  const s = m.outline('@import "a";');
  const imp = s.firstChild(m.ROOT);
  s.stretch(imp, 2);
  assert.equal(s.blockEnd(imp), -1);
  assert.equal(s.end(imp), 14);
});

const GROUP = '@media screen {\n  .a { color: red }\n  .b { color: red }\n}\n.after { color: red }\n';
/** GROUP (or `css`) paired, its CSSOM rules, and a check that `.after` is where the text has it. */
function group(css = GROUP) {
  const [a, b, after] = ['.a', '.b', '.after'].map(s => style(s)) as [CSSRule, CSSRule, CSSRule];
  const m1 = media([a, b]);
  const s = m.pair(css, [m1, after]) as Source;
  assert.ok(s);
  const afterAt = (next: Source) =>
    assert.equal(next.outline.start(next.nodes.get(after) as number), next.text.indexOf('.after'));
  const kids = (list: CSSRule[]) => ((m1 as unknown as { cssRules: CSSRule[] }).cssRules = list);
  return { s, a, b, kids, afterAt };
}

test('respliced: a style emptied, or made two rules, the top-level rule replaced for the latter', () => {
  // Called directly, past the check CSS.setStyleTexts makes of a style's text.
  for (const [by, added] of [
    ['', false],
    [' color: red } .c { top: 0 ', true],
  ] as const) {
    const g = group();
    const c = style('.c');
    if (added) g.kids([g.a, c, g.b]);
    const next = edit(g.s, '.a', ' color: red ', by);
    assert.ok(next, by);
    assert.deepEqual(tree(next), fresh(next.text), by);
    g.afterAt(next);
    // Outlined alone: the rule only; replaced with its group: the group and its rules.
    assert.equal(next.outline.dead, added ? 3 : 1, by);
    if (added) assert.equal(next.outline.start(next.nodes.get(c) as number), next.text.indexOf('.c'));
  }
});

test('respliced: a rule added at the edge of one, or a statement left unended, in its group', () => {
  {
    const g = group();
    const c = style('.c');
    g.kids([g.a, c, g.b]);
    const at = g.s.text.indexOf('.b');
    const next = m.respliced(g.s, at, at, '.c { top: 0 }\n  ');
    assert.ok(next);
    assert.deepEqual(tree(next), fresh(next.text));
    g.afterAt(next);
    assert.equal(next.outline.dead, 3);
  }
  {
    // `@layer x .a { … }` once `;` is gone: a block whose prelude is invalid, which the CSSOM drops.
    const css = '@media screen {\n  @layer x;\n  .a { color: red }\n  .b { color: red }\n}\n.after { color: red }\n';
    const [a, b, after] = ['.a', '.b', '.after'].map(s => style(s)) as [CSSRule, CSSRule, CSSRule];
    const m1 = media([rule('CSSLayerStatementRule', {}), a, b]);
    const s = m.pair(css, [m1, after]) as Source;
    assert.ok(s);
    (m1 as unknown as { cssRules: CSSRule[] }).cssRules = [b];
    const at = s.text.indexOf('x;') + 1;
    const next = m.respliced(s, at, at + 1, '');
    assert.ok(next);
    assert.deepEqual(tree(next), fresh(next.text));
    assert.equal(next.outline.start(next.nodes.get(after) as number), next.text.indexOf('.after'));
    assert.equal(next.outline.start(next.nodes.get(b) as number), next.text.indexOf('.b'));
    // The group replaced, with its three rules.
    assert.equal(next.outline.dead, 4);
  }
});

test('respliced: null when the edit breaks the top-level rule, or the outline is worn', () => {
  for (const by of [' color: red } }', ' color: red; x { ', ' color: red; /* open']) {
    const g = group();
    const text = g.s.text;
    assert.equal(edit(g.s, '.a', ' color: red ', by), null, by);
    // Given up before any record was counted dead; its text the old one.
    assert.equal(g.s.text, text, by);
    assert.equal(g.s.outline.dead, 0, by);
  }
  const g = group();
  // As many dead records as live ones: replaceTops gives up, for the text to be paired anew.
  const worn = (g.s.outline.dead = g.s.outline.ruleCount);
  const text = g.s.text;
  assert.equal(edit(g.s, '.after', 'red', 'blue'), null);
  assert.equal(g.s.text, text);
  assert.equal(g.s.outline.dead, worn);
});

test('respliced: dead declarations give up past 1024, not before', () => {
  const decls = Array.from({ length: 32 }, (_, i) => `p${i}: ${i}`).join('; ');
  const others = Array.from({ length: 60 }, (_, i) => `.s${i}`);
  const css = `@media screen {\n  .big { ${decls} }\n${others.map(o => `  ${o} { top: 0 }\n`).join('')}}\n`;
  const otherRules = others.map(o => style(o));
  let s = m.pair(css, [media([style('.big'), ...otherRules])]) as Source;
  // Checked before each edit: after 32, 1024 are dead, not past it; after 33, 1056 are.
  for (let i = 0; i < 33; i++) {
    const next = edit(s, '.big', `p0: ${i}`, `p0: ${i + 1}`);
    assert.ok(next, `${i}`);
    s = next;
  }
  assert.deepEqual(tree(s), fresh(s.text));
  assert.equal(s.outline.dead, 33);
  assert.equal(s.outline.start(s.nodes.get(s.topRules[0] as CSSRule) as number), 0);
  assert.equal(s.outline.start(s.nodes.get(otherRules[5] as CSSRule) as number), s.text.indexOf('.s5 '));
  assert.equal(m.deadDeclarations(s.outline), 33 * 32);
  assert.equal(edit(s, '.big', 'p0: 33', 'p0: 34'), null);
  // A small sheet: more dead declarations than live ones, but not past 1024, edited in place.
  const small = Array.from({ length: 30 }, (_, i) => `.e${i}`);
  const smallCss = `@media screen {\n  .t { ${decls} }\n${small.map(o => `  ${o} {}\n`).join('')}}\n`;
  const smallRules = small.map(o => style(o));
  let t = m.pair(smallCss, [media([style('.t'), ...smallRules])]) as Source;
  for (let i = 0; i < 4; i++) {
    const next = edit(t, '.t', `p0: ${i}`, `p0: ${i + 1}`);
    assert.ok(next, `small ${i}`);
    t = next;
  }
  assert.deepEqual(tree(t), fresh(t.text));
  // 4 × 32 dead declarations of 32 × 5: more than half, not past 1024; 4 rules dead of 36.
  assert.equal(t.outline.dead, 4);
  assert.equal(t.outline.declCount, 32 * 5);
  assert.equal(m.deadDeclarations(t.outline), 4 * 32);
  assert.ok(m.deadDeclarations(t.outline) * 2 > t.outline.declCount);
  assert.equal(t.outline.start(t.nodes.get(smallRules[5] as CSSRule) as number), t.text.indexOf('.e5 '));
});

test('respliced: a nested rule added, keyframes, @scope not gone into, a rule the CSSOM dropped', () => {
  {
    const inner = style('& .new');
    const n = style('.n');
    const s = m.pair('@media screen {\n  .n { color: red }\n}\n', [media([n])]) as Source;
    (n as unknown as { cssRules: CSSRule[] }).cssRules = [inner];
    const next = edit(s, '.n', ' color: red ', ' color: red; & .new { top: 1px } ');
    assert.ok(next);
    assert.deepEqual(tree(next), fresh(next.text));
    assert.equal(next.outline.start(next.nodes.get(inner) as number), next.text.indexOf('& .new'));
    assert.equal(next.outline.dead, 1);
  }
  {
    const [from, to] = ['from', 'to'].map(keyText => rule('CSSKeyframeRule', { keyText })) as [CSSRule, CSSRule];
    const css = '@layer a {\n  @keyframes k { from { top: 0 } to { top: 1px } }\n}\n.after { color: red }\n';
    const after = style('.after');
    const s = m.pair(css, [layer([rule('CSSKeyframesRule', { name: 'k' }, [from, to])]), after]) as Source;
    const next = edit(s, ' to ', 'top: 1px', 'top: 2px; left: 0');
    assert.ok(next);
    assert.deepEqual(tree(next), fresh(next.text));
    assert.equal(next.outline.dead, 1);
    assert.equal(next.outline.start(next.nodes.get(to) as number), next.text.indexOf('to {'));
    assert.equal(next.outline.start(next.nodes.get(after) as number), next.text.indexOf('.after'));
  }
  {
    const t = style('.t');
    const after = style('.after');
    const css = '@scope (.sc) {\n  .t { color: red }\n}\n.after { color: red }\n';
    const s = m.pair(css, [rule('CSSScopeRule', {}, [t]), after]) as Source;
    const next = edit(s, '.t', 'red', 'blue');
    assert.ok(next);
    assert.deepEqual(tree(next), fresh(next.text));
    // The whole @scope rule outlined again.
    assert.equal(next.outline.dead, 2);
    assert.equal(next.outline.start(next.nodes.get(after) as number), next.text.indexOf('.after'));
  }
  {
    const g = group(
      '@media screen {\n  @nope x { top: 0 }\n  .a { color: red }\n  .b { color: red }\n}\n.after { color: red }\n'
    );
    let s = g.s;
    for (const at of ['.a', '.b']) {
      const next = edit(s, at, 'red', 'blue');
      assert.ok(next, at);
      s = next;
      assert.deepEqual(tree(s), fresh(s.text), at);
      g.afterAt(s);
    }
    assert.equal(s.outline.dead, 2);
  }
});
