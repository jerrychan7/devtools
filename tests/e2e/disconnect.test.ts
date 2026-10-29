// Removing <devtools-anywhere> undoes what its frontend did to the page, and attaching it again
// connects a new frontend as before.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/tests/e2e/pages/zero-config.html');
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<style>#target:hover { color: rgb(255, 0, 0); }</style><button id="target">target</button>'
    );
    window.__clicks = 0;
    document.getElementById('target')?.addEventListener('click', () => (window.__clicks = (window.__clicks ?? 0) + 1));
  });
});
after(() => env?.close());

/** The fake frontend in the panel's iframe, once it is loaded. */
const frontend = () =>
  page.waitForFrame(frame => frame.parentFrame() === page.mainFrame() && frame.url().includes('fake-frontend'));

let nextId = 100;
/** Sends a CDP request from the frontend and waits for its result. */
async function call(frame: Frame, method: string, params: object = {}): Promise<unknown> {
  const id = nextId++;
  return frame.evaluate(
    (id, method, params) =>
      new Promise((resolve, reject) => {
        const onMessage = (e: MessageEvent) => {
          const message = JSON.parse(e.data);
          if (message.id !== id) return;
          removeEventListener('message', onMessage);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        };
        addEventListener('message', onMessage);
        parent.postMessage(JSON.stringify({ id, method, params }), '*');
      }),
    id,
    method,
    params
  );
}

const clickTarget = async () => {
  const before = await page.evaluate(() => window.__clicks ?? 0);
  await page.click('#target');
  return (await page.evaluate(() => window.__clicks ?? 0)) - before;
};
const targetColor = () =>
  page.evaluate(() => {
    const target = document.getElementById('target');
    return target ? getComputedStyle(target).color : '';
  });

test('removed in inspect mode, the element gives the page its clicks and styles back', async () => {
  const frame = await frontend();
  await call(frame, 'DOM.enable');
  await call(frame, 'CSS.enable');
  const doc = await call(frame, 'DOM.getDocument');
  const root = typeof doc === 'object' && doc && 'root' in doc ? doc.root : null;
  const rootId = typeof root === 'object' && root && 'nodeId' in root ? root.nodeId : 0;
  const found = await call(frame, 'DOM.querySelector', { nodeId: rootId, selector: '#target' });
  const nodeId = typeof found === 'object' && found && 'nodeId' in found ? found.nodeId : 0;
  await call(frame, 'CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  await call(frame, 'Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
  assert.equal(await clickTarget(), 0, 'inspect mode takes the click');
  assert.equal(await targetColor(), 'rgb(255, 0, 0)', 'forced :hover');

  await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    window.__devtools = devtools;
    devtools.remove();
  });
  assert.equal(await clickTarget(), 1, 'the page gets the click');
  await page.mouse.move(0, 0);
  assert.notEqual(await targetColor(), 'rgb(255, 0, 0)', 'no forced :hover');
});

test('attached again after several removals, a new frontend connects and works', async () => {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const devtools = window.__devtools;
      if (!devtools) throw new Error('no <devtools-anywhere>');
      document.documentElement.append(devtools);
      devtools.remove();
    });
  }
  await page.evaluate(() => {
    if (window.__devtools) document.documentElement.append(window.__devtools);
  });
  const frame = await frontend();
  const result = await call(frame, 'Runtime.evaluate', { expression: '__clicks', returnByValue: true });
  assert.deepEqual(result, { result: { type: 'number', value: 1, description: '1' } });
  // Captured before the removals, still there for the new frontend.
  const replayed = await frame.evaluate(() =>
    (window.received ?? []).some(
      m => m.method === 'Runtime.consoleAPICalled' && JSON.stringify(m.params).includes('zero-config early')
    )
  );
  assert.ok(replayed);
  await call(frame, 'Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
  assert.equal(await clickTarget(), 0, 'inspect mode works again');
  await call(frame, 'Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
  assert.equal(await clickTarget(), 1);
});
