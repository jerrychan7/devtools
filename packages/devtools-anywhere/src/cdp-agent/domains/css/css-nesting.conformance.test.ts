// CSS nesting in CSS.getMatchedStylesForNode: nested rules, nested declarations and forced
// pseudo-classes in nested rules (`&:hover`), compared with Chrome.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  .n-outer, .n-alt {
    color: rgb(1, 0, 0);
    & .n-inner { color: rgb(2, 0, 0); &:hover { color: rgb(3, 0, 0); } }
    & > b { color: rgb(4, 0, 0); }
    @media (min-width: 1px) { padding: 1px; }
    @media (max-width: 1px) { padding: 2px; }
    margin: 1px;
  }
  .n-hover { &:hover { outline-color: rgb(5, 0, 0); } }
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
      '<div class="n-outer" id="n-o"><p class="n-inner" id="n-p">x</p><b id="n-b"></b></div><i class="n-hover" id="n-h"></i>'
    );
  }, STYLE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

async function nodeId(side: Side, selector: string) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  return nodeId;
}

const summarize = (matches: Protocol.CSS.RuleMatch[]) =>
  matches
    .filter(m => m.rule.origin === 'regular' && m.rule.styleSheetId)
    .filter(m => !['p, .note'].includes(m.rule.selectorList.text))
    .map(({ rule, matchingSelectors }) => ({
      selector: rule.selectorList.text,
      selectors: rule.selectorList.selectors.map(s => ({
        text: s.text,
        a: s.specificity?.a,
        b: s.specificity?.b,
        c: s.specificity?.c,
      })),
      matchingSelectors,
      nestingSelectors: rule.nestingSelectors ?? [],
      ruleTypes: rule.ruleTypes ?? [],
      media: (rule.media ?? []).map(m => m.text),
      declared: rule.style.cssProperties.filter(p => p.text).map(p => `${p.name}: ${p.value}`),
    }));

async function matched(side: Side, id: number) {
  return summarize((await side.send('CSS.getMatchedStylesForNode', { nodeId: id })).matchedCSSRules ?? []);
}

for (const selector of ['#n-o', '#n-p', '#n-b']) {
  test(`nested rules matching ${selector}`, async () => {
    const [ours, chrome] = [
      await matched(t.ours, await nodeId(t.ours, selector)),
      await matched(t.chrome, await nodeId(t.chrome, selector)),
    ];
    assert.ok(chrome.length > 0);
    assert.deepEqual(ours, chrome);
  });
}

/** Forces :hover on `selector` through one side, returns its matched rules and color, then un-forces. */
async function hovered(side: Side, selector: string) {
  const id = await nodeId(side, selector);
  await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['hover'] });
  try {
    const rules = await matched(side, id);
    const style = await t.page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.color, outline: cs.outlineColor };
    }, selector);
    return { rules, style };
  } finally {
    await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
  }
}

for (const selector of ['#n-p', '#n-h']) {
  test(`forced :hover in a nested rule (${selector})`, async () => {
    const chrome = await hovered(t.chrome, selector);
    const ours = await hovered(t.ours, selector);
    assert.ok(chrome.rules.some(r => r.selector === '&:hover'));
    assert.deepEqual(ours, chrome);
  });
}
