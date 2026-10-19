import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, waitForBoth } from './harness.ts';
import type { Env, TestPage } from './harness.ts';

type DomNode = Protocol.DOM.Node;

let env: Env | undefined;
let t: TestPage;
let ours: DomNode;
let chrome: DomNode;

before(async () => {
  env = await launch();
  t = await openPage(env, ['CSS.styleSheetAdded']);
  await Promise.all([t.ours.send('DOM.enable'), t.chrome.send('DOM.enable')]);
  await Promise.all([t.ours.send('CSS.enable'), t.chrome.send('CSS.enable')]);
  ours = (await t.ours.send('DOM.getDocument', { depth: -1 })).root;
  chrome = (await t.chrome.send('DOM.getDocument', { depth: -1 })).root;
});
after(() => env?.close());

function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const attr = (node: DomNode, name: string): string | undefined => {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
};
const nodeIds = (predicate: (n: DomNode) => boolean): [number, number] => {
  const [o, c] = [find(ours, predicate), find(chrome, predicate)];
  assert.ok(o && c);
  return [o.nodeId, c.nodeId];
};
const byId = (id: string) => nodeIds(n => attr(n, 'id') === id);
const byTag = (tag: string) => nodeIds(n => n.localName === tag);

/** Author rules only (Chrome also reports user-agent rules), reduced to what the panel shows. */
const summarize = (matches: Protocol.CSS.RuleMatch[]) =>
  matches
    .filter(m => m.rule.origin === 'regular')
    .map(m => ({
      selector: m.rule.selectorList.text,
      matching: m.matchingSelectors,
      specificity: m.rule.selectorList.selectors.map(({ specificity }) => {
        assert.ok(specificity);
        const { a, b, c } = specificity;
        return { a, b, c };
      }),
      media: (m.rule.media || []).map(x => x.text),
      declared: declared(m.rule.style),
    }));
const declared = (style: Protocol.CSS.CSSStyle) =>
  style.cssProperties.filter(p => p.text).map(p => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`);

describe('CSS', () => {
  test('styleSheetAdded for the fixture sheet', async () => {
    const [[o], [c]] = await waitForBoth(t, 'CSS.styleSheetAdded');
    assert.ok(o && c);
    assert.equal(o.header.origin, c.header.origin);
    assert.equal(o.header.isInline, c.header.isInline);
  });

  for (const [name, pick] of [
    ['#app', () => byId('app')],
    ['section', () => byTag('section')],
    ['p', () => byTag('p')],
  ] as const) {
    test(`getMatchedStylesForNode ${name}`, async () => {
      const [o, c] = pick();
      const [mo, mc] = await Promise.all([
        t.ours.send('CSS.getMatchedStylesForNode', { nodeId: o }),
        t.chrome.send('CSS.getMatchedStylesForNode', { nodeId: c }),
      ]);
      assert.ok(mo.matchedCSSRules && mc.matchedCSSRules && mo.inherited && mc.inherited);
      assert.deepEqual(summarize(mo.matchedCSSRules), summarize(mc.matchedCSSRules));
      assert.deepEqual(mo.inlineStyle && declared(mo.inlineStyle), mc.inlineStyle && declared(mc.inlineStyle));
      assert.deepEqual(
        mo.inherited.map(e => summarize(e.matchedCSSRules)),
        mc.inherited.map(e => summarize(e.matchedCSSRules))
      );
    });
  }

  test('getComputedStyleForNode', async () => {
    const [o, c] = byTag('section');
    const [so, sc] = await Promise.all([
      t.ours.send('CSS.getComputedStyleForNode', { nodeId: o }),
      t.chrome.send('CSS.getComputedStyleForNode', { nodeId: c }),
    ]);
    const pick = (list: Protocol.CSS.GetComputedStyleForNodeResponse) =>
      Object.fromEntries(list.computedStyle.map(p => [p.name, p.value]));
    const [po, pc] = [pick(so), pick(sc)];
    for (const name of ['width', 'color', 'padding-top', 'margin-left', 'border-top-width', 'display']) {
      assert.equal(po[name], pc[name], name);
    }
  });

  test('editing a rule through setStyleTexts', async () => {
    const [o] = byId('app');
    const { matchedCSSRules } = await t.ours.send('CSS.getMatchedStylesForNode', { nodeId: o });
    const rule = matchedCSSRules?.find(m => m.rule.selectorList.text === '#app.a')?.rule;
    assert.ok(rule?.styleSheetId && rule.style.range);
    const { styles } = await t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: rule.styleSheetId, range: rule.style.range, text: 'color: rgb(1, 2, 3);' }],
    });
    assert.ok(styles[0]);
    assert.deepEqual(declared(styles[0]), ['color: rgb(1, 2, 3)']);
    const color = await t.page.evaluate(() => {
      const app = document.getElementById('app');
      if (!app) throw new Error('#app not found');
      return getComputedStyle(app).color;
    });
    assert.equal(color, 'rgb(1, 2, 3)');
  });

  test('editing the inline style', async () => {
    const [o] = byTag('section');
    const { inlineStyle } = await t.ours.send('CSS.getInlineStylesForNode', { nodeId: o });
    assert.ok(inlineStyle?.styleSheetId && inlineStyle.range);
    await t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: inlineStyle.styleSheetId, range: inlineStyle.range, text: 'width: 60px;' }],
    });
    const width = await t.page.evaluate(() => {
      const section = document.querySelector('section');
      if (!section) throw new Error('section not found');
      return section.style.width;
    });
    assert.equal(width, '60px');
  });

  test('adding a rule to the inspector style sheet', async () => {
    const { styleSheetId } = await t.ours.send('CSS.createStyleSheet', { frameId: 'x' });
    const { rule } = await t.ours.send('CSS.addRule', {
      styleSheetId,
      ruleText: 'span { outline: 1px solid red; }',
      location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    });
    assert.equal(rule.origin, 'inspector');
    const outline = await t.page.evaluate(() => {
      const span = document.querySelector('span');
      if (!span) throw new Error('span not found');
      return getComputedStyle(span).outlineStyle;
    });
    assert.equal(outline, 'solid');
  });
});
