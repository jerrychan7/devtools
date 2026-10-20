// Remote debugging: a page connects to @devtools-anywhere/remote-server, and DevTools (a stand-in
// client here, and the real frontend when it is built) inspects it through the server.
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { startRemoteServer, type RemoteServer } from '@devtools-anywhere/remote-server';
import { launch, type Env } from '../conformance/harness.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));

let env: Env;
let remote: RemoteServer;
let page: Page;
const TOKEN = 'test-token';

interface Listed {
  id: string;
  title: string;
  url: string;
  connected: boolean;
  clients: number;
  devtoolsFrontendUrl: string;
  webSocketDebuggerUrl: string;
}

before(async () => {
  env = await launch();
  remote = await startRemoteServer({ port: 0, host: '127.0.0.1', token: TOKEN });
  page = await env.browser.newPage();
  await page.goto(`${env.baseUrl}/tests/e2e/remote-page.html?remote=${encodeURIComponent(origin() + '/')}`);
});
after(async () => {
  await env.close();
  await remote.close();
});

const origin = () => new URL(remote.url).origin;

async function waitFor<T>(get: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await Promise.resolve()
      .then(get)
      .catch(() => null);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 100));
  }
}

const targets = async (): Promise<Listed[]> => (await fetch(`${origin()}/json/list?token=${TOKEN}`)).json();
const target = () => waitFor(async () => (await targets()).find(t => t.title === 'remote page'));

/** A stand-in DevTools: sends commands and keeps every message it receives. */
class Client {
  readonly messages: { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown }[] = [];
  closed: number | undefined;
  private seq = 0;
  readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = event => this.messages.push(JSON.parse(String(event.data)));
    socket.onclose = event => (this.closed = event.code);
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new Client(socket);
  }

  async call(method: string, params: object = {}) {
    const id = ++this.seq;
    this.socket.send(JSON.stringify({ id, method, params }));
    return waitFor(() => this.messages.find(m => m.id === id));
  }

  logged(text: string) {
    return this.messages.some(m => m.method === 'Runtime.consoleAPICalled' && JSON.stringify(m.params).includes(text));
  }
}

test('the target list and client connections need the token', async () => {
  assert.equal((await fetch(`${origin()}/`)).status, 401);
  assert.equal((await fetch(`${origin()}/json/list`)).status, 401);
  assert.equal((await fetch(`${origin()}/?token=${TOKEN}`)).status, 200);
  const { id } = await target();
  await assert.rejects(Client.connect(`ws://${new URL(origin()).host}/client/${id}`));
});

test('the page is listed, and its own connection is not one of its requests', async () => {
  const listed = await target();
  assert.ok(listed.url.includes('/tests/e2e/remote-page.html'));
  assert.ok(listed.devtoolsFrontendUrl.startsWith('/front_end/anywhere_app.html?ws='));
  const client = await Client.connect(listed.webSocketDebuggerUrl);
  await client.call('Network.enable');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!client.messages.some(m => m.method === 'Network.webSocketCreated'));
  client.socket.close();
});

test('a client sees output from before the page connected', async () => {
  const client = await Client.connect((await target()).webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await waitFor(() => client.logged('remote early'));
  client.socket.close();
});

test('DevTools stays connected across a reload, and the new page replays its output', async () => {
  const client = await Client.connect((await target()).webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await waitFor(() => client.logged('remote early'));
  const before = await page.evaluate(() => performance.timeOrigin);
  client.messages.length = 0;
  await page.reload();
  await waitFor(() => client.messages.some(m => m.method === 'Page.frameNavigated'));
  // Replayed by the new page instance: its own early output, logged with its time origin.
  await waitFor(() =>
    client.messages.some(
      m => m.method === 'Runtime.consoleAPICalled' && !JSON.stringify(m.params).includes(String(before))
    )
  );
  assert.equal(client.closed, undefined);
  const { result } = await client.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  assert.deepEqual(result, { result: { type: 'string', value: 'remote page' } });
  client.socket.close();
});

test('two clients inspect the page at once, each in a session of its own', async () => {
  const listed = await target();
  const first = await Client.connect(listed.webSocketDebuggerUrl);
  await first.call('Runtime.enable');
  await waitFor(() => first.logged('remote early'));
  const second = await Client.connect(listed.webSocketDebuggerUrl);
  // Runtime.enable replays the output for the second session too, and only to it.
  const before = first.messages.length;
  await second.call('Runtime.enable');
  await waitFor(() => second.logged('remote early'));
  await waitFor(async () => (await target()).clients === 2);
  // Output from now on reaches both.
  await page.evaluate(() => console.log('remote both'));
  await waitFor(() => first.logged('remote both') && second.logged('remote both'));
  assert.ok(!first.messages.slice(before).some(m => JSON.stringify(m).includes('remote early')));
  // Remote objects are the session's own: ending one session leaves the other's working.
  const { result } = await first.call('Runtime.evaluate', { expression: '({ a: 1 })' });
  const objectId = JSON.stringify(result).match(/"objectId":"([^"]+)"/)?.[1];
  assert.ok(objectId);
  second.socket.close();
  await waitFor(async () => (await target()).clients === 1);
  const props = await first.call('Runtime.getProperties', { objectId, ownProperties: true });
  assert.ok(JSON.stringify(props.result).includes('"name":"a"'));
  assert.equal(first.closed, undefined);
  first.socket.close();
});

test('the handlers mount in a server of its own, under a base path, with a public URL', async () => {
  const { createServer } = await import('node:http');
  const { createRemoteHandler } = await import('@devtools-anywhere/remote-server');
  const handler = createRemoteHandler({
    basePath: '/devtools/',
    token: false,
    publicUrl: 'https://debug.example/devtools/',
    frontendUrl: 'https://cdn.example/anywhere_app.html',
  });
  const server = createServer((req, res) => {
    if (!handler.handleRequest(req, res)) res.end('app');
  });
  server.on('upgrade', (req, socket, head) => handler.handleUpgrade(req, socket, head) || socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    assert.equal(await (await fetch(`http://${host}/other`)).text(), 'app');
    assert.ok((await (await fetch(`http://${host}/devtools/probe.iife.js`)).text()).length > 1000);
    assert.ok((await (await fetch(`http://${host}/devtools/`)).text()).includes('https://debug.example/devtools/'));
    // A page connects under the base path, and the list opens the frontend from the CDN.
    const ws = new WebSocket(`ws://${host}/devtools/target/mounted`);
    await new Promise(resolve => (ws.onopen = resolve));
    ws.send(
      JSON.stringify({
        method: 'DevtoolsAnywhere.hello',
        params: { loaderId: 'l', url: 'https://x/', title: 'mounted' },
      })
    );
    const listed = await waitFor(async (): Promise<Listed | undefined> =>
      ((await (await fetch(`http://${host}/devtools/json/list`)).json()) as Listed[]).find(t => t.title === 'mounted')
    );
    assert.equal(
      listed.devtoolsFrontendUrl,
      `https://cdn.example/anywhere_app.html?ws=${encodeURIComponent(`${host}/devtools/client/mounted`)}`
    );
    // A page that went away stays listed for a while, to come back.
    ws.close();
    await waitFor(async () => {
      const all = (await (await fetch(`http://${host}/devtools/json/list`)).json()) as Listed[];
      return all.find(t => t.id === 'mounted')?.connected === false;
    });
  } finally {
    handler.close();
    server.close();
  }
});

test('the printed script tag names the public URL', () => {
  assert.equal(remote.scriptTag, `<script src="${remote.publicUrl}probe.iife.js" data-remote></script>`);
});

test(
  'the real frontend inspects the page through the server',
  { skip: built ? false : 'frontend not built' },
  async () => {
    const listed = await target();
    const devtools = await env.browser.newPage();
    await devtools.goto(origin() + listed.devtoolsFrontendUrl);
    const frame: Frame = devtools.mainFrame();
    // The Elements panel, which it opens on, shows the page.
    await waitFor(() =>
      frame.evaluate(() => {
        const parts: (string | null)[] = [];
        const walk = (root: Document | ShadowRoot) => {
          parts.push(root === document ? document.documentElement.textContent : root.textContent);
          for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(document);
        return parts.join('\n').includes('remote-marker');
      })
    );
    await devtools.close();
  }
);
