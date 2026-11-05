// The DevTools frontend built from the official sources (packages/devtools-frontend) on a page
// whose cross-origin iframe loads the probe too, the two linked (frame-links/): the iframe is a
// child target of the page's agent, shown in the page's DevTools as Chrome shows an
// out-of-process iframe. The page is on localhost, the iframe on 127.0.0.1, of the one server.
// Skipped when the frontend has not been built.
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { launch, setUpAndTearDown } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

let env: Env | undefined;
let page: Page;
let frontend: Frame;

setUpAndTearDown(
  async () => {
    if (!built) return;
    // Every site in its own process, as Chrome runs cross-site iframes for real.
    env = await launch(['--site-per-process']);
    page = await env.browser.newPage();
    await page.setViewport({ width: 1000, height: 1200 });
    const child = new URL('/packages/devtools-anywhere/test-support/frame-link-child.html', env.baseUrl);
    child.hostname = '127.0.0.1';
    const parent = new URL('/tests/e2e/pages/oopif-frontend.html', env.baseUrl);
    parent.hostname = 'localhost';
    child.searchParams.set('parentOrigins', parent.origin);
    parent.searchParams.set('frameOrigins', child.origin);
    parent.searchParams.set('child', child.href);
    await page.goto(parent.href);
    frontend = await waitFor(() => page.frames().find(f => new URL(f.url()).pathname.endsWith('/anywhere_app.html')));
  },
  () => env?.close()
);

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

/** The first element of the frontend, shadow trees included, that matches. */
const find = (selector: string, text = '') =>
  frontend.evaluateHandle(
    (selector, text) => {
      const search = (root: Document | ShadowRoot): Element | null => {
        const found = Array.from(root.querySelectorAll(selector)).find(el => el.textContent?.startsWith(text));
        if (found) return found;
        for (const el of root.querySelectorAll('*')) {
          const inShadow = el.shadowRoot && search(el.shadowRoot);
          if (inShadow) return inShadow;
        }
        return null;
      };
      return search(document);
    },
    selector,
    text
  );

/** An element of the frontend, once there. */
const element = (selector: string, text = '') =>
  // asElement() is typed as a handle to any Node; the page function returns an Element or null.
  waitFor(async () => (await find(selector, text)).asElement() as ElementHandle<Element> | null);

/** The text of the frontend's elements that match, shadow trees included. */
const texts = (selector: string) =>
  frontend.evaluate(selector => {
    const found: string[] = [];
    const search = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll(selector)) found.push(el.textContent ?? '');
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) search(el.shadowRoot);
    };
    search(document);
    return found;
  }, selector);

/** Whether a panel is the main tabbed pane's selected tab, loaded and shown. */
const panelShowing = (id: string) =>
  frontend.evaluate(async id => {
    // The built frontend has no type declarations; only this much of it is used.
    const {
      InspectorView,
    }: {
      InspectorView: {
        InspectorView: {
          instance(): {
            tabbedPane: { selectedTabId: string | null };
            panel(id: string): Promise<{ isShowing(): boolean }>;
          };
        };
      };
    } = await (
      await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
    ).modules['ui/legacy/legacy.js']();
    const inspectorView = InspectorView.InspectorView.instance();
    return inspectorView.tabbedPane.selectedTabId === id && (await inspectorView.panel(id)).isShowing();
  }, id);

/** The text of the frontend's elements that match, with that of their shadow trees, style sheets left out. */
const deepTexts = (selector: string) =>
  frontend.evaluate(selector => {
    const textOf = (node: Node): string => {
      if (node instanceof HTMLStyleElement) return '';
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
      const shadow = node instanceof Element && node.shadowRoot ? textOf(node.shadowRoot) : '';
      return shadow + Array.from(node.childNodes, textOf).join('');
    };
    const found: string[] = [];
    const search = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll(selector)) found.push(textOf(el).replace(/\s+/g, ' ').trim());
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) search(el.shadowRoot);
    };
    search(document);
    return found;
  }, selector);

/** Clicks a panel's tab until the panel shows. */
async function showPanel(id: string) {
  await waitFor(async () => {
    await (await element(`#tab-${id}`)).click();
    return panelShowing(id);
  });
}

/** The first collapsed row on the way from the <iframe> to the child's body: the iframe's, its document's, html's or body's. */
const collapsedInIframe = () =>
  frontend.evaluateHandle(() => {
    const rows: Element[] = [];
    const search = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('.elements-tree-outline [role="treeitem"]')) rows.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) search(el.shadowRoot);
    };
    search(document);
    const from = rows.findIndex(row => row.textContent?.startsWith('<iframe'));
    const to = rows.findIndex(row => row.textContent?.startsWith('</iframe>'));
    return (
      rows
        .slice(from, to < 0 ? undefined : to)
        .find(
          row =>
            row.getAttribute('aria-expanded') === 'false' &&
            /^(<iframe|#document|<html|<body)/.test(row.textContent ?? '')
        ) ?? null
    );
  });

test("the Elements panel expands the cross-origin iframe's document", { skip }, async () => {
  await showPanel('elements');
  await element('.elements-tree-outline [role="treeitem"]', '<iframe');
  // The frontend has grafted the child target's document under the <iframe> (DOMModel
  // .requestDocument of the child, DOM.getFrameOwner on the parent): expanding it, by the rows'
  // disclosure triangles, shows the document, fetched from the child's session. The child target
  // attaches asynchronously, the <iframe> not expandable until then: each poll clicks whichever
  // row on the way is still collapsed, none yet meaning wait.
  const rows = await waitFor(async () => {
    const found = await texts('.elements-tree-outline [role="treeitem"]');
    if (found.some(row => row.includes('child page'))) return found;
    // asElement() is typed as a handle to any Node; the page function returns an Element or null.
    const row = (await collapsedInIframe()).asElement() as ElementHandle<Element> | null;
    await row?.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const box = await row?.boundingBox();
    // The triangle, left of the row's title.
    if (box) await frontend.page().mouse.click(box.x + 20, box.y + 8);
    return null;
  });
  const at = rows.findIndex(row => row.startsWith('<iframe'));
  // The child's document, its URL that of the iframe's page, right under the <iframe>.
  assert.match(rows[at + 1] ?? '', /^#document \(http:\/\/127\.0\.0\.1:\d+\/.*frame-link-child\.html/);
  assert.ok(rows.slice(at).some(row => row.startsWith('<p id=\u200b"target">')));
});

test("the Console's context menu offers the cross-origin iframe's context", { skip }, async () => {
  await showPanel('console');
  await (await element('[aria-label^="JavaScript context"]')).click();
  // The menu's items, their labels in shadow trees.
  const items = await waitFor(async () => {
    const found = await deepTexts('.console-context-selector-element');
    return found.length > 1 ? found : null;
  });
  assert.equal(items.length, 2, items.join(' | '));
  assert.match(items[0] ?? '', /^top/);
  // The child target's main frame's context, named by its document and origin, as with Chrome.
  assert.match(items[1] ?? '', /^frame-link-child\.html127\.0\.0\.1:\d+$/);
  await frontend.page().keyboard.press('Escape');
});
