// The DOM of a sandboxed iframe without allow-same-origin merged into the page's agent
// (core/frames/merged-frames.ts, domains/dom/merged.ts), against Chrome, which keeps such a frame in the
// page's target: its document grafted under the iframe, its nodes on the page's session.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif/oopif.ts';
import {
  chromeSide,
  get,
  type MergedSide,
  oursSide,
  type Received,
} from '../../../../test-support/oopif/merged-sides.ts';

let env: Env | undefined;
const sides: { name: string; side: MergedSide }[] = [];

before(async () => {
  env = await launchOopif();
  sides.push({ name: 'chrome', side: await chromeSide(env) }, { name: 'ours', side: await oursSide(env) });
});
after(async () => {
  for (const { side } of sides) await side.close();
  await env?.close();
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const children = (node: unknown): unknown[] => {
  const list = get(node, 'children');
  return Array.isArray(list) ? list : [];
};

/** The first node of a serialized tree (contentDocuments included) that `match` takes. */
function find(node: unknown, match: (node: unknown) => boolean): unknown {
  if (match(node)) return node;
  for (const child of [...children(node), get(node, 'contentDocument')].filter(Boolean)) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

const isIframe = (node: unknown) => get(node, 'nodeName') === 'IFRAME';

/** A tree as names, attributes and text, without ids: what both sides must agree on. */
function shape(node: unknown): unknown {
  return {
    name: get(node, 'nodeName'),
    ...(get(node, 'attributes') !== undefined && { attributes: get(node, 'attributes') }),
    ...(get(node, 'nodeType') === 3 && { text: get(node, 'nodeValue') }),
    childNodeCount: get(node, 'childNodeCount'),
    children: children(node).map(shape),
  };
}

/** Runs `fn` on each side, returning the results by side name. */
async function each<T>(fn: (side: MergedSide) => Promise<T>): Promise<{ chrome: T; ours: T }> {
  const [chrome, ours] = await Promise.all(sides.map(({ side }) => fn(side)));
  assert.ok(chrome !== undefined && ours !== undefined);
  return { chrome, ours };
}

test("getDocument with pierce grafts the sandboxed frame's whole document, as in Chrome", async () => {
  const { chrome, ours } = await each(async side => {
    const root = get(await side.send('DOM.getDocument', { depth: -1, pierce: true }), 'root');
    const iframe = find(root, isIframe);
    const doc = get(iframe, 'contentDocument');
    const html = children(doc).find(n => get(n, 'nodeName') === 'HTML');
    // Like a same-origin frame's, its document element names its frame: the iframe's.
    assert.equal(get(html, 'frameId'), get(iframe, 'frameId'));
    assert.equal(get(doc, 'parentId'), undefined);
    const body = children(html).find(n => get(n, 'nodeName') === 'BODY');
    return { url: String(get(doc, 'documentURL')).replace(/:\d+/, ''), body: shape(body) };
  });
  assert.deepEqual(ours, chrome);
});

test('getDocument without pierce: the document only, its children by requestChildNodes, as in Chrome', async () => {
  const { chrome, ours } = await each(async side => {
    const root = get(await side.send('DOM.getDocument', { depth: -1 }), 'root');
    const doc = get(find(root, isIframe), 'contentDocument');
    assert.ok(doc);
    const before = (await side.events()).length;
    await side.send('DOM.requestChildNodes', { nodeId: get(doc, 'nodeId'), depth: 2 });
    await wait(200);
    const set = (await side.events()).slice(before).filter(e => e.method === 'DOM.setChildNodes');
    return {
      doc: { childNodeCount: get(doc, 'childNodeCount'), children: get(doc, 'children') },
      setChildNodes: set.map(e => ({
        toDocument: get(e.params, 'parentId') === get(doc, 'nodeId'),
        nodes: (Array.isArray(e.params['nodes']) ? e.params['nodes'] : []).map(n => get(n, 'nodeName')),
      })),
    };
  });
  assert.deepEqual(ours, chrome);
});

test('describeNode of the iframe has its contentDocument, as in Chrome', async () => {
  const { chrome, ours } = await each(async side => {
    const root = get(await side.send('DOM.getDocument', { depth: 0 }), 'root');
    const found = await side.send('DOM.querySelector', { nodeId: get(root, 'nodeId'), selector: '#child' });
    const shallow = get(await side.send('DOM.describeNode', { nodeId: get(found, 'nodeId') }), 'node');
    const deep = get(
      await side.send('DOM.describeNode', { nodeId: get(found, 'nodeId'), depth: -1, pierce: true }),
      'node'
    );
    const html = children(get(deep, 'contentDocument')).find(n => get(n, 'nodeName') === 'HTML');
    return {
      frameId: typeof get(shallow, 'frameId'),
      shallow: {
        ...Object(get(shallow, 'contentDocument')),
        nodeId: 0,
        backendNodeId: 0,
        documentURL: '',
        baseURL: '',
      },
      deep: shape(children(html).find(n => get(n, 'nodeName') === 'BODY')),
    };
  });
  assert.deepEqual(ours, chrome);
});

test("performSearch finds the sandboxed frame's nodes, as in Chrome", async () => {
  const { chrome, ours } = await each(async side => {
    await side.send('DOM.getDocument', { depth: 0 });
    const search = await side.send('DOM.performSearch', { query: 'target' });
    const count = Number(get(search, 'resultCount'));
    const results = await side.send('DOM.getSearchResults', {
      searchId: get(search, 'searchId'),
      fromIndex: 0,
      toIndex: count,
    });
    const nodeIds = get(results, 'nodeIds');
    const names = [];
    for (const nodeId of Array.isArray(nodeIds) ? nodeIds : [])
      names.push(get(get(await side.send('DOM.describeNode', { nodeId }), 'node'), 'nodeName'));
    await side.send('DOM.discardSearchResults', { searchId: get(search, 'searchId') });
    return { count, names };
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(chrome, { count: 1, names: ['P'] });
});

test("getNodeForLocation and getBoxModel cross into the sandboxed frame's document, as in Chrome", async () => {
  const { chrome, ours } = await each(async side => {
    const root = get(await side.send('DOM.getDocument', { depth: -1, pierce: true }), 'root');
    const iframe = find(root, isIframe);
    const target = find(get(iframe, 'contentDocument'), n => get(n, 'nodeName') === 'P');
    const model = get(await side.send('DOM.getBoxModel', { nodeId: get(target, 'nodeId') }), 'model');
    const content = get(model, 'content');
    assert.ok(Array.isArray(content));
    const [x = 0, y = 0] = content.map(Number);
    const found = await side.send('DOM.getNodeForLocation', { x: x + 2, y: y + 2 });
    return {
      content: content.map(v => Math.round(Number(v))),
      found: {
        nodeId: get(found, 'nodeId') === get(target, 'nodeId'),
        frame: get(found, 'frameId') === get(iframe, 'frameId'),
      },
    };
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(chrome.found, { nodeId: true, frame: true });
});

test('moving a node out of the sandboxed frame is not supported', async () => {
  const side = sides.find(s => s.name === 'ours')?.side;
  assert.ok(side);
  const root = get(await side.send('DOM.getDocument', { depth: -1, pierce: true }), 'root');
  const target = find(get(find(root, isIframe), 'contentDocument'), n => get(n, 'nodeName') === 'P');
  const body = find(root, n => get(n, 'nodeName') === 'BODY');
  const reply = await side.send('DOM.moveTo', { nodeId: get(target, 'nodeId'), targetNodeId: get(body, 'nodeId') });
  assert.match(String(reply), /^Not supported in the page: /);
});

test('a reloaded sandboxed frame: its iframe removed and inserted with the new document, as in Chrome', async () => {
  const { chrome, ours } = await each(async side => {
    const root = get(await side.send('DOM.getDocument', { depth: -1, pierce: true }), 'root');
    const iframe = find(root, isIframe);
    const before = (await side.events()).length;
    await side.send('Runtime.evaluate', { expression: 'document.getElementById("child").src += "&r=1"' });
    let events: Received[] = [];
    for (let i = 0; i < 40 && !events.some(e => e.method === 'DOM.childNodeInserted'); i++) {
      await wait(100);
      events = (await side.events()).slice(before);
    }
    const removed = events.find(e => e.method === 'DOM.childNodeRemoved');
    const inserted = events.find(e => e.method === 'DOM.childNodeInserted');
    const node = get(inserted?.params, 'node');
    return {
      removed: get(removed?.params, 'nodeId') === get(iframe, 'nodeId'),
      sameFrame: get(node, 'frameId') === get(iframe, 'frameId'),
      url: String(get(get(node, 'contentDocument'), 'documentURL')).endsWith('&r=1'),
    };
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(chrome, { removed: true, sameFrame: true, url: true });
});
