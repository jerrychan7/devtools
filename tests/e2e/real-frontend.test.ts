// The DevTools frontend built from the official sources (packages/devtools-frontend),
// against the in-page CDP server. Skipped when the frontend has not been built.
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementHandle, Frame } from 'puppeteer-core';
import { launch } from '../conformance/harness.ts';
import type { Env } from '../conformance/harness.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

let env: Env | undefined;
let frontend: Frame;
/** Uncaught errors in the frontend. */
const errors: string[] = [];

before(async () => {
  if (!built) return;
  env = await launch();
  const page = await env.browser.newPage();
  page.on('pageerror', error => errors.push(error instanceof Error ? error.message : String(error)));
  // Tall enough for the Network panel to render its rows below the overview.
  await page.setViewport({ width: 1000, height: 1600 });
  await page.goto(env.baseUrl + '/tests/e2e/real-frontend.html');
  frontend = await waitFor(() => page.frames().find(f => new URL(f.url()).pathname.endsWith('/anywhere_app.html')));
});
after(() => env?.close());

async function waitFor<T>(get: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await Promise.resolve()
      .then(get)
      .catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Text of the frontend, including shadow DOM. */
const text = () =>
  frontend.evaluate(() => {
    const parts: (string | null)[] = [];
    const walk = (root: Document | ShadowRoot) => {
      parts.push(root === document ? document.documentElement.textContent : root.textContent);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return parts.join('\n');
  });

/** Clicks a panel's tab in the main tabbed pane (inside shadow DOM). */
async function showPanel(id: string) {
  const tab = await frontend.evaluateHandle(id => {
    const find = (root: Document | ShadowRoot): Element | null => {
      const tab = root.querySelector(`#tab-${id}`);
      if (tab) return tab;
      for (const el of root.querySelectorAll('*')) {
        const found = el.shadowRoot && find(el.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    return find(document);
  }, id);
  // asElement() is typed as a handle to any Node; the page function returns an Element or null.
  await (tab.asElement() as ElementHandle<Element> | null)?.click();
}

test('the Elements panel shows the page', { skip }, async () => {
  await showPanel('elements');
  await waitFor(async () => (await text()).includes('real-frontend-marker'));
});

test('the Console panel shows output from before DevTools loaded', { skip }, async () => {
  await waitFor(async () => {
    await showPanel('console');
    return (await text()).includes('real frontend early');
  });
});

test('only the panels that work in the page are offered', { skip }, async () => {
  const tabs = await frontend.evaluate(() => {
    const ids: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('[id^="tab-"]')) ids.push(el.id.slice(4));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return ids;
  });
  for (const panel of ['elements', 'console', 'sources', 'network', 'resources'])
    assert.ok(tabs.includes(panel), panel);
  for (const panel of ['timeline', 'heap-profiler', 'lighthouse', 'security']) assert.ok(!tabs.includes(panel), panel);
});

test('every panel opens without uncaught errors', { skip }, async () => {
  for (const panel of ['elements', 'console', 'sources', 'network', 'resources']) {
    await showPanel(panel);
    await new Promise(r => setTimeout(r, 300));
  }
  assert.deepEqual(errors, []);
});

test('the Network panel lists the document and its resources, but not DevTools itself', { skip }, async () => {
  await showPanel('network');
  await waitFor(async () => (await text()).includes('probe.iife.js'));
  const all = await text();
  assert.ok(all.includes('real-frontend.html'), 'the document');
  assert.ok(!all.includes('devtools-anywhere.iife.js'), "the bundle is DevTools' own");
});

test("the Sources panel lists the page's scripts and style sheets, but not DevTools itself", { skip }, async () => {
  await showPanel('sources');
  const files = () =>
    frontend.evaluate(async () => {
      // The frontend's own module, loaded from its location: its workspace backs the Sources panel.
      // The built frontend has no type declarations; only this much of it is used.
      const {
        Workspace,
      }: {
        Workspace: { WorkspaceImpl: { instance(): { uiSourceCodes(): { url(): string }[] } } };
      } = await import(new URL('models/workspace/workspace.js', location.href).href);
      return Workspace.WorkspaceImpl.instance()
        .uiSourceCodes()
        .map(code => code.url());
    });
  const urls = await waitFor(async () => {
    const urls = await files();
    return urls.some(url => url.endsWith('real-frontend.js')) ? urls : null;
  });
  assert.ok(
    urls.some(url => url.endsWith('/assets/real-frontend.css')),
    'the style sheet'
  );
  assert.ok(!urls.some(url => url.endsWith('devtools-anywhere.iife.js')), "the bundle is DevTools' own");
});
