import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, waitForBoth } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

let env: Env | undefined;
let t: TestPage;

/** Adds an external script and waits for it to run. */
const addScript = (query: string) =>
  t.page.evaluate(
    query =>
      new Promise(resolve => {
        const s = document.createElement('script');
        s.src = `/tests/conformance/assets/resource.js?${query}`;
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
  for (let i = 0; i < 50 && !(await parsed(t.ours, 'later')); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(await parsed(t.chrome, 'later'));
  assert.ok(await parsed(t.ours, 'later'));
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

test('inline scripts and DevTools itself are not reported', async () => {
  const urls = (await t.ours.events('Debugger.scriptParsed')).map(e => e.url);
  assert.ok(urls.every(url => /^https?:/.test(url)));
});

test('breakpoint commands are accepted', async () => {
  const result = await t.ours.send('Debugger.setBreakpointByUrl', { lineNumber: 0, url: 'x.js' });
  assert.deepEqual(result.locations, []);
  const possible = await t.ours.send('Debugger.getPossibleBreakpoints', {
    start: { scriptId: '1', lineNumber: 0 },
  });
  assert.deepEqual(possible.locations, []);
});
