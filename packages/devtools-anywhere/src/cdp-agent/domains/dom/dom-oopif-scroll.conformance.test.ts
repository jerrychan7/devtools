// DOM.scrollIntoViewIfNeeded in a linked cross-origin iframe, end to end against Chrome: the same
// command on the same pages (test-support/oopif/oopif-sides.ts), where each page is scrolled to after it
// compared. In Chrome the iframe's renderer hands what is left to expose to its parent's; our
// iframe's agent sends it over the link to the parent's, which scrolls on outward.
import { test } from 'node:test';
import { setUpAndTearDown } from '../../../../test-support/conformance.ts';
import assert from 'node:assert/strict';
import type { Env } from '../../../../test-support/conformance.ts';
import { launchOopif } from '../../../../test-support/oopif/oopif.ts';
import { chromeSide, get, oursSide, type Side } from '../../../../test-support/oopif/oopif-sides.ts';

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launchOopif();
  },
  () => env?.close()
);

/**
 * Waits a while in both pages, for scrolls to land and the parent to hear its iframe: by timers,
 * as Chrome draws no frames for a cross-origin iframe out of view, whose animation frames wait.
 */
async function settled(side: Side) {
  const wait = 'new Promise(r => setTimeout(r, 200))';
  await side.run(wait, true);
  await side.run(wait);
}

/**
 * The iframe below the parent's fold and its #target below its own: where each page is scrolled
 * to once the iframe's session asks for #target (or a part of it, `rect`), and whether #target is
 * in the parent's viewport then.
 */
async function scroll(side: Side, rect?: object) {
  await side.run(
    "document.getElementById('parent').style.height = '2000px'; document.body.style.paddingBottom = '2000px'; scrollTo(0, 0)"
  );
  await side.run(
    "document.getElementById('target').style.marginTop = '1000px'; document.body.style.height = '2000px'; scrollTo(0, 0)",
    true
  );
  await settled(side);
  const doc = get(await side.send('DOM.getDocument', {}, side.child), 'root');
  const nodeId = get(
    await side.send('DOM.querySelector', { nodeId: get(doc, 'nodeId'), selector: '#target' }, side.child),
    'nodeId'
  );
  const reply = await side.send('DOM.scrollIntoViewIfNeeded', { nodeId, ...(rect ? { rect } : {}) }, side.child);
  await settled(side);
  const frame = JSON.parse(
    String(await side.run("JSON.stringify(document.getElementById('child').getBoundingClientRect())"))
  );
  const target = JSON.parse(
    String(await side.run("JSON.stringify(document.getElementById('target').getBoundingClientRect())", true))
  );
  const top = frame.top + target.top;
  const innerHeight = Number(await side.run('innerHeight'));
  return {
    reply,
    // The pages' viewports differ in size between the sides: where #target is from the middle of
    // the parent's, and the iframe's own scroll, which its fixed size makes the same.
    fromMiddle: Math.round(top + target.height / 2 - innerHeight / 2) + 0,
    scrolled: await side.run('scrollY', true),
    visible: top >= 0 && top + target.height <= innerHeight,
  };
}

async function run<T>(open: (env: Env) => Promise<Side>, act: (side: Side) => Promise<T>): Promise<T> {
  assert.ok(env);
  const side = await open(env);
  try {
    return await act(side);
  } finally {
    await side.close();
  }
}

test('ours: DOM.scrollIntoViewIfNeeded in a cross-origin iframe scrolls its parent too, as in Chrome', async () => {
  const expected = await run(chromeSide, side => scroll(side));
  const actual = await run(oursSide, side => scroll(side));
  assert.deepEqual(actual, expected);
  assert.equal(expected.visible, true);
});

test('ours: with a rect, the part asked for is what the parent exposes, as in Chrome', async () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const expected = await run(chromeSide, side => scroll(side, rect));
  const actual = await run(oursSide, side => scroll(side, rect));
  assert.deepEqual(actual, expected);
});
