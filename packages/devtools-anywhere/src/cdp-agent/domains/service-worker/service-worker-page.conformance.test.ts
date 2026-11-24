// The ServiceWorker domain where the page itself takes part: registrations other tabs make, the
// page as a controlled client, and the commands the page carries out through its registration.
import { test } from 'node:test';
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
