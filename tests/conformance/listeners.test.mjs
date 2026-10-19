import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.mjs';

let env;
let t;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  // Registered after the CDP server (and so the probe) is installed.
  await t.page.evaluate(() => {
    const el = document.getElementById('app');
    el.addEventListener('click', function onClick() {});
    el.addEventListener('click', function onClickCapture() {}, true);
    el.addEventListener('scroll', function onScroll() {}, { passive: true });
    el.addEventListener('keydown', function onceKey() {}, { once: true });
    el.addEventListener('focus', { handleEvent() {} });
    const dup = function duplicate() {};
    el.addEventListener('blur', dup);
    el.addEventListener('blur', dup);
    const removed = function removed() {};
    el.addEventListener('input', removed);
    el.removeEventListener('input', removed);
    const controller = new AbortController();
    el.addEventListener('change', function aborted() {}, { signal: controller.signal });
    controller.abort();
    el.onmouseover = function onMouseOver() {};
    window.__fireOnce = () => el.dispatchEvent(new KeyboardEvent('keydown'));
  });
});
after(() => env?.close());

async function listeners(side) {
  const { result } = await side.send('Runtime.evaluate', {
    expression: "document.getElementById('app')",
    objectGroup: 'test',
  });
  const { listeners } = await side.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  return (
    listeners
      // Chrome also sees the probe's helper that forgets `once` listeners after they run.
      .filter(l => !l.handler?.description?.includes('devtoolsAnywhereForget'))
      .map(
        l =>
          `${l.type} capture=${l.useCapture} passive=${l.passive} once=${l.once} ${l.handler?.description?.split('(')[0]}`
      )
      .sort()
  );
}

test('listeners of an element', async () => {
  assert.deepEqual(await listeners(t.ours), await listeners(t.chrome));
});

test('handlers only for objects in a group, like Chrome', async () => {
  await t.page.evaluate(() => document.body.addEventListener('click', function onBodyClick() {}));
  for (const side of [t.ours, t.chrome]) {
    const { result } = await side.send('Runtime.evaluate', { expression: 'document.body' });
    const { listeners } = await side.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    assert.equal(listeners[0].handler, undefined);
    assert.equal(typeof listeners[0].backendNodeId, 'number');
  }
});

test('once listeners are gone after they run', async () => {
  await t.page.evaluate(() => window.__fireOnce());
  const ours = await listeners(t.ours);
  assert.deepEqual(ours, await listeners(t.chrome));
  assert.ok(!ours.some(l => l.startsWith('keydown')));
});
