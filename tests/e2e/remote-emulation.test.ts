// Device metrics overrides of remote clients (through @devtools-anywhere/remote-server) of a page
// in shell mode across its reloads. Chrome, measured with two sessions A and B attached in that
// order: an override survives a reload; after one, each session's override is applied again in
// the order they attached, so B's holds whichever was set last (B sets, A sets: A's, then B's
// after the reload); A's clear then still ends the page's override, but B's own is still on and
// the next reload applies it again; a cleared one is not. During a reload the new document never
// has the page's own size. A session setting its own override again while the page has one does
// nothing (A sets 400x600, B 700x300, A 400x600 again: 700x300), but does once the page has none
// (another's clear lifted it). A set Chrome rejects (a negative width) is not kept. The first test checks this
// in Chrome; the next ones, the relay re-sending each client's override to the new page instance.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { startRemoteServer, type RemoteServer } from '@devtools-anywhere/remote-server';
import { frontendRequest, launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let remote: RemoteServer | undefined;

before(async () => {
  env = await launch();
  remote = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    token: false,
  });
});
after(async () => {
  await env?.close();
  await remote?.close();
});

const metrics = (width: number, height: number) => ({
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
const pause = () => new Promise(r => setTimeout(r, 300));

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

test("Chrome: overrides survive a reload, re-applied in the sessions' attach order", async () => {
  assert.ok(env);
  const chrome = await env.browser.newPage();
  await chrome.setViewport(null);
  // The size the new document first has, before any script of its own.
  await chrome.evaluateOnNewDocument(() => {
    Reflect.set(window, '__early', `${innerWidth}x${innerHeight}`);
  });
  await chrome.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  // innerWidth follows the override a frame later.
  const size = async () => {
    await pause();
    return chrome.evaluate(() => `${innerWidth}x${innerHeight}`);
  };
  const natural = await size();
  const a = await chrome.createCDPSession();
  const b = await chrome.createCDPSession();
  await a.send('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  await chrome.reload();
  assert.equal(await chrome.evaluate(() => Reflect.get(window, '__early')), '400x600', 'never the own size');
  assert.equal(await size(), '400x600', 'the override survives the reload');
  const rejected = await b.send('Emulation.setDeviceMetricsOverride', metrics(-5, 300)).then(
    () => 'ok',
    () => 'rejected'
  );
  assert.equal(rejected, 'rejected');
  await chrome.reload();
  assert.equal(await size(), '400x600', 'a rejected set is not kept');
  await b.send('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await a.send('Emulation.setDeviceMetricsOverride', metrics(450, 650));
  assert.equal(await size(), '450x650');
  await chrome.reload();
  assert.equal(await size(), '700x300', 'the later-attached session wins after the reload');
  await a.send('Emulation.clearDeviceMetricsOverride');
  assert.equal(await size(), natural, "A's clear ends B's override too");
  await chrome.reload();
  assert.equal(await size(), '700x300', "but B's own is still on: the next reload applies it again");
  await b.send('Emulation.clearDeviceMetricsOverride');
  await chrome.reload();
  assert.equal(await size(), natural, 'a cleared override is not');
  await a.send('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  await b.send('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await a.send('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  assert.equal(await size(), '700x300', 'setting its own again does nothing while the page has one');
  await b.send('Emulation.clearDeviceMetricsOverride');
  await a.send('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  assert.equal(await size(), '400x600', 'but does once the page has none');
  await a.send('Emulation.clearDeviceMetricsOverride');
  await a.detach();
  await b.detach();
  await chrome.close();
});

/** A stand-in remote DevTools client. */
class Client {
  private seq = 0;
  private readonly answers = new Map<number, (message: unknown) => void>();
  readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = event => {
      const message: unknown = JSON.parse(String(event.data));
      const id: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'id') : undefined;
      if (typeof id === 'number') this.answers.get(id)?.(message);
    };
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new Client(socket);
  }

  call(method: string, params: object = {}) {
    const id = ++this.seq;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => this.answers.set(id, resolve));
  }
}

let shell: Page;
let natural = '';

/** The page iframe's size, once it has followed the override. */
async function pageSize() {
  await pause();
  return shell.evaluate(() => {
    const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!view) throw new Error('no page window');
    return `${view.innerWidth}x${view.innerHeight}`;
  });
}

/** Reloads the page in the shell's iframe, and waits for the new instance's probe. */
async function reloadPage() {
  const before = await shell.evaluate(() => {
    const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    const time = view?.performance.timeOrigin;
    view?.location.reload();
    return time;
  });
  await shell.waitForFunction(
    before => {
      const view = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
      return (
        !!view &&
        view.performance.timeOrigin !== before &&
        view.document.readyState === 'complete' &&
        !!view.DevtoolsAnywhere
      );
    },
    {},
    before
  );
}

async function connect(): Promise<Client> {
  assert.ok(remote);
  const at = new URL(remote.url).origin;
  const listed = await waitFor(async () => {
    const list: { url: string; webSocketDebuggerUrl: string }[] = await (await fetch(`${at}/json/list`)).json();
    return list.find(t => t.url.includes('remote-emulation'));
  });
  return Client.connect(listed.webSocketDebuggerUrl);
}

test("in shell mode, a remote client's override survives the page's reloads, as in Chrome", async () => {
  assert.ok(env && remote);
  shell = await env.browser.newPage();
  const at = new URL(remote.url).origin;
  await shell.goto(
    `${env.baseUrl}/tests/e2e/pages/remote-page.html?local&panel&remote-emulation&remote=${encodeURIComponent(at + '/')}`
  );
  await shell.waitForFunction(
    () => !!document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow?.DevtoolsAnywhere
  );
  // Where the shell's frontend lays out the page: only then does the shell size it.
  await frontendRequest(shell, {
    type: 'page-bounds',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
  });
  natural = await pageSize();
  assert.equal(natural, '300x200');
  const a = await connect();
  await a.call('Runtime.enable');
  await a.call('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  assert.equal(await pageSize(), '400x600');
  await watchSizes();
  await reloadPage();
  assert.equal(await pageSize(), '400x600', 'the override survives the reload');
  assert.deepEqual(await watchedSizes(), [], 'never the own size during the reload');
  assert.match(JSON.stringify(await a.call('Emulation.setDeviceMetricsOverride', metrics(-5, 300))), /"error"/);
  await reloadPage();
  assert.equal(await pageSize(), '400x600', 'a rejected set is not kept');
  const b = await connect();
  await b.call('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await a.call('Emulation.setDeviceMetricsOverride', metrics(450, 650));
  assert.equal(await pageSize(), '450x650');
  await reloadPage();
  assert.equal(await pageSize(), '700x300', 'the later-connected client wins after the reload');
  await a.call('Emulation.clearDeviceMetricsOverride');
  assert.equal(await pageSize(), natural, "A's clear ends B's override too");
  await reloadPage();
  assert.equal(await pageSize(), '700x300', "but B's own is still on: it is re-sent");
  await b.call('Emulation.clearDeviceMetricsOverride');
  await reloadPage();
  assert.equal(await pageSize(), natural, 'a cleared override is not');
  await b.call('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await reloadPage();
  assert.equal(await pageSize(), '700x300');
  await b.call('Emulation.clearDeviceMetricsOverride');
  await a.call('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  await b.call('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  await a.call('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  assert.equal(await pageSize(), '700x300', 'setting its own again does nothing while the page has one');
  await b.call('Emulation.clearDeviceMetricsOverride');
  await a.call('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  assert.equal(await pageSize(), '400x600', 'but does once the page has none');
  await a.call('Emulation.clearDeviceMetricsOverride');
  await b.call('Emulation.setDeviceMetricsOverride', metrics(700, 300));
  b.socket.close();
  assert.equal(await pageSize(), natural, "a client's disconnect lifts its override");
  await reloadPage();
  assert.equal(await pageSize(), natural, "nor is a gone client's re-sent");
  remotes.push(a);
});

const remotes: Client[] = [];
let frontendSeq = 1000;

/** Sends a command from the shell's frontend, as DevTools' device mode does. */
async function fromFrontend(method: string, params: object = {}) {
  const frame = await shell.waitForFrame(frame => /fake-frontend/.test(frame.url()));
  await frame.evaluate(
    (id, method, params) => parent.postMessage(JSON.stringify({ id, method, params }), '*'),
    ++frontendSeq,
    method,
    params
  );
}

test("in shell mode, after a reload the shell frontend's override and remote clients' follow attach order", async () => {
  const [a] = remotes;
  assert.ok(a);
  // The frontend attached first (with the shell), before A: A's holds after the reload.
  await fromFrontend('Emulation.setDeviceMetricsOverride', metrics(500, 500));
  await a.call('Emulation.setDeviceMetricsOverride', metrics(400, 600));
  await fromFrontend('Emulation.setDeviceMetricsOverride', metrics(550, 550));
  assert.equal(await pageSize(), '550x550');
  await reloadPage();
  assert.equal(await pageSize(), '400x600', 'the later-attached client wins after the reload');
  // A new frontend instance attaches after A: its override holds after the reload.
  await fromFrontend('Emulation.clearDeviceMetricsOverride');
  await reloadFrontend();
  await fromFrontend('Emulation.setDeviceMetricsOverride', metrics(500, 500));
  await a.call('Emulation.setDeviceMetricsOverride', metrics(450, 650));
  assert.equal(await pageSize(), '450x650');
  await reloadPage();
  assert.equal(await pageSize(), '500x500', 'the frontend attached later: its override wins');
  // C connects before a new frontend instance, but sets its override only after the frontend's:
  // it attached when it connected, so the frontend's holds after the reload.
  await fromFrontend('Emulation.clearDeviceMetricsOverride');
  await a.call('Emulation.clearDeviceMetricsOverride');
  const c = await connect();
  await pause();
  await reloadFrontend();
  await fromFrontend('Emulation.setDeviceMetricsOverride', metrics(500, 500));
  await c.call('Emulation.setDeviceMetricsOverride', metrics(350, 250));
  assert.equal(await pageSize(), '350x250');
  await reloadPage();
  assert.equal(await pageSize(), '500x500', 'C attached before the frontend, though it set its override later');
  c.socket.close();
  a.socket.close();
  await shell.close();
});

/** Reloads the shell's frontend frame: a new frontend instance, once it has sent its first commands. */
async function reloadFrontend() {
  const frame = await shell.waitForFrame(frame => /fake-frontend/.test(frame.url()));
  const before = await frame.evaluate(() => performance.timeOrigin);
  await frame.evaluate(() => location.reload()).catch(() => {});
  await waitFor(async () => {
    const now = await shell.waitForFrame(frame => /fake-frontend/.test(frame.url()));
    return now.evaluate(
      before => performance.timeOrigin !== before && Number(Reflect.get(window, 'received')?.length) >= 3,
      before
    );
  });
}

/** Starts recording the page iframe's sizes that are its own (as laid out, `natural`). */
function watchSizes() {
  return shell.evaluate(natural => {
    const frame = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page');
    const seen: string[] = [];
    Reflect.set(window, '__natural', seen);
    if (!frame) return;
    new ResizeObserver(([entry]) => {
      const size = entry && `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
      if (size === natural) seen.push(size);
    }).observe(frame);
  }, natural);
}
const watchedSizes = () => shell.evaluate(() => Reflect.get(window, '__natural'));
