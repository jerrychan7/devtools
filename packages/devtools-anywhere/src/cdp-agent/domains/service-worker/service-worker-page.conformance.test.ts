// The ServiceWorker domain where the page itself takes part: registrations other tabs make, the
// page as a controlled client, and the commands the page carries out through its registration.
import { afterEach, test } from 'node:test';
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

/** Unregisters every registration under the fixture's directory, so that no test sees another's. */
const unregisterAll = () =>
  t.page.evaluate(async s => {
    const all = await navigator.serviceWorker.getRegistrations();
    await Promise.all(all.filter(r => r.scope.startsWith(s)).map(r => r.unregister()));
  }, scope);
afterEach(() => unregisterAll());

/** Starts collecting what the page's workers post to it, in `window.posted`. */
const collect = () =>
  t.page.evaluate(() => {
    const page = window as unknown as { posted: string[] };
    if (page.posted) return;
    page.posted = [];
    navigator.serviceWorker.addEventListener('message', e => page.posted.push(JSON.stringify(e.data)));
  });
const posted = () => t.page.evaluate(() => (window as unknown as { posted: string[] }).posted);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a registration made in another tab shows when the page gets focus', async () => {
  await both(side => side.clear());
  const other = await env.browser.newPage();
  await other.goto(scope + 'fixture.html');
  const assets = scope + 'assets/';
  await other.evaluate(s => navigator.serviceWorker.register(s + 'sw.js', { scope: s }).then(() => {}), assets);
  try {
    await until(async () => (await scopesOf(t.chrome)).includes(`${assets} false`), "Chrome's report");
    await other.close();
    await t.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await scopesOf(t.ours)).includes(`${assets} false`), 'our report');
  } finally {
    await t.page.evaluate(async s => (await navigator.serviceWorker.getRegistration(s))?.unregister(), assets);
  }
});

/**
 * Registers `script` for the fixture's directory and waits until it, and no other script, controls
 * the page. A registration left by a test before is taken over: the new script, which waits behind
 * the active one, is asked to skip waiting.
 */
const control = (script: string) =>
  t.page.evaluate(
    async (src, s) => {
      const reg = await navigator.serviceWorker.register(src, { scope: s });
      const start = Date.now();
      while (navigator.serviceWorker.controller?.scriptURL !== src) {
        if (Date.now() - start > 10000) throw new Error(`timed out waiting for ${src} to control the page`);
        if (reg.waiting?.scriptURL === src) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        await new Promise(r => setTimeout(r, 50));
      }
    },
    script,
    scope
  );

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
  await control(script);
  for (const side of [t.chrome, t.ours]) {
    await until(
      async () => (await clientsOf(side, script))?.[0] === 'self',
      `${side === t.ours ? 'our' : "Chrome's"} list`
    );
  }
});

/** The id each side gave the registration of `s`. */
const idOn = async (side: TestPage['ours'], s: string) => {
  const id = (await side.events('ServiceWorker.workerRegistrationUpdated'))
    .flatMap(e => e.registrations)
    .findLast(r => r.scopeURL === s)?.registrationId;
  assert.ok(id, `no registration reported for ${s}`);
  return id;
};

/** Sends dispatchSyncEvent for the registration of `s` as `side` reported it. */
const dispatchSync = async (side: TestPage['ours'], s: string, tag: string, lastChance = false) =>
  side.send('ServiceWorker.dispatchSyncEvent', {
    origin: new URL(scope).origin,
    registrationId: await idOn(side, s),
    tag,
    lastChance,
  });
const syncOf = (tag: string, lastChance = false) => JSON.stringify({ sync: tag, lastChance });
/** Waits until both sides last reported `s` live. */
const reported = (s: string) =>
  until(async () => {
    const last = async (side: TestPage['ours']) => (await scopesOf(side)).findLast(x => x.startsWith(s + ' '));
    return (await last(t.ours)) === `${s} false` && (await last(t.chrome)) === `${s} false`;
  }, `reports of ${s}`);

test('dispatchSyncEvent fires a sync event in the worker', async () => {
  const origin = new URL(scope).origin;
  await control(scope + 'sw-events.js?v=1');
  await reported(scope);
  await collect();
  await dispatchSync(t.chrome, scope, 'chrome');
  await dispatchSync(t.ours, scope, 'ours');
  const want = [syncOf('chrome'), syncOf('ours')];
  await until(async () => {
    const all = await posted();
    return want.every(w => all.includes(w));
  }, 'both sync events');
  // An unknown registration succeeds without effect on both; an id that is no 64-bit integer
  // fails on both.
  for (const side of [t.chrome, t.ours]) {
    for (const registrationId of ['9999', '-1', '+9223372036854775807', '-9223372036854775808']) {
      await side.send('ServiceWorker.dispatchSyncEvent', { origin, registrationId, tag: 'x', lastChance: false });
    }
    for (const registrationId of ['x', '', ' 1', '1.0', '9223372036854775808', '-9223372036854775809']) {
      await assert.rejects(
        side.send('ServiceWorker.dispatchSyncEvent', { origin, registrationId, tag: 'x', lastChance: false }),
        /Invalid version ID/,
        JSON.stringify(registrationId)
      );
    }
  }
});

test('dispatchSyncEvent with lastChance: Chrome fires it as the last chance, the page cannot', async () => {
  await control(scope + 'sw-events.js?v=1');
  await reported(scope);
  await collect();
  await dispatchSync(t.chrome, scope, 'last-chrome', true);
  await until(async () => (await posted()).includes(syncOf('last-chrome', true)), "Chrome's last-chance sync");
  await assert.rejects(
    dispatchSync(t.ours, scope, 'last-ours', true),
    /the browser decides whether a sync event is the last chance/
  );
  await sleep(500);
  assert.ok(!(await posted()).some(p => p.includes('last-ours')));
});

test('dispatchSyncEvent offline: Chrome fires it at once, the page fails rather than wait', async () => {
  await control(scope + 'sw-events.js?v=1');
  await reported(scope);
  await collect();
  await t.page.setOfflineMode(true);
  try {
    assert.equal(await t.page.evaluate(() => navigator.onLine), false);
    await dispatchSync(t.chrome, scope, 'offline-chrome');
    await until(async () => (await posted()).includes(syncOf('offline-chrome')), "Chrome's sync while offline");
    await assert.rejects(dispatchSync(t.ours, scope, 'offline-ours'), /the browser is offline/);
  } finally {
    await t.page.setOfflineMode(false);
  }
  // Nothing was registered, so nothing fires once online again.
  await sleep(500);
  assert.ok(!(await posted()).some(p => p.includes('offline-ours')));
});

test('dispatchSyncEvent on a registration with no active worker succeeds without effect', async () => {
  const held = scope + 'held/';
  await collect();
  // Installing for 3s: the registration has no active worker meanwhile.
  await t.page.evaluate(
    (src, s) => navigator.serviceWorker.register(src, { scope: s }).then(() => {}),
    `${scope}sw-events.js?hold=3000`,
    held
  );
  await reported(held);
  const installing = () =>
    t.page.evaluate(async s => {
      const reg = await navigator.serviceWorker.getRegistration(s);
      return !!reg?.installing && !reg.active;
    }, held);
  for (const [side, tag] of [
    [t.chrome, 'held-chrome'],
    [t.ours, 'held-ours'],
  ] as const) {
    assert.ok(await installing(), `the worker was still installing before ${tag}`);
    await dispatchSync(side, held, tag);
  }
  // Once active, the worker gets neither: none was kept for it.
  await t.page.evaluate(async s => {
    const reg = await navigator.serviceWorker.getRegistration(s);
    while (!reg?.active) await new Promise(r => setTimeout(r, 50));
  }, held);
  await sleep(1000);
  assert.deepEqual(
    (await posted()).filter(p => p.includes('held-')),
    []
  );
});

/** Registers `src` for the fixture's directory and waits until it is the waiting worker. */
const waitFor = (src: string) =>
  t.page.evaluate(
    async (src, s) => {
      const reg = await navigator.serviceWorker.register(src, { scope: s });
      const start = Date.now();
      while (reg.waiting?.scriptURL !== src) {
        if (Date.now() - start > 10000) throw new Error(`timed out waiting for ${src} to wait`);
        await new Promise(r => setTimeout(r, 50));
      }
    },
    src,
    scope
  );
const registered = (which: 'active' | 'waiting') =>
  t.page.evaluate(
    async (s, w) => (await navigator.serviceWorker.getRegistration(s))?.[w]?.scriptURL ?? null,
    scope,
    which
  );

test('skipWaiting with nothing waiting succeeds without effect, as in Chrome', async () => {
  for (const side of [t.chrome, t.ours]) {
    await side.send('ServiceWorker.skipWaiting', { scopeURL: 'https://unknown.example/' });
    await side.send('ServiceWorker.skipWaiting', { scopeURL: scope + 'nothing-here/' });
  }
  const active = scope + 'sw-events.js?v=1';
  await control(active);
  for (const side of [t.chrome, t.ours]) await side.send('ServiceWorker.skipWaiting', { scopeURL: scope });
  assert.equal(await registered('active'), active);
});

test('skipWaiting activates a waiting worker that listens for SKIP_WAITING', async () => {
  await control(scope + 'sw-events.js?v=1');
  const listening = scope + 'sw-events.js?v=2';
  await waitFor(listening);
  await t.ours.send('ServiceWorker.skipWaiting', { scopeURL: scope });
  assert.equal(await registered('active'), listening);
});

test('skipWaiting follows a newer worker that replaces the waiting one', async () => {
  await control(scope + 'sw-events.js?v=1');
  // One that ignores the message waits; while the command waits, one that listens replaces it.
  await waitFor(scope + 'sw-events.js?v=4&listen=0');
  const skipping = t.ours.send('ServiceWorker.skipWaiting', { scopeURL: scope });
  const newer = scope + 'sw-events.js?v=5';
  await t.page.evaluate((src, s) => navigator.serviceWorker.register(src, { scope: s }).then(() => {}), newer, scope);
  await skipping;
  assert.equal(await registered('active'), newer);
  assert.equal(await registered('waiting'), null);
});

test('skipWaiting on a worker that ignores SKIP_WAITING: Chrome forces it, the page cannot', async () => {
  const active = scope + 'sw-events.js?v=1';
  await control(active);
  const deaf = scope + 'sw-events.js?v=3&listen=0';
  await waitFor(deaf);
  await assert.rejects(
    t.ours.send('ServiceWorker.skipWaiting', { scopeURL: scope }),
    /the waiting worker did not skip waiting on the page's request/
  );
  assert.equal(await registered('active'), active);
  await t.chrome.send('ServiceWorker.skipWaiting', { scopeURL: scope });
  await until(async () => (await registered('active')) === deaf, "Chrome's activation of the waiting worker");
});
