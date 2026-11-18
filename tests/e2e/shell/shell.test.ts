// Shell mode in real Chrome, with a fake frontend that records what it receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import type { Protocol } from 'devtools-protocol';
import { devtoolsShown, frontendRequest, launch, setUpAndTearDown } from '../../support/browser.ts';
import type { Env } from '../../support/browser.ts';

let env: Env | undefined;
let page: Page;

setUpAndTearDown(
  async () => {
    env = await launch();
    page = await env.browser.newPage();
    await page.goto(env.baseUrl + '/tests/e2e/pages/shell-page.html?first');
  },
  () => env?.close()
);

const shellState = () =>
  page.evaluate(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    const devtools = document.querySelector('devtools-anywhere[data-shell]');
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
  // DevTools' lock button.
  await frontendRequest(page, { type: 'keep-open', keep: true });
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
  assert.ok(state.received.some(m => m.method === 'DOM.documentUpdated'));
  // The shell re-sends the frontend's enables to the new page; their answers stay in the shell.
  assert.ok(!state.received.some(m => JSON.stringify(m).includes('"id":"relay-')));
  assert.equal(state.received.filter(m => m.id === 1).length, 1, 'Runtime.enable is answered once');
});

test('navigation inside the page updates the address bar', async () => {
  await page.evaluate(() => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    pageWindow.location.href = '/tests/e2e/pages/shell-page.html?second';
  });
  // The address bar can update before the new page's output arrives, so wait for both.
  await waitFor(s => s.url.endsWith('?second') && earlyLogs(s).length >= 3);
});

/** The fake frontend's frame in the shell. */
const frontendFrame = () => {
  const frame = page.frames().find(f => f.parentFrame() === page.mainFrame() && f.url().includes('fake-frontend'));
  assert.ok(frame, 'the DevTools frame');
  return frame;
};

/** Posts a command from the frontend's window. */
const fromFrontend = (message: object) =>
  frontendFrame().evaluate(json => parent.postMessage(json, '*'), JSON.stringify(message));

test("a reloaded frontend is a new session in shell mode too: the previous instance's objects are gone", async () => {
  await fromFrontend({ id: 300, method: 'Runtime.evaluate', params: { expression: '({ a: 1 })' } });
  const evaluated = (await waitFor(s => s.received.some(m => m.id === 300))).received.find(m => m.id === 300);
  const objectId = (evaluated?.result as Protocol.Runtime.EvaluateResponse | undefined)?.result.objectId;
  assert.ok(objectId);
  // Until the new instance sets its own, waitFor sees nothing: not the old instance's messages.
  await frontendFrame().evaluate(() => {
    delete window.received;
    location.reload();
  });
  // The new instance's Runtime.enable is answered, and replays the page's output.
  await waitFor(s => s.received.some(m => m.id === 1) && earlyLogs(s).length > 0);
  await fromFrontend({ id: 301, method: 'Runtime.getProperties', params: { objectId, ownProperties: true } });
  const answer = (await waitFor(s => s.received.some(m => m.id === 301))).received.find(m => m.id === 301);
  assert.ok(answer && 'error' in answer, JSON.stringify(answer));
});

test("closing (DevTools' own close button) hides DevTools; stopping keeping it open leaves shell mode", async () => {
  // What the frontend sends when its toolbar's close button is clicked.
  const devtools = page.frames().find(f => f.parentFrame() === page.mainFrame() && f.url().includes('fake-frontend'));
  assert.ok(devtools, 'the DevTools frame');
  await devtools.evaluate(() => parent.postMessage({ devtoolsAnywhere: { type: 'close' } }, '*'));
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display === 'none';
  });
  assert.equal(await devtoolsShown(page), false);
  await devtools.waitForFunction(() => (window.notices ?? []).length > 0);
  assert.deepEqual(await devtools.evaluate(() => window.notices), [{ devtoolsAnywhere: { type: 'hidden' } }]);
  // Still in the shell, whose address bar follows the page shown.
  assert.match((await waitFor(s => s.inShell)).url, /\?second$/);
  // Its info bar's "Stop keeping open": the user turns shell mode off, which is remembered.
  await devtools.evaluate(() => parent.postMessage({ devtoolsAnywhere: { type: 'keep-open', keep: false } }, '*'));
  const state = await waitFor(s => !s.inShell && s.shellRanPageScript);
  assert.match(state.url, /\?second$/);
  assert.equal(await page.evaluate(() => localStorage.getItem('devtools-anywhere:shell-mode')), 'off');
});

test('a shell config pointing to another origin is removed and ignored', async () => {
  const requested: string[] = [];
  page.on('request', r => requested.push(r.url()));
  await page.evaluate(() => {
    sessionStorage.setItem(
      'devtools-anywhere:shell',
      JSON.stringify({ frontend: location.origin + '/x.html', bundle: 'https://evil.invalid/bundle.js' })
    );
  });
  await page.reload();
  const state = await waitFor(s => s.shellRanPageScript);
  assert.equal(state.inShell, false);
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell')),
    null,
    'the key is removed'
  );
  assert.ok(!requested.some(url => url.includes('evil.invalid')), 'the bundle is not loaded');
});
