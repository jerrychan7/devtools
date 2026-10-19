// Shell mode in real Chrome, with a fake frontend that records what it receives.
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
  await page.goto(env.baseUrl + '/tests/e2e/shell-page.html?first');
});
after(() => env?.close());

const shellState = () =>
  page.evaluate(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    const devtools = document.querySelector('devtools-anywhere[shell]');
    const frontendFrame = devtools?.shadowRoot?.querySelector('iframe');
    if (devtools && !frontendFrame?.contentWindow) throw new Error('no frontend frame');
    const frontend = frontendFrame?.contentWindow;
    const pageWindow = frame instanceof HTMLIFrameElement ? frame.contentWindow : null;
    if (frame && !pageWindow) throw new Error('no page window');
    return {
      inShell: !!frame && !!devtools,
      shellRanPageScript: !!window.__pageScriptRan,
      pageRanScript: !!pageWindow?.__pageScriptRan,
      url: location.href,
      received: frontend?.received || [],
    };
  });

type ShellState = Awaited<ReturnType<typeof shellState>>;

async function waitFor(predicate: (state: ShellState) => boolean, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    let state: ShellState | undefined;
    try {
      state = await shellState();
      if (predicate(state)) return state;
    } catch {
      // Navigation in progress.
    }
    if (Date.now() - start > timeout) throw new Error('timed out: ' + JSON.stringify(state));
    await new Promise(r => setTimeout(r, 50));
  }
}

/** The first argument of a Runtime.consoleAPICalled message. */
const firstArg = (m: ReceivedMessage) => {
  const arg = (m.params as Protocol.Runtime.ConsoleAPICalledEvent).args[0];
  assert.ok(arg);
  return arg.value;
};
const earlyLogs = (state: ShellState) =>
  state.received.filter(m => m.method === 'Runtime.consoleAPICalled' && firstArg(m) === 'early');

test('entering shell mode turns the page into the shell in place', async () => {
  await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    devtools.enterShell();
  });
  const state = await waitFor(s => s.inShell && earlyLogs(s).length > 0);
  assert.equal(state.shellRanPageScript, false, "the page's scripts do not run in the shell");
  assert.equal(state.pageRanScript, true, 'the page runs inside the iframe');
  assert.match(state.url, /shell-page\.html\?first$/, 'the address bar keeps the page URL');
});

test('DevTools survives a page reload and gets the new page output', async () => {
  await page.evaluate(() => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    pageWindow.location.reload();
  });
  const state = await waitFor(s => earlyLogs(s).length >= 2);
  assert.ok(state.received.some(m => m.method === 'Runtime.executionContextsCleared'));
  assert.ok(state.received.some(m => m.method === 'Page.frameNavigated'));
});

test('navigation inside the page updates the address bar', async () => {
  await page.evaluate(() => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    pageWindow.location.href = '/tests/e2e/shell-page.html?second';
  });
  const state = await waitFor(s => s.url.endsWith('?second'));
  assert.ok(earlyLogs(state).length >= 3);
});

test('closing leaves shell mode', async () => {
  await page.evaluate(() => {
    const close = document.querySelector('devtools-anywhere[shell]')?.shadowRoot?.querySelector<HTMLElement>('.close');
    if (!close) throw new Error('no close button');
    close.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  const state = await page.evaluate(() => ({
    inShell: !!document.getElementById('devtools-anywhere-page'),
    ran: !!window.__pageScriptRan,
    url: location.href,
  }));
  assert.equal(state.inShell, false);
  assert.equal(state.ran, true);
  assert.match(state.url, /\?second$/);
});
