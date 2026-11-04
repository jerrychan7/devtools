// Editing the DOM of a sandboxed iframe merged into the page's agent (domains/dom/merged.ts),
// against Chrome, which keeps such a frame in the page's target: the edits' events on the page's
// session, their node ids describable there, and DOM.undo / DOM.redo over the page's and the
// frame's edits as one history, in the order they were made.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

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

function find(node: unknown, match: (node: unknown) => boolean): unknown {
  if (match(node)) return node;
  for (const child of [...children(node), get(node, 'contentDocument')].filter(Boolean)) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

async function each<T>(fn: (side: MergedSide) => Promise<T>): Promise<{ chrome: T; ours: T }> {
  const [chrome, ours] = await Promise.all(sides.map(({ side }) => fn(side)));
  assert.ok(chrome !== undefined && ours !== undefined);
  return { chrome, ours };
}

/** The page's #parent and the frame's #target, as node ids, from a fresh pierced document. */
async function nodes(side: MergedSide) {
  const root = get(await side.send('DOM.getDocument', { depth: -1, pierce: true }), 'root');
  const iframe = find(root, n => get(n, 'nodeName') === 'IFRAME');
  const parent = find(root, n => get(n, 'nodeName') === 'P');
  const body = find(get(iframe, 'contentDocument'), n => get(n, 'nodeName') === 'BODY');
  const target = find(body, n => get(n, 'nodeName') === 'P');
  return {
    parent: Number(get(parent, 'nodeId')),
    body: Number(get(body, 'nodeId')),
    target: Number(get(target, 'nodeId')),
  };
}

const attrs = async (side: MergedSide, nodeId: number) => {
  const reply = await side.send('DOM.getAttributes', { nodeId });
  return get(reply, 'attributes') ?? reply;
};

test("editing the sandboxed frame's nodes: its events on the page's session, as in Chrome", async () => {
  const { chrome, ours } = await each(async side => {
    const { target } = await nodes(side);
    const from = (await side.events()).length;
    await side.send('DOM.setAttributeValue', { nodeId: target, name: 'data-k', value: 'v' });
    await side.send('DOM.removeAttribute', { nodeId: target, name: 'data-k' });
    await side.send('DOM.setOuterHTML', { nodeId: target, outerHTML: '<p id="target">edited</p><i>x</i>' });
    await wait(300);
    const events = (await side.events()).slice(from).filter(e => e.method.startsWith('DOM.'));
    const described = [];
    for (const e of events) {
      const id = get(e.params, 'nodeId') ?? get(get(e.params, 'node'), 'nodeId');
      const node = get(await side.send('DOM.describeNode', { nodeId: id }), 'node');
      described.push({ method: e.method, name: get(node, 'nodeName') ?? 'gone', ownNode: id === target });
    }
    // Back as it was for the next tests.
    await side.send('DOM.undo');
    return described;
  });
  assert.deepEqual(ours, chrome);
});

test("removeNode of a sandboxed frame's node: childNodeRemoved with its ids, as in Chrome", async () => {
  const { chrome, ours } = await each(async side => {
    const { body, target } = await nodes(side);
    const from = (await side.events()).length;
    await side.send('DOM.removeNode', { nodeId: target });
    await wait(300);
    const removed = (await side.events()).slice(from).filter(e => e.method === 'DOM.childNodeRemoved');
    await side.send('DOM.undo');
    return removed.map(e => ({
      parent: get(e.params, 'parentNodeId') === body,
      node: get(e.params, 'nodeId') === target,
    }));
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(chrome, [{ parent: true, node: true }]);
});

test('pushNodesByBackendIdsToFrontend into the sandboxed frame, duplicates included, as in Chrome', async () => {
  const { chrome, ours } = await each(async side => {
    const { parent, target } = await nodes(side);
    const backend = async (nodeId: number) =>
      get(get(await side.send('DOM.describeNode', { nodeId }), 'node'), 'backendNodeId');
    const [p, t] = [await backend(parent), await backend(target)];
    const pushed = get(
      await side.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [t, p, t] }),
      'nodeIds'
    );
    return Array.isArray(pushed)
      ? pushed.map(id => (id === target ? 'target' : id === parent ? 'parent' : id))
      : pushed;
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(chrome, ['target', 'parent', 'target']);
});

test('pushNodeByPathToFrontend into the sandboxed frame, as in Chrome', async () => {
  const { chrome, ours } = await each(async side => {
    const { target } = await nodes(side);
    // HTML > BODY > IFRAME (#2) > its document > HTML > BODY > P.
    const found = await side.send('DOM.pushNodeByPathToFrontend', {
      path: '1,HTML,1,BODY,1,IFRAME,d,#document,1,HTML,1,BODY,0,P',
    });
    return get(found, 'nodeId') === target;
  });
  assert.deepEqual(ours, chrome);
});

test('DOM.disable then DOM.enable: the sandboxed frame still reports its edits, as in Chrome', async () => {
  const { chrome, ours } = await each(async side => {
    await side.send('DOM.disable');
    await side.send('DOM.enable');
    const { target } = await nodes(side);
    const from = (await side.events()).length;
    await side.send('DOM.setAttributeValue', { nodeId: target, name: 'data-e', value: '1' });
    await wait(300);
    const events = (await side.events()).slice(from).filter(e => e.method === 'DOM.attributeModified');
    await side.send('DOM.removeAttribute', { nodeId: target, name: 'data-e' });
    return events.map(e => get(e.params, 'nodeId') === target);
  });
  assert.deepEqual(ours, chrome);
  assert.deepEqual(chrome, [true]);
});

test("DOM.undo / DOM.redo: the page's and the frame's edits as one history, as in Chrome", async () => {
  const { chrome, ours } = await each(async side => {
    // A fresh history.
    await side.send('DOM.disable');
    await side.send('DOM.enable');
    const { parent, target } = await nodes(side);
    const state = async () => ({ parent: await attrs(side, parent), target: await attrs(side, target) });
    const states = [];
    await side.send('DOM.setAttributeValue', { nodeId: parent, name: 'data-a', value: '1' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.setAttributeValue', { nodeId: target, name: 'data-b', value: '2' });
    await side.send('DOM.markUndoableState');
    await side.send('DOM.setAttributeValue', { nodeId: parent, name: 'data-c', value: '3' });
    await side.send('DOM.setAttributeValue', { nodeId: target, name: 'data-d', value: '4' });
    await side.send('DOM.markUndoableState');
    states.push(await state());
    for (const step of ['DOM.undo', 'DOM.undo', 'DOM.undo', 'DOM.redo', 'DOM.redo', 'DOM.redo']) {
      await side.send(step);
      states.push(await state());
    }
    // Back as it was for the next tests.
    for (const name of ['data-a', 'data-c']) await side.send('DOM.removeAttribute', { nodeId: parent, name });
    for (const name of ['data-b', 'data-d']) await side.send('DOM.removeAttribute', { nodeId: target, name });
    return states;
  });
  assert.deepEqual(ours, chrome);
});
