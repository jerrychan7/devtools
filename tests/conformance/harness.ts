// Runs real Chrome's CDP and our in-page CDP server side by side on the same page, so a
// single action in the page produces events from both that can be compared.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../playground/server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CDP_BUNDLE = path.join(root, 'packages/cdp-server/dist/cdp-server.iife.js');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Keys whose values legitimately differ between implementations. */
export const VOLATILE = new Set([
  'objectId',
  'timestamp',
  'wallTime',
  'executionContextId',
  'scriptId',
  'exceptionId',
  'uniqueId',
  'requestId',
  'loaderId',
  'frameId',
  'stackTrace',
  'initiator',
]);

export async function launch() {
  const server = await startServer(0);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  return {
    baseUrl: server.url,
    browser,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

export async function openPage(env, events) {
  const page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/tests/conformance/fixture.html');
  const session = await page.createCDPSession();
  const chromeEvents = [];
  for (const name of events) session.on(name, params => chromeEvents.push({ method: name, params }));

  await page.addScriptTag({ path: CDP_BUNDLE });
  await page.evaluate(() => {
    const server = window.DevtoolsAnywhereCdp.createCdpServer();
    window.__ours = [];
    server.onMessage(m => {
      const msg = JSON.parse(m);
      if (msg.method) window.__ours.push(msg);
    });
    window.__server = server;
  });

  const chrome = {
    send: (method, params) => session.send(method, params),
    events: method => chromeEvents.filter(e => e.method === method).map(e => e.params),
    clear: () => (chromeEvents.length = 0),
  };
  const ours = {
    send: (method, params) => page.evaluate((m, p) => window.__server.call(m, p), method, params),
    events: method => page.evaluate(m => window.__ours.filter(e => e.method === m).map(e => e.params), method),
    clear: () => page.evaluate(() => (window.__ours.length = 0)),
  };
  return { page, chrome, ours };
}

/** Waits until both sides have emitted at least `count` events of `method`. */
export async function waitForBoth(t, method, count = 1, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const [a, b] = [t.chrome.events(method), await t.ours.events(method)];
    if (a.length >= count && b.length >= count) return [b, a];
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${method}: chrome=${a.length} ours=${b.length}`);
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

/** Fields that must be present whenever Chrome emits them. */
export const REQUIRED = new Set([
  'type',
  'subtype',
  'className',
  'description',
  'value',
  'unserializableValue',
  'preview',
  'properties',
  'entries',
  'overflow',
  'name',
  'text',
  'exception',
  'result',
  'exceptionDetails',
]);

/**
 * Checks that every field we emit matches Chrome's. We may emit fewer fields, except the
 * ones in REQUIRED. Returns a list of human-readable differences.
 */
export function diffSubset(ours, chrome, at = '$') {
  if (ours === chrome) return [];
  if (typeof ours !== 'object' || ours === null || typeof chrome !== 'object' || chrome === null) {
    return [`${at}: ours=${JSON.stringify(ours)} chrome=${JSON.stringify(chrome)}`];
  }
  if (Array.isArray(ours) !== Array.isArray(chrome)) return [`${at}: array mismatch`];
  if (Array.isArray(ours) && ours.length !== chrome.length) {
    return [`${at}: length ours=${ours.length} chrome=${chrome.length}`];
  }
  const diffs = [];
  for (const key of Object.keys(chrome)) {
    if (REQUIRED.has(key) && !(key in ours)) diffs.push(`${at}.${key}: missing in ours`);
  }
  for (const key of Object.keys(ours)) {
    if (VOLATILE.has(key)) continue;
    if (!(key in chrome)) {
      diffs.push(`${at}.${key}: only in ours (${JSON.stringify(ours[key])})`);
      continue;
    }
    diffs.push(...diffSubset(ours[key], chrome[key], `${at}.${key}`));
  }
  return diffs;
}

/** Lists fields Chrome emits that we do not, for information. */
export function missingFields(ours, chrome, at = '$') {
  if (typeof chrome !== 'object' || chrome === null || typeof ours !== 'object' || ours === null) return [];
  const missing = [];
  for (const key of Object.keys(chrome)) {
    if (VOLATILE.has(key)) continue;
    if (!(key in ours)) missing.push(`${at}.${key}`);
    else missing.push(...missingFields(ours[key], chrome[key], `${at}.${key}`));
  }
  return missing;
}
