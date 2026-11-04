// A sandboxed iframe without allow-same-origin, on the page's origin, merged into the page's agent
// (core/merged-frames.ts), against Chrome, which keeps it in the page's target: no child target,
// and its execution context on the page's session.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

let env: Env | undefined;
let ours: MergedSide | undefined;
let chrome: MergedSide | undefined;

before(async () => {
  env = await launchOopif();
  chrome = await chromeSide(env);
  ours = await oursSide(env);
});
after(async () => {
  await ours?.close();
  await chrome?.close();
  await env?.close();
});

/** The sandboxed frame's id, from the page's frame tree. */
async function sandboxedFrameId(side: MergedSide): Promise<string> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const id = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  assert.equal(typeof id, 'string');
  return String(id);
}

test('no child target for the sandboxed iframe, as in Chrome', async () => {
  for (const side of [chrome, ours]) {
    assert.ok(side);
    const attached = (await side.events()).filter(e => e.method === 'Target.attachedToTarget');
    assert.deepEqual(attached, []);
  }
});

test("Runtime.evaluate in the sandboxed frame's context goes there and back, as in Chrome", async () => {
  const results = [];
  for (const side of [chrome, ours]) {
    assert.ok(side);
    const frameId = await sandboxedFrameId(side);
    // The latest: the iframe's initial about:blank had one before.
    const created = (await side.events()).findLast(
      e =>
        e.method === 'Runtime.executionContextCreated' &&
        get(get(e.params['context'], 'auxData'), 'frameId') === frameId
    );
    const context = created?.params['context'];
    assert.ok(context, 'the sandboxed frame has an execution context');
    // Its origin, which Chrome reports as the precursor's (the page's), is Runtime's to align.
    const reply = await side.send('Runtime.evaluate', {
      expression: 'self.origin + " " + document.title',
      contextId: get(context, 'id'),
      returnByValue: true,
    });
    results.push(get(reply, 'result'));
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0], { type: 'string', value: 'null sandboxed child' });
});

test('Target.getTargets lists no target for the sandboxed iframe, as in Chrome', async () => {
  for (const side of [chrome, ours]) {
    assert.ok(side);
    const infos = get(await side.send('Target.getTargets'), 'targetInfos');
    assert.ok(Array.isArray(infos));
    // Chrome's lists the browser's other pages and UI too: no iframe target is all compared.
    assert.deepEqual(
      infos.filter(info => get(info, 'type') === 'iframe'),
      []
    );
    assert.ok(infos.some(info => get(info, 'type') === 'page'));
  }
});

test('Target.getTargetInfo: the page, none for the sandboxed frame, as in Chrome', async () => {
  const results = [];
  for (const side of [chrome, ours]) {
    assert.ok(side);
    const own = get(await side.send('Target.getTargetInfo'), 'targetInfo');
    const frame = await side.send('Target.getTargetInfo', { targetId: await sandboxedFrameId(side) });
    results.push({ type: get(own, 'type'), parentId: get(own, 'parentId'), frame });
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0], { type: 'page', parentId: undefined, frame: 'No target with given id found' });
});

test("the sandboxed frame's own agent tells the page's target as its own", async () => {
  assert.ok(ours);
  const pageId = get(get(await ours.send('Target.getTargetInfo'), 'targetInfo'), 'targetId');
  const frameId = await sandboxedFrameId(ours);
  const created = (await ours.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  // Asked in the frame, of a session of its agent's own.
  const reply = await ours.send('Runtime.evaluate', {
    contextId: get(created?.params['context'], 'id'),
    expression: `new Promise(resolve => {
      const session = DevtoolsAnywhere.createCdpSession();
      session.onMessage(m => resolve(JSON.parse(m).result.targetInfo));
      void session.dispatch(JSON.stringify({ id: 1, method: 'Target.getTargetInfo' }));
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  const info = get(get(reply, 'result'), 'value');
  assert.deepEqual(
    { targetId: get(info, 'targetId'), parentId: get(info, 'parentId'), parentFrameId: get(info, 'parentFrameId') },
    { targetId: pageId, parentId: undefined, parentFrameId: undefined }
  );
});
