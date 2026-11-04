// The overlay over a sandboxed iframe merged into the page's agent (core/merged-frames.ts), against
// Chrome (test-support/merged-sides.ts): a node of the iframe highlighted on the page where Chrome
// places it, and inspect mode picking the node under the mouse in the iframe. The iframe's nodes are
// reached by objects of its execution context (Runtime.evaluate there), not through DOM.getDocument,
// whose graft of the iframe's document is the DOM domain's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

const DRAWN = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))';

/** The sandboxed frame's latest execution context id. */
async function childContext(side: MergedSide): Promise<unknown> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const frameId = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  const created = (await side.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  const id = get(created?.params['context'], 'id');
  assert.ok(id !== undefined, 'the sandboxed frame has an execution context');
  return id;
}

/** One side at a time: a page in a background tab draws no frames, which input waits for. */
async function run<T>(open: (env: Env) => Promise<MergedSide>, act: (side: MergedSide) => Promise<T>): Promise<T> {
  assert.ok(env);
  const side = await open(env);
  try {
    return await act(side);
  } finally {
    await side.close();
  }
}

const ours = oursSide;

/** The object of the iframe's #target, in its context. */
async function targetObject(side: MergedSide): Promise<string> {
  const contextId = await childContext(side);
  const reply = await side.send('Runtime.evaluate', {
    expression: "document.getElementById('target')",
    contextId,
  });
  const objectId = get(get(reply, 'result'), 'objectId');
  assert.equal(typeof objectId, 'string', String(reply));
  return String(objectId);
}

const round = (q: unknown) => (Array.isArray(q) ? q.map(n => Math.round(Number(n))) : q);

test("highlightNode draws a sandboxed iframe's node on the page where Chrome places it", async () => {
  // Chrome's box model of the node is in the page's viewport: one process, one layout.
  const expected = await run(chromeSide, async side => {
    const reply = await side.send('DOM.getBoxModel', { objectId: await targetObject(side) });
    const model = get(reply, 'model');
    return ['margin', 'border', 'padding', 'content'].map(k => round(get(model, k)));
  });
  const actual = await run(ours, async side => {
    await side.send('Overlay.enable');
    const reply = await side.send('Overlay.highlightNode', {
      objectId: await targetObject(side),
      highlightConfig: { contentColor: { r: 1, g: 2, b: 3 } },
    });
    assert.equal(typeof reply, 'object', String(reply));
    const drawn = await side.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `Array.from(document.querySelectorAll('[data-devtools-anywhere="overlay"] > div'), d => {
        const r = d.getBoundingClientRect();
        return [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom].map(Math.round);
      })`,
    });
    await side.send('Overlay.hideHighlight');
    return get(get(drawn, 'result'), 'value');
  });
  assert.deepEqual(actual, expected);
});

test("hideHighlight sent while a sandboxed iframe's node is being highlighted leaves nothing drawn", async () => {
  // Chrome applies overlay commands in order; its overlay is not in the page's DOM, so only ours
  // is looked at. The merged highlight awaits the iframe's agent, and the hide arrives meanwhile.
  const layers = await run(ours, async side => {
    await side.send('Overlay.enable');
    const objectId = await targetObject(side);
    await Promise.all([
      side.send('Overlay.highlightNode', { objectId, highlightConfig: {} }),
      side.send('Overlay.hideHighlight'),
    ]);
    const drawn = await side.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `${DRAWN}.then(() => document.querySelectorAll('[data-devtools-anywhere="overlay"]').length)`,
    });
    return get(get(drawn, 'result'), 'value');
  });
  assert.equal(layers, 0);
});

test('inspect mode picks the node clicked in a sandboxed iframe, as in Chrome', async () => {
  const pick = async (side: MergedSide) => {
    await side.send('Overlay.enable');
    const contextId = await childContext(side);
    const rect = async (expression: string, inChild: boolean) =>
      get(
        get(
          await side.send('Runtime.evaluate', {
            expression: `JSON.stringify(${expression}.getBoundingClientRect())`,
            returnByValue: true,
            ...(inChild ? { contextId } : {}),
          }),
          'result'
        ),
        'value'
      );
    const frame = JSON.parse(String(await rect("document.getElementById('child')", false)));
    const node = JSON.parse(String(await rect("document.getElementById('target')", true)));
    const x = Math.round(frame.left + node.left + 5);
    const y = Math.round(frame.top + node.top + 5);
    assert.equal(
      typeof (await side.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} })),
      'object'
    );
    for (const args of [
      { expression: DRAWN, awaitPromise: true, contextId },
      { expression: DRAWN, awaitPromise: true },
    ])
      await side.send('Runtime.evaluate', args);
    const left = { button: 'left', clickCount: 1 };
    for (const [type, extra] of [
      ['mouseMoved', {}],
      ['mousePressed', left],
      ['mouseReleased', left],
    ] as const)
      assert.equal(typeof (await side.send('Input.dispatchMouseEvent', { type, x, y, ...extra })), 'object');
    let requested;
    for (let i = 0; i < 40 && !requested; i++, await new Promise(r => setTimeout(r, 50)))
      requested = (await side.events()).find(e => e.method === 'Overlay.inspectNodeRequested');
    assert.ok(requested, 'Overlay.inspectNodeRequested');
    await side.send('Overlay.setInspectMode', { mode: 'none' });
    const described = await side.send('DOM.describeNode', { backendNodeId: requested.params['backendNodeId'] });
    const n = get(described, 'node');
    // What the page's document got of the click: nothing, as inspect mode eats it.
    const clicked = await side.send('Runtime.evaluate', {
      expression: "document.getElementById('target').dataset.clicked ?? 'no'",
      returnByValue: true,
      contextId,
    });
    return {
      localName: get(n, 'localName'),
      attributes: get(n, 'attributes'),
      clicked: get(get(clicked, 'result'), 'value'),
    };
  };
  const setUp = async (side: MergedSide) => {
    await side.send('Runtime.evaluate', {
      expression: "document.getElementById('target').onclick = e => (e.target.dataset.clicked = 'yes')",
      contextId: await childContext(side),
    });
    return pick(side);
  };
  const expected = await run(chromeSide, setUp);
  const actual = await run(ours, setUp);
  assert.deepEqual(actual, expected);
  assert.equal(expected.localName, 'p');
});
