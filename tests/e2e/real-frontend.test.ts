// The DevTools frontend built from the official sources (packages/devtools-frontend),
// against the in-page CDP server. Skipped when the frontend has not been built.
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { launch } from '../conformance/harness.ts';
import type { Env } from '../conformance/harness.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

let env: Env | undefined;
let page: Page;
let frontend: Frame;
/** Uncaught errors in the frontend. */
const errors: string[] = [];

before(async () => {
  if (!built) return;
  env = await launch();
  page = await env.browser.newPage();
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

test("the frontend uses Chrome's default theme colors", { skip }, async () => {
  // Without Chrome's theme, the frontend would show a dynamic theme's blue-tinted surfaces.
  const classes = await frontend.evaluate(() => document.documentElement.className);
  assert.ok(classes.split(' ').includes('baseline-default'), classes);
});

test("the panel's bar takes the color of DevTools' toolbar", { skip }, async () => {
  const toolbar = await frontend.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--app-color-toolbar-background').trim()
  );
  const bar = await waitFor(() =>
    page.evaluate(() => {
      const el = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
      return el instanceof HTMLElement ? el.style.getPropertyValue('--bar-background') : '';
    })
  );
  assert.equal(bar, toolbar);
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

test('the screencast is off by default and shows the page when turned on', { skip }, async () => {
  await frontend.evaluate(() => {
    const state = { frames: 0 };
    Object.assign(window, { __screencast: state });
    addEventListener('message', e => {
      if (typeof e.data === 'string' && e.data.includes('"Page.screencastFrame"')) state.frames++;
    });
  });
  const frames = () =>
    frontend.evaluate(() => (window as unknown as { __screencast: { frames: number } }).__screencast.frames);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await frames(), 0);
  const toggle = await frontend.evaluateHandle(() => {
    const find = (root: Document | ShadowRoot): Element | null => {
      const button = root.querySelector('[aria-label="Toggle screencast"]');
      if (button) return button;
      for (const el of root.querySelectorAll('*')) {
        const found = el.shadowRoot && find(el.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    return find(document);
  });
  // asElement() is typed as a handle to any Node; the page function returns an Element or null.
  const button = toggle.asElement() as ElementHandle<Element> | null;
  assert.ok(button, 'the toolbar offers the screencast');
  await button.click();
  await waitFor(async () => (await frames()) > 0);
  await button.click();
  assert.ok(!(await text()).includes('snapdom.js'), "snapDOM is DevTools' own");
});

test('the Dock side menu moves the panel to each side, and floats it', { skip }, async () => {
  /** Chooses a side as the main menu's Dock side buttons do. */
  const setDockSide = (side: string) =>
    frontend.evaluate(async side => {
      // The built frontend has no type declarations; only this much of it is used.
      const {
        DockController,
      }: {
        DockController: { DockController: { instance(): { canDock(): boolean; setDockSide(side: string): void } } };
      } = await import(new URL('ui/legacy/legacy.js', location.href).href);
      const controller = DockController.DockController.instance();
      if (!controller.canDock()) throw new Error('docking is off');
      controller.setDockSide(side);
    }, side);
  const panel = () =>
    page.evaluate(() => {
      const el = document.querySelector('devtools-anywhere');
      const rect = el?.shadowRoot?.querySelector('.panel')?.getBoundingClientRect();
      return rect && { dock: el?.getAttribute('dock'), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  const { width, height } = page.viewport() ?? { width: 0, height: 0 };
  try {
    await setDockSide('right');
    let rect = await waitFor(async () => ((await panel())?.dock === 'right' ? panel() : null));
    assert.equal(Math.round(rect.x + rect.width), width);
    assert.equal(rect.height, height);

    await setDockSide('left');
    rect = await waitFor(async () => ((await panel())?.dock === 'left' ? panel() : null));
    assert.equal(rect.x, 0);
    assert.equal(rect.height, height);

    await setDockSide('undocked');
    rect = await waitFor(async () => ((await panel())?.dock === 'undocked' ? panel() : null));
    assert.ok(rect.x > 0 && rect.y > 0 && rect.width < width && rect.height < height, 'a window over the page');
    assert.equal(await page.evaluate(() => localStorage.getItem('devtools-anywhere:dock')), 'undocked', 'remembered');

    // Dragging the window past the bottom right corner keeps all of it in view.
    const bar = await page.evaluateHandle(() =>
      document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.bar')
    );
    const box = await (bar.asElement() as ElementHandle<Element> | null)?.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 50, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 50 + width, box.y + 8 + height, { steps: 5 });
    await page.mouse.up();
    rect = await waitFor(() => panel());
    assert.equal(Math.round(rect.x + rect.width), width);
    assert.equal(Math.round(rect.y + rect.height), height);
  } finally {
    await setDockSide('bottom');
    await page.evaluate(() => localStorage.removeItem('devtools-anywhere:dock'));
  }
  const rect = await waitFor(async () => ((await panel())?.dock === 'bottom' ? panel() : null));
  assert.equal(Math.round(rect.y + rect.height), height);
  assert.equal(rect.width, width);
});

// Last: it reloads the page into shell mode and back.
test('the toolbar keeps DevTools open across reloads, and reloads the page', { skip }, async () => {
  /** A button of the frontend whose label starts with `label`, and the frontend currently shown. */
  const button = async (label: string) => {
    const current = await waitFor(() => page.frames().find(f => f.url().includes('anywhere_app.html')));
    const handle = await current.evaluateHandle(label => {
      const find = (root: Document | ShadowRoot): Element | null => {
        const found =
          root.querySelector(`[aria-label^="${label}"]`) ??
          Array.from(root.querySelectorAll('devtools-button')).find(b => b.textContent?.trim() === label);
        if (found) return found;
        for (const el of root.querySelectorAll('*')) {
          const inShadow = el.shadowRoot && find(el.shadowRoot);
          if (inShadow) return inShadow;
        }
        return null;
      };
      return find(document);
    }, label);
    // asElement() is typed as a handle to any Node; the page function returns an Element or null.
    return handle.asElement() as ElementHandle<Element> | null;
  };
  const inShell = () => page.evaluate(() => !!document.getElementById('devtools-anywhere-page'));

  assert.ok(await button('Reload page'), 'the reload button');
  // A dialog explains the mode first (no tooltip: touch screens have no hover).
  await (await waitFor(() => button('Keep DevTools open'))).click();
  await (await waitFor(() => button('Reload and keep open'))).click();
  await waitFor(inShell);
  // While it is on, an info bar says so.
  await waitFor(async () => {
    frontend = await waitFor(() => page.frames().find(f => f.url().includes('anywhere_app.html')));
    return (await text()).includes('DevTools stays open across reloads');
  });
  await (await waitFor(() => button('Stop keeping DevTools open'))).click();
  await waitFor(async () => !(await inShell()));
});
