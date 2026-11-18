// CSS.setStyleSheetText on a <style>, compared with Chrome: the rules, the text and the matched
// styles (ranges included) are Chrome's. Unlike Chrome, which replaces every rule, only the
// top-level rules whose text changed are new objects, when the change can be told rule by rule;
// otherwise (a comment left open, @import) all are replaced, as Chrome does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { matched, nodeId, rule } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
/** Our agent on one page, Chrome on another. */
let sides: { side: Side; t: TestPage }[] = [];
/** The edited sheet's id on each side. */
const ids = new Map<Side, string>();

const BASE = `/* head */
.r0 { color: red }
.r1 { top: 1px }
@media screen { .r2 { left: 2px } .r3 { right: 3px } }
.r4 { color: blue; & .in { margin: 4px } }
.r5 { width: 5px }

.r6 { height: 6px }
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    const [a, b] = [await openPage(env, []), await openPage(env, [])];
    sides = [
      { side: a.ours, t: a },
      { side: b.chrome, t: b },
    ];
    for (const { side, t } of sides) {
      await t.page.evaluate(css => {
        const s = document.createElement('style');
        s.id = 'retext';
        s.textContent = css;
        document.head.appendChild(s);
        document.body.insertAdjacentHTML(
          'beforeend',
          '<p id="p" class="r0 r1 r2 r3 r4 r5 r6 rx"><span id="in" class="in">x</span></p>'
        );
      }, BASE);
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      ids.set(side, (await matched(side, '#p')).sheet);
    }
  },
  () => env?.close()
);

/** The sheet's rules and text, and the styles matched, after `text` replaced `from`. */
async function edit(side: Side, t: TestPage, from: string, text: string) {
  const sheet = ids.get(side) ?? '';
  await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text: from });
  await t.page.evaluate(() => {
    const s = document.getElementById('retext') as HTMLStyleElement;
    Reflect.set(window, '__held', [...(s.sheet as CSSStyleSheet).cssRules]);
  });
  await side.send('CSS.setStyleSheetText', { styleSheetId: sheet, text });
  const cssom = await t.page.evaluate(() => {
    const s = document.getElementById('retext') as HTMLStyleElement;
    const rules = [...(s.sheet as CSSStyleSheet).cssRules];
    const held = Reflect.get(window, '__held') as CSSRule[];
    return { rules: rules.map(r => r.cssText), kept: held.map(r => rules.includes(r)) };
  });
  const { text: served } = await side.send('CSS.getStyleSheetText', { styleSheetId: sheet });
  return { cssom, served, p: await rulesIn(side, '#p', sheet), inner: await rulesIn(side, '#in', sheet) };
}

/** The rules of `sheet` matching the element. */
async function rulesIn(side: Side, selector: string, sheet: string) {
  const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) });
  return (res.matchedCSSRules ?? []).filter(m => m.rule.styleSheetId === sheet).map(m => rule(m.rule));
}

/** Edits on both sides; checks they agree but for the rules kept, and returns ours kept. */
async function compare(text: string, from = BASE): Promise<boolean[]> {
  const [a, b] = sides;
  assert.ok(a && b);
  const ours = await edit(a.side, a.t, from, text);
  const chrome = await edit(b.side, b.t, from, text);
  assert.deepEqual({ ...ours, cssom: ours.cssom.rules }, { ...chrome, cssom: chrome.cssom.rules });
  assert.equal(ours.served, text);
  // Chrome replaces them all.
  assert.ok(chrome.cssom.kept.every(k => !k));
  return ours.cssom.kept;
}

const T = true;
const F = false;

test('a value changed: only its rule is new', async () => {
  assert.deepEqual(await compare(BASE.replace('top: 1px', 'top: 9px')), [T, F, T, T, T, T]);
});

test('a rule inserted in the middle: all others kept', async () => {
  assert.deepEqual(await compare(BASE.replace('.r5', '.rx { color: green }\n.r5')), [T, T, T, T, T, T]);
});

test('a rule removed', async () => {
  assert.deepEqual(await compare(BASE.replace('.r5 { width: 5px }\n', '')), [T, T, T, T, F, T]);
});

test('changes in several places: the rules between them kept', async () => {
  const text = BASE.replace('red', 'olive').replace('6px', '7px').replace('/* head */', '/* x */');
  assert.deepEqual(await compare(text), [F, T, T, T, T, F]);
});

test('an invalid rule inserted and changed rules around it', async () => {
  const text = BASE.replace('.r1 {', '.r1:::bad { top: 0 }\n.r1 {').replace('5px', '15px');
  assert.deepEqual(await compare(text), [T, T, T, T, F, T]);
});

test('in @media and in a nested rule: the top-level rule around it is new', async () => {
  assert.deepEqual(await compare(BASE.replace('right: 3px', 'right: 30px')), [T, T, F, T, T, T]);
  assert.deepEqual(await compare(BASE.replace('margin: 4px', 'margin: 40px')), [T, T, T, F, T, T]);
});

test('a comment left open: all replaced', async () => {
  assert.deepEqual(await compare(BASE.replace('.r5', '/* .r5')), [F, F, F, F, F, F]);
});

test('a rule left open at the end: all replaced', async () => {
  assert.deepEqual(await compare(`${BASE}.rx { color: green`), [F, F, F, F, F, F]);
});

test('@import added or removed: all replaced', async () => {
  const imported = `@import url("data:text/css,.rx{top:1px}");\n${BASE}`;
  assert.deepEqual(await compare(imported), [F, F, F, F, F, F]);
  assert.deepEqual(await compare(BASE, imported), [F, F, F, F, F, F, F]);
});

test('after an @import, rules changed one by one', async () => {
  const imported = `@import url("data:text/css,.rx{top:1px}");\n${BASE}`;
  assert.deepEqual(await compare(imported.replace('top: 1px', 'top: 2px'), imported), [T, T, F, T, T, T, T]);
});

test('edits one after another', async () => {
  let text = BASE;
  for (let i = 0; i < 6; i++) {
    const next = i % 2 ? text.replace(`.r${i}`, `.n${i} { top: ${i}px }\n.r${i}`) : text.replace('px', `${i}0px`);
    await compare(next, text);
    text = next;
  }
  // Back to the start in one go.
  await compare(BASE, text);
});

/**
 * Three times what the CSSOM has no rule for (@charset, CDO and CDC, invalid rules, a top-level
 * `--var:{}` whose `;` makes the next rule invalid too, bad strings) around three rules.
 */
const MIXED = [0, 1, 2]
  .map(
    i =>
      `@charset "utf-8";\n<!-- .a\\31 b${i} { content: "q\\"uo\\\nte"; } -->\n.é\\E9 x${i}{background:url( a\\(b.png ) ;b:url(bad"x)}\n` +
      `/* ★ */#\\31 23${i}{width:1.5e3px;height:-.5em}\n--var:{a};@-moz-x u+1?? ;"bad\nstr" 'unterminated\n\u0000 😀 \r\n\f\t!important\\\n.n${i}{x:${i}}\n`
  )
  .join('');
/** Its rules: .a\31 b, .é\E9 x, #\31 23, three times. */
const KEPT = [T, T, T, T, T, T, T, T, T];
/** All kept but rule `i`. */
const but = (i: number) => KEPT.map((_, j) => j !== i);

test('mixed: a rule changed next to what has no rule, only that rule new', async () => {
  const edits: [string, string, number][] = [
    ['#\\31 230{width:1.5e3px', '#\\31 230{width:2px', 2],
    ['#\\31 231{width:1.5e3px', '#\\31 231{width:7px', 5],
    ['#\\31 232{width:1.5e3px', '#\\31 232{width:3px', 8],
    ['.a\\31 b0 { content', '.a\\31 b0 { top: 0; content', 0],
    ['.a\\31 b1 { content', '.a\\31 b1 { color: red; content', 3],
    ['x1{background', 'x1{top:0;background', 4],
  ];
  for (const [from, to, i] of edits) assert.deepEqual(await compare(MIXED.replace(from, to), MIXED), but(i), to);
});

test('mixed: what has no rule added, removed and changed, all rules kept', async () => {
  const edits = [
    // @charset removed, added twice, changed.
    MIXED.replace('@charset "utf-8";\n<!-- .a\\31 b1', '<!-- .a\\31 b1'),
    MIXED.replace('/* ★ */#\\31 231', '@charset "x";\n@charset "y";\n#\\31 231'),
    MIXED.replace('@charset "utf-8"', '@charset "latin1"'),
    // CDO and CDC, bad strings and invalid rules added and removed, first and last.
    MIXED.replace('/* ★ */#\\31 231', '<!-- --> <!--\n#\\31 231'),
    MIXED.replace(' -->\n.é\\E9 x1', '\n.é\\E9 x1'),
    MIXED.replace('/* ★ */#\\31 231', '"bad\nstr" ;\n:::x{top:0}\n@nope;\n#\\31 231'),
    MIXED.replace('--var:{a};@-moz-x u+1?? ;"bad\nstr" \'unterminated\n\u0000 😀 \r\n\f\t!important\\\n.n1{x:1}\n', ''),
    MIXED.replace('.n2{x:2}', '.n2{x:3}'),
    MIXED.replace('.n0{x:0}', '.n0{x:0} --w:{b}'),
    `<!-- ${MIXED}`,
  ];
  for (const text of edits) assert.deepEqual(await compare(text, MIXED), KEPT, text);
});

test('mixed: rules added among what has no rule', async () => {
  const edits: [string, string, boolean[]][] = [
    // After `--var:{a};`: part of the invalid rule the `;` starts.
    ['.n1{x:1}\n', '.n1{x:1}\n.v{top:1px}\n', KEPT],
    ['@charset "utf-8";\n<!-- .a\\31 b1', '@charset "utf-8";\n.v{top:1px}\n<!-- .a\\31 b1', KEPT],
    ['/* ★ */#\\31 231', '/* ★ */.v{top:1px}\n#\\31 231', KEPT],
    // A rule removed with what has no rule around it.
    ['/* ★ */#\\31 231{width:1.5e3px;height:-.5em}\n--var:{a};', '--var:{a};', but(5)],
  ];
  for (const [from, to, kept] of edits) assert.deepEqual(await compare(MIXED.replace(from, to), MIXED), kept, to);
});

test('an @namespace that a rule removed before it makes valid: all replaced', async () => {
  const text = '@charset "utf-8";\n.x { top: 1px }\n@namespace s url(http://www.w3.org/2000/svg);\ns|a { top: 2px }\n';
  // Whether `s|a` is a rule after the @namespace dropped depends on the sheet's past, in Chrome too.
  for (const from of [MIXED, BASE]) {
    await compare(text, from);
    const removed = await compare(text.replace('.x { top: 1px }\n', ''), text);
    assert.ok(removed.every(k => !k));
    const changed = await compare(text.replace('.x { top: 1px }', '.x { top: 3px }'), text);
    assert.ok(changed.every(k => !k));
  }
});
