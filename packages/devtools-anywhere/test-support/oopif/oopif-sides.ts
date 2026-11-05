// The two sides compared by the end-to-end tests of cross-origin iframes as child targets: Chrome,
// and our agent in the same pages (frame-link-parent.html holding frame-link-child.html, both with
// the probe, trusting each other), each set up as the frontend sets up a page and its iframe target.
import type { Page } from 'puppeteer-core';
import type { Env } from '../../../../tests/support/browser.ts';
import { FRONTEND_ENABLES, fixtureUrl, OopifPage, THIRD_HOST } from './oopif.ts';

/** A message a client got: an event with the session it came on ('' for the root's). */
export interface Received {
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

/** One side of the comparison, set up as the frontend sets up a page and its iframe target. */
export interface Side {
  /** A command's result, or its error's message; on the root's session unless `sessionId` is given. */
  send(method: string, params?: object, sessionId?: string): Promise<Record<string, unknown> | string>;
  events(): Promise<Received[]>;
  /** The root's target id, the child's session and the child's target id. */
  readonly root: string;
  readonly child: string;
  readonly childTarget: string;
  /**
   * Runs `expression` in the parent's page or the iframe's and waits for its value: through the
   * page itself, not the agent compared (whose Runtime.evaluate needs the panel's evaluator).
   */
  run(expression: string, inChild?: boolean): Promise<unknown>;
  close(): Promise<void> | void;
}

export const get = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

/**
 * The pages compared: the parent on localhost, its iframe on 127.0.0.1, both with the probe, trusting
 * each other. With `nested`, the iframe has one of its own on THIRD_HOST, the same page, which it
 * trusts both ways; the parent trusts that origin too, for the iframe to be pointed at it.
 */
export function linkedUrl(env: Env, { nested = false } = {}): string {
  const childUrl = new URL(fixtureUrl(env, 'frame-link-child.html', '127.0.0.1'));
  const parentOrigin = new URL(fixtureUrl(env, '')).origin;
  const thirdOrigin = new URL(fixtureUrl(env, '', THIRD_HOST)).origin;
  childUrl.searchParams.set('parentOrigins', parentOrigin);
  if (nested) {
    const grandchildUrl = new URL(fixtureUrl(env, 'frame-link-child.html', THIRD_HOST));
    grandchildUrl.searchParams.set('parentOrigins', childUrl.origin);
    childUrl.searchParams.set('frameOrigins', thirdOrigin);
    childUrl.searchParams.set('grandchild', grandchildUrl.href);
  }
  const parentUrl = new URL(fixtureUrl(env, 'frame-link-parent.html'));
  parentUrl.searchParams.set('frameOrigins', nested ? `${childUrl.origin} ${thirdOrigin}` : childUrl.origin);
  parentUrl.searchParams.set('child', childUrl.href);
  return parentUrl.href;
}

/** Chrome, through OopifPage, which sets up the child as the frontend does. */
export async function chromeSide(env: Env, options: { nested?: boolean } = {}): Promise<Side> {
  const page = await OopifPage.open(env, linkedUrl(env, options));
  await page.child('frame-link-child');
  if (options.nested) await page.child(THIRD_HOST);
  // The page's own iframe: the grandchild is the same page, on its session.
  const own = page.children.find(c => c.parent === page.sessionId);
  const child = own?.sessionId ?? '';
  const childTarget = own?.targetId ?? '';
  await page.cdp.settle();
  return {
    root: page.targetId,
    child,
    childTarget,
    send: (method, params = {}, sessionId = '') =>
      // Any method: the comparison reads the replies loosely.
      Reflect.apply(page.cdp.send, page.cdp, [method, params, sessionId || page.sessionId]).then(
        (result: unknown) => ({ ...Object(result) }),
        (e: unknown) => String(e instanceof Error ? e.message : e).replace(`${method}: `, '')
      ),
    events: async () =>
      page.cdp.log
        .filter(e => e.sessionId !== '')
        .map(e => ({ ...e, sessionId: e.sessionId === page.sessionId ? '' : e.sessionId })),
    run: async (expression, inChild = false) => {
      const reply = await page.cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        inChild ? child : page.sessionId
      );
      return reply.result.value;
    },
    close: () => page.close(),
  };
}

/**
 * Our agent in the parent page, with a flatten client in the page, which sets up each target it
 * is attached to as the frontend does: Page, Runtime, DOM and Network enabled on its session,
 * auto-attach on it too, then resumed.
 */
export async function oursSide(env: Env, options: { nested?: boolean } = {}): Promise<Side> {
  const page: Page = await env.browser.newPage();
  await page.goto(linkedUrl(env, options));
  await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  await page.evaluate(enables => {
    const session = window.DevtoolsAnywhere.createCdpSession();
    const log: Record<string, unknown>[] = [];
    const pending = new Map<number, (reply: Record<string, unknown>) => void>();
    let seq = 0;
    const send = (method: string, params: object = {}, sessionId = '') =>
      new Promise<Record<string, unknown>>(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        void session.dispatch(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const setUp = async (sessionId: string, waiting: boolean) => {
      for (const method of enables) await send(method, {}, sessionId);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      if (waiting) await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    };
    session.onMessage(message => {
      const parsed: Record<string, unknown> = { ...Object(JSON.parse(message)) };
      const id = parsed['id'];
      if (typeof id === 'number') return pending.get(id)?.(parsed);
      log.push(parsed);
      // Each target as it comes, as the frontend sets one up (the page's own below).
      const params: unknown = parsed['params'];
      const child = typeof params === 'object' && params !== null ? Reflect.get(params, 'sessionId') : undefined;
      if (parsed['method'] === 'Target.attachedToTarget' && typeof child === 'string')
        void setUp(child, Reflect.get(Object(params), 'waitingForDebugger') === true);
    });
    window.__client = { log, send };
  }, FRONTEND_ENABLES);
  const send: Side['send'] = async (method, params = {}, sessionId = '') => {
    const reply = await page.evaluate((m, p, s) => window.__client?.send(m, p, s), method, params, sessionId);
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
  await send('Target.getTargetInfo');
  let attached: Received | undefined;
  for (const start = Date.now(); !attached; await new Promise(r => setTimeout(r, 20))) {
    attached = (await events()).find(e => e.sessionId === '' && e.method === 'Target.attachedToTarget');
    if (Date.now() - start > 5000) throw new Error('the iframe was not attached');
  }
  const child = String(attached.params['sessionId']);
  // Settled: no event for a while.
  for (let seen = -1, now = 0; seen !== now; await new Promise(r => setTimeout(r, 300))) {
    seen = now;
    now = (await events()).length;
  }
  const root = String(get(get(await send('Target.getTargetInfo'), 'targetInfo'), 'targetId'));
  return {
    root,
    child,
    childTarget: String(get(attached.params['targetInfo'], 'targetId')),
    send,
    events,
    run: (expression, inChild = false) => {
      const frame = inChild ? page.mainFrame().childFrames()[0] : page.mainFrame();
      if (!frame) throw new Error('no iframe');
      return frame.evaluate(expression);
    },
    close: () => page.close(),
  };
}
