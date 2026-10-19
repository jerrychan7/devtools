// A style sheet from another origin: page scripts cannot read its rules, so the CSS
// domain fetches a copy (the server sends CORS headers for .css files).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';

let env;
let t;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  const crossUrl = env.baseUrl.replace('localhost', '127.0.0.1') + '/tests/conformance/assets/cross.css';
  await t.page.evaluate(
    href =>
      new Promise(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = resolve;
        document.head.appendChild(link);
      }),
    crossUrl
  );
  const readable = await t.page.evaluate(() => {
    try {
      return !!document.styleSheets[document.styleSheets.length - 1].cssRules;
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

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const summarize = matches =>
  matches
    .filter(m => m.rule.origin === 'regular')
    .map(m => ({
      selector: m.rule.selectorList.text,
      media: (m.rule.media || []).map(x => x.text),
      declared: m.rule.style.cssProperties.filter(p => p.text).map(p => `${p.name}: ${p.value}`),
    }));

async function matched(side, predicate) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  return side.send('CSS.getMatchedStylesForNode', { nodeId: find(root, predicate).nodeId });
}

for (const [name, predicate] of [
  ['#app', n => (n.attributes || []).includes('app')],
  ['section', n => n.localName === 'section'],
]) {
  test(`rules from the cross-origin sheet match ${name}`, async () => {
    const [ours, chrome] = await Promise.all([matched(t.ours, predicate), matched(t.chrome, predicate)]);
    assert.deepEqual(summarize(ours.matchedCSSRules), summarize(chrome.matchedCSSRules));
  });
}

test('the copy is read-only', async () => {
  const ours = await matched(t.ours, n => (n.attributes || []).includes('app'));
  const rule = ours.matchedCSSRules.find(m => m.rule.selectorList.text === '#app' && m.rule.origin === 'regular').rule;
  await assert.rejects(
    t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: rule.styleSheetId, range: rule.style.range, text: 'letter-spacing: 9px;' }],
    }),
    /another origin/
  );
});
