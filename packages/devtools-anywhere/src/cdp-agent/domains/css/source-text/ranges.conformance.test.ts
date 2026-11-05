// The text of a <style> and the ranges of its rules in it, compared with Chrome: selectors,
// declarations (commented out, !important, invalid, without `;`), at-rule conditions, nesting,
// error recovery and line breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both } from '../../../../../test-support/css-source.ts';

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

test('line breaks: CR LF, CR, FF, U+2028 and characters outside the BMP', () =>
  same(
    // U+2028 is no white space in CSS (`\u2028.l1` would be another selector): here in a comment.
    '.l1 {\r\n  color: red;\r\n}\r\n.l1 { content: "你好😀"; left: 1px }\r.l1 { top: 1px }\f.l1 { right: 1px }/*\u2028*/.l1 { bottom: 1px }',
    '<p class="l1">x</p>',
    '.l1'
  ));
