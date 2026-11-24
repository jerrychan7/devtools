// The ServiceWorker domain where the page itself takes part: registrations other tabs make, the
// page as a controlled client, and the commands the page carries out through its registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env;
let t: TestPage;
/** The fixture's directory: the scope of `sw-events.js`, which controls the fixture page. */
let scope: string;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['ServiceWorker.workerRegistrationUpdated', 'ServiceWorker.workerVersionUpdated']);
    scope = env.baseUrl + '/packages/devtools-anywhere/test-support/';
    await Promise.all([t.ours.send('ServiceWorker.enable'), t.chrome.send('ServiceWorker.enable')]);
  },
  () => env.close()
);

const both = <T>(fn: (side: TestPage['ours']) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);
const until = async (check: () => Promise<boolean>, what: string, timeout = 5000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};
const scopesOf = async (side: TestPage['ours']) =>
  (await side.events('ServiceWorker.workerRegistrationUpdated')).flatMap(e =>
    e.registrations.map(r => `${r.scopeURL} ${r.isDeleted}`)
  );

test('a registration made in another tab shows when the page gets focus', async () => {
  await both(side => side.clear());
  const other = await env.browser.newPage();
  await other.goto(scope + 'fixture.html');
  const assets = scope + 'assets/';
  await other.evaluate(s => navigator.serviceWorker.register(s + 'sw.js', { scope: s }).then(() => {}), assets);
  await until(async () => (await scopesOf(t.chrome)).includes(`${assets} false`), "Chrome's report");
  await other.close();
  await t.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(async () => (await scopesOf(t.ours)).includes(`${assets} false`), 'our report');
});

/** The clients each side last listed on the worker of `script`, by the side's own target id. */
const clientsOf = async (side: TestPage['ours'], script: string) => {
  const own = (await side.send('Target.getTargetInfo')).targetInfo.targetId;
  const versions = (await side.events('ServiceWorker.workerVersionUpdated')).flatMap(e => e.versions);
  const last = versions.filter(v => v.scriptURL === script).at(-1);
  return last?.controlledClients?.map(id => (id === own ? 'self' : id));
};

test('the page is listed on the worker that controls it, by its target id', async () => {
  await both(side => side.clear());
  const script = scope + 'sw-events.js?v=1';
  await t.page.evaluate(
    async (src, s) => {
      await navigator.serviceWorker.register(src, { scope: s });
      while (!navigator.serviceWorker.controller) await new Promise(r => setTimeout(r, 50));
    },
    script,
    scope
  );
  for (const side of [t.chrome, t.ours]) {
    await until(
      async () => (await clientsOf(side, script))?.[0] === 'self',
      `${side === t.ours ? 'our' : "Chrome's"} list`
    );
  }
});

test('dispatchSyncEvent fires a sync event in the worker', async () => {
  const origin = new URL(scope).origin;
  const idOn = async (side: TestPage['ours']) =>
    (await side.events('ServiceWorker.workerRegistrationUpdated'))
      .flatMap(e => e.registrations)
      .findLast(r => r.scopeURL === scope)?.registrationId ?? '';
  type Page = { syncs: string[] };
  await t.page.evaluate(() => {
    const page = window as unknown as Page;
    page.syncs = [];
    navigator.serviceWorker.addEventListener('message', e => page.syncs.push(JSON.stringify(e.data)));
  });
  for (const [side, tag] of [
    [t.chrome, 'chrome'],
    [t.ours, 'ours'],
  ] as const) {
    await side.send('ServiceWorker.dispatchSyncEvent', {
      origin,
      registrationId: await idOn(side),
      tag,
      lastChance: false,
    });
  }
  const want = ['chrome', 'ours'].map(tag => JSON.stringify({ sync: tag, lastChance: false }));
  await until(async () => {
    const syncs = await t.page.evaluate(() => (window as unknown as Page).syncs);
    return want.every(w => syncs.includes(w));
  }, 'both sync events');
  // An unknown registration succeeds without effect on both; an id that is no number fails on both.
  for (const side of [t.chrome, t.ours]) {
    await side.send('ServiceWorker.dispatchSyncEvent', { origin, registrationId: '9999', tag: 'x', lastChance: false });
    await assert.rejects(
      side.send('ServiceWorker.dispatchSyncEvent', { origin, registrationId: 'x', tag: 'x', lastChance: false }),
      /Invalid version ID/
    );
  }
  // Only the browser can make a sync the last chance.
  await assert.rejects(
    t.ours.send('ServiceWorker.dispatchSyncEvent', {
      origin,
      registrationId: await idOn(t.ours),
      tag: 'l',
      lastChance: true,
    }),
    /the browser decides whether a sync event is the last chance/
  );
});

test('skipWaiting activates a waiting worker that listens for SKIP_WAITING', async () => {
  const waitFor = (src: string) =>
    t.page.evaluate(
      async (src, s) => {
        const reg = await navigator.serviceWorker.register(src, { scope: s });
        while (!reg.waiting || !reg.waiting.scriptURL.endsWith(src.slice(src.lastIndexOf('/')))) {
          await new Promise(r => setTimeout(r, 50));
        }
      },
      src,
      scope
    );
  const activeScript = () =>
    t.page.evaluate(async s => (await navigator.serviceWorker.getRegistration(s))?.active?.scriptURL, scope);
  // Like Chrome, an unknown scope succeeds without effect.
  await t.ours.send('ServiceWorker.skipWaiting', { scopeURL: 'https://unknown.example/' });
  const listening = scope + 'sw-events.js?v=2';
  await waitFor(listening);
  await t.ours.send('ServiceWorker.skipWaiting', { scopeURL: scope });
  assert.equal(await activeScript(), listening);
  // No waiting worker left: succeeds without effect.
  await t.ours.send('ServiceWorker.skipWaiting', { scopeURL: scope });
  // A worker that ignores the message cannot be made to skip waiting from the page.
  const deaf = scope + 'sw-events.js?v=3&listen=0';
  await waitFor(deaf);
  await assert.rejects(
    t.ours.send('ServiceWorker.skipWaiting', { scopeURL: scope }),
    /the waiting worker did not skip waiting on the page's request/
  );
  assert.equal(await activeScript(), listening);
});
