// Runtime.globalLexicalScopeNames against Chrome's, on a page with classic and module scripts,
// declarations in their temporal dead zone and a script that does not compile.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  const asset = (name: string) => `${env?.baseUrl}/packages/devtools-anywhere/test-support/assets/${name}`;
  await t.page.addScriptTag({ url: asset('lexical-classic.js') });
  await t.page.addScriptTag({ url: asset('lexical-module.js'), type: 'module' });
  await t.page.addScriptTag({ content: 'let inlineLet = 1, inlineOther; const inlineConst = 2\nclass InlineClass {}' });
  await t.page.addScriptTag({ content: 'let let_ = 1; var let2 = 1; if (true) { let blockLet = 1 }' });
  // Never initialized: the script throws before the declaration runs.
  await t.page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'throw 0; let inDeadZone = 1;';
    window.addEventListener('error', e => e.preventDefault(), { once: true });
    document.head.append(script);
  });
  // Does not compile: nothing is declared.
  await t.page.addScriptTag({ content: 'let notCompiled = ;' }).catch(() => {});
});
after(() => env?.close());

test('globalLexicalScopeNames lists the names Chrome lists', async () => {
  const ours = (await t.ours.send('Runtime.globalLexicalScopeNames', {})).names.toSorted();
  const chrome = (await t.chrome.send('Runtime.globalLexicalScopeNames', {})).names.toSorted();
  assert.deepEqual(ours, chrome);
});

test('a script no longer in the document is not fetched again from the network', async () => {
  const url = `${env?.baseUrl}/packages/devtools-anywhere/test-support/assets/lexical-classic.js?_=${Date.now()}`;
  // Under load the first load's response event can arrive after the script has run: wait for it,
  // so it is not taken for a fetch made by Runtime.globalLexicalScopeNames.
  const firstLoad = t.page.waitForResponse(res => res.url() === url);
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = script.onerror = () => {
          script.remove();
          resolve(null);
        };
        document.head.append(script);
      }),
    url
  );
  await firstLoad;
  const fetched: string[] = [];
  const onResponse = (res: { url(): string; fromCache(): boolean }) => {
    if (res.url() === url && !res.fromCache()) fetched.push(res.url());
  };
  t.page.on('response', onResponse);
  try {
    await t.ours.send('Runtime.globalLexicalScopeNames', {});
  } finally {
    t.page.off('response', onResponse);
  }
  assert.deepEqual(fetched, []);
});
