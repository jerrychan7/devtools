// Same-origin iframes in the DOM domain: their documents as `contentDocument`, commands on the
// nodes inside them, and their mutations, navigations and removal, against Chrome's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;
type Commands = ProtocolMapping.Commands;

for (const key of ['nodeId', 'backendNodeId', 'parentId', 'parentNodeId', 'previousNodeId', 'frameId', 'hostId'])
  VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'DOM.setChildNodes',
    'DOM.childNodeInserted',
    'DOM.childNodeRemoved',
    'DOM.attributeModified',
    'DOM.characterDataModified',
    'DOM.childNodeCountUpdated',
  ]);
  // A srcdoc iframe with fallback content and a same-origin src one, loaded.
  await t.page.evaluate(
    src =>
      Promise.all(
        [
          (f: HTMLIFrameElement) => {
            f.id = 'sd';
            f.srcdoc = '<p id="in">hi <b>x</b></p>';
            f.textContent = 'fallback';
          },
          (f: HTMLIFrameElement) => {
            f.id = 'src';
            f.src = src;
          },
        ].map(
          init =>
            new Promise(resolve => {
              const frame = document.createElement('iframe');
              init(frame);
              frame.onload = resolve;
              document.body.append(frame);
            })
        )
      ),
    CHILD
  );
  for (const side of [t.ours, t.chrome]) await side.send('DOM.enable');
});
after(() => env?.close());

const both = <M extends keyof Commands>(method: M, ...params: Commands[M]['paramsType']) =>
  Promise.all([t.ours.send(method, ...params), t.chrome.send(method, ...params)]);

function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  const next = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
  if (node.contentDocument) next.push(node.contentDocument);
  for (const child of next) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const byId = (root: DomNode, id: string) => {
  const node = find(root, n =>
    (n.attributes ?? []).some((v, i) => i % 2 === 0 && v === 'id' && n.attributes?.[i + 1] === id)
  );
  assert.ok(node, `#${id}`);
  return node;
};

describe('serialization', () => {
  test('getDocument lists iframe documents apart from the children, without theirs', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1 });
    assert.deepEqual(diffSubset(ours, chrome), []);
    const sd = byId(ours, 'sd');
    assert.equal(sd.childNodeCount, 1);
    assert.equal(sd.contentDocument?.documentURL, 'about:srcdoc');
    assert.equal(sd.contentDocument?.children, undefined);
    assert.equal(sd.contentDocument?.parentId, undefined);
    assert.ok(sd.frameId && sd.frameId !== byId(ours, 'src').frameId);
  });

  test('getDocument with pierce goes into iframes', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1, pierce: true });
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.ok(byId(ours, 'in') && byId(ours, 'child'));
    // The document element of each frame names it.
    const html = byId(ours, 'sd').contentDocument?.children?.[0];
    assert.equal(html?.frameId, byId(ours, 'sd').frameId);
  });

  test('describeNode gives the iframe document the iframe depth', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1 });
    for (const depth of [1, 2, 3])
      for (const pierce of [false, true]) {
        const [a, b] = await Promise.all([
          t.ours.send('DOM.describeNode', { nodeId: byId(ours, 'sd').nodeId, depth, pierce }),
          t.chrome.send('DOM.describeNode', { nodeId: byId(chrome, 'sd').nodeId, depth, pierce }),
        ]);
        assert.deepEqual(diffSubset(a, b), [], `depth ${depth}, pierce ${pierce}`);
      }
  });

  test('requestChildNodes of an iframe document', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1 });
    await t.chrome.clear();
    await t.ours.clear();
    for (const [side, root] of [
      [t.ours, ours],
      [t.chrome, chrome],
    ] as const) {
      const doc = byId(root, 'src').contentDocument;
      assert.ok(doc);
      await side.send('DOM.requestChildNodes', { nodeId: doc.nodeId, depth: -1 });
    }
    const [[a], [b]] = await waitForBoth(t, 'DOM.setChildNodes');
    assert.deepEqual(diffSubset(a, b), []);
  });

  test('querySelector, getOuterHTML and resolveNode in an iframe document', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1 });
    const results: unknown[][] = [];
    for (const [side, root] of [
      [t.ours, ours],
      [t.chrome, chrome],
    ] as const) {
      const doc = byId(root, 'sd').contentDocument;
      assert.ok(doc);
      // The top document's querySelector does not reach into iframes.
      const outside = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#in' });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#in' });
      const described = await side.send('DOM.describeNode', { nodeId });
      const outer = await side.send('DOM.getOuterHTML', { nodeId: doc.nodeId });
      const { object } = await side.send('DOM.resolveNode', { nodeId });
      results.push([outside, described.node, outer, { type: object.type, subtype: object.subtype }]);
    }
    const [a = [], b = []] = results;
    assert.equal(a[0] && typeof a[0] === 'object' && 'nodeId' in a[0] ? a[0].nodeId : -1, 0);
    assert.deepEqual(diffSubset(a, b), []);
  });

  test('a search result in an iframe is pushed through the iframe', async () => {
    await both('DOM.getDocument', { depth: 0 });
    await t.chrome.clear();
    await t.ours.clear();
    const [ours, chrome] = await both('DOM.performSearch', { query: '#in' });
    assert.equal(ours.resultCount, chrome.resultCount);
    await Promise.all([
      t.ours.send('DOM.getSearchResults', { searchId: ours.searchId, fromIndex: 0, toIndex: 1 }),
      t.chrome.send('DOM.getSearchResults', { searchId: chrome.searchId, fromIndex: 0, toIndex: 1 }),
    ]);
    const [a, b] = [await t.ours.events('DOM.setChildNodes'), await t.chrome.events('DOM.setChildNodes')];
    assert.deepEqual(diffSubset(a, b), []);
  });

  test('pushNodeByPathToFrontend through an iframe document', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1, pierce: true });
    const index = (root: DomNode) => {
      const body = find(root, n => n.nodeName === 'BODY');
      return body?.children?.findIndex(n => n === byId(root, 'sd')) ?? -1;
    };
    assert.equal(index(ours), index(chrome));
    const path = `1,HTML,1,BODY,${index(ours)},IFRAME,d,#document,0,HTML,1,BODY,0,P`;
    const [a, b] = await both('DOM.pushNodeByPathToFrontend', { path });
    assert.equal(a.nodeId, byId(ours, 'in').nodeId);
    assert.ok(b.nodeId);
  });
});
