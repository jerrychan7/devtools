// Two clients of one page attaching the same cross-origin iframe target, ours against Chrome on the
// same pages (oopif-sides.ts, linkedUrl): as when a human uses the in-page DevTools while an agent
// is connected remotely. In Chrome each client gets a session of its own with the target; what it
// enables there is its own. See test-support/oopif/oopif-notes.md (Clients).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { get, linkedUrl } from '../../../../test-support/oopif/oopif-sides.ts';
import { launchOopif, RawCdp } from '../../../../test-support/oopif/oopif.ts';
import type { Env } from '../../../../test-support/conformance.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

/** A client of the page: its commands (on its root session unless `sessionId` is given) and its events. */
interface Client {
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  events(): Promise<{ sessionId: string; method: string; params: unknown }[]>;
}

async function waitFor<T>(get: () => Promise<T | undefined>, timeout = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

/** The iframe's target, once its document has committed, with its info. */
const childInfo = (client: Client) =>
  waitFor(async () => {
    const infos = get(await client.send('Target.getTargets'), 'targetInfos');
    return Array.isArray(infos)
      ? infos.find(info => get(info, 'type') === 'iframe' && String(get(info, 'url')).includes('frame-link-child'))
      : undefined;
  });

/** Turns auto-attach on and returns the session of the iframe's target. */
async function attachChild(client: Client): Promise<string> {
  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const event = await waitFor(async () =>
    (await client.events()).find(
      e =>
        e.method === 'Target.attachedToTarget' &&
        e.sessionId === '' &&
        String(get(get(e.params, 'targetInfo'), 'url')).includes('frame-link-child')
    )
  );
  return String(get(event.params, 'sessionId'));
}

/** Chrome: two connections, each attached to the page with a flatten session. */
async function chromeClients(env: Env): Promise<{ clients: [Client, Client]; close: () => void }> {
  const first = await RawCdp.connect(env);
  const second = await RawCdp.connect(env);
  const { targetId } = await first.send('Target.createTarget', { url: linkedUrl(env) });
  const client = async (cdp: RawCdp): Promise<Client> => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return {
      send: (method, params = {}, child = '') =>
        Reflect.apply(cdp.send, cdp, [method, params, child || sessionId]).catch((e: unknown) => ({
          error: String(e),
        })),
      events: async () =>
        cdp.log
          .filter(e => e.sessionId !== '')
          .map(e => ({ ...e, sessionId: e.sessionId === sessionId ? '' : e.sessionId })),
    };
  };
  const clients: [Client, Client] = [await client(first), await client(second)];
  return {
    clients,
    close: () => {
      void first.send('Target.closeTarget', { targetId }).catch(() => {});
      first.close();
      second.close();
    },
  };
}

/** Ours: two sessions of the parent page's agent, each a client in the page. */
async function oursClients(env: Env): Promise<{ clients: [Client, Client]; close: () => Promise<void> }> {
  const page = await env.browser.newPage();
  await page.goto(linkedUrl(env));
  await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  await page.evaluate(() => {
    window.__clients = [0, 1].map(() => {
      const session = window.DevtoolsAnywhere.createCdpSession();
      const log: Record<string, unknown>[] = [];
      const pending = new Map<number, (reply: Record<string, unknown>) => void>();
      let seq = 0;
      session.onMessage(message => {
        const parsed: Record<string, unknown> = { ...Object(JSON.parse(message)) };
        const id = parsed['id'];
        if (typeof id === 'number') pending.get(id)?.(parsed);
        else log.push(parsed);
      });
      return {
        log,
        send: (method: string, params: object = {}, sessionId = '') =>
          new Promise<Record<string, unknown>>(resolve => {
            const id = ++seq;
            pending.set(id, resolve);
            void session.dispatch(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          }),
      };
    });
  });
  const client = (index: number): Client => ({
    send: async (method, params = {}, sessionId = '') => {
      const reply = await page.evaluate(
        (index, m, p, s) => window.__clients?.[index]?.send(m, p, s),
        index,
        method,
        params,
        sessionId
      );
      const error = get(reply, 'error');
      return error === undefined ? get(reply, 'result') : { error: String(get(error, 'message')) };
    },
    events: async () =>
      (await page.evaluate(index => window.__clients?.[index]?.log ?? [], index)).map(m => ({
        sessionId: String(m['sessionId'] ?? ''),
        method: String(m['method']),
        params: m['params'],
      })),
  });
  return { clients: [client(0), client(1)], close: () => page.close() };
}

const contexts = async (client: Client, sessionId: string) =>
  (await client.events()).filter(e => e.method === 'Runtime.executionContextCreated' && e.sessionId === sessionId)
    .length;
const documentUrl = async (client: Client, sessionId: string) =>
  String(get(get(await client.send('DOM.getDocument', {}, sessionId), 'root'), 'documentURL'));
const isAttached = async (client: Client, targetId: string) =>
  get(get(await client.send('Target.getTargetInfo', { targetId }), 'targetInfo'), 'attached');

for (const [name, open] of [
  ['chrome', chromeClients],
  ['ours', oursClients],
] as const) {
  test(`${name}: two clients attach the same iframe target, each with a session of its own`, async () => {
    assert.ok(env);
    const { clients, close } = await open(env);
    try {
      const [a, b] = clients;
      // Whether the target is attached before either client attaches it: Chrome's is, to the
      // test's own browser connection (puppeteer auto-attaches every target).
      const before = get(await childInfo(a), 'attached');
      const sa = await attachChild(a);
      const sb = await attachChild(b);
      assert.notEqual(sa, sb);
      const targetId = String(
        get(get((await b.events()).find(e => get(e.params, 'sessionId') === sb)?.params, 'targetInfo'), 'targetId')
      );
      assert.equal(await isAttached(b, targetId), true);

      // One client's Runtime.enable is its own.
      await a.send('Runtime.enable', {}, sa);
      await waitFor(async () => ((await contexts(a, sa)) > 0 ? true : undefined));
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await contexts(b, sb), 0);
      await b.send('Runtime.enable', {}, sb);
      await waitFor(async () => ((await contexts(b, sb)) > 0 ? true : undefined));
      assert.match(await documentUrl(a, sa), /frame-link-child/);
      assert.match(await documentUrl(b, sb), /frame-link-child/);

      // One detaches: the other's session goes on, and the target is still attached.
      await a.send('Target.detachFromTarget', { sessionId: sa });
      assert.match(await documentUrl(b, sb), /frame-link-child/);
      assert.equal(await isAttached(a, targetId), true);
      assert.ok(get(await a.send('DOM.getDocument', {}, sa), 'error'));
      await b.send('Target.detachFromTarget', { sessionId: sb });
      // Both gone: as before they came.
      assert.equal(await isAttached(a, targetId), before);
    } finally {
      await close();
    }
  });
}
