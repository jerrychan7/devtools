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
    // Escapes, non-ASCII names, quoted attribute values and selector-list pseudo-classes.
    ['#spec', () => byId('spec')],
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

  test('shorthands list their longhands (expanded in the Styles pane)', async () => {
    const [o, c] = byTag('section');
    const [mo, mc] = await Promise.all([
      t.ours.send('CSS.getMatchedStylesForNode', { nodeId: o }),
      t.chrome.send('CSS.getMatchedStylesForNode', { nodeId: c }),
    ]);
    const longhands = (matches: Protocol.CSS.RuleMatch[] | undefined) =>
      matches
        ?.find(m => m.rule.selectorList.text === '.box')
        ?.rule.style.cssProperties.filter(p => p.text)
        .map(p => ({ name: p.name, longhands: p.longhandProperties ?? [] }));
    const result = longhands(mo.matchedCSSRules);
    assert.deepEqual(result, longhands(mc.matchedCSSRules));
    assert.ok(result?.some(p => p.name === 'margin' && p.longhands.length === 4));
  });

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

  test('an added rule is taken back by undo after undo and redo', async () => {
    const { styleSheetId } = await t.ours.send('CSS.createStyleSheet', { frameId: 'x' });
    const count = () =>
      t.page.evaluate(
        () =>
          Array.from(document.styleSheets)
            .flatMap(s => Array.from(s.cssRules))
            .filter(r => r.cssText.includes('.undo-twice')).length
      );
    await t.ours.send('DOM.markUndoableState');
    await t.ours.send('CSS.addRule', {
      styleSheetId,
      ruleText: '.undo-twice { color: rgb(5, 5, 5); }',
      location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    });
    await t.ours.send('DOM.markUndoableState');
    const seen = [await count()];
    for (const step of ['DOM.undo', 'DOM.redo', 'DOM.undo'] as const) {
      await t.ours.send(step);
      seen.push(await count());
    }
    assert.deepEqual(seen, [1, 0, 1, 0]);
  });

  /**
   * The fixture has two style sheets that differ only in the class name (twin-o, twin-c). Each
   * side edits its own, so the responses can be compared without one edit seeing the other's.
   */
  describe('editing, compared with Chrome', () => {
    type Twin = { side: TestPage['ours']; root: DomNode; name: string };
    const twins = (): [Twin, Twin] => [
      { side: t.ours, root: ours, name: 'twin-o' },
      { side: t.chrome, root: chrome, name: 'twin-c' },
    ];
    /** The twin's element, or its `.k` child with `inner`. */
    const nodeOf = ({ root, name }: Twin, inner = false) => {
      const outer = find(root, n => attr(n, 'class') === name);
      const node = outer && inner ? find(outer, n => attr(n, 'class') === 'k') : outer;
      assert.ok(node);
      return node.nodeId;
    };
    /** The twin's rule with this selector (`%` stands for the class name). */
    const ruleOf = async (twin: Twin, selector: string, inner = false) => {
      const { side, name } = twin;
      const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId: nodeOf(twin, inner) });
      const rule = matchedCSSRules?.find(m => m.rule.selectorList.text === selector.replace('%', name))?.rule;
      assert.ok(rule?.styleSheetId && rule.style.range);
      return {
        styleSheetId: rule.styleSheetId,
        range: rule.style.range,
        selectorRange: rule.selectorList.selectors[0]?.range,
      };
    };
    /** Chrome's result with its class name written as ours. */
    const asOurs = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('twin-c', 'twin-o')) as T;
    /**
     * Ours serves its own text for a sheet (one rule per line), so text and ranges differ from
     * Chrome's by design: compare text with whitespace collapsed, and leave ranges out.
     */
    const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
    const style = (s: Protocol.CSS.CSSStyle | undefined) => s && declared(s);
    const selectors = (list: Protocol.CSS.SelectorList) => ({
      text: list.text,
      selectors: list.selectors.map(({ text, specificity }) => {
        assert.ok(specificity);
        const { a, b, c } = specificity;
        return { text, specificity: { a, b, c } };
      }),
    });

    before(async () => {
      ours = (await t.ours.send('DOM.getDocument', { depth: -1 })).root;
      chrome = (await t.chrome.send('DOM.getDocument', { depth: -1 })).root;
    });

    test('getStyleSheetText', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { styleSheetId } = await ruleOf(twin, '.%');
          return flat((await twin.side.send('CSS.getStyleSheetText', { styleSheetId })).text);
        })
      );
      assert.equal(o, asOurs(c));
    });

    test('collectClassNames', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { styleSheetId } = await ruleOf(twin, '.%');
          return (await twin.side.send('CSS.collectClassNames', { styleSheetId })).classNames.sort();
        })
      );
      assert.deepEqual(o, asOurs(c));
    });

    test('setStyleTexts twice on the same rule', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { styleSheetId, range } = await ruleOf(twin, '.%');
          const first = await twin.side.send('CSS.setStyleTexts', {
            edits: [{ styleSheetId, range, text: 'color: rgb(1, 2, 3); padding: 1px;' }],
          });
          // The next edit uses the range the first one returned, as the Styles pane does.
          const next = first.styles[0]?.range;
          assert.ok(next);
          const second = await twin.side.send('CSS.setStyleTexts', {
            edits: [{ styleSheetId, range: next, text: 'color: rgb(4, 5, 6);' }],
          });
          return [style(first.styles[0]), style(second.styles[0])];
        })
      );
      assert.deepEqual(o, c);
    });

    test('setStyleTexts on the inline style', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { side } = twin;
          const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId: nodeOf(twin) });
          assert.ok(inlineStyle?.styleSheetId && inlineStyle.range);
          const { styles } = await side.send('CSS.setStyleTexts', {
            edits: [{ styleSheetId: inlineStyle.styleSheetId, range: inlineStyle.range, text: 'width: 6px;' }],
          });
          return [style(inlineStyle), style(styles[0])];
        })
      );
      assert.deepEqual(o, c);
    });

    test('setRuleSelector', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { styleSheetId, selectorRange } = await ruleOf(twin, '.% .k', true);
          assert.ok(selectorRange);
          const { selectorList } = await twin.side.send('CSS.setRuleSelector', {
            styleSheetId,
            range: selectorRange,
            selector: `.${twin.name} s.k`,
          });
          const { matchedCSSRules } = await twin.side.send('CSS.getMatchedStylesForNode', {
            nodeId: nodeOf(twin, true),
          });
          assert.ok(matchedCSSRules);
          return { selectorList: selectors(selectorList), matched: summarize(matchedCSSRules) };
        })
      );
      assert.deepEqual(o, asOurs(c));
    });

    test('addRule at the end of the sheet', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { styleSheetId } = await ruleOf(twin, '.%');
          const { text } = await twin.side.send('CSS.getStyleSheetText', { styleSheetId });
          const lines = text.split('\n');
          const end = { line: lines.length - 1, column: lines.at(-1)?.length ?? 0 };
          const { rule } = await twin.side.send('CSS.addRule', {
            styleSheetId,
            ruleText: `.${twin.name} { outline-width: 2px; }`,
            location: { startLine: end.line, startColumn: end.column, endLine: end.line, endColumn: end.column },
          });
          return {
            origin: rule.origin,
            selector: rule.selectorList.text,
            style: style(rule.style),
          };
        })
      );
      assert.deepEqual(o, asOurs(c));
    });

    test('setStyleSheetText', async () => {
      const [o, c] = await Promise.all(
        twins().map(async twin => {
          const { styleSheetId } = await ruleOf(twin, '.%');
          await twin.side.send('CSS.setStyleSheetText', {
            styleSheetId,
            text: `.${twin.name} {\n  color: rgb(7, 8, 9);\n}\n`,
          });
          const { matchedCSSRules } = await twin.side.send('CSS.getMatchedStylesForNode', {
            nodeId: nodeOf(twin),
          });
          assert.ok(matchedCSSRules);
          return {
            text: flat((await twin.side.send('CSS.getStyleSheetText', { styleSheetId })).text),
            matched: summarize(matchedCSSRules),
          };
        })
      );
      assert.deepEqual(o, asOurs(c));
    });
  });
});
