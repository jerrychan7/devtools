// The change listeners of a MediaQueryList that the browser removes by itself (probe/media.ts): one added with
// `once`, once it has run, and one added with a signal, once that is aborted, or not added at all with a signal
// aborted already. The probe counts a list's listeners to keep its own off a list that has none, so these are
// uncounted as the browser removes them: the events are Chrome's, and a list left without listeners is collected.
// Chrome's side is a page without the bundle, emulated by Chrome: the probe's hooks are in every page that has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../test-support/conformance.ts';
import type { Env } from '../../../test-support/conformance.ts';

declare global {
  interface Window {
    /** What the listeners of the lists the test made got: the label of each, in the order they ran. */
    __mqlGot: string[];
    /** Aborts the signals of the lists labelled `signal` and `abortStopped`. */
    __mqlAbort(): void;
    /** Weak references to the lists the test made, by label. */
    __mqlRefs: Record<string, WeakRef<MediaQueryList>>;
  }
}

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

const NONE = { media: '', features: [] };
const QUERY = '(prefers-color-scheme: dark)';

/** Two frames and a short settle: the rendering step that reports media changes has run by then. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))
  );

/**
 * Makes one list per way a listener goes by itself, and a plain one, none of them held by the page: `once`
 * (with a plain listener added after it on the same list, in `onceThenPlain`), `signal` (aborted by
 * `__mqlAbort`), `abortStopped` (the same, with a listener of the page's that stops the abort event before the
 * probe's own listeners of the signal), `aborted` (a signal aborted before the listener is added), `stopped` (a `once` listener
 * that stops the event for those after it) and `plain`.
 */
function makeLists(query: string): void {
  const got: string[] = [];
  window.__mqlGot = got;
  window.__mqlRefs = {};
  const make = (label: string) => {
    const mql = matchMedia(query);
    window.__mqlRefs[label] = new WeakRef(mql);
    return mql;
  };
  const tell = (label: string) => () => void got.push(label);
  make('once').addEventListener('change', tell('once'), { once: true });
  const both = make('onceThenPlain');
  both.addEventListener('change', tell('onceThenPlain: once'), { once: true, capture: true });
  both.addEventListener('change', tell('onceThenPlain: plain'));
  const controller = new AbortController();
  make('signal').addEventListener('change', tell('signal'), { signal: controller.signal });
  // The page's own listener of this signal comes first, and stops the abort event for the listeners after it.
  const stopper = new AbortController();
  stopper.signal.addEventListener('abort', e => e.stopImmediatePropagation());
  make('abortStopped').addEventListener('change', tell('abortStopped'), { signal: stopper.signal });
  window.__mqlAbort = () => {
    controller.abort();
    stopper.abort();
  };
  make('aborted').addEventListener('change', tell('aborted'), { signal: AbortSignal.abort() });
  make('stopped').addEventListener(
    'change',
    e => {
      got.push('stopped');
      e.stopImmediatePropagation();
    },
    { once: true }
  );
  make('plain').addEventListener('change', tell('plain'));
}

/** Which of the lists are alive after a garbage collection, by label. */
async function alive(page: Page): Promise<Record<string, boolean>> {
  const cdp = await page.createCDPSession();
  try {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  } finally {
    await cdp.detach();
  }
  return page.evaluate(() =>
    Object.fromEntries(Object.entries(window.__mqlRefs).map(([label, ref]) => [label, ref.deref() !== undefined]))
  );
}

/** Sets the emulated media of a page: through Chrome's CDP, or through ours. */
type Emulate = (params: Protocol.Emulation.SetEmulatedMediaRequest) => Promise<unknown>;

/** The events and the lists alive in `page`, as `emulate` flips the emulated scheme three times, aborting before the last. */
async function run(page: Page, emulate: Emulate) {
  const dark = await page.evaluate(query => matchMedia(query).matches, QUERY);
  const flip = (to: boolean) => emulate({ features: [{ name: 'prefers-color-scheme', value: to ? 'dark' : 'light' }] });
  await page.evaluate(makeLists, QUERY);
  const taken = () => page.evaluate(() => window.__mqlGot.splice(0).sort());
  try {
    const before = await alive(page);
    await flip(!dark);
    await settle(page);
    const first = await taken();
    await flip(dark);
    await settle(page);
    const second = await taken();
    await page.evaluate(() => window.__mqlAbort());
    await flip(!dark);
    await settle(page);
    const third = await taken();
    return { before, first, second, third, after: await alive(page) };
  } finally {
    await emulate(NONE);
    await settle(page);
  }
}

test('change listeners the browser removes by itself get the events Chrome gives, and leave their list to be collected', async () => {
  assert.ok(env);
  const launched = env;
  // A page for each side, one after the other: a page behind another runs no frames.
  const plain = await launched.browser.newPage();
  let chrome: Awaited<ReturnType<typeof run>>;
  try {
    await plain.goto(launched.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
    const cdp = await plain.createCDPSession();
    chrome = await run(plain, params => cdp.send('Emulation.setEmulatedMedia', params));
  } finally {
    await plain.close();
  }
  const t = await openPage(launched, []);
  try {
    const ours = await run(t.page, params => t.ours.send('Emulation.setEmulatedMedia', params));
    assert.deepEqual(chrome.first, [
      'abortStopped',
      'once',
      'onceThenPlain: once',
      'onceThenPlain: plain',
      'plain',
      'signal',
      'stopped',
    ]);
    assert.deepEqual(chrome.second, ['abortStopped', 'onceThenPlain: plain', 'plain', 'signal']);
    assert.deepEqual(chrome.third, ['onceThenPlain: plain', 'plain']);
    // A list with a listener stays; one whose listeners the browser removed, or never added, goes.
    assert.deepEqual(chrome.before, {
      once: true,
      onceThenPlain: true,
      signal: true,
      abortStopped: true,
      aborted: false,
      stopped: true,
      plain: true,
    });
    assert.deepEqual(chrome.after, {
      once: false,
      onceThenPlain: true,
      signal: false,
      abortStopped: false,
      aborted: false,
      stopped: false,
      plain: true,
    });
    assert.deepEqual(ours, chrome);
  } finally {
    await t.page.close();
  }
});

/**
 * A list whose listener the page adds again from its own listener of the signal's abort event, where the browser
 * has removed it already: what the listener got as the emulated scheme flips after the abort, and whether a list
 * nobody holds is alive (its listener keeps it).
 */
async function readded(page: Page, emulate: Emulate) {
  const dark = await page.evaluate(query => matchMedia(query).matches, QUERY);
  await page.evaluate(query => {
    const got: string[] = [];
    window.__mqlGot = got;
    for (const stops of [false, true]) {
      const mql = matchMedia(query);
      const label = stops ? 'stopped' : 'plain';
      window.__mqlRefs = { ...window.__mqlRefs, [label]: new WeakRef(mql) };
      const controller = new AbortController();
      const again = () => void got.push(label);
      mql.addEventListener('change', again, { signal: controller.signal });
      controller.signal.addEventListener('abort', e => {
        if (stops) e.stopImmediatePropagation();
        mql.addEventListener('change', again);
      });
      controller.abort();
    }
  }, QUERY);
  try {
    await emulate({ features: [{ name: 'prefers-color-scheme', value: dark ? 'light' : 'dark' }] });
    await settle(page);
    const first = await page.evaluate(() => window.__mqlGot.splice(0).sort());
    await emulate({ features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await settle(page);
    const second = await page.evaluate(() => window.__mqlGot.splice(0).sort());
    return { first, second, alive: await alive(page) };
  } finally {
    await emulate(NONE);
    await settle(page);
  }
}

test('a change listener the page adds again as its signal is aborted gets the events Chrome gives', async () => {
  assert.ok(env);
  const launched = env;
  const plain = await launched.browser.newPage();
  let chrome: Awaited<ReturnType<typeof readded>>;
  try {
    await plain.goto(launched.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
    const cdp = await plain.createCDPSession();
    chrome = await readded(plain, params => cdp.send('Emulation.setEmulatedMedia', params));
  } finally {
    await plain.close();
  }
  const t = await openPage(launched, []);
  try {
    const ours = await readded(t.page, params => t.ours.send('Emulation.setEmulatedMedia', params));
    assert.deepEqual(chrome, {
      first: ['plain', 'stopped'],
      second: ['plain', 'stopped'],
      alive: { plain: true, stopped: true },
    });
    assert.deepEqual(ours, chrome);
    // Our own listing of the list's listeners: the one added again, once.
    const { result } = await t.ours.send('Runtime.evaluate', {
      expression: 'window.__mqlRefs.plain.deref()',
      objectGroup: 'test',
    });
    assert.ok(result.objectId);
    const { listeners } = await t.ours.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    assert.deepEqual(
      listeners.map(listener => listener.type),
      ['change']
    );
  } finally {
    await t.page.close();
  }
});
