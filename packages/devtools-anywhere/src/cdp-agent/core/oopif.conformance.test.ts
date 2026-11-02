// Chrome's side of cross-origin iframes as child targets: the reference our agent's child targets
// are to follow (see test-support/oopif-notes.md). Of the agent's side, the parent's view of the
// iframe is checked here; its child targets' sequences are a todo until the handshake links them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CDP_BUNDLE, type Env } from '../../../test-support/conformance.ts';
import {
  chromeSequence,
  fixtureUrl,
  launchOopif,
  OopifPage,
  SCENARIOS,
  THIRD_HOST,
  type Step,
} from '../../../test-support/oopif.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

const methods = (steps: Step[]) => steps.map(s => `${s.session} ${s.method}`);
const attached = (steps: Step[]) => steps.filter(s => s.method === 'Target.attachedToTarget');

test('chrome: each cross-site iframe is a child target of the session of the frame that holds it', async () => {
  assert.ok(env);
  const { setup } = await chromeSequence(env, async () => {});
  const [child, grandchild] = attached(setup).filter(s => s.session !== 'browser');
  // The target is the frame: its targetId is the frame id the parent knew it by, and it is
  // attached before it commits, with no URL yet and paused.
  assert.deepEqual(child, {
    session: 'root',
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 's1',
      targetInfo: {
        targetId: 'id2',
        type: 'iframe',
        title: '',
        url: '',
        attached: true,
        parentId: 'page',
        canAccessOpener: false,
        parentFrameId: 'page',
      },
      waitingForDebugger: true,
    },
  });
  // The grandchild hangs off the child's session, not the root's.
  assert.equal(grandchild?.session, 's1');
  assert.deepEqual(Reflect.get(Reflect.get(Object(grandchild?.params), 'targetInfo'), 'parentFrameId'), 'id2');
  // The parent's frame is swapped out once the child target has it.
  const swap = setup.findIndex(s => s.session === 'root' && s.method === 'Page.frameDetached');
  assert.ok(swap > setup.indexOf(child));
  assert.deepEqual(setup[swap]?.params, { frameId: 'id2', reason: 'swap' });
});

test('chrome: the parent keeps the <iframe> element but not the frame', async () => {
  assert.ok(env);
  const page = await OopifPage.open(env, fixtureUrl(env, 'oopif-parent.html'));
  try {
    const child = await page.child('oopif-child');
    await page.child(THIRD_HOST);
    const root = await page.cdp.send('Page.getFrameTree', {}, page.sessionId);
    assert.equal(root.frameTree.childFrames, undefined);
    const own = await page.cdp.send('Page.getFrameTree', {}, child);
    const doc = await page.cdp.send('DOM.getDocument', {}, page.sessionId);
    const { nodeId } = await page.cdp.send(
      'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: 'iframe' },
      page.sessionId
    );
    const { node } = await page.cdp.send('DOM.describeNode', { nodeId, depth: -1 }, page.sessionId);
    assert.equal(node.frameId, own.frameTree.frame.id);
    assert.equal(node.childNodeCount, 0);
    assert.equal(node.contentDocument, undefined);
    const owner = await page.cdp.send('DOM.getFrameOwner', { frameId: own.frameTree.frame.id }, page.sessionId);
    assert.equal(owner.nodeId, nodeId);
  } finally {
    page.close();
  }
});

test('chrome: input aimed at an iframe on the parent session reaches the iframe', async () => {
  assert.ok(env);
  const page = await OopifPage.open(env, fixtureUrl(env, 'oopif-parent.html'));
  try {
    const child = await page.child('oopif-child');
    // Chrome routes input to an out-of-process iframe by the compositor's hit-test data, which
    // the iframe has only once it has been drawn: wait for frames in both before clicking.
    const drawn = {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true,
    };
    await page.cdp.send('Runtime.evaluate', drawn, child);
    await page.cdp.send('Runtime.evaluate', drawn, page.sessionId);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await page.cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: 50, y: 120, button: 'left', clickCount: 1 },
        page.sessionId
      );
    }
    const clicks = await page.cdp.send('Runtime.evaluate', { expression: 'window.clicks', returnByValue: true }, child);
    // The iframe sits at (0, 100) in the parent.
    assert.deepEqual(clicks.result.value, [
      ['mousedown', 50, 20],
      ['click', 50, 20],
    ]);
  } finally {
    page.close();
  }
});

test('chrome: a cross-site frame keeps its target across reloads and navigations to other sites', async () => {
  assert.ok(env);
  for (const act of [SCENARIOS.reload, SCENARIOS.sameOrigin, SCENARIOS.otherSite(env)]) {
    const { steps } = await chromeSequence(env, act);
    assert.ok(
      !steps.some(s => s.method === 'Target.detachedFromTarget' && Reflect.get(Object(s.params), 'sessionId') === 's1')
    );
    assert.ok(steps.some(s => s.session === 's1' && s.method === 'Page.frameNavigated'));
    assert.ok(steps.some(s => s.session === 'root' && s.method === 'Target.targetInfoChanged'));
  }
});

test('chrome: a frame that comes back to its parent site, or is removed, is detached', async () => {
  assert.ok(env);
  const back = await chromeSequence(env, SCENARIOS.parentOrigin(env));
  assert.deepEqual(methods(back.steps).slice(1, 4), [
    'root Target.detachedFromTarget',
    'root Page.frameAttached',
    'root Page.frameNavigated',
  ]);
  const removed = await chromeSequence(env, SCENARIOS.remove);
  assert.deepEqual(methods(removed.steps), [
    's1 Page.frameDetached',
    's1 Target.detachedFromTarget',
    'root Page.frameDetached',
    'root Target.detachedFromTarget',
  ]);
});

test('ours: the parent keeps the <iframe> element with a frame id but no document, as Chrome', async () => {
  assert.ok(env);
  const page = await env.browser.newPage();
  try {
    await page.goto(fixtureUrl(env, 'oopif-parent.html'));
    // Cross-origin once the child has loaded: before, it holds an about:blank of the parent's.
    await page.waitForFunction(() => {
      try {
        return document.querySelector('iframe')?.contentDocument === null;
      } catch {
        return true;
      }
    });
    await page.addScriptTag({ path: CDP_BUNDLE });
    const results = await page.evaluate(async () => {
      const session = window.DevtoolsAnywhere.createCdpSession();
      const call = (method: string, params: object = {}) =>
        session.call(method, params).catch((e: unknown) => String(e instanceof Error ? e.message : e));
      const get = (value: unknown, name: string): unknown =>
        typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
      const record = (value: unknown): Record<string, unknown> => ({ ...Object(value) });
      const unknown = await call('DOM.getFrameOwner', { frameId: 'nope' });
      await call('DOM.getDocument', { depth: -1 });
      const nodeId = Number(get(await call('DOM.querySelector', { nodeId: 1, selector: 'iframe' }), 'nodeId'));
      const described = get(await call('DOM.describeNode', { nodeId, depth: -1 }), 'node');
      const frameId = String(get(described, 'frameId'));
      return {
        node: record(described),
        frameId,
        nodeId,
        owner: record(await call('DOM.getFrameOwner', { frameId })),
        unknown,
        top: await call('DOM.getFrameOwner', { frameId: 'devtools-anywhere-frame' }),
        tree: await call('Page.getFrameTree'),
      };
    });
    // As Chrome reports it (the test above): a frame id, no children, no document.
    assert.equal(results.node['childNodeCount'], 0);
    assert.deepEqual(results.node['children'], []);
    assert.equal(results.node['contentDocument'], undefined);
    assert.ok(results.frameId.startsWith('devtools-anywhere-frame-'));
    assert.equal(results.owner['nodeId'], results.nodeId);
    assert.equal(typeof results.owner['backendNodeId'], 'number');
    // Chrome's errors (measured): an unknown frame, and one that is not an iframe of the target.
    assert.equal(results.unknown, 'Frame with the given id was not found.');
    assert.equal(results.top, 'Frame with the given id does not belong to the target.');
    assert.equal(Reflect.get(Object(Reflect.get(Object(results.tree), 'frameTree')), 'childFrames'), undefined);
  } finally {
    await page.close();
  }
});

test.todo('ours: the same sequences from our agent, once it attaches cross-origin iframes as child targets');
