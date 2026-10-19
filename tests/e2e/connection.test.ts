// connectFrontend() with a minimal fake frontend (a same-origin iframe) instead of Chii.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../conformance/harness.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = path.join(root, 'packages/devtools-anywhere/dist/devtools-anywhere.iife.js');

// The fake frontend enables Runtime on load and records everything it receives.
const FRONTEND = `<script>
  window.received = []
  addEventListener('message', e => received.push(JSON.parse(e.data)))
  parent.postMessage(JSON.stringify({ id: 1, method: 'Runtime.enable' }), '*')
</script>`;

let env;
let page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/tests/conformance/fixture.html');
  await page.addScriptTag({ path: BUNDLE });
  await page.evaluate(() => console.log('logged before connecting'));
  await page.evaluate(html => {
    window.__server = window.DevtoolsAnywhere.createCdpServer();
    const frame = document.createElement('iframe');
    frame.srcdoc = html;
    document.body.appendChild(frame);
    window.__frame = frame;
    window.DevtoolsAnywhere.connectFrontend(window.__server, frame, location.origin);
  }, FRONTEND);
});
after(() => env?.close());

const received = () => page.evaluate(() => window.__frame.contentWindow.received || []);
async function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    const messages = await received();
    if (predicate(messages)) return messages;
    if (Date.now() - start > timeout) throw new Error('timed out; received ' + JSON.stringify(messages));
    await new Promise(r => setTimeout(r, 20));
  }
}
const logs = messages => messages.filter(m => m.method === 'Runtime.consoleAPICalled').map(m => m.params.args[0].value);

test('replays output captured before the frontend connected', async () => {
  const messages = await waitFor(m => logs(m).includes('logged before connecting'));
  assert.ok(
    messages.some(m => m.id === 1 && m.result),
    'answers Runtime.enable'
  );
});

test('forwards live output', async () => {
  await page.evaluate(() => console.log('live'));
  await waitFor(m => logs(m).includes('live'));
});

test('ignores messages from other windows', async () => {
  await page.evaluate(() => {
    // Same origin, but not the frontend's window: must be ignored.
    window.postMessage(
      JSON.stringify({ id: 99, method: 'Runtime.evaluate', params: { expression: 'window.__hacked = 1' } }),
      '*'
    );
  });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(await page.evaluate(() => window.__hacked), undefined);
});

test('replays again after the frontend reloads', async () => {
  await page.evaluate(() => window.__frame.contentWindow.location.reload());
  await new Promise(r => setTimeout(r, 300));
  const messages = await waitFor(m => logs(m).includes('logged before connecting') && logs(m).includes('live'));
  assert.equal(logs(messages).filter(v => v === 'live').length, 1, 'no duplicates after reload');
});
