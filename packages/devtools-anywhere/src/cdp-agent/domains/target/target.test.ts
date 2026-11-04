// The Target domain of the page's agent: cross-origin iframes' agents attached as child targets
// and the client's messages routed to them by sessionId, flattened as Chrome does
// (test-support/oopif-notes.md). The iframe agents are stand-ins in the page, linked by
// test-support/child-targets-harness.ts; the real links are made by the handshake.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Page } from 'puppeteer-core';
import { startRemoteServer, type RemoteServer } from '@devtools-anywhere/remote-server';
import { launch, type Env } from '../../../../test-support/conformance.ts';

const support = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../test-support');

let env: Env | undefined;
let page: Page;
let harness = '';

before(async () => {
  env = await launch();
  const bundled = await build({
    stdin: {
      contents:
        "import { Harness } from './child-targets-harness.ts'; Object.assign(window, { __harness: new Harness() });",
      resolveDir: support,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    external: ['@zumer/snapdom'],
  });
  harness = bundled.outputFiles[0]?.text ?? '';
});
after(() => env?.close());

beforeEach(async () => {
  assert.ok(env);
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await page.addScriptTag({ content: harness });
});

type Message = Record<string, unknown>;

const send = (message: object) => page.evaluate(message => window.__harness?.send(message), message);
const add = (name: string, parent?: string) =>
  page.evaluate((name, parent) => window.__harness?.add(name, parent) ?? '', name, parent);
const out = (): Promise<Message[]> => page.evaluate(() => window.__harness?.out ?? []);
const received = (name: string): Promise<Message[]> =>
  page.evaluate(name => window.__harness?.received(name) ?? [], name);

async function waitFor<T>(get: () => Promise<T | undefined>, timeout = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

/** The first message the client got that matches, waiting for it. */
const message = (match: (m: Message) => boolean) => waitFor(async () => (await out()).find(match));
const reply = (id: number) => message(m => m['id'] === id);
const events = async (method: string) => (await out()).filter(m => m['method'] === method);
const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

/** Waits for the attachedToTarget of `frameId` and returns its session id. */
async function attached(frameId: string): Promise<string> {
  const event = await message(
    m => m['method'] === 'Target.attachedToTarget' && field(field(m['params'], 'targetInfo'), 'targetId') === frameId
  );
  return String(field(event['params'], 'sessionId'));
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

test('an iframe linked before auto-attach is attached when it is turned on, one linked after at once', async () => {
  const first = await add('first');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  assert.deepEqual(await reply(1), { id: 1, result: {} });
  const event = await message(m => m['method'] === 'Target.attachedToTarget');
  const url = await page.evaluate(() => location.href);
  const params = event['params'];
  // Like Chrome for an iframe there when auto-attach is turned on: not paused, URL and title
  // known (the title is the URL while the document has none).
  assert.deepEqual(field(params, 'targetInfo'), {
    targetId: first,
    type: 'iframe',
    title: await page.evaluate(() => document.title || location.href),
    url,
    attached: true,
    parentId: 'devtools-anywhere-frame',
    canAccessOpener: false,
    parentFrameId: 'devtools-anywhere-frame',
  });
  assert.equal(field(params, 'waitingForDebugger'), false);
  assert.match(String(field(params, 'sessionId')), /^[0-9A-F]{32}$/);
  const second = await add('second');
  const sessions = [await attached(first), await attached(second)];
  assert.notEqual(sessions[0], sessions[1]);
  // Again on: nothing attached twice, as in Chrome.
  send({ id: 2, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  await reply(2);
  assert.equal((await events('Target.attachedToTarget')).length, 2);
});

test("the client's messages with a session id reach that iframe's agent without it, and come back with it", async () => {
  const frameId = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const sessionId = await attached(frameId);
  send({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId });
  assert.deepEqual(await reply(2), { id: 2, result: { result: { type: 'string', value: 'child' } }, sessionId });
  send({ id: 3, method: 'Runtime.runIfWaitingForDebugger', sessionId });
  assert.deepEqual(await reply(3), { id: 3, result: {}, sessionId });
  const got = await received('child');
  assert.deepEqual(got.slice(-2), [
    { id: 2, method: 'Runtime.evaluate', params: { expression: '1' } },
    { id: 3, method: 'Runtime.runIfWaitingForDebugger' },
  ]);
  // The domain's own command for the iframe's URL and title is not the client's to see.
  assert.ok(!(await out()).some(m => typeof m['id'] === 'string'));
});

test('a message for no session gets Chrome’s errors, without the session id', async () => {
  send({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'nope' });
  assert.deepEqual(await reply(1), { id: 1, error: { code: -32001, message: 'Session with given id not found.' } });
  send({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 5 });
  assert.deepEqual(await reply(2), {
    id: 2,
    error: { code: -32600, message: "Message may have string 'sessionId' property" },
  });
  // An empty one is none: the page's own session.
  send({ id: 3, method: 'Target.setDiscoverTargets', params: { discover: false }, sessionId: '' });
  assert.deepEqual(await reply(3), { id: 3, result: {} });
});

test("an iframe's own children are attached on its session, and their sessions are flat", async () => {
  const child = await add('child');
  const grandchild = await add('grandchild', 'child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  send({ id: 2, method: 'Target.setAutoAttach', params: AUTO_ATTACH, sessionId: s1 });
  const event = await message(m => m['method'] === 'Target.attachedToTarget' && m['sessionId'] === s1);
  const s2 = String(field(event['params'], 'sessionId'));
  assert.deepEqual(field(field(event['params'], 'targetInfo'), 'targetId'), grandchild);
  // Its parent is the child's frame.
  assert.equal(field(field(event['params'], 'targetInfo'), 'parentFrameId'), child);
  send({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s2 });
  assert.deepEqual(await reply(3), {
    id: 3,
    result: { result: { type: 'string', value: 'grandchild' } },
    sessionId: s2,
  });
  assert.deepEqual((await received('grandchild')).at(-1), {
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
  });
  // Removed: the grandchild first, on the child's session, as in Chrome; then the child.
  await page.evaluate(() => window.__harness?.close('grandchild'));
  await message(m => m['method'] === 'Target.detachedFromTarget' && m['sessionId'] === s1);
  await page.evaluate(() => window.__harness?.close('child'));
  const detached = await message(m => m['method'] === 'Target.detachedFromTarget' && m['sessionId'] === undefined);
  assert.deepEqual(detached['params'], { sessionId: s1, targetId: child });
  for (const [id, sessionId] of [
    [4, s1],
    [5, s2],
  ] as const) {
    send({ id, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId });
    assert.deepEqual(field(await reply(id), 'error'), { code: -32001, message: 'Session with given id not found.' });
  }
});

test("an iframe's agent speaks only on its own children's sessions, and takes no other target's", async () => {
  const a = await add('a');
  const b = await add('b');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const sa = await attached(a);
  await attached(b);
  // On a sibling's session, or on a session id taken over: dropped.
  await page.evaluate(sa => {
    window.__harness?.forge('b', { method: 'Runtime.executionContextsCleared', params: {}, sessionId: sa });
    window.__harness?.forge('b', {
      method: 'Target.attachedToTarget',
      params: { sessionId: sa, targetInfo: { targetId: 'forged', type: 'iframe' }, waitingForDebugger: false },
    });
  }, sa);
  // The client's messages on that session still reach the sibling's agent.
  send({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: sa });
  assert.deepEqual(await reply(2), { id: 2, result: { result: { type: 'string', value: 'a' } }, sessionId: sa });
  const got = await out();
  assert.ok(!got.some(m => m['method'] === 'Runtime.executionContextsCleared'));
  assert.ok(!got.some(m => field(field(m['params'], 'targetInfo'), 'targetId') === 'forged'));
});

test('a navigated iframe keeps its target and session, and its next document is set up as the last', async () => {
  const child = await add('child');
  await add('grandchild', 'child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  send({ id: 2, method: 'Runtime.enable', sessionId: s1 });
  send({ id: 3, method: 'Target.setAutoAttach', params: AUTO_ATTACH, sessionId: s1 });
  const nested = await message(m => m['method'] === 'Target.attachedToTarget' && m['sessionId'] === s1);
  const s2 = String(field(nested['params'], 'sessionId'));
  await page.evaluate(() => window.__harness?.navigate('child'));
  // Like Chrome (oopif-notes.md, Lifecycle): the old document's children go, on its session;
  // the target stays, with its new URL and title on the page's session.
  const gone = await message(m => m['method'] === 'Target.detachedFromTarget');
  assert.deepEqual(gone, {
    method: 'Target.detachedFromTarget',
    params: { sessionId: s2, targetId: field(field(nested['params'], 'targetInfo'), 'targetId') },
    sessionId: s1,
  });
  const changed = await message(m => m['method'] === 'Target.targetInfoChanged');
  assert.equal(field(field(changed['params'], 'targetInfo'), 'targetId'), child);
  assert.equal(field(field(changed['params'], 'targetInfo'), 'attached'), true);
  const cleared = await message(m => m['method'] === 'Runtime.executionContextsCleared');
  assert.equal(cleared['sessionId'], s1);
  // The next document's agent got what the client set up, under ids of the domain's own.
  const replayed = await waitFor(async () => {
    const got = (await received('child')).filter(m => !/getFrameTree|getTargetInfo/.test(String(m['method'])));
    return got.length >= 2 ? got : undefined;
  });
  assert.deepEqual(
    replayed.map(m => [m['method'], m['params']]),
    [
      ['Runtime.enable', {}],
      ['Target.setAutoAttach', AUTO_ATTACH],
    ]
  );
  assert.ok(replayed.every(m => String(m['id']).startsWith('target-own-')));
  send({ id: 4, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s1 });
  assert.deepEqual(await reply(4), { id: 4, result: { result: { type: 'string', value: 'child' } }, sessionId: s1 });
  assert.ok(!(await out()).some(m => m['method'] === 'Target.detachedFromTarget' && m['sessionId'] === undefined));
  assert.equal((await events('Target.attachedToTarget')).filter(m => m['sessionId'] === undefined).length, 1);
});

test('between two documents, what sets the session up succeeds and the rest fails; removed, the target goes', async () => {
  const child = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  await page.evaluate(() => window.__harness?.navigate('child', false));
  send({ id: 2, method: 'Runtime.enable', sessionId: s1 });
  assert.deepEqual(await reply(2), { id: 2, result: {}, sessionId: s1 });
  send({ id: 3, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s1 });
  assert.deepEqual(await reply(3), {
    id: 3,
    error: { code: -32000, message: 'Inspected target navigated or closed' },
    sessionId: s1,
  });
  await page.evaluate(() => window.__harness?.close('child'));
  const detached = await message(m => m['method'] === 'Target.detachedFromTarget');
  assert.deepEqual(detached['params'], { sessionId: s1, targetId: child });
});

test('a command in flight when the document goes away fails, as one sent between two documents', async () => {
  const child = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  send({ id: 2, method: 'Runtime.awaitPromise', params: { promiseObjectId: '1' }, sessionId: s1 });
  await waitFor(async () => ((await received('child')).some(m => m['id'] === 2) ? true : undefined));
  await page.evaluate(() => window.__harness?.navigate('child', false));
  assert.deepEqual(await reply(2), {
    id: 2,
    error: { code: -32000, message: 'Inspected target navigated or closed' },
    sessionId: s1,
  });
});

test("a reply on an iframe's nested session leaves the iframe's own command of the same id in flight", async () => {
  const child = await add('child');
  await add('grandchild', 'child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  send({ id: 2, method: 'Target.setAutoAttach', params: AUTO_ATTACH, sessionId: s1 });
  const nested = await message(m => m['method'] === 'Target.attachedToTarget' && m['sessionId'] === s1);
  const s2 = String(field(nested['params'], 'sessionId'));
  send({ id: 3, method: 'Runtime.awaitPromise', params: { promiseObjectId: '1' }, sessionId: s1 });
  await waitFor(async () => ((await received('child')).some(m => m['id'] === 3) ? true : undefined));
  // Ids are each session's own: a reply of id 3 on the nested session answers nothing on s1.
  await page.evaluate(s2 => window.__harness?.forge('child', { id: 3, result: {}, sessionId: s2 }), s2);
  await message(m => m['id'] === 3 && m['sessionId'] === s2);
  await page.evaluate(() => window.__harness?.navigate('child', false));
  assert.deepEqual(await message(m => m['id'] === 3 && m['sessionId'] === s1), {
    id: 3,
    error: { code: -32000, message: 'Inspected target navigated or closed' },
    sessionId: s1,
  });
});

test('a disabled domain is not set up again on the next document, and what was set up between two is', async () => {
  const child = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  send({ id: 2, method: 'DOM.enable', sessionId: s1 });
  await reply(2);
  send({ id: 3, method: 'DOM.disable', sessionId: s1 });
  await reply(3);
  await page.evaluate(() => window.__harness?.navigate('child', false));
  // Between two documents: a disable fails and leaves the setup, an enable succeeds and is kept.
  send({ id: 4, method: 'Page.disable', sessionId: s1 });
  assert.deepEqual(await reply(4), {
    id: 4,
    error: { code: -32000, message: 'Inspected target navigated or closed' },
    sessionId: s1,
  });
  send({ id: 5, method: 'Runtime.enable', sessionId: s1 });
  assert.deepEqual(await reply(5), { id: 5, result: {}, sessionId: s1 });
  await page.evaluate(() => window.__harness?.navigate('child'));
  const replayed = await waitFor(async () => {
    const got = (await received('child')).filter(m => String(m['id']).startsWith('target-own-replay'));
    return got.length >= 1 ? got : undefined;
  });
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(
    (await received('child')).filter(m => String(m['id']).startsWith('target-own-replay')).map(m => m['method']),
    ['Runtime.enable']
  );
  assert.equal(replayed[0]?.['method'], 'Runtime.enable');
  const created = await message(m => m['method'] === 'Runtime.executionContextCreated');
  assert.equal(created['sessionId'], s1);
});

test('detachFromTarget finds the session by target id, and fails for none', async () => {
  const child = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  send({ id: 2, method: 'Target.detachFromTarget', params: { targetId: child } });
  assert.deepEqual(await reply(2), { id: 2, result: {} });
  const detached = await message(m => m['method'] === 'Target.detachedFromTarget');
  assert.deepEqual(detached['params'], { sessionId: s1, targetId: child });
  // As Chrome answers for a session it does not have.
  send({ id: 3, method: 'Target.detachFromTarget', params: { sessionId: s1 } });
  assert.deepEqual(await reply(3), { id: 3, error: { code: -32602, message: 'No session with given id' } });
});

test('auto-attach turned off before the target is told of tells the client nothing of it', async () => {
  await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  send({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: false, waitForDebuggerOnStart: false } });
  await reply(2);
  await new Promise(r => setTimeout(r, 300));
  const told = (await out()).filter(m => /^Target\.(attached|detached)/.test(String(m['method'])));
  // Either it was told of and then of its end, or neither: never an end alone.
  assert.ok(told.length === 0 || told[0]?.['method'] === 'Target.attachedToTarget', JSON.stringify(told));
});

/** Dispatches a load event on the iframe of agent `name`, as its next document's load. */
const load = (name: string) =>
  page.evaluate(name => document.querySelector(`iframe[name="${name}"]`)?.dispatchEvent(new Event('load')), name);

test('a navigated iframe whose next document does not link ends shortly after it loads', async () => {
  const child = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  await page.evaluate(() => window.__harness?.navigate('child', false));
  await load('child');
  // RELINK_AFTER_LOAD (2 s) after the load, not RELINK_TIMEOUT (10 s) after the link closed.
  const detached = await waitFor(
    async () => (await out()).find(m => m['method'] === 'Target.detachedFromTarget'),
    4000
  );
  assert.deepEqual(detached['params'], { sessionId: s1, targetId: child });
});

test('an iframe that links again after its load keeps its target past the wait', async () => {
  const child = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(child);
  await page.evaluate(() => window.__harness?.navigate('child', false));
  await load('child');
  await page.evaluate(() => window.__harness?.navigate('child'));
  await new Promise(r => setTimeout(r, 2500));
  assert.deepEqual(await events('Target.detachedFromTarget'), []);
  // The load listener went with the wait: another load does not end the target either.
  await load('child');
  await new Promise(r => setTimeout(r, 2500));
  assert.deepEqual(await events('Target.detachedFromTarget'), []);
  send({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s1 });
  assert.deepEqual(await reply(2), { id: 2, result: { result: { type: 'string', value: 'child' } }, sessionId: s1 });
});

test('an iframe between two documents when the client turns auto-attach and discovery on is attached and announced once it links', async () => {
  const child = await add('child');
  await page.evaluate(() => window.__harness?.navigate('child', false));
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  send({ id: 2, method: 'Target.setDiscoverTargets', params: { discover: true } });
  await reply(2);
  await page.evaluate(() => window.__harness?.navigate('child'));
  await attached(child);
  const created = await message(
    m => m['method'] === 'Target.targetCreated' && field(field(m['params'], 'targetInfo'), 'targetId') === child
  );
  assert.equal(field(field(created['params'], 'targetInfo'), 'type'), 'iframe');
});

test('turning auto-attach off detaches, as in Chrome; without flatten it fails, nothing attached', async () => {
  const frameId = await add('child');
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const sessionId = await attached(frameId);
  send({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: false, waitForDebuggerOnStart: false } });
  const detached = await message(m => m['method'] === 'Target.detachedFromTarget');
  assert.deepEqual(detached['params'], { sessionId, targetId: frameId });
  // Its session in the iframe's agent ends: what the client enabled there is disabled.
  await waitFor(async () => ((await received('child')).some(m => m['endSession'] === true) ? true : undefined));
  send({ id: 3, method: 'Target.setAutoAttach', params: { ...AUTO_ATTACH, flatten: false } });
  assert.deepEqual(await reply(3), {
    id: 3,
    error: { code: -32000, message: 'Not supported in the page: only flatten sessions are supported' },
  });
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await events('Target.attachedToTarget')).length, 1);
});

test('getTargets, getTargetInfo and setDiscoverTargets list the page and its iframes', async () => {
  const frameId = await add('child');
  send({ id: 1, method: 'Target.getTargets' });
  const infos = field(field(await reply(1), 'result'), 'targetInfos');
  assert.ok(Array.isArray(infos));
  assert.deepEqual(
    infos.map(info => [field(info, 'targetId'), field(info, 'type'), field(info, 'attached')]),
    [
      ['devtools-anywhere-frame', 'page', true],
      [frameId, 'iframe', false],
    ]
  );
  send({ id: 2, method: 'Target.getTargetInfo', params: {} });
  assert.equal(field(field(field(await reply(2), 'result'), 'targetInfo'), 'type'), 'page');
  send({ id: 3, method: 'Target.getTargetInfo', params: { targetId: frameId } });
  assert.equal(field(field(field(await reply(3), 'result'), 'targetInfo'), 'type'), 'iframe');
  send({ id: 4, method: 'Target.getTargetInfo', params: { targetId: 'x' } });
  assert.deepEqual(field(await reply(4), 'error'), { code: -32602, message: 'No target with given id found' });
  send({ id: 5, method: 'Target.setDiscoverTargets', params: { discover: true } });
  await reply(5);
  const created = (await events('Target.targetCreated')).map(m => field(field(m['params'], 'targetInfo'), 'targetId'));
  assert.deepEqual(created, ['devtools-anywhere-frame', frameId]);
  await page.evaluate(() => window.__harness?.close('child'));
  assert.deepEqual((await message(m => m['method'] === 'Target.targetDestroyed'))['params'], { targetId: frameId });
  // On the iframe's own session, its own info: an iframe target.
  const own = await page.evaluate(
    name => window.__harness?.agents.get(name)?.session.call('Target.getTargetInfo'),
    'child'
  );
  assert.deepEqual(field(field(own, 'targetInfo'), 'targetId'), frameId);
  assert.deepEqual(field(field(own, 'targetInfo'), 'type'), 'iframe');
});

test("a client's end detaches silently, and leaves another client's session with the target", async () => {
  const frameId = await add('child');
  const other = await page.evaluate(() => window.__harness?.another() ?? -1);
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  await attached(frameId);
  // Like Chrome: each client attaches the target, with a session of its own.
  await page.evaluate(
    (other, params) => window.__harness?.others[other]?.call('Target.setAutoAttach', params),
    other,
    AUTO_ATTACH
  );
  const theirs = await message(m => m['method'] === 'Target.attachedToTarget' && m['other'] === other);
  assert.equal(field(field(theirs['params'], 'targetInfo'), 'targetId'), frameId);
  await page.evaluate(() => window.__harness?.end());
  await waitFor(async () => ((await received('child')).some(m => m['endSession'] === true) ? true : undefined));
  assert.equal((await events('Target.detachedFromTarget')).length, 0);
  assert.equal((await received('child')).filter(m => m['endSession'] === true).length, 1);
});

test('embedded: messages with a session id go through connectFrontend both ways', async () => {
  const frameId = await add('child');
  await page.evaluate(() => {
    const post = window.__harness?.embed();
    Object.assign(window, { __post: post });
  });
  const post = (message: object) => page.evaluate(message => Reflect.get(window, '__post')(message), message);
  await post({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const event = await message(m => m['embedded'] === true && m['method'] === 'Target.attachedToTarget');
  const sessionId = String(field(event['params'], 'sessionId'));
  assert.equal(field(field(event['params'], 'targetInfo'), 'targetId'), frameId);
  await post({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId });
  const answer = await message(m => m['embedded'] === true && m['id'] === 2);
  assert.deepEqual(answer, {
    id: 2,
    result: { result: { type: 'string', value: 'child' } },
    sessionId,
    embedded: true,
  });
});

test('remote debugging: messages with a session id go through the server both ways', async () => {
  const remote: RemoteServer = await startRemoteServer({ port: 0, host: '127.0.0.1', token: 'token' });
  try {
    const frameId = await add('child');
    await page.evaluate(url => window.__harness?.remote(url), remote.url);
    const list = await waitFor(async () => {
      const targets: { webSocketDebuggerUrl: string; connected: boolean }[] = await (
        await fetch(`${new URL(remote.url).origin}/json/list?token=token`)
      ).json();
      return targets.find(t => t.connected);
    });
    const socket = new WebSocket(list.webSocketDebuggerUrl);
    const messages: Message[] = [];
    socket.onmessage = e => messages.push({ ...Object(JSON.parse(String(e.data))) });
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const find = (match: (m: Message) => boolean) => waitFor(async () => messages.find(match));
    socket.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH }));
    const event = await find(m => m['method'] === 'Target.attachedToTarget');
    const sessionId = String(field(event['params'], 'sessionId'));
    assert.equal(field(field(event['params'], 'targetInfo'), 'targetId'), frameId);
    socket.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId }));
    assert.deepEqual(await find(m => m['id'] === 2), {
      id: 2,
      result: { result: { type: 'string', value: 'child' } },
      sessionId,
    });
    // The frontend leaves: the page's session ends, and the iframe's is let go.
    socket.close();
    await waitFor(async () => ((await received('child')).some(m => m['endSession'] === true) ? true : undefined));
  } finally {
    await remote.close();
  }
});

test('two clients attach the same iframe, each with a session of its own, as in Chrome', async () => {
  const frameId = await add('child');
  const other = await page.evaluate(() => window.__harness?.another() ?? -1);
  /** Sends the other client's message. */
  const sendOther = (message: object) =>
    page.evaluate(
      (other, message) => void window.__harness?.others[other]?.dispatch(JSON.stringify(message)).catch(() => {}),
      other,
      message
    );
  const mine = (m: Message) => m['other'] === undefined;
  const theirs = (m: Message) => m['other'] === other;
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(frameId);
  await sendOther({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const event = await message(m => theirs(m) && m['method'] === 'Target.attachedToTarget');
  const s2 = String(field(event['params'], 'sessionId'));
  assert.notEqual(s1, s2);
  assert.equal(field(field(event['params'], 'targetInfo'), 'attached'), true);

  // One client's Runtime.enable is its own: the other hears of no context.
  send({ id: 2, method: 'Runtime.enable', sessionId: s1 });
  await message(m => mine(m) && m['id'] === 2);
  const created = await message(m => m['method'] === 'Runtime.executionContextCreated');
  assert.equal(created['sessionId'], s1);
  assert.ok(mine(created));
  await sendOther({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s2 });
  assert.deepEqual(await message(m => theirs(m) && m['id'] === 2), {
    id: 2,
    result: { result: { type: 'string', value: 'child' } },
    sessionId: s2,
    other,
  });
  assert.equal((await out()).filter(m => m['method'] === 'Runtime.executionContextCreated').length, 1);
  await sendOther({ id: 3, method: 'Runtime.enable', sessionId: s2 });
  const second = await message(m => theirs(m) && m['method'] === 'Runtime.executionContextCreated');
  assert.equal(second['sessionId'], s2);
  assert.equal((await out()).filter(m => m['method'] === 'Runtime.executionContextCreated').length, 2);

  // One detaches: the other's session goes on, and the target is still attached.
  send({ id: 3, method: 'Target.detachFromTarget', params: { sessionId: s1 } });
  await message(m => mine(m) && m['id'] === 3);
  await waitFor(async () => ((await received('child')).some(m => m['endSession'] === true) ? true : undefined));
  await sendOther({ id: 4, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s2 });
  assert.equal(
    field(field(field(await message(m => theirs(m) && m['id'] === 4), 'result'), 'result'), 'value'),
    'child'
  );
  send({ id: 4, method: 'Target.getTargetInfo', params: { targetId: frameId } });
  assert.equal(
    field(field(field(await message(m => mine(m) && m['id'] === 4), 'result'), 'targetInfo'), 'attached'),
    true
  );
  send({ id: 5, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s1 });
  assert.deepEqual(field(await message(m => mine(m) && m['id'] === 5), 'error'), {
    code: -32001,
    message: 'Session with given id not found.',
  });

  // Both detached: no longer attached.
  await sendOther({ id: 5, method: 'Target.detachFromTarget', params: { sessionId: s2 } });
  await message(m => theirs(m) && m['id'] === 5);
  send({ id: 6, method: 'Target.getTargetInfo', params: { targetId: frameId } });
  assert.equal(
    field(field(field(await message(m => mine(m) && m['id'] === 6), 'result'), 'targetInfo'), 'attached'),
    false
  );
});

test('a navigated iframe carries each client’s session on, each set up as it was', async () => {
  const frameId = await add('child');
  const other = await page.evaluate(() => window.__harness?.another() ?? -1);
  const sendOther = (message: object) =>
    page.evaluate(
      (other, message) => void window.__harness?.others[other]?.dispatch(JSON.stringify(message)).catch(() => {}),
      other,
      message
    );
  send({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const s1 = await attached(frameId);
  await sendOther({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH });
  const event = await message(m => m['other'] === other && m['method'] === 'Target.attachedToTarget');
  const s2 = String(field(event['params'], 'sessionId'));
  send({ id: 2, method: 'Runtime.enable', sessionId: s1 });
  await reply(2);
  await page.evaluate(() => window.__harness?.navigate('child'));
  // The next document's Runtime is enabled again for the first client only.
  const contexts = await waitFor(async () => {
    const got = (await out()).filter(m => m['method'] === 'Runtime.executionContextCreated');
    return got.length >= 2 ? got : undefined;
  });
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(
    (await out()).filter(m => m['method'] === 'Runtime.executionContextCreated').map(m => m['sessionId']),
    [s1, s1]
  );
  assert.equal(contexts[1]?.['other'], undefined);
  await sendOther({ id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: s2 });
  assert.equal(
    field(field(field(await message(m => m['other'] === other && m['id'] === 2), 'result'), 'result'), 'value'),
    'child'
  );
});
