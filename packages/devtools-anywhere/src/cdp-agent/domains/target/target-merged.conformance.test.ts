// A sandboxed iframe without allow-same-origin, on the page's origin, merged into the page's agent
// (core/merged-frames.ts), against Chrome, which keeps it in the page's target: no child target,
// and its execution context on the page's session. Runtime's routes are this test's own until the
// Runtime domain registers its table.
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
  ours = await oursSide(env, {
    Runtime: { routeBy: { 'Runtime.evaluate': ['contextId'] }, fanOut: ['Runtime.enable', 'Runtime.disable'] },
  });
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
