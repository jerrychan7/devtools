// The F12 button in shell mode: shown in the page iframe, where the page's `::part(toggler)` styles
// reach it, and toggling the shell's element; the shell shows its own only while the page has none.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
});
after(() => env?.close());
beforeEach(async () => {
  await page?.close();
  assert.ok(env);
  // A new tab: sessionStorage of its own, so a new shell.
  page = await env.browser.newPage();
});

const open = async (name: string) => {
  await page.goto(`${env?.baseUrl}/tests/e2e/pages/${name}`);
  await page.waitForFunction(() => document.querySelector('devtools-anywhere[data-shell]')?.isConnected);
};

/** The page iframe, once the bundle has run in the page it shows. */
async function pageFrame(path: string): Promise<Frame> {
  const handle = await page.waitForFunction(
    path => {
      const frame = document.getElementById('devtools-anywhere-page');
      if (!(frame instanceof HTMLIFrameElement)) return null;
      try {
        const win = frame.contentWindow;
        return win?.location.pathname.endsWith(path) && Reflect.get(win, 'DevtoolsAnywhere') ? frame : null;
      } catch {
        return null;
      }
    },
    {},
    path
  );
  const frame = await handle.asElement()?.contentFrame();
  assert.ok(frame);
  return frame;
}

/** The F12 button's state in `target`'s document (the shell or the page iframe), null without one. */
const togglerIn = (target: Page | Frame) =>
  target.evaluate(() => {
    const host = document.querySelector('devtools-anywhere');
    const toggler = host?.shadowRoot?.querySelector('.toggler');
    if (!host || !toggler) return null;
    const r = toggler.getBoundingClientRect();
    return {
      inHtml: host.parentElement === document.documentElement,
      shown: getComputedStyle(toggler).display !== 'none',
      inTopLayer: toggler.matches(':popover-open'),
      background: getComputedStyle(toggler).backgroundColor,
      hostHeight: host.getBoundingClientRect().height,
      box: [r.left, r.top, r.width, r.height].map(Math.round),
    };
  });

const shellOpen = () =>
  page.evaluate(() => {
    const panel = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });

test('the page iframe shows the F12 button, styled by the page, and it toggles the shell', async () => {
  await open('default-shell.html');
  const frame = await pageFrame('default-shell.html');
  await frame.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none';
  });
  // The shell's own button is hidden while the page shows one.
  await page.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display === 'none';
  });
  // Laid out as the global element outside the shell: under <html>, in the top layer, no box of its own.
  await frame.evaluate(() =>
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style>devtools-anywhere::part(toggler) { background: rgb(1, 2, 3); }</style>'
    )
  );
  const shown = await togglerIn(frame);
  assert.ok(shown);
  assert.equal(shown.inHtml, true);
  assert.equal(shown.shown, true);
  assert.equal(shown.inTopLayer, true);
  assert.equal(shown.hostHeight, 0);
  assert.equal(shown.background, 'rgb(1, 2, 3)', "the page's ::part(toggler) style");
  assert.equal(await frame.evaluate(() => document.querySelectorAll('devtools-anywhere').length), 1);
  // It loads no frontend.
  assert.equal(
    await frame.evaluate(() => document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe')?.src),
    ''
  );

  // Clicking opens the shell's element; the button follows it.
  await frame.evaluate(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    if (toggler instanceof HTMLElement) toggler.click();
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });
  await frame.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display === 'none';
  });
  // The page's own toggler without an id still controls the shell, not the button's element.
  await frame.evaluate(() => document.getElementById('toggle')?.click());
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display === 'none';
  });
  assert.equal(await shellOpen(), false);
  await frame.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none';
  });
  assert.equal((await togglerIn(page))?.shown, false, "the shell's own button stays hidden");
});

test('the shell shows its own F12 button while the page iframe has a page without the probe', async () => {
  await open('default-shell.html');
  await pageFrame('default-shell.html');
  await page.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display === 'none';
  });
  await page.evaluate(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    if (frame instanceof HTMLIFrameElement && frame.contentWindow) frame.contentWindow.location.href = 'no-probe.html';
  });
  await page.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none' && toggler.matches(':popover-open');
  });
  // Back to a page with the probe: the page shows the button again, the shell hides its own.
  await page.evaluate(() => {
    const frame = document.getElementById('devtools-anywhere-page');
    if (frame instanceof HTMLIFrameElement && frame.contentWindow)
      frame.contentWindow.location.href = 'default-shell.html';
  });
  const frame = await pageFrame('default-shell.html');
  await frame.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none';
  });
  await page.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display === 'none';
  });
});

test('with data-no-toggler, neither the shell nor the page iframe has an F12 button', async () => {
  await open('locked-on.html');
  const frame = await pageFrame('locked-on.html');
  // Its togglers work: the bundle has run in the page, which mounts the button then, or once the
  // page is parsed (DOMContentLoaded) if it is still loading.
  await frame.waitForFunction(
    () => document.getElementById('toggle')?.getAttribute('aria-expanded') && document.readyState !== 'loading'
  );
  assert.equal(await togglerIn(frame), null);
  assert.equal((await togglerIn(page))?.shown, false);
});

/** Whether the shell shows its own F12 button. */
const shellTogglerShown = (shown: boolean) =>
  page.waitForFunction(
    shown => {
      const toggler = document.querySelector('devtools-anywhere[data-shell]')?.shadowRoot?.querySelector('.toggler');
      return !!toggler && (getComputedStyle(toggler).display !== 'none') === shown;
    },
    {},
    shown
  );

test("the shell shows its own F12 button while the page's is removed, and hides it once it is back", async () => {
  await open('default-shell.html');
  const frame = await pageFrame('default-shell.html');
  await frame.waitForFunction(() => document.querySelector('devtools-anywhere'));
  await shellTogglerShown(false);
  // As document.open() or replaceChildren() would.
  await frame.evaluate(() => {
    const element = document.querySelector('devtools-anywhere');
    if (element) Reflect.set(window, 'removedToggler', element);
    element?.remove();
  });
  await shellTogglerShown(true);
  await frame.evaluate(() => {
    const element: unknown = Reflect.get(window, 'removedToggler');
    if (element instanceof Element) document.documentElement.appendChild(element);
  });
  await shellTogglerShown(false);
  await frame.waitForFunction(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none';
  });
});

test('the shell shows its own F12 button once the page iframe is removed', async () => {
  await open('default-shell.html');
  const frame = await pageFrame('default-shell.html');
  await frame.waitForFunction(() => document.querySelector('devtools-anywhere'));
  await shellTogglerShown(false);
  await page.evaluate(() => document.getElementById('devtools-anywhere-page')?.remove());
  await shellTogglerShown(true);
});
