// The two sides compared by the end-to-end tests of sandboxed iframes merged into the parent's
// agent: Chrome, and our agent in the same pages (frame-link-parent.html, its data-frame-origins
// naming `sandboxed`, holding sandboxed-child.html in an iframe sandboxed without
// allow-same-origin, on the parent's origin, both with the probe). Chrome keeps such an iframe in
// the page's target, with no child target: so does the merge. In the style of oopif-sides.ts.
import type { Page } from 'puppeteer-core';
import type { Env } from '../../../../tests/support/browser.ts';
import { FRONTEND_ENABLES, fixtureUrl, OopifPage } from './oopif.ts';
import { get, type Received } from './oopif-sides.ts';

export { get, type Received };

/** One side of the comparison: the page's own session, as the frontend sets it up. */
export interface MergedSide {
  /** A command's result, or its error's message, on the page's session. */
  send(method: string, params?: object): Promise<Record<string, unknown> | string>;
  /** The events the page's session got. */
  events(): Promise<Received[]>;
  close(): Promise<void> | void;
}

/**
 * The pages compared: the parent on localhost trusting `frameOrigins` (`sandboxed` by default),
 * its iframe sandboxed (`allow-scripts`) showing sandboxed-child.html, of the parent's origin,
 * which trusts the parent.
 */
export function mergedUrl(env: Env, { frameOrigins = 'sandboxed' } = {}): string {
  const childUrl = new URL(fixtureUrl(env, 'sandboxed-child.html'));
  childUrl.searchParams.set('parentOrigins', new URL(fixtureUrl(env, '')).origin);
  const parentUrl = new URL(fixtureUrl(env, 'frame-link-parent.html'));
  parentUrl.searchParams.set('frameOrigins', frameOrigins);
  parentUrl.searchParams.set('sandbox', 'allow-scripts');
  parentUrl.searchParams.set('child', childUrl.href);
  return parentUrl.href;
}

/** Chrome, through OopifPage: the page's session set up as the frontend does, auto-attach on. */
export async function chromeSide(env: Env): Promise<MergedSide> {
  const page = await OopifPage.open(env, mergedUrl(env));
  await page.cdp.settle();
  return {
    send: (method, params = {}) =>
      // Any method: the comparison reads the replies loosely.
      Reflect.apply(page.cdp.send, page.cdp, [method, params, page.sessionId]).then(
        (result: unknown) => ({ ...Object(result) }),
        (e: unknown) => String(e instanceof Error ? e.message : e).replace(`${method}: `, '')
      ),
    events: async () => page.cdp.log.filter(e => e.sessionId === page.sessionId).map(e => ({ ...e, sessionId: '' })),
    close: () => page.close(),
  };
}

/**
 * Our agent in the parent page, with a flatten client in the page set up as the frontend sets up
 * a page, once the sandboxed iframe is merged.
 */
export async function oursSide(env: Env): Promise<MergedSide> {
  const page: Page = await env.browser.newPage();
  await page.goto(mergedUrl(env));
  await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  await page.waitForFunction(() => [...window.__devtoolsAnywhereTest.mergedFrames.frames()].length > 0, {
    timeout: 5000,
    polling: 50,
  });
  await page.evaluate(() => {
    const session = window.DevtoolsAnywhere.createCdpSession();
    const log: Record<string, unknown>[] = [];
    const pending = new Map<number, (reply: Record<string, unknown>) => void>();
    let seq = 0;
    const send = (method: string, params: object = {}) =>
      new Promise<Record<string, unknown>>(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        void session.dispatch(JSON.stringify({ id, method, params }));
      });
    session.onMessage(message => {
      const parsed: Record<string, unknown> = { ...Object(JSON.parse(message)) };
      const id = parsed['id'];
      if (typeof id === 'number') return pending.get(id)?.(parsed);
      log.push(parsed);
    });
    window.__client = { log, send };
  });
  const send: MergedSide['send'] = async (method, params = {}) => {
    const reply = await page.evaluate((m, p) => window.__client?.send(m, p), method, params);
    const error = get(reply, 'error');
    return error === undefined ? { ...Object(get(reply, 'result')) } : String(get(error, 'message'));
  };
  const events = async (): Promise<Received[]> =>
    (await page.evaluate(() => window.__client?.log ?? [])).map(m => ({
      sessionId: String(m['sessionId'] ?? ''),
      method: String(m['method']),
      params: { ...Object(m['params']) },
    }));
  for (const method of FRONTEND_ENABLES) await send(method);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Settled: no event for a while.
  for (let seen = -1, now = 0; seen !== now; await new Promise(r => setTimeout(r, 300))) {
    seen = now;
    now = (await events()).length;
  }
  return { send, events, close: () => page.close() };
}
