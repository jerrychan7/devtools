// Several CDP sessions on one page, as several clients of Chrome: each keeps its own bodies,
// forces its own pseudo-classes, and leaves nothing installed behind per session.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { CDP_BUNDLE, launch, type Env } from '../../test-support/conformance.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await page.addScriptTag({ path: CDP_BUNDLE });
  await page.evaluate(() => {
    window.__sessions = [window.DevtoolsAnywhere.createCdpSession(), window.DevtoolsAnywhere.createCdpSession()];
  });
});
after(() => env?.close());

/** Calls `method` in session `index`; an error comes back as its message. */
const call = (index: number, method: string, params: object = {}) =>
  page.evaluate(
    (index, method, params) => {
      const session = window.__sessions?.[index];
      if (!session) throw new Error(`no session ${index}`);
      return session.call(method, params).catch((e: unknown) => String(e instanceof Error ? e.message : e));
    },
    index,
    method,
    params
  );

/** Fetches `url` in the page and returns the probe's request id for it. */
async function fetchId(url: string): Promise<string> {
  await page.evaluate(url => fetch(url).then(r => r.text()), url);
  return page
    .waitForFunction(
      url => window.__devtoolsAnywhereProbe__?.requests.find(r => r.url.endsWith(url) && r.state === 'done')?.requestId,
      {},
      url
    )
    .then(handle => handle.jsonValue() as Promise<string>);
}

const bodyLength = async (index: number, requestId: string) => {
  const result = await call(index, 'Network.getResponseBody', { requestId });
  return typeof result === 'object' && result && 'body' in result && typeof result.body === 'string'
    ? result.body.length
    : result;
};

test("each session keeps bodies within its own buffer sizes, not the other's", async () => {
  await call(0, 'Network.enable', { maxTotalBufferSize: 3000, maxResourceBufferSize: 2500 });
  await call(1, 'Network.enable', {});
  const big = await fetchId('/api/echo?n=multi-big&pad=' + 'x'.repeat(3000));
  const first = await fetchId('/api/echo?n=multi-first&pad=' + 'x'.repeat(2000));
  const second = await fetchId('/api/echo?n=multi-second&pad=' + 'x'.repeat(2000));
  const evicted = 'Request content was evicted from inspector cache';
  assert.equal(await bodyLength(0, big), evicted, 'over its resource size');
  assert.equal(await bodyLength(0, first), evicted, 'past its total');
  assert.equal(typeof (await bodyLength(0, second)), 'number');
  for (const id of [big, first, second]) assert.equal(typeof (await bodyLength(1, id)), 'number', id);
  await call(0, 'Network.disable');
  await call(1, 'Network.disable');
});

const color = () =>
  page.evaluate(() => {
    const el = document.getElementById('forced');
    return el ? getComputedStyle(el).color : '';
  });

test('a pseudo-class two sessions force stays forced until both take it back', async () => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<style>#forced:hover { color: rgb(255, 0, 0); } #forced:focus { color: rgb(0, 0, 255); }</style><a id="forced">x</a>'
    );
  });
  const force = async (index: number, classes: string[]) => {
    await call(index, 'DOM.enable');
    await call(index, 'CSS.enable');
    const doc = await call(index, 'DOM.getDocument');
    const root = typeof doc === 'object' && doc && 'root' in doc ? doc.root : null;
    const nodeId = typeof root === 'object' && root && 'nodeId' in root ? root.nodeId : 0;
    const found = await call(index, 'DOM.querySelector', { nodeId, selector: '#forced' });
    const id = typeof found === 'object' && found && 'nodeId' in found ? found.nodeId : 0;
    await call(index, 'CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: classes });
  };
  await force(0, ['hover']);
  await force(1, ['hover', 'focus']);
  assert.equal(await color(), 'rgb(0, 0, 255)', 'both states');
  await call(1, 'CSS.disable');
  assert.equal(await color(), 'rgb(255, 0, 0)', "the first session's :hover stays");
  await force(1, ['focus']);
  await call(0, 'CSS.disable');
  assert.equal(await color(), 'rgb(0, 0, 255)', "the second session's :focus stays");
  await call(1, 'CSS.disable');
  assert.equal(await color(), 'rgb(0, 0, 0)');
  // The page sees its own adopted sheets only, whichever session went first.
  assert.equal(await page.evaluate(() => Object.hasOwn(document, 'adoptedStyleSheets')), false);
});

test('new sessions do not stack listeners or patches on the page', async () => {
  await call(0, 'DOMStorage.enable');
  const result = await page.evaluate(async () => {
    const probe = window.__devtoolsAnywhereProbe__;
    if (!probe) throw new Error('no probe');
    // Counts the probe's request listeners from now on.
    let listening = 0;
    const onRequest = probe.onRequest;
    probe.onRequest = listener => {
      listening++;
      const off = onRequest(listener);
      return () => {
        listening--;
        off();
      };
    };
    const setItem = Storage.prototype.setItem;
    let added = 0;
    try {
      for (let i = 0; i < 5; i++) {
        const session = window.DevtoolsAnywhere.createCdpSession();
        session.onMessage(m => {
          if (m.includes('domStorageItemAdded')) added++;
        });
        await session.call('DOMStorage.enable');
        await session.call('Network.enable');
        // Runtime watches the page's scripts from its first lookup of the global lexical names.
        await session.call('Runtime.globalLexicalScopeNames');
        await session.call('DOMStorage.disable');
        await session.call('Network.disable');
        session.reset();
      }
    } finally {
      probe.onRequest = onRequest;
    }
    localStorage.setItem('multi-session', '1');
    localStorage.removeItem('multi-session');
    return { listening, samePatch: Storage.prototype.setItem === setItem, added };
  });
  assert.deepEqual(result, { listening: 0, samePatch: true, added: 0 });
  await call(0, 'DOMStorage.disable');
});

test("in inspect mode, a hovered node is one session's only, and the page does not see the move", async () => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="hover-a" style="position:fixed;left:0;top:0;width:100px;height:100px">a</div>' +
        '<div id="hover-b" style="position:fixed;left:200px;top:0;width:100px;height:100px">b</div>'
    );
    const counts = { first: 0, second: 0, page: 0 };
    window.__hoverEvents = counts;
    window.__sessions?.forEach((session, index) =>
      session.onMessage(m => {
        if (m.includes('Overlay.nodeHighlightRequested')) counts[index ? 'second' : 'first']++;
      })
    );
    for (const type of ['mousemove', 'mouseover', 'pointermove']) document.addEventListener(type, () => counts.page++);
  });
  for (const index of [0, 1]) {
    await call(index, 'DOM.getDocument');
    await call(index, 'Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {} });
  }
  const hover = async (x: number) => {
    await page.mouse.move(x, 50, { steps: 3 });
    await new Promise(r => setTimeout(r, 100));
    const counts = await page.evaluate(() => window.__hoverEvents);
    assert.ok(counts);
    return { ...counts };
  };
  const first = await hover(50);
  assert.ok(first.first > 0);
  assert.deepEqual({ second: first.second, page: first.page }, { second: 0, page: 0 });
  // The first session leaves inspect mode: the other takes over.
  await call(0, 'Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
  const second = await hover(250);
  assert.ok(second.second > 0);
  assert.deepEqual({ first: second.first, page: second.page }, { first: first.first, page: 0 });
  await call(1, 'Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
  assert.ok((await hover(50)).page > 0, 'the page sees moves again');
});
