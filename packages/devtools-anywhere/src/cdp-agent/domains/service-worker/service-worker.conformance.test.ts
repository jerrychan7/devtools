import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, waitForBoth, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;
let scope: string;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['ServiceWorker.workerRegistrationUpdated', 'ServiceWorker.workerVersionUpdated']);
    scope = env.baseUrl + '/packages/devtools-anywhere/test-support/assets/';
    await t.page.evaluate(async scope => {
      await navigator.serviceWorker.register(scope + 'sw.js', { scope });
      const reg = await navigator.serviceWorker.getRegistration(scope);
      // Waits for it to activate, which the worker does at once.
      while (!reg?.active) await new Promise(resolve => setTimeout(resolve, 50));
    }, scope);
  },
  () => env?.close()
);

const both = <T>(fn: (side: TestPage['ours']) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);
const last = <T>(list: T[]) => list[list.length - 1];
const pick = (v?: Protocol.ServiceWorker.ServiceWorkerVersion) => v && { scriptURL: v.scriptURL, status: v.status };

test('enable lists the registrations and their workers', async () => {
  await both(side => side.send('ServiceWorker.enable'));
  const [ours, chrome] = await waitForBoth(t, 'ServiceWorker.workerRegistrationUpdated');
  const scopes = (events: Protocol.ServiceWorker.WorkerRegistrationUpdatedEvent[]) =>
    events.flatMap(e => e.registrations.map(r => `${r.scopeURL} ${r.isDeleted}`));
  assert.deepEqual(scopes(ours), scopes(chrome));
  const [oursV, chromeV] = await waitForBoth(t, 'ServiceWorker.workerVersionUpdated');
  assert.deepEqual(pick(last(oursV)?.versions[0]), pick(last(chromeV)?.versions[0]));
});

test('updateRegistration succeeds, for an unknown scope too', async () => {
  await both(side => side.send('ServiceWorker.updateRegistration', { scopeURL: scope }));
  await both(side => side.send('ServiceWorker.updateRegistration', { scopeURL: scope + 'nope/' }));
});

test('unregister removes the registration and reports it deleted', async () => {
  await both(side => side.clear());
  // One side unregisters it; the other is told by the browser or by the page.
  await t.ours.send('ServiceWorker.unregister', { scopeURL: scope });
  const [ours, chrome] = await waitForBoth(t, 'ServiceWorker.workerRegistrationUpdated');
  assert.equal(last(ours)?.registrations[0]?.isDeleted, true);
  assert.equal(last(chrome)?.registrations[0]?.isDeleted, true);
  assert.equal(await t.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  await both(side => side.send('ServiceWorker.unregister', { scopeURL: scope }));
});

test('commands that need the worker fail', async () => {
  await assert.rejects(t.ours.send('ServiceWorker.stopAllWorkers'), /Not supported in the page/);
  await assert.rejects(
    t.ours.send('ServiceWorker.setForceUpdateOnPageLoad', { forceUpdateOnPageLoad: true }),
    /Not supported in the page/
  );
  await t.ours.send('ServiceWorker.setForceUpdateOnPageLoad', { forceUpdateOnPageLoad: false });
});
