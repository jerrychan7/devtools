// Opens the DevTools frontend built from the official sources (packages/devtools-frontend)
// against the in-page CDP agent, with what its tests share: tests/e2e/real-frontend.test.ts and
// tests/e2e/animations-frontend.test.ts.
import { existsSync } from 'node:fs';
import type { Frame, Page } from 'puppeteer-core';
import { launch } from './browser.ts';
import type { Env } from './browser.ts';

export const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));
export const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

export async function waitFor<T>(get: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
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

/** Helpers on the frontend `get` gives (the toolbar test changes it when the page reloads). */
export function frontendHelpers(get: () => Frame) {
  /** Text of the frontend, including shadow DOM. */
  const text = () =>
    get().evaluate(() => {
      const parts: (string | null)[] = [];
      const walk = (root: Document | ShadowRoot) => {
        parts.push(root === document ? document.documentElement.textContent : root.textContent);
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return parts.join('\n');
    });

  /** Shows a view by its id, in the drawer for the drawer's views, as the command menu does. */
  const showView = (id: string) =>
    get().evaluate(async id => {
      const { ViewManager }: { ViewManager: { ViewManager: { instance(): { showView(id: string): Promise<void> } } } } =
        await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['ui/legacy/legacy.js']();
      await ViewManager.ViewManager.instance().showView(id);
    }, id);

  /** How many elements of the frontend match `selector`, including in shadow DOM. */
  const count = (selector: string) =>
    get().evaluate(selector => {
      let n = 0;
      const walk = (root: Document | ShadowRoot) => {
        n += root.querySelectorAll(selector).length;
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return n;
    }, selector);

  /** Text of the frontend's text nodes, one per line, without its style sheets. */
  const shownText = () =>
    get().evaluate(() => {
      const lines: string[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll('*:not(style):not(script)'))
          for (const node of el.childNodes) if (node instanceof Text && node.data.trim()) lines.push(node.data.trim());
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return lines;
    });

  /** Clicks the `index`th match of `selector` in the frontend, shadow DOM included (-1: the last). */
  const clickNth = (selector: string, index: number) =>
    get().evaluate(
      (selector, index) => {
        const all: Element[] = [];
        const walk = (root: Document | ShadowRoot) => {
          all.push(...root.querySelectorAll(selector));
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(document);
        const hit = all.at(index);
        if (hit instanceof HTMLElement) hit.click();
        return !!hit;
      },
      selector,
      index
    );
  return { text, showView, count, shownText, clickNth };
}

/**
 * Launches Chrome, opens tests/e2e/pages/real-frontend.html with the frontend embedded, and waits
 * until the frontend can show a view. Uncaught errors in the frontend go to `errors`.
 */
export async function openRealFrontend(errors: string[]): Promise<{ env: Env; page: Page; frontend: Frame }> {
  const env = await launch();
  const page = await env.browser.newPage();
  page.on('pageerror', error => errors.push(error instanceof Error ? error.message : String(error)));
  // Tall enough for the Network panel to render its rows below the overview.
  await page.setViewport({ width: 1000, height: 1600 });
  await page.goto(env.baseUrl + '/tests/e2e/pages/real-frontend.html');
  const frontend = await waitFor(() =>
    page.frames().find(f => new URL(f.url()).pathname.endsWith('/anywhere_app.html'))
  );
  // The frontend registers its locale data while it starts: until then showing a view throws "No
  // locale data registered for 'en-US'". Waiting here lets any test run alone (--test-name-pattern).
  const { showView } = frontendHelpers(() => frontend);
  await waitFor(async () => {
    await showView('elements');
    return true;
  });
  return { env, page, frontend };
}
