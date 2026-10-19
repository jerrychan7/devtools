import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from './harness.ts';

// Node ids differ between implementations; compare everything else.
for (const key of ['nodeId', 'backendNodeId', 'parentId', 'parentNodeId', 'previousNodeId', 'frameId', 'hostId'])
  VOLATILE.add(key);

let env;
let t;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'DOM.setChildNodes',
    'DOM.childNodeInserted',
    'DOM.childNodeRemoved',
    'DOM.attributeModified',
    'DOM.attributeRemoved',
    'DOM.characterDataModified',
    'DOM.childNodeCountUpdated',
    'DOM.shadowRootPushed',
  ]);
});
after(() => env?.close());

const both = (method, params) => Promise.all([t.ours.send(method, params), t.chrome.send(method, params)]);

/** Finds a node by attribute in a serialized tree. */
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const attr = (node, name) => {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
};

describe('DOM', () => {
  let ourRoot;
  let chromeRoot;

  test('getDocument', async () => {
    [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: -1 });
    // Puppeteer's injected script tags differ between runs only in content, not structure.
    assert.deepEqual(diffSubset(ourRoot, chromeRoot), []);
  });

  test('requestChildNodes', async () => {
    [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: 1 });
    t.chrome.clear();
    await t.ours.clear();
    const html = r => r.children.find(n => n.nodeName === 'HTML');
    await Promise.all([
      t.ours.send('DOM.requestChildNodes', { nodeId: html(ourRoot).nodeId }),
      t.chrome.send('DOM.requestChildNodes', { nodeId: html(chromeRoot).nodeId }),
    ]);
    const [[ours], [chrome]] = await waitForBoth(t, 'DOM.setChildNodes');
    assert.deepEqual(diffSubset(ours.nodes, chrome.nodes), []);
  });

  describe('mutations', () => {
    before(async () => {
      [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: -1 });
    });
    async function mutate(expression, event) {
      t.chrome.clear();
      await t.ours.clear();
      await t.page.evaluate(expression);
      const [[ours], [chrome]] = await waitForBoth(t, event);
      return { ours, chrome };
    }

    test('attribute set', async () => {
      const { ours, chrome } = await mutate(
        "document.getElementById('app').setAttribute('title', 'x')",
        'DOM.attributeModified'
      );
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
    test('attribute removed', async () => {
      const { ours, chrome } = await mutate(
        "document.getElementById('app').removeAttribute('title')",
        'DOM.attributeRemoved'
      );
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
    test('child inserted', async () => {
      const { ours, chrome } = await mutate(
        "document.querySelector('section').appendChild(Object.assign(document.createElement('i'), { id: 'added' }))",
        'DOM.childNodeInserted'
      );
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
    test('child removed', async () => {
      const { ours, chrome } = await mutate("document.getElementById('added').remove()", 'DOM.childNodeRemoved');
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
    test('text changed', async () => {
      const { ours, chrome } = await mutate(
        "document.querySelector('b').firstChild.nodeValue = 'there'",
        'DOM.characterDataModified'
      );
      assert.deepEqual(diffSubset(ours, chrome), []);
    });
  });

  describe('queries', () => {
    const sectionId = root => find(root, n => n.localName === 'section').nodeId;
    before(async () => {
      [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: -1 });
    });

    test('getOuterHTML', async () => {
      const [ours, chrome] = await Promise.all([
        t.ours.send('DOM.getOuterHTML', { nodeId: sectionId(ourRoot) }),
        t.chrome.send('DOM.getOuterHTML', { nodeId: sectionId(chromeRoot) }),
      ]);
      assert.deepEqual(ours, chrome);
    });

    test('getBoxModel', async () => {
      const [ours, chrome] = await Promise.all([
        t.ours.send('DOM.getBoxModel', { nodeId: sectionId(ourRoot) }),
        t.chrome.send('DOM.getBoxModel', { nodeId: sectionId(chromeRoot) }),
      ]);
      for (const box of ['content', 'padding', 'border', 'margin']) {
        assert.deepEqual(ours.model[box].map(Math.round), chrome.model[box].map(Math.round), box);
      }
      assert.equal(ours.model.width, chrome.model.width);
      assert.equal(ours.model.height, chrome.model.height);
    });

    test('querySelectorAll', async () => {
      const [ours, chrome] = await Promise.all([
        t.ours.send('DOM.querySelectorAll', { nodeId: ourRoot.nodeId, selector: 'p, span' }),
        t.chrome.send('DOM.querySelectorAll', { nodeId: chromeRoot.nodeId, selector: 'p, span' }),
      ]);
      assert.equal(ours.nodeIds.length, chrome.nodeIds.length);
    });

    test('resolveNode and requestNode round trip', async () => {
      const { object } = await t.ours.send('DOM.resolveNode', { nodeId: sectionId(ourRoot) });
      assert.equal(object.subtype, 'node');
      const { nodeId } = await t.ours.send('DOM.requestNode', { objectId: object.objectId });
      assert.equal(nodeId, sectionId(ourRoot));
    });

    test('performSearch', async () => {
      for (const query of ['section', 'note', 'world']) {
        const [ours, chrome] = await both('DOM.performSearch', { query });
        assert.equal(ours.resultCount, chrome.resultCount, query);
      }
    });
  });
});

describe('shadow DOM', () => {
  before(async () => {
    t.chrome.clear();
    await t.ours.clear();
    // Created after the CDP server is installed, so the probe records the closed root too.
    await t.page.evaluate(() => {
      const open = document.createElement('div');
      open.id = 'open-host';
      open.attachShadow({ mode: 'open' }).innerHTML = '<span>open</span>';
      const closed = document.createElement('div');
      closed.id = 'closed-host';
      closed.attachShadow({ mode: 'closed' }).innerHTML = '<b>closed</b>';
      document.body.append(open, closed);
    });
  });

  for (const pierce of [false, true]) {
    test(`open and closed shadow roots in getDocument (pierce: ${pierce})`, async () => {
      const [{ root: o }, { root: c }] = await both('DOM.getDocument', { depth: -1, pierce });
      for (const id of ['open-host', 'closed-host']) {
        const host = root => find(root, n => attr(n, 'id') === id);
        assert.deepEqual(diffSubset(host(o), host(c)), [], id);
      }
    });
  }

  test('mutations inside a shadow root', async () => {
    await both('DOM.getDocument', { depth: -1, pierce: true });
    t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(() => {
      document.getElementById('open-host').shadowRoot.appendChild(document.createElement('em'));
    });
    const [[ours], [chrome]] = await waitForBoth(t, 'DOM.childNodeInserted');
    assert.deepEqual(diffSubset(ours, chrome), []);
  });

  test('shadow root attached later', async () => {
    await both('DOM.getDocument', { depth: -1 });
    t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(() => {
      document.getElementById('app').attachShadow({ mode: 'open' }).innerHTML = '<i>late</i>';
    });
    const [[ours], [chrome]] = await waitForBoth(t, 'DOM.shadowRootPushed');
    assert.deepEqual(diffSubset(ours, chrome), []);
  });
});
