// The browser's own functions that the agent calls on the page's objects and window (core/natives.ts) are the
// probe's: taken before the page's code runs. A page that wraps them after the probe, and before the CDP bundle
// loads, sees none of the agent's calls, and the edits and the emulation read as they do in Chrome. The probe is
// the page's first script, as in a page that loads it in <head>; the wrappers come next, and the bundle after the
// fixture, as the other tests load them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Page } from 'puppeteer-core';
import { PROBE_BUNDLE, launch, openPage, setUpAndTearDown } from '../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../test-support/conformance.ts';

declare global {
  interface Window {
    /** Whether the page's wrappers record the calls made to them (natives.conformance.test.ts). */
    __natWatch: boolean;
    /** The names of the calls the wrappers recorded while `__natWatch` was set. */
    __natCalls: string[];
    /** The page's own observer, which puts its text back, and how many times it did. */
    __natRestores: number;
  }
}

/**
 * Runs in the page, after the probe and before any other script: wraps the methods and accessors the agent calls
 * on the page's elements and documents, and the window's frames and timers. A wrapper records its name while
 * `__natWatch` is set, then calls the browser's own function.
 */
function wrapNatives(): void {
  const calls: string[] = [];
  Reflect.set(window, '__natCalls', calls);
  Reflect.set(window, '__natWatch', false);
  const record = (name: string) => {
    if (Reflect.get(window, '__natWatch') === true) calls.push(name);
  };
  const wrap = (owner: object, name: string) => {
    const original: unknown = Reflect.get(owner, name);
    if (typeof original !== 'function') return;
    Reflect.set(owner, name, function (this: unknown, ...args: unknown[]) {
      record(name);
      return Reflect.apply(original, this, args);
    });
  };
  for (const name of [
    'getAttribute',
    'setAttribute',
    'removeAttribute',
    'setAttributeNS',
    'hasAttribute',
    'matches',
    'querySelector',
    'querySelectorAll',
  ])
    wrap(Element.prototype, name);
  // The getter of an accessor, which records its name when it is read.
  const wrapGetter = (owner: object, name: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    const get = descriptor?.get;
    if (!descriptor || !get) return;
    Object.defineProperty(owner, name, {
      ...descriptor,
      get: function (this: unknown) {
        record(name);
        return Reflect.apply(get, this, []);
      },
    });
  };
  wrapGetter(Element.prototype, 'attributes');
  wrapGetter(Document.prototype, 'adoptedStyleSheets');
  // A sheet's media and owner are the StyleSheet's accessors, and its rules are CSSStyleSheet's.
  wrapGetter(StyleSheet.prototype, 'media');
  wrapGetter(StyleSheet.prototype, 'ownerNode');
  wrapGetter(CSSStyleSheet.prototype, 'cssRules');
  wrap(window, 'requestAnimationFrame');
  wrap(window, 'setTimeout');
}

/**
 * Runs in the page after wrapNatives: wraps what the scan of forced colors calls besides, the queries of documents
 * and shadow roots, the computed style, the mutation observer and its methods, and the microtasks. Apart from
 * wrapNatives, as the other domains make observers and microtasks of their own, which these wrappers would see.
 */
function wrapScan(): void {
  const record = (name: string) => {
    if (Reflect.get(window, '__natWatch') === true) window.__natCalls.push(name);
  };
  const wrap = (owner: object, name: string, as = name) => {
    const original: unknown = Reflect.get(owner, name);
    if (typeof original !== 'function') return;
    Reflect.set(owner, name, function (this: unknown, ...args: unknown[]) {
      record(as);
      return Reflect.apply(original, this, args);
    });
  };
  wrap(Document.prototype, 'querySelectorAll', 'document.querySelectorAll');
  wrap(DocumentFragment.prototype, 'querySelectorAll', 'fragment.querySelectorAll');
  wrap(window, 'getComputedStyle');
  wrap(window, 'queueMicrotask');
  for (const name of ['observe', 'disconnect', 'takeRecords']) wrap(MutationObserver.prototype, name);
  wrap(CSSStyleDeclaration.prototype, 'getPropertyValue');
  const Native = MutationObserver;
  window.MutationObserver = class extends Native {
    constructor(callback: MutationCallback) {
      record('MutationObserver');
      super(callback);
    }
  };
}

/** Loads the probe, then the wrappers, before the fixture and the bundle. */
async function wrappedBeforeGoto(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(await readFile(PROBE_BUNDLE, 'utf8'));
  await page.evaluateOnNewDocument(wrapNatives);
}

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

/** A page with the wrappers in place, and the target element: `style` has an env() the emulation rewrites. */
async function openWrapped(): Promise<TestPage> {
  assert.ok(env);
  const t = await openPage(env, [], wrappedBeforeGoto);
  await t.page.evaluate(() => {
    const target = document.createElement('div');
    target.id = 'target';
    target.setAttribute('data-x', '1');
    target.setAttribute('style', 'padding-top: env(safe-area-inset-top)');
    document.body.append(target);
    const sheet = document.createElement('style');
    sheet.id = 'sheet';
    sheet.setAttribute('media', 'screen');
    sheet.textContent = '#target { color: red; }';
    document.head.append(sheet);
  });
  return t;
}

/** Sets the wrappers' recording, in the page, and returns what they recorded before (and clears it). */
const watch = (t: TestPage, on: boolean) =>
  t.page.evaluate(on => {
    window.__natWatch = on;
    return window.__natCalls.splice(0);
  }, on);

/**
 * The edits and emulation of one side, and the element's HTML after them: a safe area inset rewrites the element's
 * `style` attribute, and the DOM edits set, remove and read attributes, as the client would make them.
 */
async function editsOf(side: Side): Promise<string> {
  await side.send('DOM.enable');
  const { root } = await side.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#target' });
  // A print emulation rewrites the media of the page's sheet, which the agent reads through the sheet's accessors.
  await side.send('Emulation.setEmulatedMedia', { media: 'print' });
  await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 7 } });
  await side.send('DOM.setAttributeValue', { nodeId, name: 'data-y', value: '2' });
  await side.send('DOM.removeAttribute', { nodeId, name: 'data-x' });
  const { outerHTML } = await side.send('DOM.getOuterHTML', { nodeId });
  await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  await side.send('Emulation.setEmulatedMedia', {});
  return outerHTML;
}

test('the agent calls no page wrapper for its edits and safe area, and they read as in Chrome', async () => {
  const chromePage = await openWrapped();
  const chrome = await editsOf(chromePage.chrome);
  await chromePage.page.close();

  const t = await openWrapped();
  await watch(t, true);
  const ours = await editsOf(t.ours);
  const seen = await watch(t, false);
  assert.equal(ours, chrome);
  assert.deepEqual(seen, []);

  // The wrappers do record the page's own calls: the watch above saw nothing because the agent made no such call.
  await watch(t, true);
  await t.page.evaluate(() => {
    const target = document.getElementById('target');
    target?.getAttribute('data-y');
    target?.setAttribute('data-z', '3');
    target?.removeAttribute('data-z');
    void target?.matches('div');
    void target?.querySelectorAll('div');
    void target?.attributes;
    void document.adoptedStyleSheets;
    const sheet = document.getElementById('sheet') as HTMLStyleElement | null;
    void sheet?.sheet?.media;
    void sheet?.sheet?.ownerNode;
    void sheet?.sheet?.cssRules;
  });
  assert.deepEqual(await watch(t, false), [
    'getAttribute',
    'setAttribute',
    'removeAttribute',
    'matches',
    'querySelectorAll',
    'attributes',
    'adoptedStyleSheets',
    'media',
    'ownerNode',
    'cssRules',
  ]);
  await t.page.close();
});

test('a rewrite the page keeps putting back is paced, with no call of the agent to a page wrapper', async () => {
  const t = await openWrapped();
  // The page's own observer, made before the emulation's, puts its text back each time the style changes.
  await t.page.evaluate(() => {
    const target = document.getElementById('target');
    if (!target) throw new Error('no target');
    const text = target.style.cssText;
    window.__natRestores = 0;
    const guard = new MutationObserver(() => {
      if (target.style.cssText === text) return;
      window.__natRestores++;
      target.style.cssText = text;
    });
    guard.observe(target, { attributes: true, attributeFilter: ['style'] });
  });
  await watch(t, true);
  await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 7 } });
  // The agent's frames and timers run meanwhile; the test waits in Node, which makes no call of the page's.
  await new Promise(resolve => setTimeout(resolve, 400));
  await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  await new Promise(resolve => setTimeout(resolve, 100));
  const seen = await watch(t, false);
  const restores = await t.page.evaluate(() => window.__natRestores);
  // The page did put its text back, so the rewrite was held and resumed, not made once.
  assert.ok(restores > 1, `restores: ${restores}`);
  assert.deepEqual(seen, []);

  await watch(t, true);
  await t.page.evaluate(() => {
    requestAnimationFrame(() => undefined);
    setTimeout(() => undefined, 0);
    void document.getElementById('target')?.getAttribute('style');
  });
  assert.deepEqual(await watch(t, false), ['requestAnimationFrame', 'setTimeout', 'getAttribute']);
  await t.page.close();
});

test('the scan and the sheets of forced colors call no page wrapper', async () => {
  assert.ok(env);
  const t = await openPage(env, [], async page => {
    await wrappedBeforeGoto(page);
    await page.evaluateOnNewDocument(wrapScan);
  });
  const FORCED = { features: [{ name: 'forced-colors', value: 'active' }] };
  const color = (id: string) =>
    t.page.evaluate(id => getComputedStyle(document.getElementById(id) ?? document.body).color, id);
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p id="fc-kept" style="forced-color-adjust: none; color: rgb(1, 2, 3)">kept</p><div id="fc-host"></div>'
    );
    const root = document.getElementById('fc-host')?.attachShadow({ mode: 'open' });
    if (root) root.innerHTML = '<p style="background: linear-gradient(red, blue)">shadow</p>';
  });
  await watch(t, true);
  await t.ours.send('Emulation.setEmulatedMedia', FORCED);
  // An element the page adds meanwhile is scanned through the observer, in a microtask of the agent's.
  await t.page.evaluate(() => {
    window.__natWatch = false;
    document.body.insertAdjacentHTML('beforeend', '<p id="fc-added" style="color: rgb(4, 5, 6)">added</p>');
    window.__natWatch = true;
  });
  // The test waits in Node, which makes no call of the page's.
  await new Promise(resolve => setTimeout(resolve, 300));
  const seen = await watch(t, false);
  const during = [await color('fc-kept'), await color('fc-added')];
  await watch(t, true);
  await t.ours.send('Emulation.setEmulatedMedia', { features: [] });
  await new Promise(resolve => setTimeout(resolve, 100));
  const cleared = await watch(t, false);
  // Forced colors did paint: the kept element has its colour, the added one the palette's text.
  assert.deepEqual(during, ['rgb(1, 2, 3)', 'rgb(255, 255, 255)']);
  assert.deepEqual([seen, cleared], [[], []]);

  // The wrappers do record the page's own calls.
  await watch(t, true);
  await t.page.evaluate(() => {
    void document.querySelectorAll('p');
    void document.getElementById('fc-host')?.shadowRoot?.querySelectorAll('p');
    void getComputedStyle(document.body).getPropertyValue('color');
    queueMicrotask(() => undefined);
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true });
    void observer.takeRecords();
    observer.disconnect();
  });
  assert.deepEqual(await watch(t, false), [
    'document.querySelectorAll',
    'fragment.querySelectorAll',
    'getComputedStyle',
    'getPropertyValue',
    'queueMicrotask',
    'MutationObserver',
    'observe',
    'takeRecords',
    'disconnect',
  ]);
  await t.page.close();
});
