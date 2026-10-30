// Remote debugging: a page connects to @devtools-anywhere/remote-server, and DevTools (a stand-in
// client here, and the real frontend when it is built) inspects it through the server.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import { startRemoteServer, type RemoteServer } from '@devtools-anywhere/remote-server';
import { launch, type Env } from '../support/browser.ts';
import { DETACH_METHOD, HELLO_METHOD, PAGEHIDE_METHOD } from '../../packages/relay-core/src/protocol.ts';

const built = existsSync(new URL('../../packages/devtools-frontend/dist/anywhere_app.html', import.meta.url));

let env: Env;
let remote: RemoteServer;
let page: Page;
const TOKEN = 'test-token';

interface Listed {
  id: string;
  title: string;
  url: string;
  userAgent: string;
  connected: boolean;
  clients: number;
  devtoolsFrontendUrl: string;
  webSocketDebuggerUrl: string;
}

before(async () => {
  env = await launch();
  remote = await startRemoteServer({ port: 0, host: '127.0.0.1', token: TOKEN });
  page = await env.browser.newPage();
  await page.goto(`${env.baseUrl}/tests/e2e/pages/remote-page.html?remote=${encodeURIComponent(origin() + '/')}`);
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
  assert.ok(listed.url.includes('/tests/e2e/pages/remote-page.html'));
  assert.ok(listed.devtoolsFrontendUrl.startsWith('/front_end/anywhere_app.html?ws='));
  const client = await Client.connect(listed.webSocketDebuggerUrl);
  await client.call('Network.enable');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!client.messages.some(m => m.method === 'Network.webSocketCreated'));
  client.socket.close();
});

test('devtoolsFrontendPath names the entry page, served with its directory', async () => {
  const own = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    token: false,
    devtoolsFrontendPath: fileURLToPath(new URL('frontends/fake-frontend.html', import.meta.url)),
  });
  const other = await env.browser.newPage();
  try {
    const at = new URL(own.url).origin;
    await other.goto(`${env.baseUrl}/tests/e2e/pages/remote-page.html?remote=${encodeURIComponent(at + '/')}`);
    const listed = await waitFor(async () => ((await (await fetch(`${at}/json/list`)).json()) as Listed[])[0]);
    assert.ok(listed.devtoolsFrontendUrl.startsWith('/front_end/fake-frontend.html?ws='), listed.devtoolsFrontendUrl);
    const res = await fetch(at + listed.devtoolsFrontendUrl);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>fake frontend<\/title>/);
  } finally {
    await other.close();
    await own.close();
  }
});

test('a devtoolsFrontendPath that is not a file is refused', async () => {
  // Its parent would be served without the token.
  await assert.rejects(
    startRemoteServer({
      port: 0,
      host: '127.0.0.1',
      devtoolsFrontendPath: fileURLToPath(new URL('frontends/frontend-dir', import.meta.url)),
    }),
    /not a file/
  );
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
  await waitFor(() => client.messages.some(m => m.method === 'Runtime.executionContextsCleared'));
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

test('a session after one that ended gets none of its objects, node ids, $0 or $_', async () => {
  const listed = await target();
  const first = await Client.connect(listed.webSocketDebuggerUrl);
  await first.call('Runtime.enable');
  const { result } = await first.call('Runtime.evaluate', { expression: '({ a: 1 })' });
  const objectId = JSON.stringify(result).match(/"objectId":"([^"]+)"/)?.[1];
  assert.ok(objectId);
  await first.call('Runtime.evaluate', {
    expression: '"left over"',
    objectGroup: 'console',
    includeCommandLineAPI: true,
  });
  const { result: doc } = await first.call('DOM.getDocument');
  const nodeId = JSON.stringify(doc).match(/"nodeId":(\d+)/)?.[1];
  assert.ok(nodeId);
  await first.call('DOM.setInspectedNode', { nodeId: Number(nodeId) });
  first.socket.close();
  await waitFor(async () => (await target()).clients === 0);
  // The page's server is reused once the old one is reset; give it time to be.
  await new Promise(r => setTimeout(r, 300));
  const second = await Client.connect(listed.webSocketDebuggerUrl);
  await second.call('Runtime.enable');
  const props = await second.call('Runtime.getProperties', { objectId, ownProperties: true });
  assert.ok(props.error);
  const resolved = await second.call('DOM.resolveNode', { nodeId: Number(nodeId) });
  assert.ok(resolved.error);
  const { result: utils } = await second.call('Runtime.evaluate', {
    expression: '[typeof $_, typeof $0]',
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  assert.ok(JSON.stringify(utils).includes('"value":["undefined","undefined"]'), JSON.stringify(utils));
  second.socket.close();
});

test('the handlers mount in a server of its own, under a base path, with a public URL', async () => {
  const { createServer } = await import('node:http');
  const { createRemoteHandler } = await import('@devtools-anywhere/remote-server');
  const handler = createRemoteHandler({
    basePath: '/devtools/',
    token: false,
    publicUrl: 'https://debug.example/devtools/',
    devtoolsFrontendUrl: 'https://cdn.example/anywhere_app.html?v=1#x',
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
        method: HELLO_METHOD,
        params: { loaderId: 'l', url: 'https://x/', title: 'mounted' },
      })
    );
    const listed = await waitFor(async (): Promise<Listed | undefined> =>
      ((await (await fetch(`http://${host}/devtools/json/list`)).json()) as Listed[]).find(t => t.title === 'mounted')
    );
    assert.equal(
      listed.devtoolsFrontendUrl,
      `https://cdn.example/anywhere_app.html?v=1#x&ws=${encodeURIComponent(`${host}/devtools/client/mounted`)}`
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

test('with idInQuery, pages and DevTools connect at the base path itself, for hosts that route by exact path', async () => {
  const { createServer } = await import('node:http');
  const { createRemoteHandler } = await import('@devtools-anywhere/remote-server');
  const handler = createRemoteHandler({ basePath: '/bridge/', token: TOKEN, idInQuery: true });
  const server = createServer((req, res) => {
    if (!handler.handleRequest(req, res)) res.end('app');
  });
  // Like such a host: an upgrade is handed over only for the exact path it was registered at.
  const upgradedPaths: string[] = [];
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    upgradedPaths.push(pathname);
    const exact = pathname === '/bridge/' || pathname === '/bridge';
    if (!exact || !handler.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const idInQueryPage = await env.browser.newPage();
  try {
    assert.ok((await (await fetch(`http://${host}/bridge/?token=${TOKEN}`)).text()).includes('data-id-in-query'));
    await idInQueryPage.goto(
      `${env.baseUrl}/tests/e2e/pages/remote-page.html?idInQuery&remote=${encodeURIComponent(`http://${host}/bridge/`)}`
    );
    const listed = await waitFor(async (): Promise<Listed | undefined> =>
      ((await (await fetch(`http://${host}/bridge/json/list?token=${TOKEN}`)).json()) as Listed[]).find(
        t => t.title === 'remote page' && t.connected
      )
    );
    assert.equal(listed.webSocketDebuggerUrl, `ws://${host}/bridge/?client=${listed.id}&token=${TOKEN}`);
    const client = await Client.connect(listed.webSocketDebuggerUrl);
    await client.call('Runtime.enable');
    await waitFor(() => client.logged('remote early'));
    client.socket.close();
    assert.deepEqual([...new Set(upgradedPaths)], ['/bridge/']);
    // A host that registered the base path without its trailing slash routes there too.
    const bare = await Client.connect(`ws://${host}/bridge?client=${listed.id}&token=${TOKEN}`);
    await bare.call('Runtime.enable');
    await waitFor(() => bare.logged('remote early'));
    bare.socket.close();
    assert.ok(upgradedPaths.includes('/bridge'));
    // A query naming both, or neither, is not one of ours.
    for (const query of [`?target=a&client=a&token=${TOKEN}`, `?token=${TOKEN}`]) {
      const other = new WebSocket(`ws://${host}/bridge/${query}`);
      assert.equal(
        await new Promise(
          resolve => ((other.onopen = () => resolve('open')), (other.onerror = () => resolve('refused')))
        ),
        'refused'
      );
    }
  } finally {
    await idInQueryPage.close();
    handler.close();
    server.close();
  }
});

/** A stand-in page: keeps every message the relay sends it. */
async function fakePage(id: string) {
  const socket = new WebSocket(`${origin().replace('http', 'ws')}/target/${id}`);
  const received: string[] = [];
  socket.onmessage = event => received.push(String(event.data));
  await new Promise(resolve => (socket.onopen = resolve));
  const hello = (loaderId: string) =>
    socket.send(JSON.stringify({ method: HELLO_METHOD, params: { loaderId, title: id } }));
  return { socket, received, hello };
}
const clientUrl = (id: string) => `${origin().replace('http', 'ws')}/client/${id}?token=${TOKEN}`;

test('a page back from the back/forward cache gets the enables and detaches of while it was away', async () => {
  const fake = await fakePage('bfcache');
  fake.hello('l1');
  await waitFor(async () => (await targets()).find(t => t.id === 'bfcache'));
  const first = await Client.connect(clientUrl('bfcache'));
  const second = await Client.connect(clientUrl('bfcache'));
  fake.socket.send(JSON.stringify({ method: PAGEHIDE_METHOD }));
  // Answered while the page is away, and sent to it when it comes back.
  assert.deepEqual((await first.call('Runtime.enable')).result, {});
  second.socket.close();
  await waitFor(async () => (await targets()).find(t => t.id === 'bfcache')?.clients === 1);
  fake.hello('l1');
  await waitFor(() => fake.received.some(m => m.includes(DETACH_METHOD)));
  await waitFor(() => fake.received.some(m => m.includes('"method":"Runtime.enable"')));
  first.socket.close();
  fake.socket.close();
});

test('a Debugger.enable sent between two page instances is answered by the new one', async () => {
  const fake = await fakePage('held');
  fake.hello('l1');
  await waitFor(async () => (await targets()).find(t => t.id === 'held'));
  const client = await Client.connect(clientUrl('held'));
  fake.socket.send(JSON.stringify({ method: PAGEHIDE_METHOD }));
  const enabled = client.call('Debugger.enable');
  fake.hello('l2');
  const sent = await waitFor(() => fake.received.find(m => m.includes('"method":"Debugger.enable"')));
  // Sent once, under the client's own id, and its answer goes to the client.
  assert.equal(fake.received.filter(m => m.includes('"method":"Debugger.enable"')).length, 1);
  const colon = sent.indexOf(':');
  const { id } = JSON.parse(sent.slice(colon + 1)) as { id: number };
  fake.socket.send(`${sent.slice(0, colon)}:${JSON.stringify({ id, result: { debuggerId: 'd' } })}`);
  assert.deepEqual((await enabled).result, { debuggerId: 'd' });
  client.socket.close();
  fake.socket.close();
});

test("a hello's title and url are cut short, and the server keeps at most 1000 pages", async () => {
  const fake = await fakePage('long');
  fake.socket.send(
    JSON.stringify({
      method: HELLO_METHOD,
      params: {
        loaderId: 'l',
        title: 't'.repeat(5000),
        url: 'u'.repeat(2 * 1024 * 1024 + 10),
        userAgent: 'a'.repeat(5000),
      },
    })
  );
  const listed = await waitFor(async () => (await targets()).find(t => t.id === 'long' && t.title));
  assert.equal(listed.title.length, 4096);
  assert.equal(listed.url.length, 2 * 1024 * 1024);
  assert.equal(listed.userAgent.length, 5000);
  fake.socket.close();
  // A server of its own: the pages it keeps would otherwise stay on this one's list.
  const crowded = await startRemoteServer({ port: 0, host: '127.0.0.1', token: false });
  const sockets: WebSocket[] = [];
  const open = (id: string) =>
    new Promise<boolean>(resolve => {
      const socket = new WebSocket(`${new URL(crowded.url).origin.replace('http', 'ws')}/target/${id}`);
      sockets.push(socket);
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
    });
  try {
    for (let i = 0; i < 1000; i += 50) {
      const batch = Array.from({ length: 50 }, (_, j) => open(`many-${i + j}`));
      assert.ok((await Promise.all(batch)).every(Boolean));
    }
    assert.equal(await open('one-too-many'), false);
    // A page already known still connects.
    assert.equal(await open('many-999'), true);
  } finally {
    for (const socket of sockets) socket.close();
    await crowded.close();
  }
});

test("a new page instance is told only to the domains each client enabled, with Chrome's frame", async () => {
  const fake = await fakePage('navigated');
  fake.hello('l1');
  await waitFor(async () => (await targets()).find(t => t.id === 'navigated'));
  const network = await Client.connect(clientUrl('navigated'));
  const all = await Client.connect(clientUrl('navigated'));
  // The stand-in page never answers: the commands are only sent.
  network.socket.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
  for (const [id, method] of ['Runtime.enable', 'Page.enable', 'DOM.enable'].entries()) {
    all.socket.send(JSON.stringify({ id: id + 1, method }));
  }
  await waitFor(() => fake.received.filter(m => m.includes('.enable')).length === 4);
  const navigate = (loaderId: string, url: string) =>
    fake.socket.send(
      JSON.stringify({ method: HELLO_METHOD, params: { loaderId, url, secure: true, title: 'navigated' } })
    );
  const frames = () =>
    all.messages.flatMap(m => (m.method === 'Page.frameNavigated' ? [JSON.stringify(m.params)] : []));
  navigate('l2', 'http://localhost:5173/');
  await waitFor(() => all.messages.some(m => m.method === 'DOM.documentUpdated'));
  assert.ok(all.messages.some(m => m.method === 'Runtime.executionContextsCleared'));
  assert.ok(frames()[0]?.includes('"secureContextType":"SecureLocalhost"'));
  assert.ok(!network.messages.some(m => typeof m.method === 'string' && !m.method.startsWith('Network.')));
  navigate('l3', 'file:///index.html');
  await waitFor(() => frames().length === 2);
  assert.ok(frames()[1]?.includes('"securityOrigin":"file://"'));
  assert.ok(frames()[1]?.includes('"secureContextType":"Secure"'));
  network.socket.close();
  all.socket.close();
  fake.socket.close();
});

test('a page that reconnects gets what was queued before anything sent after', async () => {
  const fake = await fakePage('order');
  fake.hello('l1');
  await waitFor(async () => (await targets()).find(t => t.id === 'order'));
  const client = await Client.connect(clientUrl('order'));
  fake.socket.close();
  await waitFor(async () => (await targets()).find(t => t.id === 'order')?.connected === false);
  client.socket.send(JSON.stringify({ id: 1, method: 'DOM.enable' }));
  const back = await fakePage('order');
  await waitFor(async () => (await targets()).find(t => t.id === 'order')?.connected === true);
  // Before the hello of the new connection: queued too, behind the first.
  client.socket.send(JSON.stringify({ id: 2, method: 'DOM.getDocument' }));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(back.received.length, 0);
  back.hello('l1');
  await waitFor(() => back.received.length === 2);
  assert.ok(back.received[0]?.includes('DOM.enable'));
  assert.ok(back.received[1]?.includes('DOM.getDocument'));
  client.socket.close();
  back.socket.close();
});

test('a page back on a new relay has the sessions it does not know detached', async () => {
  const fake = await fakePage('stale');
  fake.socket.send(
    JSON.stringify({
      method: HELLO_METHOD,
      params: { loaderId: 'l', title: 'stale', sessions: ['1', '2'] },
    })
  );
  await waitFor(() => fake.received.filter(m => m.includes(DETACH_METHOD)).length === 2);
  assert.ok(fake.received.some(m => m.includes('"session":"1"')));
  fake.socket.close();
});

test('a page whose id another page took connects under a new one', async () => {
  const { id } = await target();
  const fake = await fakePage(id);
  let replaced = 0;
  fake.socket.addEventListener('close', () => replaced++);
  fake.hello('other');
  await waitFor(async () => (await targets()).find(t => t.title === 'remote page' && t.id !== id && t.connected));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(replaced, 0);
  fake.socket.close();
});

test('files are revalidated without being sent again', async () => {
  const first = await fetch(`${origin()}/probe.iife.js`);
  const etag = first.headers.get('etag');
  assert.ok(etag && first.headers.get('last-modified'));
  await first.arrayBuffer();
  assert.equal((await fetch(`${origin()}/probe.iife.js`, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await fetch(`${origin()}/probe.iife.js`, { headers: { 'if-none-match': 'W/"x"' } })).status, 200);
});

test('commands dropped from the queue for the page get an error', async () => {
  const fake = await fakePage('overflow');
  await waitFor(async () => (await targets()).find(t => t.id === 'overflow'));
  const client = await Client.connect(clientUrl('overflow'));
  // The page has not said hello: everything is queued, and the oldest command goes.
  for (let id = 0; id <= 10_000; id++) client.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate' }));
  const dropped = await waitFor(() => client.messages.find(m => m.id === 0));
  assert.ok(dropped.error);
  client.socket.close();
  fake.socket.close();
});

test('the URL printed for an IPv6 host is bracketed', async () => {
  const server = await startRemoteServer({ port: 0, host: '::1', token: false });
  try {
    assert.match(server.url, /^http:\/\/\[::1\]:\d+\/$/);
  } finally {
    await server.close();
  }
});

test('the printed script tag names the public URL', () => {
  assert.equal(remote.scriptTag, `<script src="${remote.publicUrl}probe.iife.js" data-remote></script>`);
});

test('with idInQuery, the printed script tag says so', async () => {
  const server = await startRemoteServer({ port: 0, host: '127.0.0.1', token: false, idInQuery: true });
  try {
    assert.equal(
      server.scriptTag,
      `<script src="${server.publicUrl}probe.iife.js" data-remote data-id-in-query></script>`
    );
  } finally {
    await server.close();
  }
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

test('a page with its own DevTools panel is inspected remotely too, each in its own session', async () => {
  const both = await env.browser.newPage();
  try {
    await both.goto(
      `${env.baseUrl}/tests/e2e/pages/remote-page.html?panel&remote=${encodeURIComponent(origin() + '/')}`
    );
    const listed = await waitFor(async () => (await targets()).find(t => t.url.includes('?panel')));
    const client = await Client.connect(listed.webSocketDebuggerUrl);
    await client.call('Runtime.enable');
    await waitFor(() => client.logged('remote early'));
    // The panel's frontend gets the page's output too.
    const frontend = await waitFor(async () => {
      const handle = await both.$('html > devtools-anywhere');
      const frame = await (await handle?.$('pierce/iframe'))?.contentFrame();
      const ready = await frame?.evaluate(() => (window.received ?? []).length > 0);
      return ready ? frame : null;
    });
    await both.evaluate(() => console.log('seen by both'));
    await waitFor(() => client.logged('seen by both'));
    await waitFor(() =>
      frontend.evaluate(() =>
        (window.received ?? []).some(
          m => m.method === 'Runtime.consoleAPICalled' && JSON.stringify(m.params).includes('seen by both')
        )
      )
    );
    // Shell mode is on by default, but not with a frontend on another origin than the probe: the page
    // stays at the top.
    assert.deepEqual(
      await both.evaluate(() => ({
        shell: !!document.querySelector('devtools-anywhere')?.hasAttribute('data-shell'),
        page: !!document.getElementById('devtools-anywhere-page'),
      })),
      { shell: false, page: false }
    );
    // Sessions of their own: the client turning Runtime off leaves the panel's on.
    await client.call('Runtime.disable');
    await both.evaluate(() => console.log('panel only'));
    await waitFor(() =>
      frontend.evaluate(() =>
        (window.received ?? []).some(
          m => m.method === 'Runtime.consoleAPICalled' && JSON.stringify(m.params).includes('panel only')
        )
      )
    );
    assert.equal(client.logged('panel only'), false);
    client.socket.close();
  } finally {
    await both.close();
  }
});

/** The remote-page.html URL with the probe from this origin, `query` added (a tag of the test's own). */
const localPage = (query: string) =>
  `${env.baseUrl}/tests/e2e/pages/remote-page.html?local&${query}&remote=${encodeURIComponent(origin() + '/')}`;

/** What `expression` evaluates to in each target whose URL has `tag`. */
async function evaluateIn(tag: string, expression: string): Promise<unknown[]> {
  const listed = (await targets()).filter(t => t.url.includes(tag));
  return Promise.all(
    listed.map(async t => {
      const client = await Client.connect(t.webSocketDebuggerUrl);
      try {
        return (await client.call('Runtime.evaluate', { expression, returnByValue: true })).result;
      } finally {
        client.socket.close();
      }
    })
  );
}
const evaluated = (value: unknown) => ({ result: { type: typeof value, value } });

/** The page iframe of a shell, once the bundle has run in it. */
async function shellPageFrame(shell: Page): Promise<Frame> {
  await shell.waitForFunction(() => document.querySelector('devtools-anywhere[data-shell]')?.isConnected);
  const frame = await waitFor(async () => {
    const frame = await (await shell.$('#devtools-anywhere-page'))?.contentFrame();
    return (await frame?.evaluate(() => !!Reflect.get(window, 'DevtoolsAnywhere'))) ? frame : null;
  });
  return frame;
}

test('a page in shell mode connects from the frame it is shown in, not the top window', async () => {
  const shell = await env.browser.newPage();
  try {
    await shell.goto(localPage('panel&shell-frame'));
    const page = await shellPageFrame(shell);
    // The page in the shell has no element of its own (the shell shows DevTools); the shell has one.
    assert.equal(await page.evaluate(() => document.querySelectorAll('devtools-anywhere').length), 0);
    assert.equal(await shell.evaluate(() => document.querySelectorAll('devtools-anywhere').length), 1);
    await waitFor(async () => (await targets()).some(t => t.url.includes('shell-frame')));
    // One connection, the page's: from the iframe, not the top window.
    assert.deepEqual(
      await evaluateIn('shell-frame', '[document.title, window === top, frameElement && frameElement.id]'),
      [evaluated(['remote page', false, 'devtools-anywhere-page'])]
    );
  } finally {
    await shell.close();
  }
});

test('a page reloaded in the shell is still one target, the new page', async () => {
  const shell = await env.browser.newPage();
  try {
    await shell.goto(localPage('panel&shell-reload'));
    const page = await shellPageFrame(shell);
    await waitFor(async () => (await targets()).some(t => t.url.includes('shell-reload')));
    await page.evaluate(() => {
      location.href += '&again';
    });
    await shellPageFrame(shell);
    await waitFor(async () => {
      const listed = (await targets()).filter(t => t.url.includes('shell-reload'));
      return listed.length === 1 && listed[0]?.url.includes('&again');
    });
    assert.deepEqual(
      await evaluateIn(
        'shell-reload',
        '[window === top, location.search.includes("again"), !!document.getElementById("remote-marker")]'
      ),
      [evaluated([false, true, true])]
    );
  } finally {
    await shell.close();
  }
});

test("a page the Service Worker gives the probe in the shell connects to the shell's server", async () => {
  const shell = await env.browser.newPage();
  try {
    await shell.goto(localPage('panel&serviceWorker&shell-worker'));
    const page = await shellPageFrame(shell);
    await shell.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => {
      location.href = '/tests/e2e/pages/no-probe.html?shell-worker-injected';
    });
    await waitFor(async () => (await targets()).some(t => t.url.includes('shell-worker-injected')));
    assert.deepEqual(await evaluateIn('shell-worker-injected', '[document.title, window === top]'), [
      evaluated(['no probe', false]),
    ]);
  } finally {
    await shell.close();
  }
});

test("in a shell whose probe has no server, a page's own data-remote does not connect", async () => {
  const shell = await env.browser.newPage();
  const control = await env.browser.newPage();
  try {
    await shell.goto(localPage('panel&noRemote&shell-none'));
    const page = await shellPageFrame(shell);
    // The page's probe names the server, but the shell's probe decides.
    await page.evaluate(() => {
      location.href = location.href.replace('&noRemote', '') + '&own';
    });
    await shellPageFrame(shell);
    // A page connecting after it does reach the server: had the page connected, it would be listed.
    await control.goto(localPage('shellOff&shell-none-control'));
    await waitFor(async () => (await targets()).some(t => t.url.includes('shell-none-control')));
    assert.deepEqual(
      (await targets()).filter(t => t.url.includes('shell-none&')),
      []
    );
  } finally {
    await control.close();
    await shell.close();
  }
});

test('a page locked out of shell mode connects from its top window', async () => {
  const other = await env.browser.newPage();
  try {
    await other.goto(localPage('panel&shellOff&shell-off'));
    await other.waitForFunction(() => document.querySelector('html > devtools-anywhere')?.isConnected);
    assert.equal(await other.evaluate(() => !!document.getElementById('devtools-anywhere-page')), false);
    await waitFor(async () => (await targets()).some(t => t.url.includes('shell-off')));
    assert.deepEqual(await evaluateIn('shell-off', 'window === top'), [evaluated(true)]);
  } finally {
    await other.close();
  }
});
