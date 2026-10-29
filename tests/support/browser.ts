// Launches headless Chrome with the repository's static server, for the tests that drive pages.
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
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
 * Chooses a dock side as the user does, from DevTools' main menu: the frontend in the panel's
 * iframe asks the element (embedder.ts).
 */
export async function chooseDockSide(page: Page, side: string): Promise<void> {
  const frame = await page.waitForFrame(
    frame => frame.parentFrame() === page.mainFrame() && /frontend/.test(frame.url())
  );
  await frame.evaluate(side => parent.postMessage({ devtoolsAnywhere: { type: 'dock', side } }, '*'), side);
}
