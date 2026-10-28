import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from '../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['Runtime.consoleAPICalled']);
  await t.chrome.send('Runtime.enable');
  await t.ours.send('Runtime.enable');
});
after(() => env?.close());

async function exists(side: Side, objectId: string) {
  return side.send('Runtime.getProperties', { objectId, ownProperties: true }).then(
    () => true,
    () => false
  );
}

test('a console entry dropped past 1000 messages keeps its object handles', async () => {
  await t.chrome.clear();
  await t.ours.clear();
  await t.page.evaluate('for (let i = 0; i < 1100; i++) console.log({ i })');
  const [ours, chrome] = await waitForBoth(t, 'Runtime.consoleAPICalled', 1100, 20000);
  const first = ours[0]?.args[0]?.objectId;
  const chromeFirst = chrome[0]?.args[0]?.objectId;
  assert.ok(first && chromeFirst);
  assert.equal(await exists(t.ours, first), await exists(t.chrome, chromeFirst));
  assert.equal(await exists(t.ours, first), true);
});

test('discardConsoleEntries releases console handles', async () => {
  await t.chrome.clear();
  await t.ours.clear();
  await t.page.evaluate('console.log({ a: 1 })');
  const [[ours], [chrome]] = await waitForBoth(t, 'Runtime.consoleAPICalled');
  const id = ours?.args[0]?.objectId;
  const chromeId = chrome?.args[0]?.objectId;
  assert.ok(id && chromeId);
  await t.ours.send('Runtime.discardConsoleEntries');
  await t.chrome.send('Runtime.discardConsoleEntries');
  assert.equal(await exists(t.chrome, chromeId), false);
  assert.equal(await exists(t.ours, id), false);
});
