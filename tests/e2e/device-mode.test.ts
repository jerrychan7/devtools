// Device mode in shell mode, with the DevTools frontend built from the official sources: the
// frontend lays out the page and itself as in Chrome (shell-layout.ts), and device mode sizes the
// page. Skipped when the frontend has not been built. The tests run in order, each from where the
// previous one left the page.
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));
const skip = built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first';

let env: Env | undefined;
let page: Page;
/** Uncaught errors in the shell, the frontend and the toolbox. */
const errors: string[] = [];

before(async () => {
  if (!built) return;
  env = await launch();
  page = await env.browser.newPage();
  page.on('pageerror', error => errors.push(error instanceof Error ? error.message : String(error)));
  await page.setViewport({ width: 1000, height: 800 });
  await page.goto(env.baseUrl + '/tests/e2e/pages/device-mode.html');
});
after(() => env?.close());

async function waitFor<T>(get: () => T | Promise<T>, what = 'condition', timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await Promise.resolve()
      .then(get)
      .catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

const frontend = () => waitFor(() => page.frames().find(f => f.url().includes('anywhere_app.html')), 'the frontend');

/** Runs an action of the frontend's (UI.ActionRegistry), as its toolbar button or menu item would. */
async function runAction(id: string) {
  await (
    await frontend()
  ).evaluate(async id => {
    const script = document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '';
    // The built frontend has no type declarations; only this much of it is used.
    const UI: {
      ActionRegistry: { ActionRegistry: { instance(): { getAction(id: string): { execute(): Promise<unknown> } } } };
    } = await (await import(script)).modules['ui/legacy/legacy.js']();
    await UI.ActionRegistry.ActionRegistry.instance().getAction(id).execute();
  }, id);
}

/** Moves DevTools to a dock side, as the main menu's "Dock side" does. */
async function dock(side: string) {
  await (
    await frontend()
  ).evaluate(async side => {
    const script = document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '';
    const UI: { DockController: { DockController: { instance(): { setDockSide(side: string): void } } } } = await (
      await import(script)
    ).modules['ui/legacy/legacy.js']();
    UI.DockController.DockController.instance().setDockSide(side);
  }, side);
}

/** Picks a device in device mode's toolbar, in `frame` (the frontend, or undocked the toolbox). */
async function pickDevice(frame: Frame, name: string) {
  await frame.evaluate(name => {
    const find = (root: Document | ShadowRoot): HTMLSelectElement | null => {
      const found = root.querySelector<HTMLSelectElement>('select[aria-label="Device type"]');
      if (found) return found;
      for (const el of root.querySelectorAll('*')) {
        const inShadow = el.shadowRoot && find(el.shadowRoot);
        if (inShadow) return inShadow;
      }
      return null;
    };
    const select = find(document);
    if (!select) throw new Error('no device select');
    const index = [...select.options].findIndex(o => o.text === name);
    if (index < 0) throw new Error(`no device ${name}`);
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, name);
}

/** Where the page iframe is, and the page's viewport. */
const pageState = () =>
  page.evaluate(() => {
    const iframe = document.getElementById('devtools-anywhere-page');
    if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) throw new Error('no page iframe');
    const { left, top, width, height } = iframe.getBoundingClientRect();
    return {
      rect: { left, top, width, height },
      viewport: { width: iframe.contentWindow.innerWidth, height: iframe.contentWindow.innerHeight },
    };
  });

/**
 * The frontend's InspectedPagePlaceholder, where it lays out the page, in the shell's coordinates:
 * in `origin`, the frontend's frame or undocked the toolbox's.
 */
const placeholder = async (origin: Frame) => {
  const rect = await (
    await frontend()
  ).evaluate(() => {
    // The built frontend has no type declarations: AdvancedApp's placeholder, a private field.
    const app: unknown = Reflect.get(globalThis, 'Emulation')?.AdvancedApp?.instance();
    const el: unknown = app && Reflect.get(Reflect.get(app, 'inspectedPagePlaceholder'), 'element');
    if (!(el instanceof Element)) throw new Error('no placeholder');
    const { left, top, width, height } = el.getBoundingClientRect();
    return { left, top, width, height };
  });
  const offset = await (
    await origin.frameElement()
  )?.evaluate(f => {
    const { left, top } = f.getBoundingClientRect();
    return { left, top };
  });
  return { ...rect, left: rect.left + (offset?.left ?? 0), top: rect.top + (offset?.top ?? 0) };
};

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 2, `${what}: ${a} vs ${b}`);

test('in shell mode the frontend fills the shell and places the page, as in Chrome', { skip }, async () => {
  const fe = await frontend();
  const frame = await waitFor(async () => {
    const rect = await (await fe.frameElement())?.evaluate(f => f.getBoundingClientRect().toJSON());
    return rect && rect.width === 1000 && rect.height === 800 ? rect : null;
  });
  assert.ok(frame);
  // The page goes where the frontend's placeholder is, on top of it.
  const where = await waitFor(async () => {
    const [state, spot] = [await pageState(), await placeholder(fe)];
    return state.rect.height < 800 && Math.abs(state.rect.top - spot.top) <= 2 ? { state, spot } : null;
  });
  near(where.state.rect.width, where.spot.width, 'width');
  near(where.state.rect.height, where.spot.height, 'height');
  assert.equal(where.state.viewport.width, Math.round(where.state.rect.width));
  // The toolbar's device button is device mode's, not the screencast's.
  const labels = await fe.evaluate(() => {
    const out: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('[aria-label]')) out.push(el.getAttribute('aria-label') ?? '');
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  });
  assert.ok(labels.includes('Toggle device toolbar'), 'device mode button');
  assert.ok(!labels.includes('Toggle screencast'), 'no screencast button');
});

test('device mode sizes the page as the device, scaled to fit, and takes its screenshot', { skip }, async () => {
  await runAction('emulation.toggle-device-mode');
  const fe = await frontend();
  await waitFor(() => pickDevice(fe, 'iPhone SE').then(() => true));
  const state = await waitFor(async () => {
    const s = await pageState();
    return s.viewport.width === 375 && s.viewport.height === 667 ? s : null;
  });
  // Scaled to fit the room the frontend gives it.
  assert.ok(state.rect.height < 667, `scaled: ${state.rect.height}`);
  near(state.rect.width / state.rect.height, 375 / 667, 'aspect');
  // The screenshot command saves the page at the device's size (at the page's own pixel ratio):
  // the image it draws, and the link it clicks to download it (not followed here).
  await fe.evaluate(() => {
    const saved: { name?: string; width?: number; height?: number } = {};
    const convert = OffscreenCanvas.prototype.convertToBlob;
    const click = HTMLAnchorElement.prototype.click;
    Reflect.set(window, '__saved', saved);
    Reflect.set(window, '__restore', () => {
      OffscreenCanvas.prototype.convertToBlob = convert;
      HTMLAnchorElement.prototype.click = click;
    });
    OffscreenCanvas.prototype.convertToBlob = function (this: OffscreenCanvas, options) {
      Object.assign(saved, { width: this.width, height: this.height });
      return convert.call(this, options);
    };
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      saved.name = this.download;
    };
  });
  let saved: { name: string; width: number; height: number };
  try {
    await runAction('emulation.capture-screenshot');
    saved = await waitFor(
      () =>
        fe.evaluate(() => {
          const value: { name?: string; width?: number; height?: number } = Reflect.get(window, '__saved');
          return value.name ? { name: value.name, width: value.width ?? 0, height: value.height ?? 0 } : null;
        }),
      'the screenshot'
    );
  } finally {
    await fe.evaluate(() => {
      const restore: unknown = Reflect.get(window, '__restore');
      if (typeof restore === 'function') restore();
    });
  }
  assert.match(saved.name, /\(iPhone SE\)\.png$/);
  assert.equal(saved.width, 375);
  near(saved.height, 667, 'screenshot height');
});

test('hidden, the page fills the shell at its own size; shown again, device mode is back', { skip }, async () => {
  const toggle = () =>
    page.evaluate(() =>
      document
        .querySelector('devtools-anywhere')
        ?.dispatchEvent(new CustomEvent('devtools-anywhere-control', { detail: { toggle: true } }))
    );
  await toggle();
  const hidden = await waitFor(async () => {
    const s = await pageState();
    return s.viewport.width === 1000 && s.viewport.height === 800 ? s : null;
  });
  assert.deepEqual(hidden.rect, { left: 0, top: 0, width: 1000, height: 800 });
  await toggle();
  await waitFor(async () => (await pageState()).viewport.width === 375);
});

test('undocked, device mode draws into its own page under the floating panel', { skip }, async () => {
  await dock('undocked');
  try {
    const toolbox = await waitFor(() => page.frames().find(f => f.url().includes('device_mode_emulation_frame.html')));
    // Its toolbar is there, and the page goes where it says.
    // Another device than before, so that the page's size comes from this toolbar.
    await waitFor(() => pickDevice(toolbox, 'iPhone 16').then(() => true), "the toolbox's toolbar");
    const where = await waitFor(async () => {
      const [state, spot] = [await pageState(), await placeholder(toolbox).catch(() => null)];
      return spot &&
        state.viewport.width === 393 &&
        Math.abs(state.rect.left - spot.left) <= 2 &&
        Math.abs(state.rect.width - spot.width) <= 2
        ? { state, spot }
        : null;
    }, 'the page in the toolbox');
    near(where.state.rect.width, where.spot.width, 'width');
  } finally {
    await dock('bottom');
  }
  await waitFor(async () => !page.frames().some(f => f.url().includes('device_mode_emulation_frame.html')));
  await waitFor(async () => (await pageState()).rect.height < 800);
});

test('docked to the right, the page goes where the frontend says', { skip }, async () => {
  await dock('right');
  const fe = await frontend();
  // The page left of DevTools, where the placeholder is.
  try {
    await waitFor(async () => {
      const [state, spot] = [await pageState(), await placeholder(fe)];
      return (
        state.viewport.width === 393 &&
        spot.left < 500 &&
        Math.abs(state.rect.left - spot.left) <= 2 &&
        Math.abs(state.rect.top - spot.top) <= 2
      );
    }, 'the page docked right');
  } finally {
    await dock('bottom');
  }
});

test("in device mode, the grip stays on DevTools' edge, not on the device's screen", { skip }, async () => {
  const fe = await frontend();
  await waitFor(async () => {
    // DevTools' top edge, docked at the bottom, in the shell's coordinates.
    const edge = await fe.evaluate(async () => {
      const script = document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '';
      // The built frontend has no type declarations: InspectorView's element.
      const UI: { InspectorView: { InspectorView: { instance(): { element: Element } } } } = await (
        await import(script)
      ).modules['ui/legacy/legacy.js']();
      return UI.InspectorView.InspectorView.instance().element.getBoundingClientRect().top;
    });
    const offset = await (await fe.frameElement())?.evaluate(f => f.getBoundingClientRect().top);
    const grip = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('body > div > div[title="Drag to resize"]');
      return el?.getClientRects().length ? el.getBoundingClientRect().bottom : null;
    });
    return grip !== null && offset !== undefined && Math.abs(grip - (edge + offset)) <= 2;
  }, "the grip on DevTools' edge");
});

test('leaving device mode gives the page the room the frontend lays out for it', { skip }, async () => {
  await runAction('emulation.toggle-device-mode');
  const fe = await frontend();
  const where = await waitFor(async () => {
    const [state, spot] = [await pageState(), await placeholder(fe)];
    return state.viewport.width !== 393 && Math.abs(state.rect.width - spot.width) <= 2 ? { state, spot } : null;
  }, 'the page at its own size');
  near(where.state.rect.height, where.spot.height, 'height');
  assert.equal(where.state.viewport.width, Math.round(where.state.rect.width));
});

test(
  "docked, a grip on the edge between the page and DevTools, on the page's side, resizes them",
  { skip },
  async () => {
    const fe = await frontend();
    const found = await waitFor(async () => {
      const [spot, handle] = [
        await placeholder(fe),
        await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('body > div > div[title="Drag to resize"]');
          if (!el || !el.getClientRects().length) return null;
          const { top, width, height } = el.getBoundingClientRect();
          return { top, width, height, dots: el.children.length };
        }),
      ];
      // Docked at the bottom, the edge is the bottom of the page's area: the grip sits on it, above.
      return handle && Math.abs(handle.top + handle.height - (spot.top + spot.height)) <= 2 ? handle : null;
    }, 'the handle on the edge');
    // For a mouse, a grip of 36 × 12 pixels with three dots: it takes input only where it is seen.
    assert.deepEqual(
      { width: found.width, height: found.height, dots: found.dots },
      { width: 36, height: 12, dots: 3 }
    );
  }
);

test('on a touch screen, a handle on the edge between the page and DevTools resizes them', { skip }, async () => {
  // A touch screen, as the shell sees it; a resize lays the shell out again.
  await page.evaluate(() => {
    const matchMedia = window.matchMedia.bind(window);
    Reflect.set(window, '__matchMedia', window.matchMedia);
    window.matchMedia = query => (query === '(pointer: coarse)' ? matchMedia('all') : matchMedia(query));
    window.dispatchEvent(new Event('resize'));
  });
  /** The handle's center, once shown. */
  const handle = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('body > div > div[title="Drag to resize"]');
      if (!el || !el.getClientRects().length) return null;
      const { left, top, width, height } = el.getBoundingClientRect();
      return { x: left + width / 2, y: top + height / 2 };
    });
  try {
    const start = await waitFor(handle, 'the touch handle');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y - 150, { steps: 5 });
    await page.mouse.up();
    // DevTools took the room (as much as its minimum sizes allow): the edge, and the handle on it,
    // moved up.
    await waitFor(async () => {
      const now = await handle();
      return now && now.y < start.y - 100;
    }, 'the handle to move up');
  } finally {
    await page.evaluate(() => {
      const original: unknown = Reflect.get(window, '__matchMedia');
      if (original instanceof Function) window.matchMedia = query => Reflect.apply(original, window, [query]);
      window.dispatchEvent(new Event('resize'));
    });
  }
});

test("device mode's page is only one next to the frontend's", { skip }, async () => {
  // Same origin as the frontend, but not its page: refused.
  await (
    await frontend()
  ).evaluate(() =>
    parent.postMessage({ devtoolsAnywhere: { type: 'toolbox', url: '/tests/e2e/pages/device-mode.html' } }, '*')
  );
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => document.querySelectorAll('body > iframe[title="Device mode"]').length), 0);
});

test('removed from the shell, the element leaves the page filling it, not placed', { skip }, async () => {
  const style = await page.evaluate(() => {
    document.querySelector('devtools-anywhere')?.remove();
    const frame = document.getElementById('devtools-anywhere-page');
    return frame && { position: frame.style.position, transform: frame.style.transform, height: frame.style.height };
  });
  assert.deepEqual(style, { position: '', transform: '', height: '' });
});

test('no uncaught errors', { skip }, () => {
  assert.deepEqual(errors, []);
});
