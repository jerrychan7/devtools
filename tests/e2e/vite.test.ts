// The Vite plugin injects the probe first in <head> and serves everything it needs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import type { Protocol } from 'devtools-protocol';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import devtoolsAnywhere from '@devtools-anywhere/vite-plugin';

const here = path.dirname(fileURLToPath(import.meta.url));
let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let page: Page;

/** The dev server's local URL. */
const localUrl = () => {
  const url = server?.resolvedUrls?.local[0];
  assert.ok(url);
  return url;
};

before(async () => {
  server = await createServer({
    root: path.join(here, 'vite-app'),
    logLevel: 'silent',
    server: { port: 0, strictPort: false },
    plugins: [devtoolsAnywhere({ frontendDir: here, frontendEntry: 'fake-frontend.html', open: true, shell: false })],
  });
  await server.listen();
  browser = await puppeteer.launch({
    executablePath: process.env['CHROME_PATH'] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  page = await browser.newPage();
  await page.goto(localUrl());
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test('the probe is the first script to run', async () => {
  // Module scripts (like Vite's own client) are deferred; the probe must be the first classic one.
  const first = await page.evaluate(() => {
    const script = document.head.querySelector('script:not([type="module"])');
    if (!script) throw new Error('no classic script');
    return script.getAttribute('src');
  });
  assert.equal(first, '/@devtools-anywhere/probe.iife.js');
});

test('shell: false keeps the page out of shell mode', async () => {
  const shell = await page.evaluate(() =>
    document.head.querySelector('script[src="/@devtools-anywhere/probe.iife.js"]')?.getAttribute('data-shell')
  );
  assert.equal(shell, 'off');
  assert.equal(await page.evaluate(() => document.querySelector('devtools-anywhere[shell]')), null);
});

test('DevTools mounts and receives output from before any app code ran', async () => {
  const start = Date.now();
  let values: unknown[] = [];
  while (Date.now() - start < 8000) {
    values = await page.evaluate(() => {
      const frame = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
      if (frame && !frame.contentWindow) throw new Error('no frontend window');
      return (frame?.contentWindow?.received || [])
        .filter(m => m.method === 'Runtime.consoleAPICalled')
        .map(m => {
          // Messages are parsed JSON; this one is a Runtime.consoleAPICalled event.
          const arg = (m.params as Protocol.Runtime.ConsoleAPICalledEvent).args[0];
          if (!arg) throw new Error('console call without arguments');
          return arg.value;
        });
    });
    if (values.includes('vite early') && values.includes('vite module')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(values.includes('vite early'), JSON.stringify(values));
  assert.ok(values.includes('vite module'), JSON.stringify(values));
});

test(
  'locales from @devtools-anywhere/devtools-frontend-locales are served with the frontend',
  {
    skip: existsSync(path.join(here, '../../packages/devtools-frontend-locales/dist/core/i18n/locales/ja.json'))
      ? false
      : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first',
  },
  async () => {
    const base = localUrl().replace(/\/$/, '');
    const res = await fetch(base + '/@devtools-anywhere/front_end/core/i18n/locales/ja.json');
    assert.equal(res.status, 200);
    assert.equal(typeof (await res.json()), 'object');
  }
);
