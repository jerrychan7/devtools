// The text of a <style> and the ranges of its rules in it, compared with Chrome: selectors,
// declarations (commented out, !important, invalid, without `;`), at-rule conditions, nesting,
// error recovery and line breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both, matched, nodeId, style } from '../../../../../test-support/css-source.ts';

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

async function same(css: string, html: string, target: string) {
  const at = await addStyle(t, css, html);
  const { ours, chrome } = await both(t, `${at} ${target}`);
  assert.equal(ours.text, chrome.text);
  assert.ok(chrome.rules.length);
  assert.deepEqual(ours.rules, chrome.rules);
}

test('selectors and declarations', () =>
  same(
    `
/* leading comment */
.d1 , #d1:hover>span  {
  color : red ;
  /* margin: 1px; */
  padding: 1px !important;
  background: url("a;b.png") no-repeat;
  content: "a\\"}b";
  font-family: \\66 oo;
  bogus-prop: 3;
  width: 10px
}
.d1{top:1px}
.d1 { left : 1px ! IMPORTANT ; /* right: 2px */ }
`,
    '<div class="d1" id="d1"></div>',
    '.d1'
  ));

test('at-rule conditions', () =>
  same(
    `@media (min-width: 1px) and screen { .c1 { top: 1px } }
@supports (display: grid) { .c1 { left: 1px } }
@container  (min-width: 0px) { .c1 { right: 1px } }
@layer L1 { .c1 { bottom: 1px } }
@scope (.c0) to (.end) { .c1 { z-index: 2 } }
@media screen { @supports (top: 0) { .c1 { order: 1 } } }`,
    '<div class="c0" style="container-type: inline-size"><p class="c1">x</p></div>',
    '.c1'
  ));

test('nesting', () =>
  same(
    `.parent { color: red; & .n1 { color: blue; } opacity: .5; .n1 & {x:y} }
.n2 { > b { top: 1px } @media screen { left: 1px; .x & { right: 1px } } bottom: 2px }`,
    '<div class="parent"><p class="n1 n2"><b>x</b></p></div>',
    '.n1'
  ));

test('nested declarations', () =>
  same(`.n3 { color: red; & .x { color: blue; } opacity: .5;  margin: 1px }`, '<p class="n3">x</p>', '.n3'));

// Chrome lists the invalid run as a rule of its own (`color: 1px!!;`) though the CSSOM has no
// CSSNestedDeclarations for it, which we cannot pair a rule with: only the valid run is ours.
// Chrome does so only in some texts: not for `.a { b {} color: 1px!!; }`, nor when another rule
// or run follows (`… c {} d {} color: red`, `… c {} color: red; d {} color: 2px!!; e {} …`). It
// pairs the rules it parsed from the text with the CSSOM's by a longest common subsequence of
// their canonical texts (Chromium's third_party/blink/renderer/core/inspector/
// inspector_style_sheet.cc: InspectorStyleSheet::MapSourceDataToCSSOM, which calls
// InspectorDiff::FindLCSMapping). From the texts we measured, we infer that the extra rule is
// a side effect of that diff, not a rule of the sheet.
test(
  'nested declarations: a run of invalid ones the CSSOM dropped, then a valid run of the same property',
  { todo: 'Chrome reports the dropped run as a rule the CSSOM lacks' },
  () => same(`.n4 { b {} color: 1px!!; c {} color: red }`, '<p class="n4">x</p>', '.n4')
);

test('nested declarations: a run of invalid ones the CSSOM dropped, ours', async () => {
  // Our side alone, pinned: the rule's own style, then only the valid run.
  const at = await addStyle(t, `.n5 { b {} color: 1px!!; c {} color: red }`, '<p class="n5">x</p>');
  const { rules } = await matched(t.ours, `${at} .n5`);
  assert.deepEqual(
    rules.map(r => [r.nestingSelectors ?? null, r.style.range, r.style.cssText]),
    [
      [null, '0:5-0:41', ' b {} color: 1px!!; c {} color: red '],
      [['.n5'], '0:30-0:41', 'color: red '],
    ]
  );
});

// A rule the CSSOM drops in a style rule's block (`x:a {}`, an invalid selector; `!!{}`; an at-rule
// such as `@foo {}`, `@import`, `@layer x;`) ends no run of declarations: what follows is still the
// rule's own, or of the same nested declarations rule. Chrome lists a rule given up as a
// declaration (`x:a`) as a property, with parsedOk false, its text to the `{`; other dropped rules
// add none.
const DROPPED = [
  '.k1{x:a {} ; top:0}',
  '.k2{b:hover{} top:0}',
  '.k3{x:a {}; top:0; left:1px}',
  '.k4{x:a {} ; top:0; b {} left:1px}',
  '.k5{color:red; x:a {} ; top:0}',
  '@media all{.k6{x:a {} ; top:0}}',
  '.k7{color:red; x:a {}}',
  '.k8{!!{} top:0}',
  '.k9{color:red; b{} x:a {} top:0}',
  '.k10{x:a {} top:0; @media all {} left:1px}',
  '.k11{x:a b {} top:0}',
  '.k12{x:a{}top:0}',
  '.k13{x:a{b:c} top:0}',
  '.k14{color:red {} top:0}',
  '.k15{p{} color:red {} top:0; q{} left: 1px; y:b{} right:0}',
  '.k16{b{} top:0; x:a{} left:1px}',
  '.k17{b{} top:0; x:a{}}',
  '.k18{x:a {} ; top:0} .k18{left:1px}',
  // Dropped at-rules.
  '.k19{ top:0; @foo {} left:1px }',
  '.k20{ top:0; @foo; left:1px }',
  '.k21{ top:0; @import url(x.css); left:1px }',
  '.k22{ top:0; @charset "x"; left:1px }',
  '.k23{ top:0; @layer x; left:1px }',
  '.k24{ b{} top:0; @foo {} left:1px }',
  // The value and text of a rule given up as a declaration, as written.
  '.k25{ x: a {} top:0 }',
  '.k26{x:a /*c*/ {} top:0}',
  '.k27{x : a{} top:0}',
  '.k28{/*c*/x:a{} top:0}',
  // Several dropped rules: first, in the middle, last.
  '.k29{x:a{} y:b{} top:0}',
  '.k30{!!{} x:a{} top:0}',
  '.k31{top:0; x:a{} y:b{}}',
  // In a nested @media, and alternating with kept rules of the same selector.
  '.k32{@media all{x:a{} top:0}}',
  '.k33{@media all{b{} x:a{} top:0}}',
  '.k34{b{} x:a{} top:0; b{} left:1px}',
  // Comments before the `{`; nothing else before it, where Chrome's value runs to the style's end.
  '.k35{x: /*c*/ a {} top:0}',
  '.k36{x:/*c*/{} top:0}',
  '.k37{x: /*c*/ {} top:0}',
  '.k38{x:{} top:0}',
  '.k39{p{} x:{} top:0}',
  '.k40{x:{}}',
  // A custom property's value takes the block: a declaration, not a rule given up.
  '.k47 { --x:a {} }',
  '.k48 { \\2d-x:a {} }',
  '.k49 { --x:a {} top:0 }',
];

// With no value before the `{` and a `;` later in the style, Chrome reports the style with no
// range, text or properties as written; we report them as for `.k38`: the given-up declaration's
// value and text run to the style's end, over the declarations after it.
const NO_RANGE = ['.k41{x:{} top:0; left:1px}', '.k42{x:/*c*/{} top:0; b{} left:1px}', '.k43{x:{} top:0; y:{} z:a{}}'];

test('rules the CSSOM dropped, among declarations', async tc => {
  for (const css of DROPPED) {
    const cls = /\.(k\d+)/.exec(css)?.[1] ?? '';
    await tc.test(css, () => same(css, `<p class="${cls}">x</p>`, `.${cls}`));
  }
  for (const css of NO_RANGE) {
    const cls = /\.(k\d+)/.exec(css)?.[1] ?? '';
    await tc.test(css, { todo: 'Chrome reports this style with no range' }, () =>
      same(css, `<p class="${cls}">x</p>`, `.${cls}`)
    );
  }
  // Our side alone, pinned, so that a change to it is seen though Chrome's is not compared.
  for (const [css, expected] of [
    [
      '.k44{x:{} top:0; left:1px}',
      [
        [
          '0:5-0:25',
          [
            ['x', '{} top:0; left:1px'],
            ['top', '0'],
            ['left', '1px'],
          ],
        ],
      ],
    ],
    [
      '.k45{x:/*c*/{} top:0; b{} left:1px}',
      [
        [
          '0:5-0:21',
          [
            ['x', '/*c*/{} top:0;'],
            ['top', '0'],
          ],
        ],
        ['0:26-0:34', [['left', '1px']]],
      ],
    ],
    [
      '.k46{x:{} top:0; y:{} z:a{}}',
      [
        [
          '0:5-0:27',
          [
            ['x', '{} top:0; y:{} z:a{}'],
            ['top', '0'],
            ['y', '{} z:a{}'],
            ['z', 'a'],
          ],
        ],
      ],
    ],
  ] as const) {
    const cls = /\.(k\d+)/.exec(css)?.[1] ?? '';
    await tc.test(`${css}, ours`, async () => {
      const at = await addStyle(t, css, `<p class="${cls}">x</p>`);
      const { rules } = await matched(t.ours, `${at} .${cls}`);
      assert.deepEqual(
        rules.map(r => [r.style.range, r.style.properties.filter(p => p.range).map(p => [p.name, p.value])]),
        expected
      );
    });
  }
});

/** The keyframes of the element's animations as Chrome reports them, with their styles. */
async function keyframes(side: Side, selector: string) {
  const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) });
  return (res.cssKeyframesRules ?? []).map(k => k.keyframes.map(f => ({ key: f.keyText.text, ...style(f.style) })));
}

// Keyframes are compared through the keyframes CSS.getMatchedStylesForNode lists for an element's
// animation: they are no matched rules, and that is where the Animations and Styles panes read them.
test('a keyframe with no dropped rule', async () => {
  const at = await addStyle(
    t,
    '@keyframes kk4{from{top:0px} to{left:1px}} .kf4{animation: kk4 10s paused}',
    '<p class="kf4">x</p>'
  );
  const [ours, chrome] = [await keyframes(t.ours, `${at} .kf4`), await keyframes(t.chrome, `${at} .kf4`)];
  assert.ok(chrome.length);
  assert.deepEqual(ours, chrome);
});

test('a dropped at-rule in a keyframe ends no run of declarations', async () => {
  const at = await addStyle(
    t,
    '@keyframes kk1{from{top:0px; @foo{} left:1px} to{left:2px}} .kf1{animation: kk1 10s paused}',
    '<p class="kf1">x</p>'
  );
  const [ours, chrome] = [await keyframes(t.ours, `${at} .kf1`), await keyframes(t.chrome, `${at} .kf1`)];
  assert.ok(chrome.length);
  assert.deepEqual(ours, chrome);
});

test(
  'a rule given up as a declaration in a keyframe',
  { todo: 'Chrome lists no keyframes for the animation; we list them' },
  async () => {
    const at = await addStyle(
      t,
      '@keyframes kk2{from{x:a{} top:0px} to{left:1px}} .kf2{animation: kk2 10s paused}',
      '<p class="kf2">x</p>'
    );
    assert.deepEqual(await keyframes(t.ours, `${at} .kf2`), await keyframes(t.chrome, `${at} .kf2`));
  }
);

test('a rule given up as a declaration in a keyframe, ours', async () => {
  // Our side alone, pinned: `x` listed as given up, `top` the keyframe's own after it.
  const at = await addStyle(
    t,
    '@keyframes kk3{from{x:a{} top:0px} to{left:1px}} .kf3{animation: kk3 10s paused}',
    '<p class="kf3">x</p>'
  );
  const frames = await keyframes(t.ours, `${at} .kf3`);
  assert.deepEqual(
    frames.map(k =>
      k.map(f => [f.key, f.range, f.properties.map(p => [p.name, p.value, p.range ?? null, p.parsedOk])])
    ),
    [
      [
        [
          '0%',
          '0:20-0:33',
          [
            ['x', 'a', '0:20-0:23', false],
            ['top', '0px', '0:26-0:33', undefined],
          ],
        ],
        [
          '100%',
          '0:38-0:46',
          // As Chrome lists a keyframe's properties: each as written, with its range, then the
          // style's own without one (see the plain keyframe compared with Chrome below).
          [
            ['left', '1px', '0:38-0:46', undefined],
            ['left', '1px', null, undefined],
          ],
        ],
      ],
    ]
  );
});

// Editing such a style by the range Chrome gives it: each side on a page of its own.
test('setStyleTexts on the range of a run past dropped rules', async t2 => {
  assert.ok(env);
  // Pages of their own, closed at the end: page a for our agent, page b for Chrome.
  const [a, b] = [await openPage(env, []), await openPage(env, [])];
  t2.after(() => Promise.all([a.page.close(), b.page.close()]));
  const sides: [Side, TestPage][] = [
    [a.ours, a],
    [b.chrome, b],
  ];
  for (const [side] of sides) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
  for (const [css, index] of [
    ['.e1{x:a {} ; top:0}', 0],
    ['.e2{x:a {} ; top:0; b {} left:1px}', 0],
    ['.e3{x:a {} ; top:0; b {} left:1px}', 1],
    ['.e4{color:red {} top:0}', 0],
    ['.e5{p{} color:red {} top:0; q{} left: 1px; y:b{} right:0}', 1],
    ['.e6{p{} color:red {} top:0; q{} left: 1px; y:b{} right:0}', 2],
    ['.e7{ top:0; @foo {} left:1px }', 0],
  ] as const) {
    const cls = /\.(e\d+)/.exec(css)?.[1] ?? '';
    await t2.test(`${css} #${index}`, async () => {
      const results = [];
      for (const [side, page] of sides) {
        const at = await addStyle(page, css, `<p class="${cls}">x</p>`);
        const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} .${cls}`) });
        const own = (res.matchedCSSRules ?? []).filter(
          m => m.rule.origin === 'regular' && m.rule.selectorList.text === `.${cls}`
        );
        const target = own[index]?.rule;
        assert.ok(target?.style.range && target.styleSheetId);
        const edit = await side.send('CSS.setStyleTexts', {
          edits: [{ styleSheetId: target.styleSheetId, range: target.style.range, text: ' top: 5px; ' }],
        });
        const after = await matched(side, `${at} .${cls}`);
        results.push({
          range: target.style.range,
          styles: edit.styles.map(style),
          text: (await side.send('CSS.getStyleSheetText', { styleSheetId: target.styleSheetId })).text,
          after: after.rules,
        });
      }
      assert.deepEqual(results[0], results[1]);
    });
  }
  // Edits after which Chrome writes the text, then hangs on the next CSS.getMatchedStylesForNode,
  // so only our side is run, its output pinned: one without its `;` before a kept rule (`top: 5px
  // b {}` takes in what kept the run; Chrome writes `.h1{ top: 5px  b {} left:1px}`), and one of
  // an own style whose range takes in kept rules (no own declarations; Chrome writes
  // `.h2{ top: 5px }`). Ours: the edited text no longer pairs with the CSSOM, and the sheet is
  // serialized from it.
  for (const [css, written] of [
    ['.h1{x:a {} ; top:0; b {} left:1px}', '.h1 {\n  top: 5px;\n  & b { }\n  left: 1px;\n}\n'],
    [
      '.h2{p{} color:red {} top:0; q{} left: 1px; y:b{} right:0}',
      '.h2 {\n  top: 5px;\n  & p { }\n  top: 0px;\n  & q { }\n  left: 1px; right: 0px;\n}\n',
    ],
  ] as const) {
    const cls = /\.(h\d+)/.exec(css)?.[1] ?? '';
    await t2.test(`${css}, ours`, async () => {
      const [side, page] = sides[0] as [Side, TestPage];
      const at = await addStyle(page, css, `<p class="${cls}">x</p>`);
      const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} .${cls}`) });
      const target = (res.matchedCSSRules ?? []).find(
        m => m.rule.origin === 'regular' && m.rule.selectorList.text === `.${cls}`
      )?.rule;
      assert.ok(target?.style.range && target.styleSheetId);
      await side.send('CSS.setStyleTexts', {
        edits: [{ styleSheetId: target.styleSheetId, range: target.style.range, text: ' top: 5px ' }],
      });
      const text = (await side.send('CSS.getStyleSheetText', { styleSheetId: target.styleSheetId })).text;
      assert.equal(text, written);
    });
  }
});

// After the page changes the rules of such a block through the CSSOM, its text is no longer the
// CSSOM's: we serialize the sheet instead, as for any such change, and report no dropped rule.
// (Chrome keeps the text and pairs what it can by its diff, which we do not follow.)
test('a block with dropped rules the page changed through the CSSOM', async () => {
  const at = await addStyle(t, '.c1{x:a {} ; top:0}', '<p class="c1">x</p>');
  await matched(t.ours, `${at} .c1`);
  await t.page.evaluate(id => {
    const sheet = (document.getElementById(`${id}-style`) as HTMLStyleElement).sheet as CSSStyleSheet;
    (sheet.cssRules[0] as CSSStyleRule).insertRule('b {}', 0);
  }, at.slice(1));
  const { rules } = await matched(t.ours, `${at} .c1`);
  assert.ok(rules.length);
  for (const r of rules) assert.ok(!r.style.properties.some(p => p.name === 'x'), JSON.stringify(r.style));
  // `top` is still the rule's own, as the CSSOM has it.
  const own = rules.find(r => r.text === '.c1' && !r.nestingSelectors);
  assert.ok(
    own?.style.properties.some(p => p.name === 'top' && p.range),
    JSON.stringify(own?.style)
  );
});

test('comments named after members of a style that are no properties: `length`, `item`', () =>
  same(`.m1 { /* length: 1 */ /* item: x */ /* constructor: y */ color: red }`, '<p class="m1">x</p>', '.m1'));

test('error recovery: a block left open', () =>
  same(`.e1 { color: red }\n.e1 {{ broken }\n.e1 { top: 1px }`, '<p class="e1">x</p>', '.e1'));

test('error recovery: unknown at-rules, bad declarations', () =>
  same(
    `@unknown-thing foo { .e2 { color: blue } }
.e2 { color: green; ;; garbage ; margin: 2px; 12px: 3; top: }
@foo;
.e2 { left: 1px }`,
    '<p class="e2">x</p>',
    '.e2'
  ));

test('escapes ending a selector, comments in values and not of properties, disabled !important', () =>
  same(
    `.k\\31  { color: red; /* FIXME: a note */ margin: 0 /*!*/ ; /* padding: 1px !important; */ }
.k\\31, .k1 { top: 1px }`,
    '<p class="k1">x</p>',
    '.k1'
  ));

test('selectors the CSSOM writes otherwise, at the top and nested, around dropped ones', () =>
  same(
    `.b1:before { top: 1px }
.b1[data-x=y] , .b1:after { left: 1px }
.b1:unknown-pseudo { right: 1px }
.b1 { [data-x=y]:before { top: 2px } :bad-one { top: 3px } & .c:after { top: 4px } &[data-x=y] { top: 5px } }
.b1\\
{ bottom: 1px }
.B1\\31 , .b1[data-x="y"] { margin: 0 }
.b1[ data-x = Y i ]:first-letter, .b1[title=":before"]:AFTER { padding: 0 }`,
    '<p class="b1" data-x="y">x</p>',
    '.b1'
  ));

test('selectors with escapes the CSSOM writes otherwise or keeps, and an at-rule name with one', () =>
  same(
    `.e\\66oo { top: 1px }
.e\\:b, .\\31 0e { left: 1px }
.e\\-1\\31, .\\65 foo, .efoo[data-x=y\\ z] { right: 1px }
@\\6d edia screen { .efoo:\\6e ot(.\\31) { bottom: 1px } }
.efoo { &.\\31 { margin: 0 } [data-x='\\79'] { padding: 0 } }
@\\6b eyframes ek1 { from { top: 0 } }
@-webkit-\\6b eyframes ek2 { to { top: 1px } }
.efoo:\\4e th-child( \\6f dd ) { animation: ek1 1s, ek2 1s }`,
    '<p class="efoo e:b 10e" data-x="y">x</p>',
    '.efoo'
  ));

test('relative selector lists in nested rules', () =>
  same(
    `.p1 { a, img { color: red } }
.p1 { a:any-link, img[usemap] { top: 1px } & b, i { left: 1px } }`,
    '<div class="p1"><a href="#">x</a><b>y</b></div>',
    'a'
  ));

test('comments in and after selectors: out of their text, the last one in the range', () =>
  same(
    `p.q1 /*{*/ { top: 1px }
p.q1 /*a*/, /*b*/ div.q1 /*c*/ /*d*/ { left: 1px }
/*x*/p.q1/*y*/{right:1px}
p/*z*/.q1, p /*z*/ .q1,p
/*q*/
.q1
/*w*/ { order: 1 }
p.q1/**/ ,div{bottom:1px}
[title="/*"].q1 /**/ { z-index: 1 }
.q2 { p.q1 /* n */ { color: red } }`,
    '<div class="q2"><p class="q1" title="/*">x</p></div>',
    '.q1'
  ));

test("Chrome's user agent style sheet, whole: the text as written and the rules in it", async () => {
  const css = readFileSync(new URL('../user-agent/html.css', import.meta.url), 'utf8');
  const at = await addStyle(
    t,
    css,
    '<input><button></button><a href="#">a</a><dialog></dialog><table><tr><td>x</td></tr></table>'
  );
  for (const target of ['input', 'button', 'a', 'dialog', 'td']) {
    const { ours, chrome } = await both(t, `${at} ${target}`);
    assert.equal(ours.text, css);
    assert.equal(ours.text, chrome.text);
    assert.deepEqual(ours.rules, chrome.rules, target);
  }
});

test('line breaks: CR LF, CR, FF, U+2028 and characters outside the BMP', () =>
  same(
    // U+2028 is no white space in CSS (`\u2028.l1` would be another selector): here in a comment.
    '.l1 {\r\n  color: red;\r\n}\r\n.l1 { content: "你好😀"; left: 1px }\r.l1 { top: 1px }\f.l1 { right: 1px }/*\u2028*/.l1 { bottom: 1px }',
    '<p class="l1">x</p>',
    '.l1'
  ));

test('@namespace: selectors with prefixes pair in the namespaces the sheet declares', async () => {
  await same(
    '@namespace svg url(http://www.w3.org/2000/svg);\nsvg|\\61 { top: 1px }\n.n1 { color: red }',
    '<p class="n1">x</p>',
    '.n1'
  );
  await same(
    '@namespace url(http://www.w3.org/1999/xhtml);\n@namespace s "http://www.w3.org/2000/svg";\n' +
      '|p, s|\\61 , *|p.n2 { color: red }\n.n2 { top: 1px }',
    '<p class="n2">x</p>',
    '.n2'
  );
});
