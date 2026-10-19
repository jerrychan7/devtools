import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from './harness.ts';
import type { Env, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.chrome.send('Page.enable');
});
after(() => env?.close());

test('getAppManifest without a manifest', async () => {
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getAppManifest'), t.chrome.send('Page.getAppManifest')]);
  assert.equal(ours.url, chrome.url);
  assert.equal(ours.data, chrome.data);
});

test('getAppManifest returns the linked manifest (Application panel)', async () => {
  await t.page.evaluate(() =>
    document.head.append(
      Object.assign(document.createElement('link'), {
        rel: 'manifest',
        href: '/tests/conformance/assets/manifest.json',
      })
    )
  );
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getAppManifest'), t.chrome.send('Page.getAppManifest')]);
  assert.ok(chrome.data);
  assert.equal(ours.url, chrome.url);
  assert.equal(ours.data, chrome.data);
  assert.deepEqual(ours.errors, chrome.errors);
});
