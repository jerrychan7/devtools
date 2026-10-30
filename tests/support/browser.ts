// Launches headless Chrome with the repository's static server, for the tests that drive pages.
import puppeteer, { type Browser, type Frame, type Page } from 'puppeteer-core';
import { startServer } from '../../playground/server.ts';

const CHROME = process.env['CHROME_PATH'] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface Env {
  baseUrl: string;
  browser: Browser;
  close(): Promise<void>;
}

/** `args` are extra Chrome flags, e.g. to turn on an experimental feature. */
export async function launch(args: string[] = []): Promise<Env> {
  const server = await startServer(0);
  let browser: Browser;
  try {
    // A call that hangs fails after 30s rather than Puppeteer's default 180s.
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args, protocolTimeout: 30_000 });
  } catch (e) {
    // Otherwise the listening server keeps the worker alive and hides the launch error.
    server.close();
    throw e;
  }
  return {
    baseUrl: server.url,
    browser,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/**
 * Sends a request from the DevTools frontend in the panel's iframe to its element (embedder.ts),
 * as the frontend does on the user's behalf: its dock side menu, its close button, its lock
 * button (`keep-open`).
 */
export async function frontendRequest(page: Page, request: object): Promise<void> {
  const frame = await page.waitForFrame(
    frame => frame.parentFrame() === page.mainFrame() && /frontend/.test(frame.url())
  );
  await frame.evaluate(request => parent.postMessage({ devtoolsAnywhere: request }, '*'), request);
}

/** Chooses a dock side as the user does, from DevTools' main menu. */
export const chooseDockSide = (page: Page, side: string) => frontendRequest(page, { type: 'dock', side });

/** Whether the user sees DevTools: the panel of the page's <devtools-anywhere> is shown. */
export const devtoolsShown = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });

/** Clicks the F12 button, as the user does to open DevTools; in shell mode, in the page iframe's `frame`. */
export async function clickF12(page: Page | Frame): Promise<void> {
  const handle = await page.waitForFunction(() => {
    const button = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return button instanceof HTMLElement && getComputedStyle(button).display !== 'none' ? button : null;
  });
  await page.evaluate(button => button instanceof HTMLElement && button.click(), handle);
}
