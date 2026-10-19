// The Vite plugin injects the probe first in <head> and serves everything it needs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import devtoolsAnywhere from '../../packages/vite-plugin/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let browser;
let page;

before(async () => {
  server = await createServer({
    root: path.join(here, 'vite-app'),
    logLevel: 'silent',
    server: { port: 0, strictPort: false },
    plugins: [devtoolsAnywhere({ frontendDir: here, frontendEntry: 'fake-frontend.html', open: true })],
  });
  await server.listen();
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test('the probe is the first script to run', async () => {
  // Module scripts (like Vite's own client) are deferred; the probe must be the first classic one.
  const first = await page.evaluate(() =>
    document.head.querySelector('script:not([type="module"])').getAttribute('src')
  );
  assert.equal(first, '/@devtools-anywhere/probe.iife.js');
});

test('DevTools mounts and receives output from before any app code ran', async () => {
  const start = Date.now();
  let values = [];
  while (Date.now() - start < 8000) {
    values = await page.evaluate(() => {
      const frame = document.querySelector('devtools-anywhere')?.shadowRoot.querySelector('iframe');
      return (frame?.contentWindow.received || [])
        .filter(m => m.method === 'Runtime.consoleAPICalled')
        .map(m => m.params.args[0].value);
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
    const base = server.resolvedUrls.local[0].replace(/\/$/, '');
    const res = await fetch(base + '/@devtools-anywhere/front_end/core/i18n/locales/ja.json');
    assert.equal(res.status, 200);
    assert.equal(typeof (await res.json()), 'object');
  }
);
