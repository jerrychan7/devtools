// Runs real Chrome's CDP and our in-page CDP agent side by side on the same page, so a
// single action in the page produces events from both that can be compared.
import type { Page } from 'puppeteer-core';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, type Env } from '../../../tests/support/browser.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CDP_BUNDLE = path.join(root, 'packages/devtools-anywhere/dist/devtools-anywhere.iife.js');
export const PROBE_BUNDLE = path.join(root, 'packages/devtools-anywhere/dist/probe.iife.js');

export { launch, type Env };

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

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;
export type EventName = keyof Events;
/** The params of a CDP event. */
export type EventParams<E extends EventName> = Events[E] extends [infer P] ? P : never;

/** One CDP implementation as seen by the tests: Chrome's own, or ours inside the page. */
export interface Side {
  send<M extends keyof Commands>(method: M, ...params: Commands[M]['paramsType']): Promise<Commands[M]['returnType']>;
  events<E extends EventName>(method: E): Promise<EventParams<E>[]>;
  clear(): Promise<void>;
}

export interface TestPage {
  page: Page;
  chrome: Side;
  ours: Side;
}

export async function openPage(env: Env, events: EventName[]): Promise<TestPage> {
  const page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  const session = await page.createCDPSession();
  const chromeEvents: { method: string; params: unknown }[] = [];
  for (const name of events) session.on(name, params => chromeEvents.push({ method: name, params }));

  await page.addScriptTag({ path: CDP_BUNDLE });
  await page.evaluate(() => {
    const session = window.DevtoolsAnywhere.createCdpSession();
    window.__ours = [];
    session.onMessage(m => {
      const msg: { method?: string; params: unknown } = JSON.parse(m);
      if (msg.method) window.__ours.push({ method: msg.method, params: msg.params });
    });
    window.__session = session;
  });

  // Both sides return what the protocol says; the casts state that our server does too,
  // which is exactly what the tests check.
  const chrome: Side = {
    // session.send is typed per method like Side['send'], but against Puppeteer's own (older)
    // devtools-protocol version, and TypeScript cannot relate the two generic signatures:
    // the implementation is checked without them.
    send: ((method: keyof Commands, params?: object) => session.send(method as never, params as never)) as Side['send'],
    events: async method =>
      chromeEvents.filter(e => e.method === method).map(e => e.params as EventParams<typeof method>),
    clear: async () => {
      chromeEvents.length = 0;
    },
  };
  const ours: Side = {
    send: async (method, ...params) => {
      const start = Date.now();
      try {
        return (await page.evaluate((m, p) => window.__session.call(m, p), method, params[0] ?? {})) as Awaited<
          ReturnType<Side['send']>
        >;
      } catch (e) {
        // Names the command, so a timeout says which call hung; other errors are compared
        // with Chrome's, so they stay as they are.
        if (e instanceof Error && /timed out/.test(e.message)) {
          e.message = `${method} (after ${Date.now() - start}ms): ${e.message}`;
        }
        throw e;
      }
    },
    events: async method =>
      (await page.evaluate(m => window.__ours.filter(e => e.method === m).map(e => e.params), method)) as EventParams<
        typeof method
      >[],
    clear: async () => {
      await page.evaluate(() => {
        window.__ours.length = 0;
      });
    },
  };
  return { page, chrome, ours };
}

/** Waits until both sides have emitted at least `count` events of `method`. */
export async function waitForBoth<E extends EventName>(
  t: TestPage,
  method: E,
  count = 1,
  timeout = 5000
): Promise<[ours: EventParams<E>[], chrome: EventParams<E>[]]> {
  const start = Date.now();
  for (;;) {
    const [a, b] = [await t.chrome.events(method), await t.ours.events(method)];
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
export function diffSubset(ours: unknown, chrome: unknown, at = '$'): string[] {
  if (ours === chrome) return [];
  if (typeof ours !== 'object' || ours === null || typeof chrome !== 'object' || chrome === null) {
    return [`${at}: ours=${JSON.stringify(ours)} chrome=${JSON.stringify(chrome)}`];
  }
  if (Array.isArray(ours) !== Array.isArray(chrome)) return [`${at}: array mismatch`];
  if (Array.isArray(ours) && Array.isArray(chrome) && ours.length !== chrome.length) {
    return [`${at}: length ours=${ours.length} chrome=${chrome.length}`];
  }
  const diffs: string[] = [];
  for (const key of Object.keys(chrome)) {
    if (REQUIRED.has(key) && !(key in ours)) diffs.push(`${at}.${key}: missing in ours`);
  }
  for (const key of Object.keys(ours)) {
    if (VOLATILE.has(key)) continue;
    if (!(key in chrome)) {
      diffs.push(`${at}.${key}: only in ours (${JSON.stringify(Reflect.get(ours, key))})`);
      continue;
    }
    diffs.push(...diffSubset(Reflect.get(ours, key), Reflect.get(chrome, key), `${at}.${key}`));
  }
  return diffs;
}

/** Lists fields Chrome emits that we do not, for information. */
export function missingFields(ours: unknown, chrome: unknown, at = '$'): string[] {
  if (typeof chrome !== 'object' || chrome === null || typeof ours !== 'object' || ours === null) return [];
  const missing: string[] = [];
  for (const key of Object.keys(chrome)) {
    if (VOLATILE.has(key)) continue;
    if (!(key in ours)) missing.push(`${at}.${key}`);
    else missing.push(...missingFields(Reflect.get(ours, key), Reflect.get(chrome, key), `${at}.${key}`));
  }
  return missing;
}
