// Prints Chrome's and our CDP output side by side for one action.
//   node tests/conformance/dump.mjs log "<expr>"       console.log(expr)
//   node tests/conformance/dump.mjs run "<code>"       run code, show console/exception events
//   node tests/conformance/dump.mjs props "<expr>"     getProperties(ownProperties) of expr
import { launch, openPage } from './harness.mjs';

const [mode, code] = process.argv.slice(2);
const env = await launch();
try {
  const t = await openPage(env, ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown']);
  await t.chrome.send('Runtime.enable');
  await t.ours.send('Runtime.enable');
  t.chrome.clear();
  await t.ours.clear();
  const show = (label, value) => console.log(`--- ${label}\n${JSON.stringify(value, null, 1)}`);
  if (mode === 'props') {
    const [o, c] = await Promise.all([
      t.ours.send('Runtime.evaluate', { expression: code }),
      t.chrome.send('Runtime.evaluate', { expression: code }),
    ]);
    show('chrome', await t.chrome.send('Runtime.getProperties', { objectId: c.result.objectId, ownProperties: true }));
    show('ours', await t.ours.send('Runtime.getProperties', { objectId: o.result.objectId, ownProperties: true }));
  } else {
    await t.page.evaluate(mode === 'log' ? `console.log(${code})` : code);
    await new Promise(r => setTimeout(r, 300));
    for (const m of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown']) {
      show('chrome ' + m, t.chrome.events(m));
      show('ours ' + m, await t.ours.events(m));
    }
  }
} finally {
  await env.close();
}
