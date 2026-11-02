// The DevTools frontend built from the official sources (packages/devtools-frontend),
// against the in-page CDP agent. Skipped when the frontend has not been built.
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementHandle, Frame, JSHandle, Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

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
  await page.goto(env.baseUrl + '/tests/e2e/pages/real-frontend.html');
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

test('the Elements panel shows the page', { skip }, async () => {
  // The page can set devtools-anywhere's attribute itself: that does not hide an element.
  await page.evaluate(() => {
    const forged = document.createElement('div');
    forged.id = 'forged-own';
    forged.setAttribute('data-devtools-anywhere', '');
    document.body.append(forged);
  });
  await showPanel('elements');
  await waitFor(async () => (await text()).includes('real-frontend-marker'));
  await waitFor(async () => (await text()).includes('forged-own'));
  // devtools-anywhere's own element stays hidden.
  assert.ok((await text()).includes('<body'));
  assert.ok(!(await text()).includes('<devtools-anywhere'));
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

test('only the breakpoint panes the page supports are offered', { skip }, async () => {
  const views = await frontend.evaluate(async () => {
    // The built frontend has no type declarations; only this much of it is used.
    const { ViewManager }: { ViewManager: { ViewManager: { instance(): { hasView(id: string): boolean } } } } = await (
      await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
    ).modules['ui/legacy/legacy.js']();
    const ids = [
      'elements.event-listeners',
      'sources.xhr-breakpoints',
      'sources.dom-breakpoints',
      'elements.dom-breakpoints',
      'sources.global-listeners',
      'sources.event-listener-breakpoints',
      'sources.csp-violation-breakpoints',
    ];
    return Object.fromEntries(ids.map(id => [id, ViewManager.ViewManager.instance().hasView(id)]));
  });
  assert.deepEqual(views, {
    'elements.event-listeners': true,
    'sources.xhr-breakpoints': false,
    'sources.dom-breakpoints': false,
    'elements.dom-breakpoints': false,
    'sources.global-listeners': false,
    'sources.event-listener-breakpoints': false,
    'sources.csp-violation-breakpoints': false,
  });
});

// The page's debugger cannot pause: the Sources panel has no debugger sidebar (pause and step
// buttons, Breakpoints with "Pause on exceptions", Call Stack, Scope, Watch) and its editor sets no
// breakpoints, but still shows the source.
test('the Sources panel shows source and Watch, without breakpoints or pausing controls', { skip }, async () => {
  await showPanel('sources');
  await waitFor(() => panelShowing('sources'));
  // Opens the page's script in the editor.
  await waitFor(() =>
    frontend.evaluate(async () => {
      // The built frontend has no type declarations; only this much of it is used.
      const { Workspace }: { Workspace: { WorkspaceImpl: { instance(): { uiSourceCodes(): { url(): string }[] } } } } =
        await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['models/workspace/workspace.js']();
      const { Revealer }: { Revealer: { reveal(revealable: unknown): Promise<void> } } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['core/common/common.js']();
      const code = Workspace.WorkspaceImpl.instance()
        .uiSourceCodes()
        .find(code => code.url().startsWith('http') && code.url().endsWith('real-frontend.js'));
      if (!code) return false;
      await Revealer.reveal(code);
      return true;
    })
  );
  /** The first element matching `selector` in the frontend, including shadow DOM. */
  const query = (selector: string): Promise<JSHandle<Element | null>> =>
    frontend.evaluateHandle(selector => {
      const find = (root: Document | ShadowRoot): Element | null => {
        const found = root.querySelector(selector);
        if (found) return found;
        for (const el of root.querySelectorAll('*')) {
          const inShadow = el.shadowRoot && find(el.shadowRoot);
          if (inShadow) return inShadow;
        }
        return null;
      };
      return find(document);
    }, selector);
  const content = await waitFor(async () => {
    const value = await (await query('.cm-content')).evaluate(el => el?.textContent ?? '');
    return value.includes('realFrontendScript') ? value : null;
  });
  assert.ok(content.includes("return 'loaded'"), content);

  for (const selector of [
    '.scripts-debug-toolbar',
    '[aria-label="Breakpoints"]',
    '[aria-label="Call Stack"]',
    '[aria-label="Scope"]',
    '[aria-label^="Pause on"]',
    '[aria-label="Deactivate breakpoints"]',
  ])
    assert.equal(await (await query(selector)).evaluate(el => el === null), true, selector);
  const all = await text();
  for (const label of ['Pause on uncaught exceptions', 'Call Stack', 'Not paused'])
    assert.ok(!all.includes(label), label);

  // Watch stays: without pausing, its expressions are evaluated in the global scope.
  assert.equal(await (await query('[aria-label="Watch"]')).evaluate(el => el === null), false, 'Watch');
  const addWatch = async () =>
    // asElement() is typed as a handle to any Node; the page function returns an Element or null.
    (await query('[aria-label="Add watch expression"]')).asElement() as ElementHandle<Element> | null;
  await (await waitFor(addWatch)).click();
  const prompt = async () =>
    // asElement() is typed as a handle to any Node; the page function returns an Element or null.
    (await query('.text-prompt[contenteditable]')).asElement() as ElementHandle<Element> | null;
  await (await waitFor(prompt)).click();
  await frontend.page().keyboard.type('document.title');
  await frontend.page().keyboard.press('Enter');
  await waitFor(async () => (await text()).includes('document.title: "real frontend"'));

  // Clicking a line number sets no breakpoint.
  const lineNumber = async () =>
    // asElement() is typed as a handle to any Node; the page function returns an Element or null.
    (await query('.cm-lineNumbers .cm-gutterElement:nth-child(2)')).asElement() as ElementHandle<Element> | null;
  await (await waitFor(lineNumber)).click();
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await (await query('.cm-breakpoint')).evaluate(el => el === null), true);
  const breakpoints = await frontend.evaluate(async () => {
    const {
      BreakpointManager,
    }: { BreakpointManager: { BreakpointManager: { instance(): { allBreakpointLocations(): unknown[] } } } } = await (
      await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
    ).modules['models/breakpoints/breakpoints.js']();
    return BreakpointManager.BreakpointManager.instance().allBreakpointLocations().length;
  });
  assert.equal(breakpoints, 0);

  // Its context menu offers no breakpoints or logpoints.
  await (await waitFor(lineNumber)).click({ button: 'right' });
  const menuText = await waitFor(async () => {
    const value = await (await query('.soft-context-menu')).evaluate(el => el?.textContent ?? '');
    return value || null;
  });
  for (const item of ['breakpoint', 'logpoint', 'Never pause here'])
    assert.ok(!menuText.toLowerCase().includes(item.toLowerCase()), menuText);
  await frontend.page().keyboard.press('Escape');
  await waitFor(async () => (await query('.soft-context-menu')).evaluate(el => el === null));
});

test('every panel opens without uncaught errors', { skip }, async () => {
  for (const panel of ['elements', 'console', 'sources', 'network', 'resources']) {
    await showPanel(panel);
    await waitFor(() => panelShowing(panel));
  }
  // Panels load lazily: errors from their first round trips come a little later.
  await new Promise(r => setTimeout(r, 1000));
  assert.deepEqual(errors, []);
});

test('the Network panel lists the document and its resources, but not DevTools itself', { skip }, async () => {
  await showPanel('network');
  await waitFor(async () => (await text()).includes('real-frontend.css'));
  const all = await text();
  assert.ok(all.includes('real-frontend.html'), 'the document');
  assert.ok(!all.includes('devtools-anywhere.iife.js'), "the bundle is DevTools' own");
  assert.ok(!all.includes('probe.iife.js'), "the probe is DevTools' own");
});

test(
  "the Sources panel lists the page's scripts and style sheets, and ignore-lists DevTools' own",
  { skip },
  async () => {
    await showPanel('sources');
    const files = () =>
      frontend.evaluate(async () => {
        // The frontend's own module, loaded from its location: its workspace backs the Sources panel.
        // The built frontend has no type declarations; only this much of it is used.
        const {
          Workspace,
          IgnoreListManager,
        }: {
          Workspace: { WorkspaceImpl: { instance(): { uiSourceCodes(): { url(): string }[] } } };
          IgnoreListManager: { IgnoreListManager: { instance(): { isUserIgnoreListedURL(url: string): boolean } } };
        } = await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['models/workspace/workspace.js']();
        const ignoreList = IgnoreListManager.IgnoreListManager.instance();
        return Workspace.WorkspaceImpl.instance()
          .uiSourceCodes()
          .map(code => ({ url: code.url(), ignored: ignoreList.isUserIgnoreListedURL(code.url()) }));
      });
    /** Whether the frontend ignore-lists each URL. */
    const ignored = (urls: string[]) =>
      frontend.evaluate(async urls => {
        const {
          IgnoreListManager,
        }: {
          IgnoreListManager: { IgnoreListManager: { instance(): { isUserIgnoreListedURL(url: string): boolean } } };
        } = await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['models/workspace/workspace.js']();
        const ignoreList = IgnoreListManager.IgnoreListManager.instance();
        return urls.map(url => ignoreList.isUserIgnoreListedURL(url));
      }, urls);
    const sources = await waitFor(async () => {
      const list = await files();
      return list.some(file => file.url.endsWith('real-frontend.js')) &&
        list.some(file => file.url.endsWith('devtools-anywhere.iife.js'))
        ? list
        : null;
    });
    // The network resources, not the debugger's per-script `debugger:///VM… name` entries.
    const find = (suffix: string) => sources.find(file => file.url.startsWith('http') && file.url.endsWith(suffix));
    assert.ok(find('/assets/real-frontend.css'), 'the style sheet');
    assert.equal(find('real-frontend.js')?.ignored, false, "the page's script");
    assert.equal(find('devtools-anywhere.iife.js')?.ignored, true, "the bundle is DevTools' own");
    assert.equal(find('probe.iife.js')?.ignored, true, "the probe is DevTools' own");
    // Where other pages load the rest of DevTools' own scripts from, and look-alikes of the page's.
    const origin = new URL(env?.baseUrl ?? '').origin;
    assert.deepEqual(
      await ignored([
        `${origin}/vendor/devtools-anywhere.iife.js`,
        `${origin}/assets/snapdom.js`,
        `${origin}/assets/my-probe.iife.js`,
        `${origin}/assets/snapdom.js.html`,
      ]),
      [true, true, false, false]
    );
  }
);

test('the screencast is off by default and shows the page when turned on', { skip }, async () => {
  await frontend.evaluate(() => {
    window.__screencastFrames = 0;
    addEventListener('message', e => {
      if (typeof e.data === 'string' && e.data.includes('"Page.screencastFrame"'))
        window.__screencastFrames = (window.__screencastFrames ?? 0) + 1;
    });
  });
  const frames = () => frontend.evaluate(() => window.__screencastFrames);
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
  // Device mode needs the shell, which can resize the page (device-mode.test.ts).
  const deviceMode = await frontend.evaluate(() => {
    const find = (root: Document | ShadowRoot): boolean =>
      !!root.querySelector('[aria-label="Toggle device toolbar"]') ||
      [...root.querySelectorAll('*')].some(el => !!el.shadowRoot && find(el.shadowRoot));
    return find(document);
  });
  assert.equal(deviceMode, false, 'no device mode outside the shell');
  await button.click();
  await waitFor(async () => ((await frames()) ?? 0) > 0);
  await button.click();
  // A frame already on its way may still come; none after that.
  await new Promise(r => setTimeout(r, 500));
  const stopped = await frames();
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(await frames(), stopped, 'turned off');

  // snapDOM was loaded for the frames, but the Network panel does not list it.
  await showPanel('network');
  await waitFor(async () => (await panelShowing('network')) && (await text()).includes('real-frontend.css'));
  assert.ok(!(await text()).includes('snapdom.js'), "snapDOM is DevTools' own");
});

test('revealing the Console in a minimized or dragged-down drawer makes room for it', { skip }, async () => {
  /** Reveals the Console as `console.log` links and the Console shortcut do, after `before` ran on the drawer. */
  const reveal = (before: 'minimize' | 'shrink') =>
    frontend.evaluate(async before => {
      // The built frontend has no type declarations; only this much of it is used.
      const {
        InspectorView,
      }: {
        InspectorView: {
          InspectorView: {
            instance(): { setDrawerMinimized(minimized: boolean): void; setDrawerSize(size: number): void };
          };
        };
      } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['ui/legacy/legacy.js']();
      const {
        Console,
        Revealer,
      }: { Console: { Console: { instance(): object } }; Revealer: { reveal(object: object): Promise<void> } } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['core/common/common.js']();
      const inspectorView = InspectorView.InspectorView.instance();
      if (before === 'minimize') inspectorView.setDrawerMinimized(true);
      else inspectorView.setDrawerSize(20);
      await Revealer.reveal(Console.Console.instance());
    }, before);
  /** The size of the Console view and whether the drawer is minimized. */
  const consoleSize = () =>
    frontend.evaluate(async () => {
      const { InspectorView }: { InspectorView: { InspectorView: { instance(): { isDrawerMinimized(): boolean } } } } =
        await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['ui/legacy/legacy.js']();
      const {
        ConsoleView,
      }: { ConsoleView: { ConsoleView: { instance(): { element: HTMLElement; isShowing(): boolean } } } } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['panels/console/console.js']();
      const view = ConsoleView.ConsoleView.instance();
      return {
        showing: view.isShowing(),
        minimized: InspectorView.InspectorView.instance().isDrawerMinimized(),
        width: view.element.offsetWidth,
        height: view.element.offsetHeight,
      };
    });
  const hasRoom = async () => {
    const size = await consoleSize();
    return size.showing && !size.minimized && size.width >= 50 && size.height >= 50;
  };
  // The Console in the drawer, under another panel.
  await showPanel('elements');
  await frontend.evaluate(async () => {
    const { ViewManager }: { ViewManager: { ViewManager: { instance(): { showView(id: string): Promise<void> } } } } =
      await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['ui/legacy/legacy.js']();
    await ViewManager.ViewManager.instance().showView('console-view');
  });
  try {
    await waitFor(hasRoom);
    await reveal('minimize');
    await waitFor(hasRoom);
    await reveal('shrink');
    await waitFor(hasRoom);
  } finally {
    await frontend.evaluate(async () => {
      const { InspectorView }: { InspectorView: { InspectorView: { instance(): { closeDrawer(): void } } } } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['ui/legacy/legacy.js']();
      InspectorView.InspectorView.instance().closeDrawer();
    });
  }
});

test(
  "a declarative tabbed pane shows the content of a tab selected later (WebMCP's call details)",
  { skip },
  async () => {
    /** The second tab's content: whether its widget is showing, its classes and its height. */
    const second = () =>
      frontend.evaluate(async () => {
        // The built frontend has no type declarations; only this much of it is used.
        const { Widget }: { Widget: { Widget: { get(element: Element): { isShowing(): boolean } | undefined } } } =
          await (
            await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
          ).modules['ui/legacy/legacy.js']();
        const el = document.getElementById('anywhere-test-tab-b');
        return (
          el && {
            showing: Widget.Widget.get(el)?.isShowing(),
            hidden: el.classList.contains('hidden'),
            height: el.offsetHeight,
          }
        );
      });
    await frontend.evaluate(async () => {
      const {
        InspectorView,
        Widget,
      }: {
        InspectorView: { InspectorView: { instance(): { contentElement: HTMLElement } } };
        Widget: {
          Widget: new (element: HTMLElement) => object;
          widgetConfig(factory: (element: HTMLElement) => object): object;
          registerWidgetConfig(element: HTMLElement, config: object): void;
        };
      } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['ui/legacy/legacy.js']();
      // As WebMCP's call details render it: <devtools-widget> tabs, the first one selected.
      const pane = document.createElement('devtools-tabbed-pane');
      pane.id = 'anywhere-test-tabs';
      pane.style.height = '200px';
      for (const id of ['a', 'b']) {
        const tab = document.createElement('devtools-widget');
        tab.id = `anywhere-test-tab-${id}`;
        tab.setAttribute('label', id);
        if (id === 'a') tab.setAttribute('selected', '');
        tab.textContent = `tab ${id}`;
        Widget.registerWidgetConfig(
          tab,
          Widget.widgetConfig(element => new Widget.Widget(element))
        );
        pane.append(tab);
      }
      InspectorView.InspectorView.instance().contentElement.append(pane);
    });
    try {
      // The second tab starts hidden, then is selected as by a click on its header.
      await waitFor(async () => (await second())?.hidden);
      await frontend.evaluate(async () => {
        const {
          Widget,
        }: { Widget: { Widget: { get(element: Element): { selectTab(id: string): void } | undefined } } } = await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['ui/legacy/legacy.js']();
        const pane = document.getElementById('anywhere-test-tabs');
        if (!pane) throw new Error('no tabbed pane');
        Widget.Widget.get(pane)?.selectTab('anywhere-test-tab-b');
      });
      await waitFor(async () => {
        const tab = await second();
        return tab?.showing && !tab.hidden && tab.height > 0;
      });
    } finally {
      await frontend.evaluate(() => document.getElementById('anywhere-test-tabs')?.remove());
    }
  }
);

test('CDP messages go only to the embedder, and only its messages are taken', { skip }, async () => {
  const origin = new URL(env?.baseUrl ?? '').origin;
  const hash = await frontend.evaluate(() => location.hash);
  const embedded = new URLSearchParams(hash.replace(/^#\??/, '')).get('embedded');
  assert.equal(embedded, origin, 'the embedder passes its origin');

  // What the frontend sends: the target origin it gives postMessage (the test message is not
  // passed on to the page's CDP session).
  const MARKER = 'devtools-anywhere-test-marker';
  // The frontend calls the page's postMessage (window.parent.postMessage), which is replaced here.
  await page.evaluate(MARKER => {
    const postMessage = window.postMessage;
    const targets: string[] = [];
    window.__targets = targets;
    window.__postMessage = postMessage;
    window.postMessage = function (this: Window, message: unknown, options?: string | WindowPostMessageOptions) {
      if (message !== MARKER)
        return postMessage.call(this, message, typeof options === 'string' ? { targetOrigin: options } : options);
      targets.push(typeof options === 'string' ? options : (options?.targetOrigin ?? '/'));
    } as typeof window.postMessage;
  }, MARKER);
  try {
    await frontend.evaluate(async MARKER => {
      // The built frontend has no type declarations; only this much of it is used.
      const {
        InspectorFrontendHost,
      }: {
        InspectorFrontendHost: { InspectorFrontendHostInstance: { sendMessageToBackend(message: string): void } };
      } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['core/host/host.js']();
      InspectorFrontendHost.InspectorFrontendHostInstance.sendMessageToBackend(MARKER);
    }, MARKER);
    assert.deepEqual(await page.evaluate(() => window.__targets), [origin]);
  } finally {
    await page.evaluate(() => {
      if (window.__postMessage) window.postMessage = window.__postMessage;
    });
  }

  // What the frontend takes: messages from the embedder, not from another window.
  const forged = JSON.stringify({ method: 'AnywhereTest.forged', params: {} });
  const sent = JSON.stringify({ method: 'AnywhereTest.sent', params: {} });
  await frontend.evaluate(async () => {
    const {
      InspectorFrontendHost,
      InspectorFrontendHostAPI,
    }: {
      InspectorFrontendHost: {
        InspectorFrontendHostInstance: {
          events: { addEventListener(type: string, listener: (event: { data: unknown }) => void): void };
        };
      };
      InspectorFrontendHostAPI: { Events: { DispatchMessage: string } };
    } = await (
      await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
    ).modules['core/host/host.js']();
    const received: unknown[] = [];
    window.__received = received;
    InspectorFrontendHost.InspectorFrontendHostInstance.events.addEventListener(
      InspectorFrontendHostAPI.Events.DispatchMessage,
      event => received.push(event.data)
    );
  });
  // From the frontend's own window, then from the embedder.
  await frontend.evaluate(forged => postMessage(forged, '*'), forged);
  await page.evaluate(sent => {
    const iframe = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
    iframe?.contentWindow?.postMessage(sent, '*');
  }, sent);
  const received = () =>
    frontend.evaluate(() =>
      (window.__received ?? []).filter(data => typeof data === 'string' && data.includes('AnywhereTest.'))
    );
  await waitFor(async () => (await received()).includes(sent));
  assert.deepEqual(await received(), [sent]);
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
      } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['ui/legacy/legacy.js']();
      const controller = DockController.DockController.instance();
      if (!controller.canDock()) throw new Error('docking is off');
      controller.setDockSide(side);
    }, side);
  const panel = () =>
    page.evaluate(() => {
      const el = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
      if (!(el instanceof HTMLElement)) return null;
      const rect = el.getBoundingClientRect();
      return { dock: el.dataset['dock'], x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
    // Sizes are in viewport units, so they fit other screens.
    const floatStyle = await page.evaluate(() => {
      const el = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
      return el instanceof HTMLElement ? [el.style.width, el.style.height] : [];
    });
    assert.match(floatStyle.join(' '), /^[\d.]+dvw [\d.]+dvh$/);

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

test("DevTools' own scripts are ignore-listed once, next to the user's rules", { skip }, async () => {
  const KEY = 'skip-stack-frames-pattern';
  const SEEDED = 'devtools-anywhere-ignore-list-seeded';
  // The stored rule, spelled out: users keep it in their settings, so a change to it is breaking.
  const OWN = '/(probe\\.iife\\.js|devtools-anywhere\\.iife\\.js|snapdom\\.js)$';
  /** Reloads the page with these preferences, and returns the rules the new frontend uses. */
  const reloadWith = async (prefs: Record<string, string | null>) => {
    // The frontend's preferences are the localStorage of its origin, the page's.
    await page.evaluate(prefs => {
      for (const [key, value] of Object.entries(prefs)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }, prefs);
    await page.reload();
    frontend = await waitFor(() => page.frames().find(f => new URL(f.url()).pathname.endsWith('/anywhere_app.html')));
    return waitFor(() =>
      frontend.evaluate(async KEY => {
        // The built frontend has no type declarations; only this much of it is used.
        const {
          Settings,
        }: {
          Settings: {
            Settings: { instance(): { moduleSetting(name: string): { getAsArray(): { pattern: string }[] } } };
          };
        } = await (
          await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
        ).modules['core/common/common.js']();
        return Settings.Settings.instance()
          .moduleSetting(KEY)
          .getAsArray()
          .map(rule => rule.pattern);
      }, KEY)
    );
  };
  const saved = await page.evaluate(
    (KEY, SEEDED) => [localStorage.getItem(KEY), localStorage.getItem(SEEDED)],
    KEY,
    SEEDED
  );
  try {
    // The user's rules are kept.
    assert.deepEqual(
      await reloadWith({ [KEY]: JSON.stringify([{ pattern: 'user-rule', disabled: false }]), [SEEDED]: null }),
      ['user-rule', OWN]
    );
    // Rules that cannot be read are the setting's default.
    assert.deepEqual(await reloadWith({ [KEY]: 'not json', [SEEDED]: null }), ['/node_modules/|^node:', OWN]);
    // Once added, the rule is not added again: the user removed it.
    assert.deepEqual(
      await reloadWith({ [KEY]: JSON.stringify([{ pattern: 'user-rule', disabled: false }]), [SEEDED]: 'true' }),
      ['user-rule']
    );
  } finally {
    await reloadWith({ [KEY]: saved[0] ?? null, [SEEDED]: saved[1] ?? null });
  }
});

test('right-clicking a node in the Elements panel opens the soft context menu', { skip }, async () => {
  await showPanel('elements');
  // The tree's <body> row (inside shadow DOM): element nodes are the ones with a "Break on" submenu in Chrome.
  const row = await waitFor(async () => {
    const handle = await frontend.evaluateHandle(() => {
      const find = (root: Document | ShadowRoot): Element | null => {
        const found = Array.from(root.querySelectorAll('.elements-tree-outline [role="treeitem"]')).find(el =>
          el.textContent?.startsWith('<body')
        );
        if (found) return found;
        for (const el of root.querySelectorAll('*')) {
          const inShadow = el.shadowRoot && find(el.shadowRoot);
          if (inShadow) return inShadow;
        }
        return null;
      };
      return find(document);
    });
    // asElement() is typed as a handle to any Node; the page function returns an Element or null.
    return handle.asElement() as ElementHandle<Element> | null;
  });
  await row.click({ button: 'right' });
  // Without SetUseSoftMenu the frontend asks the host for a native menu and nothing shows.
  const menuShown = () =>
    frontend.evaluate(() => {
      const find = (root: Document | ShadowRoot): boolean =>
        !!root.querySelector('.soft-context-menu') ||
        Array.from(root.querySelectorAll('*')).some(el => !!el.shadowRoot && find(el.shadowRoot));
      return find(document);
    });
  await waitFor(menuShown);
  // DOM breakpoints need a debugger that pauses, which the page cannot have: no "Break on" submenu.
  const menuText = await frontend.evaluate(() => {
    const find = (root: Document | ShadowRoot): string | null => {
      const menu = root.querySelector('.soft-context-menu');
      if (menu) return menu.textContent;
      for (const el of root.querySelectorAll('*')) {
        const found = el.shadowRoot && find(el.shadowRoot);
        if (found) return found;
      }
      return null;
    };
    return find(document) ?? '';
  });
  assert.ok(menuText.includes('Copy'), menuText);
  assert.ok(!menuText.includes('Break on'), menuText);
  await frontend.page().keyboard.press('Escape');
  await waitFor(async () => !(await menuShown()));
});

test('hidden, DevTools leaves inspect mode and the page gets its clicks back', { skip }, async () => {
  /** Whether the toolbar's inspect button is on, after clicking it when `toggle`. */
  const inspecting = (toggle: boolean) =>
    frontend.evaluate(async toggle => {
      // The built frontend has no type declarations; only this much of it is used.
      const {
        ActionRegistry,
      }: {
        ActionRegistry: {
          ActionRegistry: {
            instance(): { getAction(id: string): { toggled(): boolean; execute(): Promise<boolean> } };
          };
        };
      } = await (
        await import(document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '')
      ).modules['ui/legacy/legacy.js']();
      const action = ActionRegistry.ActionRegistry.instance().getAction('elements.toggle-element-search');
      if (toggle) await action.execute();
      return action.toggled();
    }, toggle);
  const control = (part: string) =>
    page.evaluate(part => {
      const el = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector(part);
      if (!(el instanceof HTMLElement)) throw new Error(`no ${part}`);
      el.click();
    }, part);
  assert.equal(await inspecting(true), true);
  await control('.close');
  await waitFor(async () => !(await inspecting(false)));
  await page.evaluate(() => {
    Reflect.set(window, '__markerClicks', 0);
    document.getElementById('real-frontend-marker')?.addEventListener('click', () => {
      Reflect.set(window, '__markerClicks', Number(Reflect.get(window, '__markerClicks')) + 1);
    });
  });
  await page.click('#real-frontend-marker');
  assert.equal(await page.evaluate(() => Reflect.get(window, '__markerClicks')), 1, 'not taken by inspect mode');
  await control('.toggler');
  await waitFor(() =>
    page.evaluate(() => {
      const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
      return !!panel && getComputedStyle(panel).display !== 'none';
    })
  );
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
  // A dialog explains the mode first (no tooltip: touch screens have no hover). Cancelling it
  // keeps the page as it is.
  await (await waitFor(() => button('Keep DevTools open'))).click();
  await (await waitFor(() => button('Cancel'))).click();
  await waitFor(async () => !(await button('Reload and keep open')));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await inShell(), false);
  // Confirming with "Don't ask again" checked enters shell mode.
  await (await waitFor(() => button('Keep DevTools open'))).click();
  const confirm = await waitFor(() => button('Reload and keep open'));
  await confirm.evaluate(ok => {
    // The dialog's only checkbox, next to its buttons.
    const root = ok.getRootNode();
    const checkbox =
      root instanceof ShadowRoot || root instanceof Document ? root.querySelector('devtools-checkbox') : null;
    if (!checkbox) throw new Error('no checkbox in the dialog');
    checkbox.setAttribute('checked', '');
  });
  await confirm.click();
  await waitFor(inShell);
  // While it is on, an info bar says so.
  await waitFor(async () => {
    frontend = await waitFor(() => page.frames().find(f => f.url().includes('anywhere_app.html')));
    return (await text()).includes('DevTools stays open across reloads');
  });
  await (await waitFor(() => button('Stop keeping DevTools open'))).click();
  await waitFor(async () => !(await inShell()));
  // Asked not to, the dialog is skipped the next time.
  await (await waitFor(() => button('Keep DevTools open'))).click();
  await waitFor(inShell);
  assert.equal(await button('Reload and keep open'), null);
  await waitFor(async () => {
    frontend = await waitFor(() => page.frames().find(f => f.url().includes('anywhere_app.html')));
    return (await text()).includes('DevTools stays open across reloads');
  });
  await (await waitFor(() => button('Stop keeping DevTools open'))).click();
  await waitFor(async () => !(await inShell()));
});
