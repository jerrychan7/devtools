// CSS.forcePseudoState. Chrome and we both act on the same page, so each side forces,
// measures and un-forces in turn.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';

let env;
let t;

const STYLE = `
  #fo:hover { outline-color: rgb(1, 2, 3) }
  .f-order:hover { color: rgb(10, 0, 0) }
  .f-order.x { color: rgb(20, 0, 0) }
  .f-order:hover { background-color: rgb(0, 0, 5) }
  .f-order:focus::before { content: "F" }
  @media (min-width: 1px) { .f-media:active { color: rgb(30, 0, 0) } }
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
      '<div id="fo" class="f-order x">fo</div><div id="fm" class="f-media">fm</div>'
    );
  }, STYLE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const attr = (node, name) => {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
};

/** Forces `classes` on #id through one side, runs `measure`, then un-forces. */
async function withForced(side, id, classes, measure) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const nodeId = find(root, n => attr(n, 'id') === id).nodeId;
  await side.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
  try {
    return await measure(nodeId);
  } finally {
    await side.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  }
}

const computed = (id, pseudo) =>
  t.page.evaluate(
    (id, pseudo) => {
      const style = getComputedStyle(document.getElementById(id), pseudo);
      return {
        color: style.color,
        background: style.backgroundColor,
        outline: style.outlineColor,
        content: style.content,
      };
    },
    id,
    pseudo ?? null
  );

async function both(id, classes, measure) {
  return {
    ours: await withForced(t.ours, id, classes, nodeId => measure(t.ours, nodeId)),
    chrome: await withForced(t.chrome, id, classes, nodeId => measure(t.chrome, nodeId)),
  };
}

test(':hover applies, and later rules of equal specificity still win', async () => {
  const { ours, chrome } = await both('fo', ['hover'], () => computed('fo'));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.color, 'rgb(20, 0, 0)');
  assert.equal(ours.background, 'rgb(0, 0, 5)');
  assert.equal(ours.outline, 'rgb(1, 2, 3)');
});

test(':active inside @media', async () => {
  const { ours, chrome } = await both('fm', ['active'], () => computed('fm'));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.color, 'rgb(30, 0, 0)');
});

test('a forced :focus creates the ::before it selects', async () => {
  const { ours, chrome } = await both('fo', ['focus'], () => computed('fo', '::before'));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.content, '"F"');
});

test('the Styles pane shows the forced rules as matching', async () => {
  const summarize = r =>
    r.matchedCSSRules
      .filter(m => m.rule.origin === 'regular')
      .map(m => [m.rule.selectorList.text, m.matchingSelectors]);
  const { ours, chrome } = await both('fo', ['hover'], (side, nodeId) =>
    side.send('CSS.getMatchedStylesForNode', { nodeId }).then(summarize)
  );
  assert.deepEqual(ours, chrome);
});

test('the marker attribute is not visible to the client', async () => {
  const seen = await withForced(t.ours, 'fo', ['hover'], async nodeId => {
    const { attributes } = await t.ours.send('DOM.getAttributes', { nodeId });
    const { outerHTML } = await t.ours.send('DOM.getOuterHTML', { nodeId });
    return { attributes, outerHTML };
  });
  assert.deepEqual(seen.attributes, ['id', 'fo', 'class', 'f-order x']);
  assert.doesNotMatch(seen.outerHTML, /devtools-anywhere/);
});

test('un-forcing restores the original styles', async () => {
  const before = await computed('fo');
  await withForced(t.ours, 'fo', ['hover'], () => {});
  assert.deepEqual(await computed('fo'), before);
  const leftovers = await t.page.evaluate(() => document.querySelectorAll('[data-devtools-anywhere]').length);
  assert.equal(leftovers, 0);
});
