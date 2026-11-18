import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { CDPSession } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';
import { openAxPage, setBody } from '../../../../test-support/accessibility.ts';

let env: Env | undefined;
let t: TestPage;
/** A Chrome session of its own, whose nodesUpdated events are kept in `chromeEvents`. */
let chrome: CDPSession;
const chromeEvents: Protocol.Accessibility.NodesUpdatedEvent[] = [];

const FIXTURE = `<div id=a><button id=b>Go</button><p id=c>text</p><span id=d>dd</span></div><p><span id=e>ee</span></p>`;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openAxPage(env);
    // openAxPage's session does not keep its events.
    await t.page.evaluate(() => {
      window.__ours = [];
      window.__session.onMessage(m => {
        const msg: { method?: string; params: unknown } = JSON.parse(m);
        if (msg.method) window.__ours.push({ method: msg.method, params: msg.params });
      });
    });
    chrome = await t.page.createCDPSession();
    chrome.on('Accessibility.nodesUpdated', e => chromeEvents.push(e));
    await chrome.send('DOM.getDocument', { depth: -1 });
  },
  () => env?.close()
);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The backend node id of `#id` on our side and on Chrome's (the same page, the same ids). */
async function backendIds(id: string): Promise<{ ours: number; chrome: number }> {
  const ours = async () => {
    const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await t.ours.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `#${id}`,
    });
    return (await t.ours.send('DOM.describeNode', { nodeId })).node.backendNodeId;
  };
  const theirs = async () => {
    const { root } = await chrome.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await chrome.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `#${id}`,
    });
    return (await chrome.send('DOM.describeNode', { nodeId })).node.backendNodeId;
  };
  return { ours: await ours(), chrome: await theirs() };
}

/**
 * Both sides give the client `#b` and its ancestors, and `#a`'s children: the nodes nodesUpdated
 * then reports (the Accessibility pane's commands).
 */
async function giveNodes() {
  const b = await backendIds('b');
  await t.ours.send('Accessibility.getAXNodeAndAncestors', {
    backendNodeId: b.ours,
  });
  await chrome.send('Accessibility.getAXNodeAndAncestors', {
    backendNodeId: b.chrome,
  });
  const a = await backendIds('a');
  await t.ours.send('Accessibility.getChildAXNodes', { id: String(a.ours) });
  const ax = await chrome.send('Accessibility.getPartialAXTree', {
    backendNodeId: a.chrome,
    fetchRelatives: false,
  });
  await chrome.send('Accessibility.getChildAXNodes', {
    id: ax.nodes[0]?.nodeId ?? '',
  });
}

async function fresh() {
  await setBody(t, FIXTURE);
  await Promise.all([t.ours.send('Accessibility.enable'), chrome.send('Accessibility.enable')]);
  await giveNodes();
  await sleep(200);
  await clear();
}

async function clear() {
  chromeEvents.length = 0;
  await t.ours.clear();
}

/** Runs `change` in the page and gives the nodes each side reported, as `role:name`, after a while. */
async function after(change: string): Promise<{ ours: string[][]; chrome: string[][] }> {
  await clear();
  await t.page.evaluate(change);
  await sleep(400);
  const label = (e: Protocol.Accessibility.NodesUpdatedEvent) =>
    e.nodes.map(n => `${String(n.role?.value)}:${String(n.name?.value ?? '')}`);
  const ours = (await t.ours.events('Accessibility.nodesUpdated')).map(label);
  return { ours, chrome: chromeEvents.map(label) };
}

/** Our nodes are among Chrome's, which may add a parent whose AXNode did not change. */
function assertAmong(ours: string[][], chrome: string[][], expected: string) {
  assert.ok(ours.flat().includes(expected), `ours: ${JSON.stringify(ours)}`);
  assert.ok(chrome.flat().includes(expected), `chrome: ${JSON.stringify(chrome)}`);
  for (const node of ours.flat()) assert.ok(chrome.flat().includes(node), `${node} not in ${JSON.stringify(chrome)}`);
}

describe('Accessibility.nodesUpdated', () => {
  test('a node given to the client is sent when its name changes', async () => {
    await fresh();
    const { ours, chrome } = await after(`document.getElementById('b').setAttribute('aria-label', 'X')`);
    assert.deepEqual(ours, [['button:X']]);
    assertAmong(ours, chrome, 'button:X');
  });

  test("a parent is sent when its children change, with the new child's id", async () => {
    await fresh();
    const { ours, chrome } = await after(
      `document.getElementById('a').append(Object.assign(document.createElement('h2'), { textContent: 'H' }))`
    );
    assertAmong(ours, chrome, 'generic:');
    const [event] = await t.ours.events('Accessibility.nodesUpdated');
    assert.equal(event?.nodes[0]?.childIds?.length, 4);
  });

  test('a role change is sent', async () => {
    await fresh();
    const { ours, chrome } = await after(
      `const a = document.getElementById('a'); a.setAttribute('aria-label', 'Z'); a.setAttribute('role', 'region')`
    );
    assertAmong(ours, chrome, 'region:Z');
  });

  test('a class that hides a node is seen: its parent is sent, not the node', async () => {
    await fresh();
    const { ours, chrome } = await after(
      `document.head.insertAdjacentHTML('beforeend', '<style>.h{display:none}</style>');
       document.getElementById('b').className = 'h'`
    );
    assertAmong(ours, chrome, 'generic:');
    assert.ok(!ours.flat().some(n => n.startsWith('button')));
    assert.ok(!chrome.flat().some(n => n.startsWith('button')));
  });

  test('the changes of one task come in one event', async () => {
    await fresh();
    const { ours } = await after(`const b = document.getElementById('b');
      b.setAttribute('aria-label', 'L1'); b.setAttribute('aria-label', 'L2')`);
    assert.deepEqual(ours, [['button:L2']]);
  });

  test('a child given by getChildAXNodes is sent', async () => {
    await fresh();
    const { ours, chrome } = await after(`const d = document.getElementById('d');
      d.setAttribute('role', 'note'); d.setAttribute('aria-label', 'Y')`);
    assertAmong(ours, chrome, 'note:Y');
  });

  test('a node not given to the client is not sent', async () => {
    await fresh();
    const { ours, chrome } = await after(`const e = document.getElementById('e');
      e.setAttribute('role', 'note'); e.setAttribute('aria-label', 'Y')`);
    assert.deepEqual(ours, []);
    assert.deepEqual(chrome, []);
  });

  test('getFullAXTree gives no node that is sent', async () => {
    await setBody(t, FIXTURE);
    await Promise.all([t.ours.send('Accessibility.disable'), chrome.send('Accessibility.disable')]);
    await Promise.all([t.ours.send('Accessibility.enable'), chrome.send('Accessibility.enable')]);
    await Promise.all([t.ours.send('Accessibility.getFullAXTree'), chrome.send('Accessibility.getFullAXTree')]);
    const { ours, chrome: theirs } = await after(`document.getElementById('b').setAttribute('aria-label', 'F')`);
    assert.deepEqual(ours, []);
    assert.deepEqual(theirs, []);
  });

  test('nothing is sent after disable, nor for the nodes given before it once enabled again', async () => {
    await fresh();
    await Promise.all([t.ours.send('Accessibility.disable'), chrome.send('Accessibility.disable')]);
    let r = await after(`document.getElementById('b').setAttribute('aria-label', 'D')`);
    assert.deepEqual(r, { ours: [], chrome: [] });
    await Promise.all([t.ours.send('Accessibility.enable'), chrome.send('Accessibility.enable')]);
    r = await after(`document.getElementById('b').setAttribute('aria-label', 'E')`);
    assert.deepEqual(r, { ours: [], chrome: [] });
  });

  test('a command right after a change gives the new tree', async () => {
    await fresh();
    const b = await backendIds('b');
    const name = async () => {
      const { nodes } = await t.ours.send('Accessibility.getPartialAXTree', {
        backendNodeId: b.ours,
        fetchRelatives: false,
      });
      return nodes[0]?.name?.value;
    };
    for (const label of ['N1', 'N2']) {
      await t.page.evaluate(l => document.getElementById('b')?.setAttribute('aria-label', l), label);
      assert.equal(await name(), label);
    }
    // A style change the observer does not see (the CSSOM) still shows in the next command.
    await t.page.evaluate(() => document.head.appendChild(document.createElement('style')));
    await sleep(100);
    await t.page.evaluate(() => [...document.styleSheets].at(-1)?.insertRule('#b { display: none }'));
    const { nodes } = await t.ours.send('Accessibility.getPartialAXTree', {
      backendNodeId: b.ours,
      fetchRelatives: false,
    });
    assert.equal(nodes[0]?.ignored, true);
  });
});
