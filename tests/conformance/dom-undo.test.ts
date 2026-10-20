// DOM.undo / DOM.redo / DOM.markUndoableState. Both sides edit the same page, so each scenario
// runs on Chrome and then on ours, from the same markup, and the snapshots are compared.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

const MARKUP =
  '<div id="a" class="x" title="t"><span id="s">one</span><b id="b">two</b></div><p id="p">text</p><section id="dst"></section>';

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'DOM.childNodeRemoved',
    'DOM.childNodeInserted',
    'DOM.attributeModified',
    'DOM.attributeRemoved',
    'DOM.characterDataModified',
  ]);
  for (const side of [t.ours, t.chrome]) await side.send('DOM.enable');
});
after(() => env?.close());

type Scenario = (side: Side, id: (selector: string) => Promise<number>, snap: () => Promise<void>) => Promise<void>;

/** Runs `scenario` on each side from fresh markup; returns the snapshots each took. */
async function both(scenario: Scenario): Promise<{ ours: string[]; chrome: string[] }> {
  const result: { ours: string[]; chrome: string[] } = { ours: [], chrome: [] };
  for (const key of ['chrome', 'ours'] as const) {
    const side = t[key];
    // A fresh history.
    await side.send('DOM.disable');
    await side.send('DOM.enable');
    await t.page.evaluate(html => {
      const root = document.getElementById('undo-root') ?? document.body.appendChild(document.createElement('main'));
      root.id = 'undo-root';
      root.innerHTML = html;
    }, MARKUP);
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    const id = async (selector: string) =>
      (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
    const snaps = result[key];
    const snap = async () => {
      snaps.push(await t.page.evaluate(() => document.getElementById('undo-root')?.innerHTML ?? ''));
    };
    await scenario(side, id, snap);
  }
  return result;
}

test('undo and redo attribute edits step by step', async () => {
  const { ours, chrome } = await both(async (side, id, snap) => {
    const a = await id('#a');
    await side.send('DOM.setAttributeValue', { nodeId: a, name: 'title', value: 'changed' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.setAttributesAsText', { nodeId: a, name: 'class', text: 'data-k="v" class="y"' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.removeAttribute', { nodeId: a, name: 'title' });
    await side.send('DOM.markUndoableState');
    await snap();
    for (let i = 0; i < 3; i++) {
      await side.send('DOM.undo');
      await snap();
    }
    // Nothing more to undo.
    await side.send('DOM.undo');
    await snap();
    for (let i = 0; i < 4; i++) {
      await side.send('DOM.redo');
      await snap();
    }
  });
  assert.deepEqual(ours, chrome);
});

test('undo restores removed, moved, copied and renamed nodes', async () => {
  const { ours, chrome } = await both(async (side, id, snap) => {
    await side.send('DOM.removeNode', { nodeId: await id('#s') });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.moveTo', { nodeId: await id('#p'), targetNodeId: await id('#dst') });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.copyTo', { nodeId: await id('#b'), targetNodeId: await id('#dst') });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.setNodeName', { nodeId: await id('#a'), name: 'article' });
    await side.send('DOM.markUndoableState');
    await snap();
    for (let i = 0; i < 4; i++) {
      await side.send('DOM.undo');
      await snap();
    }
    for (let i = 0; i < 4; i++) {
      await side.send('DOM.redo');
      await snap();
    }
  });
  assert.deepEqual(ours, chrome);
});

test('undo setOuterHTML and setNodeValue', async () => {
  const { ours, chrome } = await both(async (side, id, snap) => {
    const p = await id('#p');
    const { node } = await side.send('DOM.describeNode', { nodeId: p, depth: 1 });
    const text = node.children?.[0];
    assert.ok(text);
    await side.send('DOM.requestChildNodes', { nodeId: p });
    const pushed = await side.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [text.backendNodeId] });
    await side.send('DOM.setNodeValue', { nodeId: pushed.nodeIds[0] ?? 0, value: 'new text' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.setOuterHTML', { nodeId: await id('#b'), outerHTML: '<i id="i1">x</i><u>y</u>' });
    await side.send('DOM.markUndoableState');
    await snap();
    for (let i = 0; i < 2; i++) {
      await side.send('DOM.undo');
      await snap();
    }
    for (let i = 0; i < 2; i++) {
      await side.send('DOM.redo');
      await snap();
    }
  });
  assert.deepEqual(ours, chrome);
});

test('edits without a mark form one step; a new edit drops the redo', async () => {
  const { ours, chrome } = await both(async (side, id, snap) => {
    const a = await id('#a');
    await side.send('DOM.setAttributeValue', { nodeId: a, name: 'title', value: '1' });
    await side.send('DOM.setAttributeValue', { nodeId: a, name: 'title', value: '2' });
    await side.send('DOM.removeNode', { nodeId: await id('#b') });
    await side.send('DOM.undo');
    await snap();
    await side.send('DOM.redo');
    await snap();
    await side.send('DOM.markUndoableState');
    await side.send('DOM.setAttributeValue', { nodeId: a, name: 'title', value: '3' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.undo');
    await snap();
    await side.send('DOM.setAttributeValue', { nodeId: a, name: 'lang', value: 'en' });
    await side.send('DOM.redo');
    await snap();
    await side.send('DOM.undo');
    await snap();
  });
  assert.deepEqual(ours, chrome);
});

test('undo is reported as DOM mutations', async () => {
  const side = t.ours;
  await t.page.evaluate(html => {
    const root = document.getElementById('undo-root');
    if (root) root.innerHTML = html;
  }, MARKUP);
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#s' });
  await side.send('DOM.removeNode', { nodeId });
  await side.send('DOM.markUndoableState');
  await side.clear();
  await side.send('DOM.undo');
  await t.page.evaluate(() => new Promise(r => setTimeout(r, 0)));
  const inserted = await side.events('DOM.childNodeInserted');
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0]?.node.attributes, ['id', 's']);
});

test('DOM.undo and DOM.redo take back CSS edits too', async () => {
  const cssStates: { ours: string[]; chrome: string[] } = { ours: [], chrome: [] };
  const { ours, chrome } = await both(async (side, id, snap) => {
    await side.send('CSS.enable');
    await t.page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '#a { color: rgb(1, 1, 1); }';
      document.getElementById('undo-root')?.append(style);
    });
    const a = await id('#a');
    const cssSnap = async () => {
      await snap();
      const state = await t.page.evaluate(() => {
        const el = document.getElementById('a');
        const sheet = document.querySelector<HTMLStyleElement>('#undo-root style')?.sheet;
        return JSON.stringify({
          color: el && getComputedStyle(el).color,
          style: el?.getAttribute('style'),
          rules: sheet ? Array.from(sheet.cssRules, r => r.cssText) : null,
        });
      });
      cssStates[side === t.ours ? 'ours' : 'chrome'].push(state);
    };
    const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: a });
    const rule = (m.matchedCSSRules ?? []).find(r => r.rule.selectorList.text === '#a')?.rule;
    assert.ok(rule?.styleSheetId && rule.style.range && m.inlineStyle?.styleSheetId);
    const sheetId = rule.styleSheetId;
    await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: sheetId, range: rule.style.range, text: 'color: rgb(2, 2, 2);' }],
    });
    await side.send('DOM.markUndoableState');
    const selectorRange = rule.selectorList.selectors[0]?.range;
    assert.ok(selectorRange);
    await side.send('CSS.setRuleSelector', { styleSheetId: sheetId, range: selectorRange, selector: '#a, #p' });
    await side.send('DOM.markUndoableState');
    await side.send('CSS.addRule', {
      styleSheetId: sheetId,
      ruleText: '#a { padding: 1px; }',
      location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    });
    await side.send('DOM.markUndoableState');
    await side.send('CSS.setStyleTexts', {
      edits: [
        {
          styleSheetId: m.inlineStyle.styleSheetId,
          range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
          text: 'margin: 1px;',
        },
      ],
    });
    await side.send('DOM.markUndoableState');
    await cssSnap();
    for (let i = 0; i < 4; i++) {
      await side.send('DOM.undo');
      await cssSnap();
    }
    for (let i = 0; i < 4; i++) {
      await side.send('DOM.redo');
      await cssSnap();
    }
    await side.send('CSS.disable');
  });
  assert.deepEqual(cssStates.ours, cssStates.chrome);
  assert.deepEqual(ours, chrome);
});

type DomNode = { nodeId: number; nodeName: string; nodeValue: string; attributes?: string[]; children?: DomNode[] };

/** A name for a node that is the same on both sides. */
const labelOf = (n: DomNode) => {
  const attrs = n.attributes ?? [];
  const id = attrs[attrs.indexOf('id') + 1];
  return attrs.includes('id') && id ? `${n.nodeName}#${id}` : n.nodeValue ? `${n.nodeName}:${n.nodeValue}` : n.nodeName;
};

/** The DOM mutation events of one side, in order per kind, with node ids as labels. */
async function mutations(side: Side, labels: Map<number, string>) {
  await new Promise(r => setTimeout(r, 100));
  const name = (id: number | undefined) => (id ? (labels.get(id) ?? `?${id}`) : null);
  const learn = (n: DomNode) => {
    labels.set(n.nodeId, labelOf(n));
    n.children?.forEach(learn);
  };
  const inserted = (await side.events('DOM.childNodeInserted')).map(e => {
    learn(e.node as DomNode);
    return [name(e.parentNodeId), name(e.previousNodeId), labelOf(e.node as DomNode)];
  });
  const removed = (await side.events('DOM.childNodeRemoved')).map(e => [name(e.parentNodeId), name(e.nodeId)]);
  const modified = (await side.events('DOM.attributeModified')).map(e => [name(e.nodeId), e.name, e.value]);
  const attrRemoved = (await side.events('DOM.attributeRemoved')).map(e => [name(e.nodeId), e.name]);
  const data = (await side.events('DOM.characterDataModified')).map(e => [name(e.nodeId), e.characterData]);
  await side.clear();
  return { inserted, removed, modified, attrRemoved, data };
}

for (const [selector, markup] of [
  ['#a', '<div id="a" class="z" title="t"><span id="s">one</span><i>new</i></div>'],
  ['#b', '<section><b id="b">two</b></section>'],
  ['#b', '<i id="i1">x</i><u>y</u>'],
  ['#p', '<p id="p">other</p>'],
  ['#a', '<div id="a"><b id="b">two</b><span id="s">one</span></div>'],
] as const) {
  test(`setOuterHTML patches like Chrome, and undo and redo too: ${markup}`, async () => {
    const result: Record<string, unknown[]> = { ours: [], chrome: [] };
    for (const key of ['chrome', 'ours'] as const) {
      const side = t[key];
      await side.send('DOM.disable');
      await side.send('DOM.enable');
      await t.page.evaluate(html => {
        const root = document.getElementById('undo-root') ?? document.body.appendChild(document.createElement('main'));
        root.id = 'undo-root';
        root.innerHTML = html;
      }, MARKUP);
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const labels = new Map<number, string>();
      const learn = (n: DomNode) => {
        labels.set(n.nodeId, labelOf(n));
        n.children?.forEach(learn);
      };
      learn(root as DomNode);
      await side.clear();
      const out = result[key] ?? [];
      const snap = async () => out.push(await t.page.evaluate(() => document.getElementById('undo-root')?.innerHTML));
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await side.send('DOM.setOuterHTML', { nodeId, outerHTML: markup });
      await side.send('DOM.markUndoableState');
      await snap();
      out.push(await mutations(side, labels));
      await side.send('DOM.undo');
      await snap();
      out.push(await mutations(side, labels));
      await side.send('DOM.redo');
      await snap();
      out.push(await mutations(side, labels));
    }
    assert.deepEqual(result['ours'], result['chrome']);
  });
}

test('setOuterHTML on the document element patches the document like Chrome', async () => {
  const result: Record<string, unknown[]> = { ours: [], chrome: [] };
  for (const key of ['chrome', 'ours'] as const) {
    const side = t[key];
    await side.send('DOM.disable');
    await side.send('DOM.enable');
    await t.page.evaluate(html => {
      const root = document.getElementById('undo-root') ?? document.body.appendChild(document.createElement('main'));
      root.id = 'undo-root';
      root.innerHTML = html;
    }, MARKUP);
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    const labels = new Map<number, string>();
    const learn = (n: DomNode) => {
      labels.set(n.nodeId, labelOf(n));
      n.children?.forEach(learn);
    };
    learn(root as DomNode);
    await side.clear();
    const out = result[key] ?? [];
    const html = () => t.page.evaluate(() => document.documentElement.outerHTML);
    const markup = (await html())
      .replace('<html', '<html data-patched="1"')
      .replace('<p id="p">text</p>', '<p id="p">changed</p><hr>');
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'html' });
    await side.send('DOM.setOuterHTML', { nodeId, outerHTML: markup });
    await side.send('DOM.markUndoableState');
    out.push(await html(), await mutations(side, labels));
    await side.send('DOM.undo');
    out.push(await html(), await mutations(side, labels));
    await side.send('DOM.redo');
    out.push(await html(), await mutations(side, labels));
    await side.send('DOM.undo');
    await mutations(side, labels);
  }
  assert.deepEqual(result['ours'], result['chrome']);
});

test('DOM.getDocument discards the undo history like Chrome', async () => {
  const { ours, chrome } = await both(async (side, id, snap) => {
    await side.send('DOM.setAttributeValue', { nodeId: await id('#a'), name: 'title', value: 'changed' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.getDocument', { depth: -1 });
    await side.send('DOM.undo');
    await snap();
  });
  assert.deepEqual(ours, chrome);
});
