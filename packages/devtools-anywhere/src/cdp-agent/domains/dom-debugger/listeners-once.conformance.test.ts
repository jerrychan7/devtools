import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
  },
  () => env?.close()
);

test('removing a once listener also removes the helper that forgets it', async () => {
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'once-removed';
    document.body.append(el);
    const onceRemoved = function onceRemoved() {};
    el.addEventListener('transitionend', onceRemoved, { once: true });
    el.removeEventListener('transitionend', onceRemoved);
  });
  const { result } = await t.chrome.send('Runtime.evaluate', {
    expression: "document.getElementById('once-removed')",
    objectGroup: 'test',
  });
  assert.ok(result.objectId);
  const { listeners } = await t.chrome.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  assert.deepEqual(listeners, []);
});
