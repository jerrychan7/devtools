import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from '../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

/** Adds an external script and waits for it to run. */
const addScript = (query: string) =>
  t.page.evaluate(
    query =>
      new Promise(resolve => {
        const s = document.createElement('script');
        s.src = `/packages/devtools-anywhere/test-support/assets/resource.js?${query}`;
        s.onload = resolve;
        document.head.append(s);
      }),
    query
  );

before(async () => {
  env = await launch();
  t = await openPage(env, ['Debugger.scriptParsed']);
  await addScript('before');
  await t.chrome.send('Debugger.enable');
  await t.ours.send('Debugger.enable');
});
after(() => env?.close());

const parsed = async (side: Side, query: string) =>
  (await side.events('Debugger.scriptParsed')).find(e => e.url.endsWith(`resource.js?${query}`));

/** Waits until `side` has reported the script added with `query`. */
async function waitParsed(side: Side, query: string) {
  for (let i = 0; i < 50; i++) {
    const event = await parsed(side, query);
    if (event) return event;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for scriptParsed of resource.js?${query}`);
}

test('scripts loaded before enable are reported', async () => {
  await waitForBoth(t, 'Debugger.scriptParsed');
  const chrome = await parsed(t.chrome, 'before');
  const ours = await parsed(t.ours, 'before');
  assert.ok(chrome && ours);
  assert.equal(ours.url, chrome.url);
  assert.equal(ours.isModule, chrome.isModule);
  assert.equal(ours.startLine, chrome.startLine);
});

test('scripts added later are reported', async () => {
  await addScript('later');
  await Promise.all([waitParsed(t.chrome, 'later'), waitParsed(t.ours, 'later')]);
});

test('getScriptSource returns the script text', async () => {
  const chrome = await parsed(t.chrome, 'before');
  const ours = await parsed(t.ours, 'before');
  assert.ok(chrome && ours);
  const [a, b] = await Promise.all([
    t.chrome.send('Debugger.getScriptSource', { scriptId: chrome.scriptId }),
    t.ours.send('Debugger.getScriptSource', { scriptId: ours.scriptId }),
  ]);
  assert.equal(b.scriptSource, a.scriptSource);
});

test('getScriptSource rejects an unknown scriptId', async () => {
  await assert.rejects(t.ours.send('Debugger.getScriptSource', { scriptId: '999999' }));
});

test('inline scripts are not reported', async () => {
  const pageUrl = t.page.url();
  await t.page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.head.append(s);
  });
  // Chrome reports a script-inserted inline script with an empty URL; we cannot locate it, so leave it out.
  for (let i = 0; i < 50 && !(await t.chrome.events('Debugger.scriptParsed')).some(e => e.url === ''); i++)
    await new Promise(r => setTimeout(r, 100));
  assert.ok((await t.chrome.events('Debugger.scriptParsed')).some(e => e.url === ''));
  await addScript('after-inline');
  await waitParsed(t.ours, 'after-inline');
  const urls = (await t.ours.events('Debugger.scriptParsed')).map(e => e.url);
  assert.ok(urls.length > 0);
  assert.ok(urls.every(url => /^https?:/.test(url) && url !== pageUrl));
});

test('scripts are reported again after disable and enable', async () => {
  await t.ours.send('Debugger.disable');
  await t.ours.clear();
  await t.ours.send('Debugger.enable');
  const ours = await waitParsed(t.ours, 'before');
  const chrome = await parsed(t.chrome, 'before');
  assert.ok(chrome);
  const [a, b] = await Promise.all([
    t.chrome.send('Debugger.getScriptSource', { scriptId: chrome.scriptId }),
    t.ours.send('Debugger.getScriptSource', { scriptId: ours.scriptId }),
  ]);
  assert.equal(b.scriptSource, a.scriptSource);
});

test('breakpoint commands are accepted', async () => {
  const result = await t.ours.send('Debugger.setBreakpointByUrl', { lineNumber: 0, url: 'x.js' });
  assert.deepEqual(result.locations, []);
  const possible = await t.ours.send('Debugger.getPossibleBreakpoints', {
    start: { scriptId: '1', lineNumber: 0 },
  });
  assert.deepEqual(possible.locations, []);
});
