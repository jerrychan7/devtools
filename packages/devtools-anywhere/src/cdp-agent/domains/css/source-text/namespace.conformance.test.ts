// Sheets with @namespace rules, compared with Chrome: their text as written and the rules paired
// with it, selectors with namespace prefixes parsed in the namespaces the sheet declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown, waitForBoth } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both, nodeId } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['CSS.styleSheetAdded']);
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

const SVG = '@namespace svg url(http://www.w3.org/2000/svg);';

/** Adds a <style> with `css`; returns its sheet's id on each side, [ours, chrome]. */
async function added(css: string, html = ''): Promise<{ at: string; ids: [string, string] }> {
  await t.ours.clear();
  await t.chrome.clear();
  const at = await addStyle(t, css, html);
  const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetAdded');
  // Not that of a file it imports.
  const own = (list: typeof ours) =>
    list.filter(e => !e.header.sourceURL.startsWith('data:')).at(-1)?.header.styleSheetId ?? '';
  return { at, ids: [own(ours), own(chrome)] };
}

const text = (side: Side, styleSheetId: string) =>
  side.send('CSS.getStyleSheetText', { styleSheetId }).then(r => r.text);

/** The text of the sheet with `css` and the rules of it matching `target`, on both sides. */
async function same(css: string, html: string, target: string) {
  const at = await addStyle(t, css, html);
  const { ours, chrome } = await both(t, `${at} ${target}`);
  assert.equal(chrome.text, css);
  assert.equal(ours.text, chrome.text);
  assert.ok(chrome.rules.length);
  assert.deepEqual(ours.rules, chrome.rules);
}

test('a sheet of @namespace rules only is served as written', async () => {
  const css = `${SVG}\n@namespace "http://www.w3.org/1999/xhtml";\n`;
  const { ids } = await added(css);
  assert.equal(await text(t.chrome, ids[1]), css);
  assert.equal(await text(t.ours, ids[0]), css);
});

test('@import before @namespace: the rules after them pair', () =>
  same(
    `@import url("data:text/css,.zz{}");\n${SVG}\nsvg|\\61 , .n4 { color: red }\n.n4 { top: 1px }`,
    '<p class="n4">x</p>',
    '.n4'
  ));

test('an invalid @namespace: a selector with its prefix is dropped, the rules after it pair', () =>
  same(
    '@namespace x y z;\n@namespace x;\nx|p, .n5 { color: red }\n.n5 { top: 1px }\n.n5 { left: 1px }',
    '<p class="n5">x</p>',
    '.n5'
  ));

/** The rules of the <style> in `at`, as the CSSOM serializes them. */
const cssom = (at: string) =>
  t.page.evaluate(
    at =>
      [...((document.getElementById(`${at.slice(1)}-style`) as HTMLStyleElement).sheet?.cssRules ?? [])].map(
        r => r.cssText
      ),
    at
  );

/**
 * Inserts `rule` at `index` of the <style> in `at` through the CSSOM: from then on its text is
 * serialized. Ours puts each style rule on the line of its id, the @namespace rules on line 0;
 * Chrome joins the rules' texts and lags behind the CSSOM, so the texts are not compared as a
 * whole, only where the @namespace rules are.
 */
const insert = (at: string, rule: string, index: number) =>
  t.page.evaluate(
    (at, rule, index) => {
      (document.getElementById(`${at.slice(1)}-style`) as HTMLStyleElement).sheet?.insertRule(rule, index);
    },
    at,
    rule,
    index
  );

test('@namespace in a sheet served serialized: on line 0, the style rules after it', async () => {
  const { at, ids } = await added(`${SVG}\n.n8 { color: red }`, '<p class="n8">x</p>');
  await insert(at, '.n8 { top: 1px }', 1);
  const [ours, chrome] = [await text(t.ours, ids[0]), await text(t.chrome, ids[1])];
  assert.ok(chrome.startsWith('@namespace svg'));
  // Style rules are on the lines of their ids, given in the order they are first seen.
  const [first, ...lines] = ours.split('\n');
  assert.equal(first, '@namespace svg url("http://www.w3.org/2000/svg");');
  assert.deepEqual(lines.toSorted(), ['.n8 { color: red; }', '.n8 { top: 1px; }']);
  const line = lines.indexOf('.n8 { top: 1px; }') + 1;
  const res = await t.ours.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(t.ours, `${at} .n8`) });
  const top = res.matchedCSSRules?.map(m => m.rule).find(r => r.style.cssText === 'top: 1px;');
  assert.ok(top?.style.range);
  assert.deepEqual(top.selectorList.selectors[0]?.range, {
    startLine: line,
    startColumn: 0,
    endLine: line,
    endColumn: 3,
  });
  await t.ours.send('CSS.setStyleTexts', {
    edits: [{ styleSheetId: ids[0], range: top.style.range, text: 'top: 2px' }],
  });
  assert.equal((await text(t.ours, ids[0])).split('\n')[line], '.n8 { top: 2px; }');

  // addRule at line 0 puts the rule after the @namespace rules.
  await t.ours.send('CSS.addRule', {
    styleSheetId: ids[0],
    ruleText: '.n9 { left: 1px }',
    location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  });
  assert.deepEqual((await cssom(at)).slice(0, 2), [
    '@namespace svg url("http://www.w3.org/2000/svg");',
    '.n9 { left: 1px; }',
  ]);
});

test('a sheet of @namespace rules only, served serialized: they are its text', async () => {
  const { at, ids } = await added(`${SVG}\n`);
  await insert(at, '@namespace h url(http://www.w3.org/1999/xhtml)', 1);
  assert.ok((await text(t.chrome, ids[1])).startsWith('@namespace svg'));
  assert.equal(
    await text(t.ours, ids[0]),
    '@namespace svg url("http://www.w3.org/2000/svg"); @namespace h url("http://www.w3.org/1999/xhtml");'
  );
});

test('@import before @namespace, served serialized: the @namespace rules on line 0', async () => {
  const { at, ids } = await added(`@import url("data:text/css,.zz{}");\n${SVG}\n.n10 { color: red }`);
  await insert(at, '.n10 { top: 1px }', 2);
  const chrome = await text(t.chrome, ids[1]);
  assert.ok(chrome.startsWith('@import') && chrome.includes('@namespace svg'));
  // The serialized text leaves @import out, as it always has.
  const [first, ...lines] = (await text(t.ours, ids[0])).split('\n');
  assert.equal(first, '@namespace svg url("http://www.w3.org/2000/svg");');
  assert.deepEqual(lines.toSorted(), ['.n10 { color: red; }', '.n10 { top: 1px; }']);
});
