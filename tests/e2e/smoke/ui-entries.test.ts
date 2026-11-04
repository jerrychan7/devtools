// A gate against a CDP domain the agent carries out that the frontend cannot show: every domain
// with a working handler has an entry in ./ui-entries.ts (or null, with why), and each entry's view
// opens in the real frontend, without errors, and shows its content from ui-entries.html.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementHandle, Frame, JSHandle, Page } from 'puppeteer-core';
import { launch } from '../../support/browser.ts';
import type { Env } from '../../support/browser.ts';
import { UI_ENTRIES } from './ui-entries.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLE = path.join(root, 'packages/devtools-anywhere/dist/devtools-anywhere.iife.js');
const built = existsSync(path.join(root, 'packages/devtools-frontend/dist/anywhere_app.html'));
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

let env: Env | undefined;
let page: Page;
let frontend: Frame;
/** Uncaught errors in the page and the frontend. */
const errors: string[] = [];
/** Console messages of the page and the frontend. */
const messages: string[] = [];

before(async () => {
  env = await launch();
  if (!built) return;
  page = await env.browser.newPage();
  page.on('pageerror', error => errors.push(error instanceof Error ? error.message : String(error)));
  page.on('console', message => messages.push(message.text()));
  await page.setViewport({ width: 1000, height: 1600 });
  await page.goto(env.baseUrl + '/tests/e2e/smoke/ui-entries.html');
  frontend = await waitFor(() => page.frames().find(f => new URL(f.url()).pathname.endsWith('/anywhere_app.html')));
  // Loaded: the Elements panel, shown first, shows the page.
  await waitFor(async () =>
    shows(await frontend.evaluateHandle((): Element | null => document.body), undefined, 'ui-entries-marker')
  );
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

// Layer 1: the domains registered by a real agent, from its session's handlers.
test('every domain the agent carries out has an entry', async () => {
  assert.ok(env);
  const tab = await env.browser.newPage();
  await tab.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await tab.addScriptTag({ path: BUNDLE });
  const domains = await tab.evaluate(() => {
    // The session's handlers, by domain: a private field, read here only.
    const registered: unknown = Reflect.get(window.DevtoolsAnywhere.createCdpSession(), 'domains');
    if (!(registered instanceof Map)) throw new Error('no handlers');
    // domains/stubs.ts's no-ops, and its commands that fail as not supported in the page.
    const stub = (handler: unknown) =>
      typeof handler === 'function' &&
      (String(handler) === '()=>{}' ||
        /^\(\)=>\{throw new [\w$]+\(`Not supported in the page: \$\{[\w$]+\}`\)\}$/.test(String(handler)));
    const working: string[] = [];
    for (const [domain, handlers] of registered) {
      if (typeof domain === 'string' && Object.values(Object(handlers)).some(handler => !stub(handler)))
        working.push(domain);
    }
    return working.sort();
  });
  await tab.close();
  // The no-op domains are recognized, and a domain carried out cannot be missed for one.
  assert.ok(domains.includes('Runtime') && !domains.includes('Inspector'), domains.join());
  const missing = domains.filter(domain => !Object.hasOwn(UI_ENTRIES, domain));
  assert.deepEqual(missing, [], 'domains without an entry in tests/e2e/smoke/ui-entries.ts');
});

/**
 * Selects the first element named `tag` in the Elements panel's tree, as a click does: views such
 * as the Accessibility pane show the selected node.
 */
const select = (tag: string) =>
  waitFor(() =>
    frontend.evaluate(tag => {
      const find = (root: Document | ShadowRoot): Element | null => {
        for (const name of root.querySelectorAll('li[role="treeitem"] .webkit-html-tag-name'))
          if (name.textContent === tag) return name;
        for (const el of root.querySelectorAll('*')) {
          const found = el.shadowRoot && find(el.shadowRoot);
          if (found) return found;
        }
        return null;
      };
      const name = find(document);
      name?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
      return !!name;
    }, tag)
  );

/** A view's element. */
type View = JSHandle<Element | null>;

/** Opens view `id` through the ViewManager; its widget's element, or null when there is no such view. */
const showView = (id: string): Promise<View> =>
  frontend.evaluateHandle(async (id): Promise<Element | null> => {
    // The built frontend has no type declarations; only this much of it is used.
    const {
      ViewManager,
    }: {
      ViewManager: {
        ViewManager: {
          instance(): {
            hasView(id: string): boolean;
            showView(id: string): Promise<void>;
            view(id: string): { widget(): Promise<{ element: Element }> };
          };
        };
      };
    } = await (
      await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
    ).modules['ui/legacy/legacy.js']();
    const views = ViewManager.ViewManager.instance();
    if (!views.hasView(id)) return null;
    await views.showView(id);
    return (await views.view(id).widget()).element;
  }, id);

/**
 * Within `element`, shadow DOM included: whether `selector` matches, or else whether a text node
 * (style sheets left out) contains `text`.
 */
const shows = (handle: View, selector: string | undefined, text: string) =>
  handle.evaluate(
    (element, selector, text) => {
      if (!element) return false;
      const walk = (root: Element | ShadowRoot): boolean => {
        if (selector) {
          if (root.querySelector(selector)) return true;
        } else {
          for (const el of root.querySelectorAll('*:not(style):not(script)'))
            for (const node of el.childNodes) if (node instanceof Text && node.data.includes(text)) return true;
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot && walk(el.shadowRoot)) return true;
        return false;
      };
      return walk(element) || (!!element.shadowRoot && walk(element.shadowRoot));
    },
    selector,
    text
  );

/**
 * Expands the collapsed tree items in `element`, as the keyboard does: selected, then the right
 * arrow key.
 */
const expandTrees = (handle: View) =>
  handle.evaluate(element => {
    const walk = (root: Element | ShadowRoot) => {
      for (const item of root.querySelectorAll('[role="treeitem"][aria-expanded="false"]')) {
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true }));
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    if (element) walk(element.shadowRoot ?? element);
  });

// Layer 2: each entry's view, in one frontend.
for (const [domain, entry] of Object.entries(UI_ENTRIES)) {
  if (!entry) continue;
  test(`${domain}: ${entry.view} shows ${entry.trigger}`, { skip }, async () => {
    const before = { errors: errors.length, messages: messages.length };
    if (entry.select) {
      await showView('elements');
      await select(entry.select);
    }
    const element = await showView(entry.view);
    assert.equal(await element.evaluate(el => el !== null), true, `the frontend has no view ${entry.view}`);
    if (entry.tab) {
      const tab = await element.evaluateHandle((element, id) => {
        const find = (root: Element | ShadowRoot): Element | null => {
          const found = root.querySelector(`#tab-${id}`);
          if (found) return found;
          for (const el of root.querySelectorAll('*')) {
            const inShadow = el.shadowRoot && find(el.shadowRoot);
            if (inShadow) return inShadow;
          }
          return null;
        };
        return element && find(element);
      }, entry.tab);
      // asElement() is typed as a handle to any Node; the page function returns an Element or null.
      const tabElement = tab.asElement() as ElementHandle<Element> | null;
      assert.ok(tabElement, `${entry.view} has no tab ${entry.tab}`);
      await tabElement.click();
    }
    if (entry.start) await page.evaluate(entry.start);
    try {
      await waitFor(async () => {
        if (entry.expand) await expandTrees(element);
        return shows(element, entry.selector, entry.text);
      }, 8000);
    } catch {
      const shown = await element.evaluate(el => el?.textContent?.replace(/\s+/g, ' ').slice(0, 300));
      assert.fail(
        `${entry.view} does not show ${entry.selector ?? JSON.stringify(entry.text)} for ${entry.trigger}; it shows: ${shown}`
      );
    }
    assert.deepEqual(errors.slice(before.errors), [], 'uncaught errors');
    assert.deepEqual(
      messages.slice(before.messages).filter(message => message.includes("wasn't found")),
      [],
      'console'
    );
  });
}
