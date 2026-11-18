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

test('a once listener that stops its event for the listeners after it is forgotten, and leaves no helper', async () => {
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'once-stopped';
    document.body.append(el);
    el.addEventListener('transitionend', e => e.stopImmediatePropagation(), { once: true });
    el.dispatchEvent(new Event('transitionend'));
  });
  const listed = async (side: typeof t.chrome) => {
    const { result } = await side.send('Runtime.evaluate', {
      expression: "document.getElementById('once-stopped')",
      objectGroup: 'test',
    });
    assert.ok(result.objectId);
    const { listeners } = await side.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.map(listener => listener.type);
  };
  // Chrome lists what the element really has: the helper the probe adds for a once listener would be there.
  assert.deepEqual(await listed(t.chrome), []);
  assert.deepEqual(await listed(t.ours), []);
});

/** The types of the listeners each side lists for what `expression` gives. */
const listedOf = async (side: typeof t.chrome, expression: string) => {
  const { result } = await side.send('Runtime.evaluate', { expression, objectGroup: 'test' });
  assert.ok(result.objectId);
  const { listeners } = await side.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  return listeners.map(listener => listener.type);
};

test('a listener its signal removes is forgotten, though the page stops the abort event', async () => {
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'abort-stopped';
    document.body.append(el);
    const controller = new AbortController();
    // The page's listener of the signal comes first, and stops the event for the listeners after it.
    controller.signal.addEventListener('abort', e => e.stopImmediatePropagation());
    el.addEventListener('transitionend', () => {}, { signal: controller.signal });
    el.addEventListener('transitionend', () => {}, { signal: controller.signal, capture: true });
    el.addEventListener('transitioncancel', () => {}, { signal: controller.signal, once: true });
    controller.abort();
  });
  const expression = "document.getElementById('abort-stopped')";
  // Chrome lists what the element really has: the helper the probe adds for a once listener would be there.
  assert.deepEqual(await listedOf(t.chrome, expression), []);
  assert.deepEqual(await listedOf(t.ours, expression), []);
});

test('a once listener that has run leaves no helper on its signal', async () => {
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'once-signal';
    document.body.append(el);
    const controller = new AbortController();
    Reflect.set(window, '__onceSignal', controller.signal);
    el.addEventListener('transitionend', () => {}, { once: true, signal: controller.signal });
    el.dispatchEvent(new Event('transitionend'));
  });
  // Chrome lists what the signal really has: a helper left there would keep the listener until the abort.
  assert.deepEqual(await listedOf(t.chrome, 'window.__onceSignal'), []);
  assert.deepEqual(await listedOf(t.chrome, "document.getElementById('once-signal')"), []);
  assert.deepEqual(await listedOf(t.ours, "document.getElementById('once-signal')"), []);
});

test('a listener the page adds again as its signal is aborted is listed, as in Chrome', async () => {
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'abort-readded';
    document.body.append(el);
    const controller = new AbortController();
    const again = () => {};
    el.addEventListener('click', again, { signal: controller.signal });
    // The browser has removed the listener by the time the abort event runs: the page adds it again there.
    controller.signal.addEventListener('abort', () => el.addEventListener('click', again));
    controller.abort();
    el.addEventListener('click', () => {});
  });
  const expression = "document.getElementById('abort-readded')";
  assert.deepEqual(await listedOf(t.chrome, expression), ['click', 'click']);
  assert.deepEqual(await listedOf(t.ours, expression), ['click', 'click']);
});

test('elements that listen with a signal the page keeps are collected once it drops them', async () => {
  await t.page.evaluate(() => {
    const controller = new AbortController();
    const refs: WeakRef<Element>[] = [];
    for (let i = 0; i < 1000; i++) {
      const el = document.createElement('div');
      document.body.append(el);
      el.addEventListener('click', () => {}, { signal: controller.signal });
      el.addEventListener('keydown', () => {}, { signal: controller.signal, once: true });
      refs.push(new WeakRef(el));
    }
    for (const ref of refs) ref.deref()?.remove();
    Reflect.set(window, '__kept', { controller, refs });
  });
  const cdp = await t.page.createCDPSession();
  try {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  } finally {
    await cdp.detach();
  }
  const alive = await t.page.evaluate(
    () => (Reflect.get(window, '__kept') as { refs: WeakRef<Element>[] }).refs.filter(ref => ref.deref()).length
  );
  // A page without the probe has none left either: the signal holds the browser's own removal, not the element.
  assert.equal(alive, 0);
  // Chrome lists what the signal really has: nothing of the probe's is left on it.
  assert.deepEqual(await listedOf(t.chrome, 'window.__kept.controller.signal'), []);
});
