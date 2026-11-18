// A sandboxed iframe merged into the page's agent (core/frames/merged-frames.ts) reloading, against
// Chrome, which keeps it in the page's target: its document's context is destroyed, then the next
// one's created, with an id never seen before. Pages of its own: the reload changes them.
import { test } from 'node:test';
import { setUpAndTearDown } from '../../../../test-support/conformance.ts';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/oopif/merged-sides.ts';

let env: Env | undefined;
let ours: MergedSide | undefined;
let chrome: MergedSide | undefined;

setUpAndTearDown(
  async () => {
    env = await launchOopif();
    chrome = await chromeSide(env);
    ours = await oursSide(env);
  },
  async () => {
    await ours?.close();
    await chrome?.close();
    await env?.close();
  }
);

/** The sandboxed frame's id, from the page's frame tree. */
async function sandboxedFrameId(side: MergedSide): Promise<string> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const id = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  assert.equal(typeof id, 'string');
  return String(id);
}

const contextOf = (e: { method: string; params: object }, frameId: string): number | undefined => {
  if (e.method !== 'Runtime.executionContextCreated') return undefined;
  const context = get(e.params, 'context');
  const id = get(context, 'id');
  return get(get(context, 'auxData'), 'frameId') === frameId && typeof id === 'number' ? id : undefined;
};

test("a sandboxed iframe reloading: its context destroyed, then the next one's created with a new id, as in Chrome", async () => {
  assert.ok(chrome && ours);
  const results = [];
  for (const side of [chrome, ours]) {
    const frameId = await sandboxedFrameId(side);
    const before = await side.events();
    const seen = new Set(before.map(e => contextOf(e, frameId)).filter(id => id !== undefined));
    const old = before.map(e => contextOf(e, frameId)).findLast(id => id !== undefined);
    assert.ok(old !== undefined, 'the sandboxed frame has a context');
    await side.send('Runtime.evaluate', { expression: 'setTimeout(() => location.reload())', contextId: old });
    let after: typeof before = [];
    for (let i = 0; i < 50; i++) {
      after = (await side.events()).slice(before.length);
      if (after.some(e => contextOf(e, frameId) !== undefined)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const destroyedAt = after.findIndex(
      e => e.method === 'Runtime.executionContextDestroyed' && get(e.params, 'executionContextId') === old
    );
    const createdAt = after.findIndex(e => contextOf(e, frameId) !== undefined);
    const created = createdAt < 0 ? undefined : contextOf(after[createdAt] ?? { method: '', params: {} }, frameId);
    results.push({
      destroyedBeforeCreated: destroyedAt >= 0 && destroyedAt < createdAt,
      newId: created !== undefined && !seen.has(created),
    });
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0], { destroyedBeforeCreated: true, newId: true });
});
