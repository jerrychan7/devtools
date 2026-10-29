import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, EventName, Side, TestPage } from '../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;
type Commands = ProtocolMapping.Commands;

// Node ids differ between implementations; compare everything else.
for (const key of ['nodeId', 'backendNodeId', 'parentId', 'parentNodeId', 'previousNodeId', 'frameId', 'hostId'])
  VOLATILE.add(key);

let env: Env | undefined;
let t: TestPage;

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

const both = <M extends keyof Commands>(method: M, ...params: Commands[M]['paramsType']) =>
  Promise.all([t.ours.send(method, ...params), t.chrome.send(method, ...params)]);

/** Finds a node by attribute in a serialized tree. */
function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
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

describe('DOM', () => {
  let ourRoot: DomNode;
  let chromeRoot: DomNode;

  test('getDocument', async () => {
    [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: -1 });
    // Puppeteer's injected script tags differ between runs only in content, not structure.
    assert.deepEqual(diffSubset(ourRoot, chromeRoot), []);
  });

  test('requestChildNodes', async () => {
    [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: 1 });
    await t.chrome.clear();
    await t.ours.clear();
    const html = (r: DomNode) => {
      const node = r.children?.find(n => n.nodeName === 'HTML');
      assert.ok(node);
      return node;
    };
    await Promise.all([
      t.ours.send('DOM.requestChildNodes', { nodeId: html(ourRoot).nodeId }),
      t.chrome.send('DOM.requestChildNodes', { nodeId: html(chromeRoot).nodeId }),
    ]);
    const [[ours], [chrome]] = await waitForBoth(t, 'DOM.setChildNodes');
    assert.ok(ours && chrome);
    assert.deepEqual(diffSubset(ours.nodes, chrome.nodes), []);
  });

  describe('mutations', () => {
    before(async () => {
      [{ root: ourRoot }, { root: chromeRoot }] = await both('DOM.getDocument', { depth: -1 });
    });
    async function mutate<E extends EventName>(expression: string, event: E) {
      await t.chrome.clear();
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
    const sectionId = (root: DomNode) => {
      const section = find(root, n => n.localName === 'section');
      assert.ok(section);
      return section.nodeId;
    };
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
      for (const box of ['content', 'padding', 'border', 'margin'] as const) {
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
      assert.ok(object.objectId);
      const { nodeId } = await t.ours.send('DOM.requestNode', { objectId: object.objectId });
      assert.equal(nodeId, sectionId(ourRoot));
    });

    test('getNodesForSubtreeByStyle (the Layout pane)', async () => {
      const names = async (side: TestPage['ours'], root: DomNode) => {
        const { nodeIds } = await side.send('DOM.getNodesForSubtreeByStyle', {
          nodeId: root.nodeId,
          computedStyles: [
            { name: 'display', value: 'block' },
            { name: 'font-weight', value: '700' },
          ],
        });
        const described = await Promise.all(nodeIds.map(nodeId => side.send('DOM.describeNode', { nodeId })));
        return described.map(({ node }) => node.localName);
      };
      const [ours, chrome] = await Promise.all([names(t.ours, ourRoot), names(t.chrome, chromeRoot)]);
      assert.deepEqual(ours, chrome);
      assert.ok(ours.includes('b'));
    });

    test('pushNodeByPathToFrontend (selection restored after a reload)', async () => {
      /** The path DOMNode.path() builds in the frontend: index among the children and name, from the top. */
      const pathOf = (node: DomNode, predicate: (n: DomNode) => boolean): string | null => {
        for (const [i, child] of (node.children || []).entries()) {
          if (predicate(child)) return `${i},${child.nodeName}`;
          const rest = pathOf(child, predicate);
          if (rest) return `${i},${child.nodeName},${rest}`;
        }
        return null;
      };
      const isBold = (n: DomNode) => n.localName === 'b';
      const resolve = async (side: TestPage['ours'], root: DomNode) => {
        const path = pathOf(root, isBold);
        assert.ok(path);
        const { nodeId } = await side.send('DOM.pushNodeByPathToFrontend', { path });
        return { path, node: (await side.send('DOM.describeNode', { nodeId })).node.localName };
      };
      const [ours, chrome] = await Promise.all([resolve(t.ours, ourRoot), resolve(t.chrome, chromeRoot)]);
      assert.deepEqual(ours, chrome);
      assert.equal(ours.node, 'b');
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
    await t.chrome.clear();
    await t.ours.clear();
    // Created after the CDP agent is installed, so the probe records the closed root too.
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
        const host = (root: DomNode) => find(root, n => attr(n, 'id') === id);
        assert.deepEqual(diffSubset(host(o), host(c)), [], id);
      }
    });
  }

  test('mutations inside a shadow root', async () => {
    await both('DOM.getDocument', { depth: -1, pierce: true });
    await t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(() => {
      const root = document.getElementById('open-host')?.shadowRoot;
      if (!root) throw new Error('#open-host shadow root not found');
      root.appendChild(document.createElement('em'));
    });
    const [[ours], [chrome]] = await waitForBoth(t, 'DOM.childNodeInserted');
    assert.deepEqual(diffSubset(ours, chrome), []);
  });

  test('shadow root attached later', async () => {
    await both('DOM.getDocument', { depth: -1 });
    await t.chrome.clear();
    await t.ours.clear();
    await t.page.evaluate(() => {
      const app = document.getElementById('app');
      if (!app) throw new Error('#app not found');
      app.attachShadow({ mode: 'open' }).innerHTML = '<i>late</i>';
    });
    const [[ours], [chrome]] = await waitForBoth(t, 'DOM.shadowRootPushed');
    assert.deepEqual(diffSubset(ours, chrome), []);
  });
});

describe('long text and own elements', () => {
  before(async () => {
    await t.page.evaluate(() => {
      // Text up to 500 characters is sent with its element; node values are cut at 10000.
      for (const [id, length] of [
        ['text-500', 500],
        ['text-501', 501],
        ['text-10001', 10001],
      ] as const) {
        const div = document.createElement('div');
        div.id = id;
        div.textContent = 'x'.repeat(length);
        document.body.append(div);
      }
      const own = document.createElement('div');
      own.setAttribute('data-devtools-anywhere', '');
      own.id = 'own';
      document.body.append(own);
    });
  });

  test('getDocument', async () => {
    // Down to the <div>s: their text only follows when it is short enough to be inlined.
    const [{ root: o }, { root: c }] = await both('DOM.getDocument', { depth: 3 });
    const body = (root: DomNode) => find(root, n => n.localName === 'body');
    for (const id of ['text-500', 'text-501']) {
      const node = (root: DomNode) => find(root, n => attr(n, 'id') === id);
      assert.deepEqual(diffSubset(node(o), node(c)), [], id);
    }
    // The page can set devtools-anywhere's attribute itself: that does not hide an element.
    assert.ok(find(o, n => attr(n, 'id') === 'own') !== null);
    assert.equal(body(o)?.childNodeCount, body(c)?.childNodeCount);
  });

  test('long node values are cut', async () => {
    const [{ root: o }, { root: c }] = await both('DOM.getDocument', { depth: -1 });
    const text = (root: DomNode) => find(root, n => attr(n, 'id') === 'text-10001')?.children?.[0];
    assert.deepEqual(diffSubset(text(o), text(c)), []);
    assert.equal(text(o)?.nodeValue.length, 10001);
  });
});

/**
 * Two identical subtrees, #edit-ours and #edit-chrome: each side edits its own the way the
 * Elements panel does, then the two must end up with the same markup.
 */
describe('editing', () => {
  before(async () => {
    await t.page.evaluate(() => {
      for (const id of ['edit-ours', 'edit-chrome']) {
        const div = document.createElement('div');
        div.id = id;
        div.innerHTML = '<ul><li class="x" title="t">one</li><li>two</li></ul><p>text</p>';
        document.body.append(div);
      }
    });
  });

  /** Runs `edit` on each side within its own subtree, then compares the subtrees' markup. */
  async function edit<T>(run: (side: Side, scope: DomNode) => Promise<T>): Promise<[T, T]> {
    const [{ root: o }, { root: c }] = await both('DOM.getDocument', { depth: -1 });
    const scope = (root: DomNode, id: string) => {
      const node = find(root, n => attr(n, 'id') === id);
      assert.ok(node);
      return node;
    };
    const ours = await run(t.ours, scope(o, 'edit-ours'));
    const chrome = await run(t.chrome, scope(c, 'edit-chrome'));
    const [html, expected] = await t.page.evaluate(() =>
      ['edit-ours', 'edit-chrome'].map(id => document.getElementById(id)?.innerHTML)
    );
    assert.equal(html, expected);
    return [ours, chrome];
  }
  const within = (scope: DomNode, predicate: (n: DomNode) => boolean) => {
    const node = find(scope, predicate);
    assert.ok(node);
    return node;
  };
  const tag = (name: string) => (n: DomNode) => n.localName === name;

  test('setAttributesAsText replacing an attribute', async () => {
    await edit(async (side, scope) => {
      const li = within(scope, n => attr(n, 'class') === 'x');
      await side.send('DOM.setAttributesAsText', { nodeId: li.nodeId, name: 'title', text: 'data-a="1" title="u"' });
    });
  });

  test('setNodeValue', async () => {
    await edit(async (side, scope) => {
      const text = within(scope, n => n.nodeValue === 'two');
      await side.send('DOM.setNodeValue', { nodeId: text.nodeId, value: 'deux' });
    });
  });

  test('setNodeName returns a node the client knows', async () => {
    const [ours, chrome] = await edit(async (side, scope) => {
      const li = within(scope, n => attr(n, 'class') === 'x');
      const { nodeId } = await side.send('DOM.setNodeName', { nodeId: li.nodeId, name: 'dt' });
      return (await side.send('DOM.describeNode', { nodeId, depth: 1 })).node;
    });
    assert.deepEqual(diffSubset(ours, chrome), []);
  });

  test('moveTo', async () => {
    await edit(async (side, scope) => {
      const [ul, p] = [within(scope, tag('ul')), within(scope, tag('p'))];
      const first = ul.children?.[0];
      assert.ok(first);
      await side.send('DOM.moveTo', { nodeId: p.nodeId, targetNodeId: ul.nodeId, insertBeforeNodeId: first.nodeId });
    });
  });

  test('copyTo', async () => {
    await edit(async (side, scope) => {
      await side.send('DOM.copyTo', { nodeId: within(scope, tag('ul')).nodeId, targetNodeId: scope.nodeId });
    });
  });

  test('setOuterHTML', async () => {
    await edit(async (side, scope) => {
      const p = within(scope, tag('p'));
      await side.send('DOM.setOuterHTML', { nodeId: p.nodeId, outerHTML: '<p class="y">new</p>' });
    });
  });

  test('removeNode', async () => {
    await edit(async (side, scope) => {
      await side.send('DOM.removeNode', { nodeId: within(scope, tag('ul')).nodeId });
    });
  });
});
