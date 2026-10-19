import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from './harness.ts';

for (const key of ['nodeId', 'backendNodeId', 'parentId', 'pseudoElementId', 'frameId']) VOLATILE.add(key);

let env;
let t;
let ours;
let chrome;

const STYLE = `
  .pe::before { content: "»"; color: red }
  .pe:after { content: ""; }
  li::marker { color: blue }
  .pe:hover::before { color: green }
  .late::after { content: "late" }
`;

before(async () => {
  env = await launch();
  t = await openPage(env, ['DOM.pseudoElementAdded', 'DOM.pseudoElementRemoved']);
  await t.page.evaluate(style => {
    const s = document.createElement('style');
    s.textContent = style;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p class="pe" id="pe">x</p><ul><li id="li">item</li></ul><i id="late">i</i>'
    );
  }, STYLE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
  ours = (await t.ours.send('DOM.getDocument', { depth: -1 })).root;
  chrome = (await t.chrome.send('DOM.getDocument', { depth: -1 })).root;
});
after(() => env?.close());

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of [...(node.children || []), ...(node.pseudoElements || [])]) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const attr = (node, name) => {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
};
const byId = (root, id) => find(root, n => attr(n, 'id') === id);
const summarize = matches =>
  matches.filter(m => m.rule.origin === 'regular').map(m => [m.rule.selectorList.text, m.matchingSelectors]);

describe('pseudo-elements', () => {
  test('listed on their hosts', async () => {
    for (const id of ['pe', 'li']) {
      const strip = node => ({ ...node, children: undefined });
      assert.deepEqual(diffSubset(strip(byId(ours, id)), strip(byId(chrome, id))), [], id);
    }
  });

  test('rules for pseudo-elements on the host', async () => {
    const [mo, mc] = await Promise.all([
      t.ours.send('CSS.getMatchedStylesForNode', { nodeId: byId(ours, 'pe').nodeId }),
      t.chrome.send('CSS.getMatchedStylesForNode', { nodeId: byId(chrome, 'pe').nodeId }),
    ]);
    const group = list => list.map(p => [p.pseudoType, summarize(p.matches)]).filter(([, m]) => m.length);
    assert.deepEqual(group(mo.pseudoElements), group(mc.pseudoElements));
    assert.deepEqual(summarize(mo.matchedCSSRules), summarize(mc.matchedCSSRules));
  });

  test('selecting the ::before node', async () => {
    const pick = root => byId(root, 'pe').pseudoElements.find(p => p.pseudoType === 'before').nodeId;
    const [mo, mc] = await Promise.all([
      t.ours.send('CSS.getMatchedStylesForNode', { nodeId: pick(ours) }),
      t.chrome.send('CSS.getMatchedStylesForNode', { nodeId: pick(chrome) }),
    ]);
    assert.deepEqual(summarize(mo.matchedCSSRules), summarize(mc.matchedCSSRules));
    assert.equal(mo.inherited.length, mc.inherited.length);

    const [co, cc] = await Promise.all([
      t.ours.send('CSS.getComputedStyleForNode', { nodeId: pick(ours) }),
      t.chrome.send('CSS.getComputedStyleForNode', { nodeId: pick(chrome) }),
    ]);
    const get = (list, name) => list.computedStyle.find(p => p.name === name).value;
    for (const name of ['content', 'color']) assert.equal(get(co, name), get(cc, name), name);
  });

  test('pseudo-element removed when its rule stops matching', async () => {
    t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(() => document.getElementById('pe').classList.remove('pe'));
    const [o, c] = await waitForBoth(t, 'DOM.pseudoElementRemoved', 2);
    assert.equal(o.length, c.length);
  });

  test('pseudo-element added when a rule starts matching', async () => {
    t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(() => document.getElementById('late').classList.add('late'));
    const [[o], [c]] = await waitForBoth(t, 'DOM.pseudoElementAdded');
    assert.deepEqual(diffSubset(o, c), []);
  });
});
