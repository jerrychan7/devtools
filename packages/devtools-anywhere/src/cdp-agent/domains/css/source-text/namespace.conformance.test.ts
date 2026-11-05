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

const XHTML = '@namespace h url(http://www.w3.org/1999/xhtml);';

test('a selector with a namespace prefix matches in the namespace it is declared with', () =>
  same(
    `${XHTML}\nh|p.n20 { top: 1px }\n*|p.n20 { left: 1px }\n|p.n20 { right: 1px }\n[h|title].n20 { order: 1 }\np.n20 { bottom: 1px }`,
    '<p class="n20" title="a">x</p>',
    '.n20'
  ));

test('with a default namespace, a selector without a prefix matches only in it', () =>
  same(
    '@namespace url(http://www.w3.org/2000/svg);\np.n21 { top: 1px }\n.n21 { left: 1px }\n*.n21 { right: 1px }\n*|p.n21 { bottom: 1px }',
    '<p class="n21">x</p>',
    '.n21'
  ));

test('a prefixed selector matches SVG elements, with combinators too', () =>
  same(
    `${SVG}\n${XHTML}\nsvg|rect.n22 { top: 1px }\nrect.n22 { left: 1px }\nh|div svg|rect.n22 { right: 1px }\nh|rect.n22 { bottom: 1px }\nsvg|svg > .n22 { order: 1 }`,
    '<svg><rect class="n22"/></svg>',
    '.n22'
  ));

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

test('addRule at the line of @namespace rules: the rule goes in after them, its text where asked', async () => {
  const cases: [string, number][] = [
    [`${SVG}\n.n6 { color: red }`, 0],
    [`${SVG}\n.n6 { color: red }`, SVG.length],
    [`@import url("data:text/css,.zz{}");\n${SVG}\n.n6 { color: red }`, 0],
  ];
  for (const [css, column] of cases) {
    // A sheet for each side: both are on the same page.
    const sheets = [await added(css), await added(css)];
    const result: { outcome: unknown; text: string; rules: string[] }[] = [];
    for (const [i, side] of [t.ours, t.chrome].entries()) {
      const { at, ids } = sheets[i] ?? { at: '', ids: [] };
      const id = ids[i] ?? '';
      const outcome = await side
        .send('CSS.addRule', {
          styleSheetId: id,
          ruleText: '.n7 { top: 1px }',
          location: { startLine: 0, startColumn: column, endLine: 0, endColumn: column },
        })
        .then(
          r => r.rule.selectorList.selectors.map(s => s.range),
          (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
        );
      result.push({ outcome, text: await text(side, id), rules: await cssom(at) });
    }
    const [ours, chrome] = result;
    assert.ok(ours && chrome);
    // Before an @import the rule is refused. Chrome's sheet then has lost its @import rule as well
    // (Chrome 156): not followed, ours keeps its rules as they were.
    if (css.startsWith('@import')) {
      assert.equal(ours.rules[0], '@import url("data:text/css,.zz{}");');
      chrome.rules = ours.rules;
    }
    assert.deepEqual(ours, chrome, `${column} in ${css}`);
  }
});

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

const outcome = (p: Promise<unknown>) =>
  p.then(
    r => r,
    (e: Error) => (e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')
  );
/** Without sheet ids, and the specificity of selectors, which ours gives only in part. */
const plain = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'specificity' || k === 'styleSheetId' ? undefined : x)));

test('after addRule before @namespace rules, that rule and the one after it are edited as written', async () => {
  const css = `${SVG}\n.n11 { color: red }\n`;
  const html = '<p class="n11 n12">x</p>';
  const sheets = [await added(css, html), await added(css, html)];
  const result = [];
  for (const [i, side] of [t.ours, t.chrome].entries()) {
    const { at, ids } = sheets[i] ?? { at: '', ids: [] };
    const id = ids[i] ?? '';
    const steps: unknown[] = [];
    const add = await side.send('CSS.addRule', {
      styleSheetId: id,
      ruleText: '.n12 { top: 1px }',
      location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    });
    steps.push(plain(add.rule.selectorList), add.rule.style.range);
    // The new rule, then the one after the @namespace rule, each by the range it is given now.
    for (const [selector, style] of [
      ['.n12, .n13', 'top: 2px'],
      ['.n11, .n14', 'color: blue'],
    ] as const) {
      const { rules } = await side
        .send('CSS.getMatchedStylesForNode', {
          nodeId: await nodeId(side, `${at} .n11`),
        })
        .then(r => ({ rules: (r.matchedCSSRules ?? []).map(m => m.rule).filter(r => r.styleSheetId === id) }));
      const rule = rules.find(r => r.selectorList.text.startsWith(selector.slice(0, 4)));
      steps.push(plain(rules.map(r => [r.selectorList, r.style.range, r.style.cssText])));
      steps.push(
        plain(
          await outcome(
            side.send('CSS.setStyleTexts', {
              edits: [{ styleSheetId: id, range: rule?.style.range as never, text: style }],
            })
          )
        )
      );
      steps.push(
        plain(
          await outcome(
            side.send('CSS.setRuleSelector', {
              styleSheetId: id,
              range: rule?.selectorList.selectors[0]?.range as never,
              selector,
            })
          )
        )
      );
      steps.push(await text(side, id), await cssom(at));
    }
    result.push(steps);
  }
  assert.deepEqual(result[0], result[1]);
});

test('addRule with an @import in a group rule, or before an @import, is refused as in Chrome', async () => {
  const css = `@import url("data:text/css,.zz{}");\n@media all {\n  .n15 { top: 1px }\n}\n`;
  const sheets = [await added(css), await added(css)];
  const result = [];
  for (const [i, side] of [t.ours, t.chrome].entries()) {
    const ids = sheets[i]?.ids ?? [];
    const id = ids[i] ?? '';
    const steps: unknown[] = [];
    for (const [ruleText, line, column] of [
      ['@import url("data:text/css,.yy{}");', 2, 2],
      ['.n16 { top: 1px }', 0, 0],
    ] as const)
      steps.push(
        await outcome(
          side.send('CSS.addRule', {
            styleSheetId: id,
            ruleText,
            location: { startLine: line, startColumn: column, endLine: line, endColumn: column },
          })
        ).then(r => (typeof r === 'string' ? r : 'ok')),
        await text(side, id)
      );
    result.push(steps);
  }
  assert.deepEqual(result[0], result[1]);
});
