// @container, @scope, @starting-style and @layer in CSS.getMatchedStylesForNode, compared
// with Chrome: which rules match, their cascade order and the at-rules reported on them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  @layer a { @layer x { #c-box { z-index: 1; } } #c-box { z-index: 2; } }
  @layer { #c-box { z-index: 3; } }
  @layer a.x { #c-box { z-index: 4; } }
  @scope (.c-wrap) { :scope #c-box { top: 1px; } & #c-box { left: 1px; } }
  @scope (.c-wrap) to (.c-in) { #c-box2 { right: 1px; } }
  @layer base, top;
  @layer top { #c-box { padding: 1px; color: red !important; } }
  @layer base { #c-box { padding: 2px; color: blue !important; } }
  #c-box { padding: 3px; }
  .c-wrap { container: card / inline-size; width: 300px; }
  .c-in { container-type: size; height: 50px; width: 40px; padding: 5px; box-sizing: border-box; }
  @container card (min-width: 200px) { #c-box { margin: 1px; } }
  @container card (width > 400px) { #c-box { margin: 5px; } }
  @container (width < 100px) { #c-box { margin: 2px; } }
  @container other (width > 0px) { #c-box { margin: 6px; } }
  @supports (display: grid) { @media (min-width: 1px) { #c-box { border-width: 1px; } } }
  @scope (.c-wrap) to (.c-stop) { #c-box { outline-width: 1px; } }
  @starting-style { #c-box { opacity: 0; } }
  @container (height > 10px) and (width > 1000px) { #c-box2 { margin: 1px; } }
  @container not (width > 1000px) { #c-box2 { margin: 2px; } }
  @container style(--k: v) { #c-box2 { margin: 3px; } }
  @container style(--k: w) { #c-box2 { margin: 7px; } }
  @container (orientation: portrait) or (width > 1000px) { #c-box2 { margin: 4px; } }
  @container (30px <= width <= 30px) { #c-box2 { margin: 8px; } }
  @container (aspect-ratio < 1) { #c-box2 { margin: 9px; } }
  @container card (inline-size >= 300px) { #c-box2 { margin: 10px; } }
  @container (unknown-feature > 1px) { #c-box2 { margin: 11px; } }
`;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.evaluate(style => {
    const s = document.createElement('style');
    s.textContent = style;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="c-wrap"><div id="c-box">y</div><div class="c-in" style="--k: v"><i id="c-box2"></i></div></div>'
    );
  }, STYLE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

test('size queries of an unrendered container and containers up the flat tree match Chrome', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = `
      .c-hide { container-type: inline-size; width: 300px; }
      @container (width > 100px) { #c-hidden, #c-hidden2, #c-slotted { margin: 3px; } }
      @container (width < 100px) { #c-slotted { padding: 4px; } }
    `;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="c-hide" style="display: none"><i id="c-hidden"></i></div>' +
        '<div style="display: none"><div class="c-hide"><i id="c-hidden2"></i></div></div>' +
        '<div id="c-host" class="c-hide"><i id="c-slotted"></i></div>'
    );
    const host = document.getElementById('c-host');
    const root = host?.attachShadow({ mode: 'open' });
    if (root) root.innerHTML = '<div style="container-type: inline-size; width: 50px"><slot></slot></div>';
  });
  for (const selector of ['#c-hidden', '#c-hidden2', '#c-slotted']) {
    const [mo, mc] = await Promise.all(
      [t.ours, t.chrome].map(async side =>
        summarize(
          (await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) })).matchedCSSRules ??
            []
        )
      )
    );
    assert.deepEqual(mo, mc, selector);
  }
});

async function nodeId(side: Side, selector: string) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  return nodeId;
}

const summarize = (matches: Protocol.CSS.RuleMatch[]) =>
  matches
    .filter(m => m.rule.origin === 'regular' && m.rule.selectorList.text !== 'p, .note')
    .map(({ rule, matchingSelectors }) => ({
      selector: rule.selectorList.text,
      specificity: rule.selectorList.selectors.map(s => [s.specificity?.a, s.specificity?.b, s.specificity?.c]),
      matchingSelectors,
      ruleTypes: rule.ruleTypes ?? [],
      layers: (rule.layers ?? []).map(l => l.text),
      containerQueries: (rule.containerQueries ?? []).map(
        ({ text, name, physicalAxes, logicalAxes, conditionText }) => ({
          text,
          name,
          physicalAxes,
          logicalAxes,
          conditionText,
        })
      ),
      scopes: (rule.scopes ?? []).map(s => s.text),
      supports: (rule.supports ?? []).map(s => ({ text: s.text, active: s.active })),
      media: (rule.media ?? []).map(m => m.text),
      declared: rule.style.cssProperties
        .filter(p => p.text)
        .map(p => `${p.name}: ${p.value.replace(/\s*!important$/, '')}${p.important ? ' !important' : ''}`),
    }));

for (const selector of ['#c-box', '#c-box2']) {
  test(`conditional rules and layers matching ${selector}`, async () => {
    const [mo, mc] = await Promise.all(
      [t.ours, t.chrome].map(async side =>
        summarize(
          (await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) })).matchedCSSRules ??
            []
        )
      )
    );
    assert.ok(mc && mc.length > 0);
    assert.deepEqual(mo, mc);
  });
}

test('!important values, empty rule arrays and media lists match Chrome', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '@media screen and (min-width: 1px), (max-width: 2em) { #c-imp { padding: 2px !important; } }';
    document.head.appendChild(s);
    // Media queries do not use the root's font size for em.
    document.documentElement.style.fontSize = '20px';
    document.body.insertAdjacentHTML('beforeend', '<div id="c-imp" style="color: red !important; margin: 1px"></div>');
  });
  const result: unknown[] = [];
  for (const side of [t.ours, t.chrome]) {
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#c-imp' });
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId });
    const rule = (m.matchedCSSRules ?? []).find(r => r.rule.selectorList.text === '#c-imp')?.rule;
    assert.ok(rule && m.inlineStyle);
    const props = (style: Protocol.CSS.CSSStyle) =>
      style.cssProperties
        .filter(p => p.text)
        .map(p => ({ name: p.name, value: p.value, important: p.important, longhands: p.longhandProperties }));
    result.push({
      inline: props(m.inlineStyle),
      rule: props(rule.style),
      shorthands: rule.style.shorthandEntries,
      media: rule.media?.map(x => ({ text: x.text, source: x.source, sourceURL: x.sourceURL, mediaList: x.mediaList })),
      arrays: [rule.containerQueries, rule.supports, rule.layers, rule.scopes, rule.startingStyles, rule.navigations],
      ruleTypes: rule.ruleTypes,
    });
  }
  assert.deepEqual(result[0], result[1]);
});
