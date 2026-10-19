// The single-script setup, and the Service Worker that injects the probe in shell mode.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import type { Protocol } from 'devtools-protocol';
import { launch } from '../conformance/harness.ts';
import type { Env } from '../conformance/harness.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/tests/e2e/zero-config.html');
});
after(() => env?.close());

/** Messages the fake frontend received, in or outside shell mode. */
const received = () =>
  page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere[shell]') || document.querySelector('devtools-anywhere');
    if (!el) return [];
    const frontend = el.shadowRoot?.querySelector('iframe')?.contentWindow;
    if (!frontend) throw new Error('no frontend frame');
    return frontend.received || [];
  });
/** The first argument of a Runtime.consoleAPICalled message. */
const firstArg = (m: ReceivedMessage) => {
  const arg = (m.params as Protocol.Runtime.ConsoleAPICalledEvent).args[0];
  assert.ok(arg);
  return arg.value;
};
const logged = (messages: ReceivedMessage[], text: string) =>
  messages.some(m => m.method === 'Runtime.consoleAPICalled' && firstArg(m) === text);

async function waitFor(predicate: () => unknown, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) return;
    } catch {
      // Navigation in progress.
    }
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

test('one script tag captures early output and mounts DevTools after load', async () => {
  await waitFor(async () => logged(await received(), 'zero-config early'));
  const open = await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    return devtools.open;
  });
  assert.equal(open, true);
});

test('in shell mode the Service Worker injects the probe into pages without it', async () => {
  await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    devtools.enterShell();
  });
  await waitFor(() => page.evaluate(() => !!document.querySelector('devtools-anywhere[shell]')));
  await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller));
  await page.evaluate(() => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    pageWindow.location.href = '/tests/e2e/no-probe.html';
  });
  await waitFor(async () => logged(await received(), 'no-probe early'));
});

test('the Service Worker adds headers to requests known from Resource Timing', async () => {
  const find = () =>
    page.evaluate(() => {
      const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
      if (!pageWindow) throw new Error('no page frame');
      const probe = pageWindow.__devtoolsAnywhereProbe__;
      return probe?.requests.find(r => r.url.includes('cross.css?n=sw'));
    });
  await waitFor(async () => (await find())?.responseHeaders?.['content-type']);
  const rec = await find();
  assert.ok(rec);
  assert.equal(rec.type, 'Stylesheet');
  assert.equal(rec.status, 200);
  assert.equal(rec.statusText, 'OK');
  const contentType = rec.responseHeaders?.['content-type'];
  assert.ok(contentType);
  assert.match(contentType, /text\/css/);
  assert.ok(Object.keys(rec.requestHeaders).length, 'request headers');
});

test('leaving shell mode unregisters the Service Worker', async () => {
  await page.evaluate(() => {
    const devtools = document.querySelector<DevtoolsAnywhereElement>('devtools-anywhere[shell]');
    if (!devtools) throw new Error('no <devtools-anywhere shell>');
    return devtools.exitShell();
  });
  await waitFor(() => page.evaluate(() => !document.getElementById('devtools-anywhere-page')));
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  assert.equal(registrations, 0);
});
