import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  // Registered after the CDP server (and so the probe) is installed.
  await t.page.evaluate(() => {
    const el = document.getElementById('app');
    if (!el) throw new Error('#app not found');
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

async function listeners(side: Side) {
  const { result } = await side.send('Runtime.evaluate', {
    expression: "document.getElementById('app')",
    objectGroup: 'test',
  });
  assert.ok(result.objectId);
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
    assert.ok(result.objectId);
    const { listeners } = await side.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    assert.ok(listeners[0]);
    assert.equal(listeners[0].handler, undefined);
    assert.equal(typeof listeners[0].backendNodeId, 'number');
  }
});

test('once listeners are gone after they run', async () => {
  await t.page.evaluate(() => {
    if (!window.__fireOnce) throw new Error('__fireOnce not set');
    return window.__fireOnce();
  });
  const ours = await listeners(t.ours);
  assert.deepEqual(ours, await listeners(t.chrome));
  assert.ok(!ours.some(l => l.startsWith('keydown')));
});

test('depth and pierce collect subtree listeners like Chrome', async () => {
  await t.page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'deep';
    root.addEventListener('click', function onRoot() {});
    const child = root.appendChild(document.createElement('div'));
    child.addEventListener('click', function onChild() {});
    const grandchild = child.appendChild(document.createElement('span'));
    grandchild.addEventListener('click', function onGrandchild() {});
    const shadow = child.attachShadow({ mode: 'open' });
    shadow.addEventListener('click', function onShadowRoot() {});
    const inShadow = shadow.appendChild(document.createElement('b'));
    inShadow.addEventListener('click', function onInShadow() {});
    document.body.append(root);
  });
  const collect = async (side: Side, params: { depth: number; pierce?: boolean }) => {
    const { result } = await side.send('Runtime.evaluate', {
      expression: "document.getElementById('deep')",
      objectGroup: 'test',
    });
    assert.ok(result.objectId);
    const { listeners } = await side.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
      ...params,
    });
    return listeners.map(l => `${l.type} ${l.handler?.description?.split('(')[0]}`).sort();
  };
  for (const params of [{ depth: -1 }, { depth: 2 }, { depth: -1, pierce: true }]) {
    assert.deepEqual(await collect(t.ours, params), await collect(t.chrome, params), JSON.stringify(params));
  }
});
