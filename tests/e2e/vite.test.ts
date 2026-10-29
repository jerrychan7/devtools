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
import { frontendRequest } from '../support/browser.ts';

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
    plugins: [
      devtoolsAnywhere({
        devtoolsFrontendPath: path.join(here, 'frontends', 'fake-frontend.html'),
        openImmediately: true,
        defaultShellMode: 'off',
        shellModeLocked: true,
        noToggler: true,
      }),
    ],
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

test('the options become the probe script attributes', async () => {
  const attributes = await page.evaluate(() => {
    const script = document.head.querySelector('script[src="/@devtools-anywhere/probe.iife.js"]');
    if (!script) throw new Error('no probe script');
    return Object.fromEntries(
      [...script.attributes]
        .filter(a => a.name.startsWith('data-') && a.name !== 'data-devtools-frontend-url')
        .map(a => [a.name, a.value])
    );
  });
  assert.deepEqual(attributes, {
    'data-open-immediately': '',
    'data-default-shell-mode': 'off',
    'data-shell-mode-locked': '',
    'data-no-toggler': '',
  });
  // Out of shell mode, with DevTools as the options say: open, without the lock button.
  await page.waitForFunction(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    return !!panel && getComputedStyle(panel).display !== 'none';
  });
  const state = await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere');
    const src = el?.shadowRoot?.querySelector('iframe')?.getAttribute('src') ?? '';
    return {
      shell: !!el?.hasAttribute('shell'),
      locked: new URL(src, location.href).searchParams.has('shellModeLocked'),
    };
  });
  assert.deepEqual(state, { shell: false, locked: true });
  // no-toggler: no F12 button once DevTools is closed (its × button).
  await frontendRequest(page, { type: 'close' });
  const togglerShown = await page.evaluate(() => {
    const toggler = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.toggler');
    return !!toggler && getComputedStyle(toggler).display !== 'none';
  });
  assert.equal(togglerShown, false);
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

/** The probe script tag the plugin injects with `options`, from a dev server of its own. */
async function injected(options: Parameters<typeof devtoolsAnywhere>[0]) {
  const own = await createServer({
    root: path.join(here, 'vite-app'),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    plugins: [devtoolsAnywhere(options)],
  });
  try {
    const html = await own.transformIndexHtml('/', '<html><head></head><body></body></html>');
    const tag = /<script src="\/@devtools-anywhere\/probe\.iife\.js"[^>]*>/.exec(html)?.[0];
    assert.ok(tag, html);
    return tag;
  } finally {
    await own.close();
  }
}

test('idInQuery goes with remote as data-id-in-query', async () => {
  const remote = 'http://127.0.0.1:8080/';
  assert.match(await injected({ remote, idInQuery: true }), / data-remote="[^"]+" data-id-in-query[ >]/);
  assert.doesNotMatch(await injected({ remote }), /data-id-in-query/);
});

test('a devtoolsFrontendPath that is not a file serves no frontend', async () => {
  // A directory would otherwise have its parent served.
  const tag = await injected({ devtoolsFrontendPath: path.join(here, 'frontends', 'frontend-dir') });
  assert.doesNotMatch(tag, /data-devtools-frontend-url/);
});
