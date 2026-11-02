// The probe from an npm CDN (jsDelivr): one script tag, with the frontend of the same version found
// there, shell mode included; and a shell config pointing elsewhere on the CDN is not trusted. The
// CDN is played by the static server, through request interception: the probe's package from the
// build, the frontend's entry page from the fake frontend.
import { existsSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

const CDN = 'https://cdn.jsdelivr.net/npm/';
const PROBE = `${CDN}devtools-anywhere@9.9.9/dist/probe.iife.js`;
const FRONTEND = `${CDN}@devtools-anywhere/devtools-frontend@9.9.9/dist/anywhere_app.html`;

let env: Env | undefined;
let page: Page;
let url = '';

before(async () => {
  env = await launch();
  url = env.baseUrl + '/cdn.html';
});
after(() => env?.close());
beforeEach(async () => {
  await page?.close();
  assert.ok(env);
  page = await env.browser.newPage();
});

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));

/** Serves the page at `url`, with the probe's script tag given these attributes, and the CDN. */
async function serve(attributes = '', frontend: 'fake' | 'built' = 'fake') {
  const base = env?.baseUrl ?? '';
  const files: [string, string][] = [
    [`${CDN}devtools-anywhere@9.9.9/`, `${base}/packages/devtools-anywhere/`],
    frontend === 'fake'
      ? [FRONTEND, `${base}/tests/e2e/frontends/fake-frontend.html`]
      : [`${CDN}@devtools-anywhere/devtools-frontend@9.9.9/`, `${base}/packages/devtools-frontend/`],
    [`${CDN}evil@1.0.0/anywhere_app.html`, `${base}/tests/e2e/frontends/fake-frontend.html`],
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <script src="${PROBE}" ${attributes}></script>
    <script>window.__pageScriptRan = true;</script>
    </head><body><p>cdn</p></body></html>`;
  await page.setRequestInterception(true);
  page.on('request', (r: HTTPRequest) => {
    const at = r.url();
    if (at === url) return void r.respond({ status: 200, contentType: 'text/html', body: html });
    const file = files.find(([prefix]) => at.startsWith(prefix));
    if (!file) return void r.continue();
    // Cross-origin, as from the CDN.
    void fetch(file[1] + at.slice(file[0].length))
      .then(async response =>
        r.respond({
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          headers: { 'access-control-allow-origin': '*' },
          body: Buffer.from(await response.arrayBuffer()),
        })
      )
      // A request that fails, rather than one never answered.
      .catch(() => r.abort());
  });
}

/** The URL of the frontend iframe of the global element, once there. */
const frontendSrc = () =>
  page
    .waitForFunction(() => {
      const frame = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('iframe');
      return frame?.src || null;
    })
    .then(handle => handle.jsonValue());

test('one script tag: the frontend of the same version on the CDN, in shell mode', async () => {
  await serve('data-open-immediately');
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('devtools-anywhere[data-shell]'));
  const src = new URL((await frontendSrc()) ?? '');
  assert.equal(src.origin + src.pathname, FRONTEND);
  const config = await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell'));
  assert.equal(JSON.parse(config ?? '{}').frontend, FRONTEND);
});

test('a shell config pointing to another package on the CDN is removed and ignored', async () => {
  await serve('data-default-shell-mode="off"');
  await page.goto(url);
  await page.waitForFunction(() => window.__pageScriptRan === true);
  const evil = `${CDN}evil@1.0.0/anywhere_app.html`;
  await page.evaluate(
    (frontend, bundle) =>
      sessionStorage.setItem('devtools-anywhere:shell', JSON.stringify({ frontend, bundle, open: true })),
    evil,
    `${CDN}devtools-anywhere@9.9.9/dist/devtools-anywhere.iife.js`
  );
  await page.reload();
  // The probe ran: its own element, out of shell mode.
  await page.waitForFunction(() => document.querySelector('devtools-anywhere'));
  assert.equal(await page.evaluate(() => !!document.querySelector('devtools-anywhere[data-shell]')), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell')), null);
});

test('data-no-panel: no element, and no shell mode', async () => {
  // Only debugged remotely, at a server that is not there.
  await serve('data-no-panel data-remote="http://127.0.0.1:9/"');
  await page.goto(url);
  // The bundle has loaded, and would have mounted the element as it did.
  await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  assert.equal(await page.evaluate(() => document.querySelectorAll('devtools-anywhere').length), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('devtools-anywhere:shell')), null);
});

test(
  'the built frontend from the CDN lays out the page in shell mode',
  { skip: built ? false : 'run `pnpm --filter @devtools-anywhere/devtools-frontend build:frontend` first' },
  async () => {
    await page.setViewport({ width: 1000, height: 800 });
    await serve('data-open-immediately', 'built');
    await page.goto(url);
    // The frontend, on another origin, says where the page goes: above DevTools, docked at the bottom.
    await page.waitForFunction(
      () => {
        const frame = document.getElementById('devtools-anywhere-page');
        if (!(frame instanceof HTMLIFrameElement)) return false;
        const { top, height } = frame.getBoundingClientRect();
        return top === 0 && height > 100 && height < innerHeight - 100;
      },
      { timeout: 30000 }
    );
  }
);
