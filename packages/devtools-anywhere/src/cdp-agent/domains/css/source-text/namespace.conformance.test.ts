// Sheets with @namespace rules, compared with Chrome: their text as written and the rules paired
// with it, selectors with namespace prefixes parsed in the namespaces the sheet declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown, waitForBoth } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both } from '../../../../../test-support/css-source.ts';

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
