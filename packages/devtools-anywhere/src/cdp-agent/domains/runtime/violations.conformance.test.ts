import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

/** What the frontend asks for (SDK's LogModel). */
const CONFIG = [
  { name: 'longTask', threshold: 200 },
  { name: 'longLayout', threshold: 30 },
  { name: 'blockedEvent', threshold: 100 },
  { name: 'blockedParser', threshold: -1 },
  { name: 'handler', threshold: 150 },
  { name: 'recurringHandler', threshold: 50 },
  { name: 'discouragedAPIUse', threshold: -1 },
] as const;

/** One side's violation messages, the time in them rounded to tens of ms. */
async function violations(side: Side, count: number) {
  for (const start = Date.now(); Date.now() - start < 5000; await new Promise(r => setTimeout(r, 20))) {
    const entries = (await side.events('Log.entryAdded')).map(e => e.entry).filter(e => e.source === 'violation');
    if (entries.length >= count) {
      return entries
        .map(e => ({
          level: e.level,
          url: e.url,
          text: e.text.replace(/\d+ms$/, ms => `${Math.round(parseInt(ms) / 10) * 10}ms`),
        }))
        .sort((a, b) => a.text.localeCompare(b.text));
    }
  }
  throw new Error(`timed out waiting for ${count} violations: ${JSON.stringify(await side.events('Log.entryAdded'))}`);
}

describe('Log.startViolationsReport', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, ['Log.entryAdded']);
    for (const side of [t.chrome, t.ours]) {
      await side.send('Log.enable');
      await side.send('Log.startViolationsReport', { config: [...CONFIG] });
    }
  });

  test('slow handlers are reported as in Chrome', async () => {
    // From a script of the page: long animation frames attribute no time to puppeteer's.
    await t.page.evaluate(`(() => {
      const script = document.createElement('script');
      script.textContent = \`
        const busy = ms => { const s = Date.now(); while (Date.now() - s < ms); };
        setTimeout(() => busy(250), 10);
        requestAnimationFrame(() => busy(120));
        setTimeout(() => busy(60), 400);
      \`;
      document.body.append(script);
    })()`);
    const chrome = await violations(t.chrome, 2);
    const ours = await violations(t.ours, 2);
    assert.deepEqual(ours, chrome);
  });

  test('stopping ends the reports', async () => {
    for (const side of [t.chrome, t.ours]) {
      await side.send('Log.stopViolationsReport');
      await side.clear();
    }
    await t.page.evaluate(
      `new Promise(r => setTimeout(() => { const s = Date.now(); while (Date.now() - s < 250); r(); }, 10))`
    );
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(await t.ours.events('Log.entryAdded'), await t.chrome.events('Log.entryAdded'));
  });
});
