import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['CSS.styleSheetAdded']);
  // The page sets devtools-anywhere's attribute on its own elements: that must not hide them.
  await t.page.evaluate(() => {
    const div = document.createElement('div');
    div.id = 'forged';
    div.setAttribute('data-devtools-anywhere', '');
    div.style.cssText = 'position:fixed;left:0;top:0;width:50px;height:50px;z-index:2147483646';
    const style = document.createElement('style');
    style.id = 'forged-style';
    style.setAttribute('data-devtools-anywhere', '');
    style.textContent = '#forged { color: red }';
    document.head.append(style);
    document.body.append(div);
  });
});
after(() => env?.close());

const find = (node: DomNode, pred: (n: DomNode) => boolean): DomNode | null => {
  if (pred(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = find(child, pred);
    if (found) return found;
  }
  return null;
};
const attr = (n: DomNode, name: string) => {
  const a = n.attributes ?? [];
  const i = a.findIndex((v, j) => j % 2 === 0 && v === name);
  return i < 0 ? undefined : a[i + 1];
};

test('elements the page marks with the attribute stay in the DOM tree', async () => {
  for (const side of [t.ours, t.chrome]) {
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    assert.ok(find(root, n => attr(n, 'id') === 'forged'));
    assert.ok(find(root, n => attr(n, 'id') === 'forged-style'));
  }
});

test('style sheets the page marks with the attribute are still reported', async () => {
  await t.ours.send('CSS.enable');
  await t.chrome.send('CSS.enable');
  const count = async (side: TestPage['ours']) => {
    for (let i = 0; i < 100; i++) {
      const added = await side.events('CSS.styleSheetAdded');
      for (const { header } of added) {
        const { text } = await side.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
        if (text.includes('#forged')) return added.length;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    return -1;
  };
  const [ours, chrome] = [await count(t.ours), await count(t.chrome)];
  assert.ok(ours > 0);
  assert.equal(ours, chrome);
});

test('hit testing finds elements the page marks with the attribute', async () => {
  const { backendNodeId } = await t.ours.send('DOM.getNodeForLocation', { x: 10, y: 10 });
  const { node } = await t.ours.send('DOM.describeNode', { backendNodeId });
  assert.equal(attr(node, 'id'), 'forged');
  await t.page.evaluate(() => {
    window.__clicked = '';
    document.addEventListener('mousedown', e => {
      window.__clicked = e.target instanceof Element ? e.target.id : '';
    });
  });
  await t.ours.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
  await t.ours.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 });
  assert.equal(await t.page.evaluate(() => window.__clicked), 'forged');
});

test('our own overlay stays hidden', async () => {
  await t.ours.send('DOM.enable');
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
  const body = find(root, n => n.localName === 'body');
  assert.ok(body);
  await t.ours.send('Overlay.enable');
  await t.ours.send('Overlay.highlightNode', {
    highlightConfig: { contentColor: { r: 1, g: 2, b: 3 } },
    nodeId: body.nodeId,
  });
  assert.equal(await t.page.evaluate(() => document.querySelectorAll('[data-devtools-anywhere="overlay"]').length), 1);
  const { root: after } = await t.ours.send('DOM.getDocument', { depth: -1 });
  assert.equal(
    find(after, n => attr(n, 'data-devtools-anywhere') === 'overlay'),
    null
  );
  await t.ours.send('Overlay.hideHighlight');
});

declare global {
  interface Window {
    __clicked: string;
  }
}
