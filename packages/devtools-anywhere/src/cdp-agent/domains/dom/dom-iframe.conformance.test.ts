// Same-origin iframes in the DOM domain: their documents as `contentDocument`, commands on the
// nodes inside them, and their mutations, navigations and removal, against Chrome's.
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import {
  VOLATILE,
  diffSubset,
  launch,
  openPage,
  waitForBoth,
  setUpAndTearDown,
} from '../../../../test-support/conformance.ts';
import type { Env, EventName, EventParams, Side, TestPage } from '../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;
type Commands = ProtocolMapping.Commands;

for (const key of ['nodeId', 'backendNodeId', 'parentId', 'parentNodeId', 'previousNodeId', 'frameId', 'hostId'])
  VOLATILE.add(key);

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const OTHER = '/packages/devtools-anywhere/test-support/frame-other.html';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
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
  },
  () => env?.close()
);

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

type Event = { method: string; params: unknown };

/**
 * Both sides' events of the given kinds after running `expression` in the page, by kind (the
 * order of events of different kinds is not recorded on Chrome's side).
 */
async function eventsOf(expression: string, settled: (events: Event[]) => boolean, methods: EventName[]) {
  await t.chrome.clear();
  await t.ours.clear();
  await t.page.evaluate(expression);
  const collect = async (side: Side) => {
    const all: Event[] = [];
    for (const method of methods) for (const params of await side.events(method)) all.push({ method, params });
    return all;
  };
  const start = Date.now();
  for (;;) {
    const [ours, chrome] = [await collect(t.ours), await collect(t.chrome)];
    if ((settled(ours) && settled(chrome)) || Date.now() - start > 5000) return { ours, chrome };
    await new Promise(r => setTimeout(r, 20));
  }
}

/** Waits for an iframe to load after `change`. */
const load = (id: string, change: string) =>
  `new Promise(resolve => { const f = document.getElementById(${JSON.stringify(id)}); f.addEventListener('load', resolve, { once: true }); ${change}; })`;

const MUTATIONS: EventName[] = ['DOM.childNodeRemoved', 'DOM.childNodeInserted', 'DOM.attributeModified'];
const reinsertedOnce = (events: Event[]) => events.filter(e => e.method === 'DOM.childNodeInserted').length >= 1;

/**
 * Leaves out what differs by timing: Chrome sends a new iframe document as it commits, empty (so
 * in no-quirks mode) and counts its children as they are parsed (DOM.childNodeCountUpdated); ours
 * sends it complete, at its load.
 */
function withoutCounts(events: Event[]) {
  return events.map(({ method, params }) => {
    if (method !== 'DOM.childNodeInserted') return { method, params };
    const { node, ...rest } = params as EventParams<'DOM.childNodeInserted'>;
    const doc = node.contentDocument && {
      ...node.contentDocument,
      childNodeCount: undefined,
      compatibilityMode: undefined,
    };
    return { method, params: { ...rest, node: { ...node, contentDocument: doc } } };
  });
}

/** The last count Chrome reported for the document an iframe was sent again with. */
async function documentCount(side: Side, events: Event[]) {
  const inserted = events.findLast(e => e.method === 'DOM.childNodeInserted');
  const doc = (inserted?.params as EventParams<'DOM.childNodeInserted'> | undefined)?.node.contentDocument;
  assert.ok(doc);
  const updates = (await side.events('DOM.childNodeCountUpdated')).filter(u => u.nodeId === doc.nodeId);
  return updates.at(-1)?.childNodeCount ?? doc.childNodeCount;
}

describe('changes', () => {
  before(async () => {
    await both('DOM.getDocument', { depth: -1, pierce: true });
  });

  test('mutations inside an iframe document', async () => {
    const { ours, chrome } = await eventsOf(
      `(() => {
        const d = document.getElementById('sd').contentDocument;
        d.getElementById('in').setAttribute('title', 't');
        d.body.append(Object.assign(d.createElement('i'), { id: 'added' }));
        d.querySelector('b').firstChild.nodeValue = 'y';
        d.getElementById('in').remove();
      })()`,
      events => events.length >= 4,
      ['DOM.attributeModified', 'DOM.childNodeInserted', 'DOM.characterDataModified', 'DOM.childNodeRemoved']
    );
    assert.equal(chrome.length, 4);
    assert.deepEqual(diffSubset(ours, chrome), []);
  });

  test('a srcdoc iframe that loads another document is sent again', async () => {
    const { ours, chrome } = await eventsOf(load('sd', `f.srcdoc = '<p id="n2">new</p>'`), reinsertedOnce, MUTATIONS);
    assert.deepEqual(chrome.map(e => e.method).sort(), [
      'DOM.attributeModified',
      'DOM.childNodeInserted',
      'DOM.childNodeRemoved',
    ]);
    assert.deepEqual(diffSubset(withoutCounts(ours), withoutCounts(chrome)), []);
    assert.equal(await documentCount(t.ours, ours), await documentCount(t.chrome, chrome));
  });

  test('the new document of a navigated iframe can be expanded', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1, pierce: true });
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.ok(byId(ours, 'n2'));
  });

  test('a src iframe that navigates is sent again', async () => {
    const { ours, chrome } = await eventsOf(load('src', `f.src = ${JSON.stringify(OTHER)}`), reinsertedOnce, MUTATIONS);
    assert.deepEqual(diffSubset(withoutCounts(ours), withoutCounts(chrome)), []);
    assert.equal(await documentCount(t.ours, ours), await documentCount(t.chrome, chrome));
  });

  test('an iframe that reloads itself is sent again', async () => {
    const { ours, chrome } = await eventsOf(
      load('src', 'f.contentWindow.location.reload()'),
      reinsertedOnce,
      MUTATIONS
    );
    assert.deepEqual(chrome.map(e => e.method).sort(), ['DOM.childNodeInserted', 'DOM.childNodeRemoved']);
    assert.deepEqual(diffSubset(withoutCounts(ours), withoutCounts(chrome)), []);
  });

  for (const [name, init] of [
    ['without src', ''],
    ['with srcdoc', `f.srcdoc = '<i>d</i>'`],
    ['with a same-origin src', `f.src = ${JSON.stringify(CHILD)}`],
  ] as const) {
    test(`an iframe added ${name} is sent, then sent again with its document`, async () => {
      const id = `added-${name.replace(/\W/g, '')}`;
      const { ours, chrome } = await eventsOf(
        `new Promise(resolve => {
          const f = document.createElement('iframe');
          f.id = ${JSON.stringify(id)};
          ${init};
          f.addEventListener('load', resolve, { once: true });
          document.body.append(f);
        })`,
        events => events.filter(e => e.method === 'DOM.childNodeInserted').length >= 2,
        MUTATIONS
      );
      assert.deepEqual(chrome.map(e => e.method).sort(), [
        'DOM.childNodeInserted',
        'DOM.childNodeInserted',
        'DOM.childNodeRemoved',
      ]);
      assert.deepEqual(diffSubset(withoutCounts(ours), withoutCounts(chrome)), []);
      assert.equal(await documentCount(t.ours, ours), await documentCount(t.chrome, chrome));
    });
  }

  test('a moved iframe is sent again with its new document', async () => {
    const { ours, chrome } = await eventsOf(
      `document.body.prepend(document.getElementById('added-withoutsrc'))`,
      events => events.filter(e => e.method === 'DOM.childNodeInserted').length >= 2,
      MUTATIONS
    );
    assert.deepEqual(diffSubset(withoutCounts(ours), withoutCounts(chrome)), []);
  });

  test('a removed iframe takes its document with it', async () => {
    const [{ root: ours }, { root: chrome }] = await both('DOM.getDocument', { depth: -1, pierce: true });
    const { ours: a, chrome: b } = await eventsOf(
      `document.getElementById('src').remove()`,
      events => events.length >= 1,
      ['DOM.childNodeRemoved']
    );
    assert.deepEqual(diffSubset(a, b), []);
    const doc = (root: DomNode) => byId(root, 'src').contentDocument?.nodeId ?? 0;
    const [errOurs, errChrome] = await Promise.all([
      t.ours.send('DOM.describeNode', { nodeId: doc(ours) }).then(String, (e: Error) => e.message),
      t.chrome.send('DOM.describeNode', { nodeId: doc(chrome) }).then(String, (e: Error) => e.message),
    ]);
    assert.match(errOurs, /Could not find node with given id/);
    assert.match(errChrome, /Could not find node with given id/);
  });
});

describe('edits', () => {
  test('editing nodes of an iframe document changes that document', async () => {
    const snapshots: string[] = [];
    for (const side of [t.chrome, t.ours]) {
      await t.page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('#sd')?.contentDocument;
        if (doc) doc.body.innerHTML = '<p id="e">one</p><svg id="g"></svg>';
      });
      const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
      await side.send('DOM.setAttributesAsText', { nodeId: byId(root, 'g').nodeId, text: 'id="g" viewBox="0 0 1 1"' });
      await side.send('DOM.setOuterHTML', {
        nodeId: byId(root, 'e').nodeId,
        outerHTML: '<p id="e" class="x">two</p><i>3</i>',
      });
      const html = byId(root, 'sd').contentDocument?.children?.find(n => n.nodeName === 'HTML');
      assert.ok(html);
      await side.send('DOM.setOuterHTML', {
        nodeId: html.nodeId,
        outerHTML: '<html><head><title>t</title></head><body><p id="e" class="x">two</p><b>doc</b></body></html>',
      });
      snapshots.push(
        await t.page.evaluate(
          () =>
            `${document.querySelector<HTMLIFrameElement>('#sd')?.contentDocument?.documentElement.outerHTML}|${document.title}`
        )
      );
    }
    const [chrome, ours] = snapshots;
    assert.equal(ours, chrome);
    assert.match(chrome ?? '', /<b>doc<\/b>.*\|conformance fixture$/);
  });
});
