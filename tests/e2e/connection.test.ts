// connectFrontend() with a minimal fake frontend (a same-origin iframe) instead of Chii.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import type { Protocol } from 'devtools-protocol';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUNDLE = path.join(root, 'packages/devtools-anywhere/dist/devtools-anywhere.iife.js');

// The fake frontend enables Runtime on load and records everything it receives.
const FRONTEND = `<script>
  window.received = []
  addEventListener('message', e => received.push(JSON.parse(e.data)))
  parent.postMessage(JSON.stringify({ id: 1, method: 'Runtime.enable' }), '*')
</script>`;

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await page.addScriptTag({ path: BUNDLE });
  await page.evaluate(() => console.log('logged before connecting'));
  await page.evaluate(html => {
    window.__session = window.DevtoolsAnywhere.createCdpSession();
    const frame = document.createElement('iframe');
    frame.srcdoc = html;
    document.body.appendChild(frame);
    window.__frame = frame;
    window.DevtoolsAnywhere.connectFrontend(window.__session, frame, location.origin);
  }, FRONTEND);
});
after(() => env?.close());

const received = () =>
  page.evaluate(() => {
    const frontend = window.__frame?.contentWindow;
    if (!frontend) throw new Error('no frontend frame');
    return frontend.received || [];
  });
async function waitFor(predicate: (messages: ReceivedMessage[]) => boolean, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    const messages = await received();
    if (predicate(messages)) return messages;
    if (Date.now() - start > timeout) throw new Error('timed out; received ' + JSON.stringify(messages));
    await new Promise(r => setTimeout(r, 20));
  }
}
/** The first argument of a Runtime.consoleAPICalled message. */
const firstArg = (m: ReceivedMessage) => {
  const arg = (m.params as Protocol.Runtime.ConsoleAPICalledEvent).args[0];
  assert.ok(arg);
  return arg.value;
};
const logs = (messages: ReceivedMessage[]) =>
  messages.filter(m => m.method === 'Runtime.consoleAPICalled').map(firstArg);

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

/**
 * Sends a command from the frontend's own realm (so the message's source is its window) and
 * waits for the answer: messages posted to the page before it have been handled by then.
 */
async function roundTrip(id: number) {
  await page.evaluate(id => {
    const frontend = window.__frame?.contentWindow;
    if (!frontend) throw new Error('no frontend frame');
    const script = frontend.document.createElement('script');
    script.textContent = `parent.postMessage(JSON.stringify({ id: ${id}, method: 'Runtime.evaluate', params: { expression: '1' } }), '*')`;
    frontend.document.body.appendChild(script);
  }, id);
  await waitFor(m => m.some(message => message.id === id && message.result));
}

test('ignores messages from other windows', async () => {
  await page.evaluate(() => {
    // Same origin, but not the frontend's window: must be ignored.
    window.postMessage(
      JSON.stringify({ id: 99, method: 'Runtime.evaluate', params: { expression: 'window.__hacked = 1' } }),
      '*'
    );
  });
  await roundTrip(100);
  assert.equal(await page.evaluate(() => window.__hacked), undefined);
});

test('ignores messages from a frontend window of another origin', async () => {
  // The frame is the connected window, but connected for another origin than its own.
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        const frame = document.createElement('iframe');
        frame.srcdoc = `<script>parent.postMessage(JSON.stringify({ id: 98, method: 'Runtime.evaluate', params: { expression: 'window.__hacked = 1' } }), '*')</script>`;
        frame.addEventListener('load', () => resolve(), { once: true });
        document.body.appendChild(frame);
        const disconnect = window.DevtoolsAnywhere.connectFrontend(window.__session, frame, 'https://other.example');
        frame.id = 'other-frontend';
        frame.addEventListener('cleanup', () => (disconnect(), frame.remove()), { once: true });
      })
  );
  // The other frame posted before the frontend does, so it was handled first. Only disconnect
  // after that: load and the posted message come from different task sources.
  await roundTrip(101);
  await page.evaluate(() => document.getElementById('other-frontend')?.dispatchEvent(new Event('cleanup')));
  assert.equal(await page.evaluate(() => window.__hacked), undefined);
});

test('replays again after the frontend reloads', async () => {
  await page.evaluate(() => {
    const frontend = window.__frame?.contentWindow;
    if (!frontend) throw new Error('no frontend frame');
    // Until the new instance sets its own, waitFor sees nothing: not the old instance's messages.
    delete frontend.received;
    frontend.location.reload();
  });
  const messages = await waitFor(m => logs(m).includes('logged before connecting') && logs(m).includes('live'));
  assert.equal(logs(messages).filter(v => v === 'live').length, 1, 'no duplicates after reload');
});
