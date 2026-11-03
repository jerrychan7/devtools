// Cross-origin iframes linked to their parent's agent: the handshake, whom it trusts, and the
// link's life. The pages are on two sites of the one server, out of process (launchOopif):
// the parent on localhost, the child on 127.0.0.1 (or oopif.test).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { fixtureUrl, launchOopif, THIRD_HOST } from '../../test-support/oopif.ts';
import type { Env } from '../../../../tests/support/browser.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

/** The origin of a host of the test server. */
const originOf = (host: string) => {
  assert.ok(env);
  return new URL(fixtureUrl(env, '', host)).origin;
};

/**
 * Opens the parent page with `frameOrigins`, its iframe showing the child page on `childHost`
 * with `parentOrigins` (null for no attribute), and waits for both bundles. The parent records
 * its links in `__links`.
 */
async function open(
  frameOrigins: string | null,
  parentOrigins: string | null,
  childHost = '127.0.0.1'
): Promise<{ page: Page; child: Frame }> {
  assert.ok(env);
  const childUrl = new URL(fixtureUrl(env, 'frame-link-child.html', childHost));
  if (parentOrigins !== null) childUrl.searchParams.set('parentOrigins', parentOrigins);
  const parentUrl = new URL(fixtureUrl(env, 'frame-link-parent.html'));
  if (frameOrigins !== null) parentUrl.searchParams.set('frameOrigins', frameOrigins);
  parentUrl.searchParams.set('child', childUrl.href);
  const page = await env.browser.newPage();
  await page.goto(parentUrl.href);
  const child = await childFrame(page);
  await child.waitForFunction(() => 'DevtoolsAnywhere' in window);
  if (frameOrigins !== null) await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  if (frameOrigins !== null) await recordLinks(page);
  return { page, child };
}

/** The child page's frame, once loaded. */
async function childFrame(page: Page): Promise<Frame> {
  const frame = await page.waitForFrame(f => f.url().split('?')[0]?.endsWith('frame-link-child.html') === true);
  await frame.waitForFunction(() => document.readyState === 'complete');
  return frame;
}

/** Reloads the child page and returns its frame once the new document has its bundle. */
async function reloadChild(page: Page, child: Frame): Promise<Frame> {
  // Marks the old document, and reloads once the evaluation has returned.
  await child.evaluate(() => {
    window.__pageScriptRan = true;
    setTimeout(() => location.reload());
  });
  const start = Date.now();
  for (;;) {
    for (const frame of page.frames()) {
      if (!frame.url().split('?')[0]?.endsWith('frame-link-child.html')) continue;
      const fresh = await frame
        .evaluate(() => !window.__pageScriptRan && 'DevtoolsAnywhere' in window)
        .catch(() => false);
      if (fresh) return frame;
    }
    if (Date.now() - start > 5000) throw new Error('the child did not reload');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Has the parent record each link it gets in `__links`, and whether it has closed. */
async function recordLinks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const links: { frameId: string; closed: boolean }[] = (window.__links = []);
    const record = (link: { frameId: string; onClose(listener: () => void): unknown }) => {
      const entry = { frameId: link.frameId, closed: false };
      links.push(entry);
      link.onClose(() => (entry.closed = true));
    };
    for (const link of window.__devtoolsAnywhereTest.childTargets.children()) record(link);
    window.__devtoolsAnywhereTest.childTargets.onChild(record);
  });
}

/** The parent's links so far. */
const links = (page: Page) => page.evaluate(() => window.__links ?? []);

/** Waits for the parent's `count`th link. */
const waitForLink = (page: Page, count = 1) =>
  page.waitForFunction(count => (window.__links?.length ?? 0) >= count, { timeout: 5000, polling: 50 }, count);

/** Whether the child page is linked to its parent. */
const childLinked = (child: Frame) =>
  child.evaluate(() => window.__devtoolsAnywhereTest.childTargets.parent !== undefined);

/** Waits for the child page to be linked to its parent, or unlinked. */
const waitForChildLinked = (child: Frame, linked = true) =>
  child.waitForFunction(
    linked => (window.__devtoolsAnywhereTest.childTargets.parent !== undefined) === linked,
    { timeout: 5000, polling: 50 },
    linked
  );

/** Sends a CDP command over the parent's open link and returns its result. */
const command = (page: Page, method: string, params: object = {}) =>
  page.evaluate(
    (method, params) =>
      new Promise<unknown>((resolve, reject) => {
        const link = [...window.__devtoolsAnywhereTest.childTargets.children()][0];
        if (!link) return reject(new Error('no link'));
        const id = Math.floor(Math.random() * 1e9);
        const off = link.onMessage(message => {
          const reply: { id?: number; result?: unknown; error?: unknown } = JSON.parse(message);
          if (reply.id !== id) return;
          off();
          resolve(reply.result ?? reply.error);
        });
        link.send(JSON.stringify({ id, method, params }));
      }),
    method,
    params
  );

/** Gives a handshake that should not happen time to. */
const settle = () => new Promise(resolve => setTimeout(resolve, 800));

test('linked when each trusts the other: the parent runs Runtime.evaluate in the child', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    const [link] = await links(page);
    assert.match(link?.frameId ?? '', /\S/);
    await waitForChildLinked(child);
    // The child knows itself by the id the parent gave it, held in the parent's top frame.
    const ids = await child.evaluate(() => {
      const parent = window.__devtoolsAnywhereTest.childTargets.parent;
      return { frameId: parent?.frameId, parentFrameId: parent?.parentFrameId };
    });
    assert.equal(ids.frameId, link?.frameId);
    assert.match(ids.parentFrameId ?? '', /\S/);
    const result = await command(page, 'Runtime.evaluate', { expression: 'window.marker' });
    assert.deepEqual(result, { result: { type: 'string', value: `child of ${originOf('127.0.0.1')}` } });
  } finally {
    await page.close();
  }
});

test('a subdomain wildcard in the parent list links a child of that site', async () => {
  const port = new URL(originOf('localhost')).port;
  const { page, child } = await open(`http://*.test:${port}`, originOf('localhost'), THIRD_HOST);
  try {
    await waitForLink(page);
    await waitForChildLinked(child);
    const result = await command(page, 'Runtime.evaluate', { expression: 'location.hostname' });
    assert.deepEqual(result, { result: { type: 'string', value: THIRD_HOST } });
  } finally {
    await page.close();
  }
});

test('not linked when the parent does not trust the child origin', async () => {
  const { page, child } = await open(originOf(THIRD_HOST), originOf('localhost'));
  try {
    await settle();
    assert.deepEqual(await links(page), []);
    assert.equal(await childLinked(child), false);
  } finally {
    await page.close();
  }
});

test('not linked when the child does not trust the parent origin', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf(THIRD_HOST));
  try {
    await settle();
    assert.deepEqual(await links(page), []);
    assert.equal(await childLinked(child), false);
  } finally {
    await page.close();
  }
});

test('not linked when the child trusts no parent', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), null);
  try {
    await settle();
    assert.deepEqual(await links(page), []);
    assert.equal(await childLinked(child), false);
  } finally {
    await page.close();
  }
});

test('a hello from a window that is not an iframe of the page, or made up by a script, is not answered', async () => {
  assert.ok(env);
  // The iframe does not say hello itself: it trusts no parent.
  const { page } = await open(originOf('127.0.0.1'), null);
  try {
    const hello = { type: 'devtools-anywhere:frame-hello', id: 'forged' };
    // A popup of the trusted origin, which is no frame of the page.
    const popupUrl = fixtureUrl(env, 'frame-other.html', '127.0.0.1');
    const popupTarget = env.browser.waitForTarget(t => t.url() === popupUrl);
    await page.evaluate(url => void window.open(url), popupUrl);
    const popup = await (await popupTarget).page();
    assert.ok(popup);
    await popup.waitForFunction(() => document.readyState === 'complete');
    await popup.evaluate(hello => opener.postMessage(hello, '*'), hello);
    // An event a script made, as if from the iframe and of the trusted origin.
    await page.evaluate(
      (hello, origin) => {
        const iframe = document.querySelector('iframe');
        dispatchEvent(new MessageEvent('message', { data: hello, origin, source: iframe?.contentWindow ?? null }));
      },
      hello,
      originOf('127.0.0.1')
    );
    await settle();
    assert.deepEqual(await links(page), []);
    await popup.close();
  } finally {
    await page.close();
  }
});

test('the iframe reloaded links again, with the same frame id; the old link closes', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    await reloadChild(page, child);
    await waitForLink(page, 2);
    const [first, second] = await links(page);
    assert.equal(first?.closed, true);
    assert.equal(second?.closed, false);
    assert.equal(second?.frameId, first?.frameId);
    const result = await command(page, 'Runtime.evaluate', { expression: 'window.marker' });
    assert.deepEqual(result, { result: { type: 'string', value: `child of ${originOf('127.0.0.1')}` } });
  } finally {
    await page.close();
  }
});

test('removing the iframe closes its link, bye or not', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    // The page's bye on pagehide is not what the parent goes by.
    await child.evaluate(() => (MessagePort.prototype.postMessage = () => {}));
    await page.evaluate(() => document.getElementById('child')?.remove());
    await page.waitForFunction(() => window.__links?.[0]?.closed === true, { timeout: 5000, polling: 50 });
    assert.equal(await page.evaluate(() => [...window.__devtoolsAnywhereTest.childTargets.children()].length), 0);
  } finally {
    await page.close();
  }
});

test('either end closing the link closes the other', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    await waitForChildLinked(child);
    // The parent closes: the child hears its bye.
    await page.evaluate(() => [...window.__devtoolsAnywhereTest.childTargets.children()][0]?.close());
    await waitForChildLinked(child, false);
    // Linked again by a reload, then the child closes: the parent hears its bye.
    const reloaded = await reloadChild(page, child);
    await waitForLink(page, 2);
    await waitForChildLinked(reloaded);
    await reloaded.evaluate(() => window.__devtoolsAnywhereTest.childTargets.parent?.close());
    await page.waitForFunction(() => window.__links?.[1]?.closed === true, { timeout: 5000, polling: 50 });
  } finally {
    await page.close();
  }
});

test("stopping the links ends the targets kept for their iframe's next document too", async () => {
  // The probe links nothing; the test links with a stop function of its own.
  const { page, child } = await open(originOf(THIRD_HOST), originOf('localhost'));
  try {
    const gone = await page.evaluate(
      origin =>
        new Promise<number>((resolve, reject) => {
          const { childTargets } = window.__devtoolsAnywhereTest;
          const stop = window.DevtoolsAnywhere.linkFrames({ frameOrigins: origin });
          let ended = 0;
          childTargets.onGone(() => ended++);
          const timeout = setTimeout(() => reject(new Error('not linked')), 5000);
          childTargets.onChild(link => {
            clearTimeout(timeout);
            // Closed with its element still there: kept for the iframe's next document.
            link.close();
            stop();
            resolve(ended);
          });
        }),
      originOf('127.0.0.1')
    );
    assert.equal(gone, 1);
    await waitForChildLinked(child, false);
  } finally {
    await page.close();
  }
});

/** Whether the child page shows its F12 button: its global element's, hidden or not with it. */
const f12Shown = (child: Frame) =>
  child.evaluate(() => {
    const button = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return button instanceof HTMLElement && button.checkVisibility();
  });

/** Waits for the child page to show its F12 button, or hide it. */
const waitForF12 = (child: Frame, shown: boolean) =>
  child.waitForFunction(
    shown => {
      const button = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
      return button instanceof HTMLElement && button.checkVisibility() === shown;
    },
    { timeout: 5000, polling: 50 },
    shown
  );

test("the iframe's own F12 button is hidden while linked, and back once the link closes", async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForChildLinked(child);
    await waitForF12(child, false);
    await page.evaluate(() => [...window.__devtoolsAnywhereTest.childTargets.children()][0]?.close());
    await waitForF12(child, true);
  } finally {
    await page.close();
  }
});

test('an iframe that trusts no parent keeps its F12 button', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), null);
  try {
    await waitForF12(child, true);
    await settle();
    assert.equal(await f12Shown(child), true);
  } finally {
    await page.close();
  }
});

/** Waits for the parent's `index`th link to close. */
const waitForClosed = (page: Page, index: number) =>
  page.waitForFunction(index => window.__links?.[index]?.closed === true, { timeout: 5000, polling: 50 }, index);

/** How many links the parent has open. */
const openLinks = (page: Page) =>
  page.evaluate(() => [...window.__devtoolsAnywhereTest.childTargets.children()].length);

test('moving the iframe closes its link; the document it loads there links again', async () => {
  const { page } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    // Moved, the iframe loads its document again, in another window.
    await page.evaluate(() => {
      const iframe = document.getElementById('child');
      if (iframe) document.body.prepend(iframe);
    });
    await waitForClosed(page, 0);
    await waitForLink(page, 2);
    assert.equal((await links(page))[1]?.closed, false);
    assert.equal(await openLinks(page), 1);
  } finally {
    await page.close();
  }
});

test("removing the shadow host an iframe is in closes the iframe's link", async () => {
  const { page } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'host';
      document.body.append(host);
      const iframe = document.getElementById('child');
      if (iframe) host.attachShadow({ mode: 'open' }).append(iframe);
    });
    // Its document linked again from the shadow tree.
    await waitForClosed(page, 0);
    await waitForLink(page, 2);
    await page.evaluate(() => document.getElementById('host')?.remove());
    await waitForClosed(page, 1);
    assert.equal(await openLinks(page), 0);
  } finally {
    await page.close();
  }
});

// Puppeteer turns the back/forward cache off, so these play the events a page restored from it
// gets: pagehide as it is left, then pageshow with persisted.
const backForward = () => {
  dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
};

test('the parent back from the back/forward cache links its iframe again', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    await waitForChildLinked(child);
    await page.evaluate(backForward);
    await waitForClosed(page, 0);
    await waitForLink(page, 2);
    const [first, second] = await links(page);
    assert.equal(second?.closed, false);
    assert.equal(second?.frameId, first?.frameId);
    const result = await command(page, 'Runtime.evaluate', { expression: 'window.marker' });
    assert.deepEqual(result, { result: { type: 'string', value: `child of ${originOf('127.0.0.1')}` } });
  } finally {
    await page.close();
  }
});

test('the iframe back from the back/forward cache links again, as another document', async () => {
  const { page, child } = await open(originOf('127.0.0.1'), originOf('localhost'));
  try {
    await waitForLink(page);
    await waitForChildLinked(child);
    await child.evaluate(backForward);
    await waitForClosed(page, 0);
    await waitForLink(page, 2);
    await waitForChildLinked(child);
    assert.equal((await links(page))[1]?.closed, false);
    const result = await command(page, 'Runtime.evaluate', { expression: 'window.marker' });
    assert.deepEqual(result, { result: { type: 'string', value: `child of ${originOf('127.0.0.1')}` } });
  } finally {
    await page.close();
  }
});

test('a sandboxed iframe (no allow-same-origin) loads the probe without errors, and is not linked: Chrome gives it no target', async () => {
  // Its origin is opaque ("null"), which no list names. Chrome keeps such a frame in the page's
  // own target: no attachedToTarget.
  const origin = originOf('localhost');
  const { page } = await open(origin, null);
  // The probe loads there without an error: reads that throw in an opaque origin are guarded.
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url?.endsWith('/favicon.ico')) errors.push(message.text());
  });
  const session = await page.createCDPSession();
  // Only targets of the sandboxed iframe: the page's own iframe, on another site, has one.
  const attached: string[] = [];
  session.on('Target.attachedToTarget', event => {
    if (event.targetInfo.url.includes('n=sandboxed')) attached.push(event.targetInfo.url);
  });
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  try {
    assert.ok(env);
    const childUrl = new URL(fixtureUrl(env, 'frame-link-child.html'));
    childUrl.searchParams.set('parentOrigins', `${origin} null`);
    childUrl.searchParams.set('n', 'sandboxed');
    await page.evaluate(
      src =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { id: 'sandboxed', src, onload: resolve });
          frame.setAttribute('sandbox', 'allow-scripts');
          document.body.append(frame);
        }),
      childUrl.href
    );
    await settle();
    assert.deepEqual(await links(page), []);
    assert.deepEqual(attached, []);
    const sandboxed = page.frames().find(f => f.url().includes('n=sandboxed'));
    assert.equal(await sandboxed?.evaluate(() => 'DevtoolsAnywhere' in window), true);
    // Its own panel opens too.
    await sandboxed?.evaluate(() => {
      // setOpen is private to the element's class; call it as the shell's toggle would.
      const el = document.querySelector('devtools-anywhere');
      const setOpen: unknown = el && Reflect.get(el, 'setOpen');
      if (typeof setOpen === 'function') setOpen.call(el, true);
    });
    await page.waitForFrame(f => f.url().includes('fake-frontend.html'), { timeout: 5000 });
    await settle();
    assert.deepEqual(errors, []);
  } finally {
    await session.detach();
    await page.close();
  }
});

/**
 * Opens the parent page trusting `frameOrigins`, its iframe sandboxed (allow-scripts, no
 * allow-same-origin) showing sandboxed-child.html on `childHost`, which trusts the parent; returns
 * once both bundles are there.
 */
async function openSandboxed(frameOrigins: string, childHost = 'localhost'): Promise<{ page: Page; child: Frame }> {
  assert.ok(env);
  const childUrl = new URL(fixtureUrl(env, 'sandboxed-child.html', childHost));
  childUrl.searchParams.set('parentOrigins', originOf('localhost'));
  const parentUrl = new URL(fixtureUrl(env, 'frame-link-parent.html'));
  parentUrl.searchParams.set('frameOrigins', frameOrigins);
  parentUrl.searchParams.set('sandbox', 'allow-scripts');
  parentUrl.searchParams.set('child', childUrl.href);
  const page = await env.browser.newPage();
  await page.goto(parentUrl.href);
  const child = await page.waitForFrame(f => f.url().split('?')[0]?.endsWith('sandboxed-child.html') === true);
  await child.waitForFunction(() => 'DevtoolsAnywhere' in window);
  await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  return { page, child };
}

/** The parent's merged frames: their namespaces and frame ids. */
const mergedOf = (page: Page) =>
  page.evaluate(() =>
    [...window.__devtoolsAnywhereTest.mergedFrames.frames()].map(([ns, link]) => ({ ns, frameId: link.frameId }))
  );

test('a sandboxed iframe of the page origin is merged when data-frame-origins names sandboxed', async () => {
  const { page, child } = await openSandboxed(`${originOf('127.0.0.1')} sandboxed`);
  try {
    await page.waitForFunction(() => [...window.__devtoolsAnywhereTest.mergedFrames.frames()].length > 0, {
      timeout: 5000,
      polling: 50,
    });
    const [merged] = await mergedOf(page);
    assert.equal(merged?.ns, 1);
    // No child target: merged into the page's.
    assert.equal(await page.evaluate(() => [...window.__devtoolsAnywhereTest.childTargets.children()].length), 0);
    await child.waitForFunction(() => window.__devtoolsAnywhereTest.childTargets.parentMerged, {
      timeout: 5000,
      polling: 50,
    });
    // Its frame id is the one the parent gave its element; its ids are in the namespace.
    const own = await child.evaluate(() => window.__devtoolsAnywhereTest.childTargets.parent?.frameId);
    assert.equal(own, merged?.frameId);
    const result = await page.evaluate(
      () =>
        new Promise<unknown>((resolve, reject) => {
          const [, link] = [...window.__devtoolsAnywhereTest.mergedFrames.frames()][0] ?? [];
          if (!link) return reject(new Error('no link'));
          const off = link.onMessage(message => {
            const reply: { id?: number; result?: unknown } = JSON.parse(message);
            if (reply.id !== 7) return;
            off();
            resolve(reply.result);
          });
          link.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: 'window.marker' } }));
        })
    );
    assert.deepEqual(result, { result: { type: 'string', value: 'sandboxed child of null' } });
  } finally {
    await page.close();
  }
});

test('a sandboxed iframe is not merged unless data-frame-origins names sandboxed', async () => {
  const { page, child } = await openSandboxed(originOf('127.0.0.1'));
  try {
    await settle();
    assert.deepEqual(await mergedOf(page), []);
    assert.equal(await childLinked(child), false);
  } finally {
    await page.close();
  }
});

test('a sandboxed iframe of another site is not merged: Chrome gives it a target of its own', async () => {
  const { page, child } = await openSandboxed('sandboxed', '127.0.0.1');
  try {
    await settle();
    assert.deepEqual(await mergedOf(page), []);
    assert.equal(await childLinked(child), false);
  } finally {
    await page.close();
  }
});
