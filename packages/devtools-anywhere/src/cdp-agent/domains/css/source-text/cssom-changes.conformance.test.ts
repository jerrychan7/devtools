// The page changing a constructed sheet through the CSSOM again and again, compared with Chrome:
// once serialized, the text changes where the page changed it (sheet-text.ts), and is served, with
// the rules matched and their ranges, as Chrome serves it. Each side changes a page of its own. (A
// <style> changed is serialized here, where Chrome splices the rule's text into it: not compared.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { matched } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let sides: { side: Side; t: TestPage }[] = [];

const CSS = `.c1 { color: red }
@media screen { .c1 { top: 1px } .c2 { left: 1px } }
.c2 { margin: 0 auto; .c3 & { color: blue } }
@keyframes k { from { top: 0 } to { top: 9px } }
.c1, .c2 { padding: 1px 2px }
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    const events = ['CSS.styleSheetAdded', 'CSS.styleSheetChanged'] as const;
    const [a, b] = [await openPage(env, [...events]), await openPage(env, [...events])];
    sides = [
      { side: a.ours, t: a },
      { side: b.chrome, t: b },
    ];
    for (const { side, t } of sides) {
      await t.page.evaluate(css => {
        const adopted = new CSSStyleSheet();
        adopted.replaceSync(css);
        document.adoptedStyleSheets = [adopted];
        document.body.insertAdjacentHTML('beforeend', '<div class="c3"><p class="c1 c2 n" id="p1">x</p></div>');
      }, CSS);
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

/** The sheet's text after `steps`, and the rules #p1 matches in it. */
async function after(side: Side, t: TestPage, steps: string[]) {
  await t.page.evaluate(steps => {
    for (const step of steps) new Function('sheet', step)(document.adoptedStyleSheets[0]);
  }, steps);
  const { sheet, rules } = await matched(side, '#p1');
  const { text } = await side.send('CSS.getStyleSheetText', { styleSheetId: sheet });
  return { text, rules };
}

const ROUNDS: string[][] = [
  ["sheet.cssRules[0].style.setProperty('color', 'green')"],
  ["sheet.cssRules[4].selectorText = '.c1'", "sheet.cssRules[2].style.setProperty('border', '1px solid')"],
  ["sheet.insertRule('.c2 { order: 2 }', 0)"],
  ["sheet.insertRule('.c1 { order: 1 }', 3)"],
  ['sheet.deleteRule(sheet.cssRules.length - 1)'],
  ["sheet.cssRules[2].insertRule('.c1 { right: 1px }')"],
  ["sheet.cssRules[5].appendRule('50% { top: 4px }')"],
  [
    "sheet.insertRule('.n { color: red }', 1)",
    "sheet.insertRule('.c2 { order: 3 }', 0)",
    'sheet.deleteRule(2)',
    "sheet.cssRules[0].style.setProperty('order', '4')",
    "sheet.insertRule('.c1 { z-index: 1 }', sheet.cssRules.length)",
    'sheet.deleteRule(sheet.cssRules.length - 1)',
    "sheet.insertRule('.c1 { z-index: 2 }', 3)",
    'sheet.deleteRule(1)',
    "sheet.cssRules[2].style.setProperty('z-index', '3')",
  ],
  // A rule's media list.
  ["[...sheet.cssRules].find(r => r.media).media.mediaText = 'all'"],
  ["[...sheet.cssRules].find(r => r.media).media.appendMedium('print')"],
  ["[...sheet.cssRules].find(r => r.media).media = 'screen, print'"],
];

test('a sheet the page changes round after round: its text and the matched rules as in Chrome', async () => {
  for (const [i, steps] of ROUNDS.entries()) {
    const [a, b] = sides;
    assert.ok(a && b);
    const ours = await after(a.side, a.t, steps);
    const chrome = await after(b.side, b.t, steps);
    assert.deepEqual(ours, chrome, `round ${i}`);
  }
});
