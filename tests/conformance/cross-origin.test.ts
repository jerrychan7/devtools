// A style sheet from another origin: page scripts cannot read its rules, so the CSS
// domain fetches a copy (the server sends CORS headers for .css files).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

type DomNode = Protocol.DOM.Node;

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  const crossUrl = env.baseUrl.replace('localhost', '127.0.0.1') + '/tests/conformance/assets/cross.css';
  await t.page.evaluate(
    href =>
      new Promise<void>(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => resolve();
        document.head.appendChild(link);
      }),
    crossUrl
  );
  const readable = await t.page.evaluate(() => {
    try {
      return !!document.styleSheets[document.styleSheets.length - 1]?.cssRules;
    } catch {
      return false;
    }
  });
  assert.equal(readable, false, 'the sheet must not be readable from the page');
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
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
const summarize = (matches: Protocol.CSS.RuleMatch[] | undefined) => {
  assert.ok(matches);
  return matches
    .filter(m => m.rule.origin === 'regular')
    .map(m => ({
      selector: m.rule.selectorList.text,
      media: (m.rule.media || []).map(x => x.text),
      declared: m.rule.style.cssProperties.filter(p => p.text).map(p => `${p.name}: ${p.value}`),
    }));
};

async function matched(side: Side, predicate: (n: DomNode) => boolean) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const node = find(root, predicate);
  assert.ok(node);
  return side.send('CSS.getMatchedStylesForNode', { nodeId: node.nodeId });
}

for (const [name, predicate] of [
  ['#app', (n: DomNode) => (n.attributes || []).includes('app')],
  ['section', (n: DomNode) => n.localName === 'section'],
] as const) {
  test(`rules from the cross-origin sheet match ${name}`, async () => {
    const [ours, chrome] = await Promise.all([matched(t.ours, predicate), matched(t.chrome, predicate)]);
    assert.deepEqual(summarize(ours.matchedCSSRules), summarize(chrome.matchedCSSRules));
  });
}

test('the copy is read-only', async () => {
  const ours = await matched(t.ours, n => (n.attributes || []).includes('app'));
  const rule = ours.matchedCSSRules?.find(
    m => m.rule.selectorList.text === '#app' && m.rule.origin === 'regular'
  )?.rule;
  assert.ok(rule?.styleSheetId && rule.style.range);
  await assert.rejects(
    t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: rule.styleSheetId, range: rule.style.range, text: 'letter-spacing: 9px;' }],
    }),
    /another origin/
  );
});
