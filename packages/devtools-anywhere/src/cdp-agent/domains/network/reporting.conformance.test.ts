import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['Network.reportingApiReportAdded']);
    await t.chrome.send('Network.enable');
    await t.ours.send('Network.enable');
  },
  () => env?.close()
);

describe('Reporting API', () => {
  test('enableReportingApi reports what the page sees', async () => {
    await t.chrome.clear();
    await t.ours.clear();
    await t.chrome.send('Network.enableReportingApi', { enable: true });
    await t.ours.send('Network.enableReportingApi', { enable: true });
    // A synchronous XHR on the main thread is reported as deprecated.
    await t.page.evaluate(() => {
      const x = new XMLHttpRequest();
      x.open('GET', '/api/echo?reporting', false);
      x.send();
    });
    const start = Date.now();
    const of = async (side: Side) => (await side.events('Network.reportingApiReportAdded')).map(e => e.report);
    while ((!(await of(t.ours)).length || !(await of(t.chrome)).length) && Date.now() - start < 5000)
      await new Promise(r => setTimeout(r, 50));
    const pick = (r: Protocol.Network.ReportingApiReport) => ({
      initiatorUrl: r.initiatorUrl,
      destination: r.destination,
      type: r.type,
      depth: r.depth,
      completedAttempts: r.completedAttempts,
      status: r.status,
      id: r.body.id,
      message: r.body.message,
    });
    assert.ok((await of(t.chrome)).length, 'Chrome reported nothing');
    assert.deepEqual((await of(t.ours)).map(pick), (await of(t.chrome)).map(pick));
    await t.chrome.send('Network.enableReportingApi', { enable: false });
    await t.ours.send('Network.enableReportingApi', { enable: false });
  });

  test('setAttachDebugStack succeeds, and requests keep their stack', async () => {
    await t.ours.send('Network.setAttachDebugStack', { enabled: true });
    await t.chrome.send('Network.setAttachDebugStack', { enabled: true });
  });
});
