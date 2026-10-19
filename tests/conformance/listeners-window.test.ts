import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';
import type { Env, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
});
after(() => env?.close());

test('on* handlers of window, which are own properties of the instance', async () => {
  await t.page.evaluate(() => {
    window.onresize = function onWindowResize() {};
  });
  const handlers = [];
  for (const side of [t.ours, t.chrome]) {
    const { result } = await side.send('Runtime.evaluate', { expression: 'window', objectGroup: 'test' });
    assert.ok(result.objectId);
    const { listeners } = await side.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    handlers.push(listeners.filter(l => l.type === 'resize').map(l => l.handler?.description?.split('(')[0]));
  }
  assert.deepEqual(handlers[0], handlers[1]);
  assert.deepEqual(handlers[0], ['function onWindowResize']);
});
