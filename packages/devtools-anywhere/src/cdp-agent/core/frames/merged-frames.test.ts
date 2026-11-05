// The merged frames' router (merged-frames.ts): a client's commands routed to a merged frame's
// agent by the ids they carry, fanned out to all, the sessions' life. Stand-in links and frame
// agents, bundled for Node.
import { before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ChildLink, ChildSession, ChildTargets as ChildTargetsType } from './child-targets.ts';
import type { MergedFrames as MergedFramesType, ownerOfId as OwnerOfId } from './merged-frames.ts';
import type { CdpSession as CdpSessionType } from '../session.ts';

interface Loaded {
  MergedFrames: typeof MergedFramesType;
  ChildTargets: typeof ChildTargetsType;
  CdpSession: typeof CdpSessionType;
  ownerOfId: typeof OwnerOfId;
}
let lib: Loaded;

before(async () => {
  const bundled = await build({
    stdin: {
      contents:
        "export { MergedFrames, ownerOfId } from './merged-frames.ts'; export { ChildTargets } from './child-targets.ts'; export { CdpSession } from '../session.ts';",
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const code = bundled.outputFiles[0]?.text ?? '';
  lib = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
});

type Message = { id?: unknown; method?: string; params?: Record<string, unknown> };

/**
 * A merged frame's stand-in agent: each session it opens answers with `answer` (an error when it
 * throws), and records what it got.
 */
function frameAgent(frameId: string, answer: (message: Message) => unknown = () => ({})) {
  const linkCloses = new Set<() => void>();
  const sessions: { got: Message[]; emit(event: object): void; closed: boolean }[] = [];
  let linkClosed = false;
  const link: ChildLink = {
    owner: {} as Element,
    frameId,
    send: () => assert.fail('the router talks on sessions'),
    onMessage: () => () => {},
    openSession(): ChildSession {
      const listeners = new Set<(message: string) => void>();
      const closes = new Set<() => void>();
      const record = {
        got: [] as Message[],
        closed: false,
        emit: (event: object) => listeners.forEach(l => l(JSON.stringify(event))),
      };
      sessions.push(record);
      const close = () => {
        if (record.closed) return;
        record.closed = true;
        closes.forEach(l => l());
      };
      linkCloses.add(close);
      return {
        send(text) {
          const message: Message = JSON.parse(text);
          record.got.push(message);
          queueMicrotask(() => {
            let reply: object;
            try {
              reply = { id: message.id, result: answer(message) };
            } catch (e) {
              reply = { id: message.id, error: { code: -32000, message: String(e instanceof Error ? e.message : e) } };
            }
            listeners.forEach(l => l(JSON.stringify(reply)));
          });
        },
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onClose(listener) {
          closes.add(listener);
          return () => closes.delete(listener);
        },
        close,
      };
    },
    onClose(listener) {
      if (linkClosed) {
        listener();
        return () => {};
      }
      linkCloses.add(listener);
      return () => linkCloses.delete(listener);
    },
    close() {
      if (linkClosed) return;
      linkClosed = true;
      [...linkCloses].forEach(l => l());
    },
  };
  return { link, sessions };
}

/** A client of the page's agent: its replies by id, and the events it got. */
function client(merged: MergedFramesType) {
  const session = new lib.CdpSession();
  const out: Record<string, unknown>[] = [];
  session.onMessage(message => out.push(JSON.parse(message)));
  merged.attach(session);
  let seq = 0;
  const send = async (method: string, params: object = {}) => {
    const id = ++seq;
    await session.dispatch({ id, method, params });
    return out.find(m => m['id'] === id);
  };
  return { session, out, send };
}

function setUp() {
  const merged = new lib.MergedFrames(new lib.ChildTargets());
  merged.registerRoutes('DOM', {
    routeBy: { 'DOM.describeNode': ['nodeId', 'backendNodeId'] },
    fanOut: ['DOM.enable', 'DOM.disable'],
  });
  merged.registerRoutes('Runtime', { routeBy: { 'Runtime.callFunctionOn': ['objectId', 'executionContextId'] } });
  return merged;
}

test('ids tell their namespace: integers from ns * 2^32, strings prefixed m{ns}.', () => {
  assert.equal(lib.ownerOfId(5), undefined);
  assert.equal(lib.ownerOfId(2 ** 32 - 1), undefined);
  assert.equal(lib.ownerOfId(2 ** 32 + 5), 1);
  assert.equal(lib.ownerOfId(3 * 2 ** 32), 3);
  assert.equal(lib.ownerOfId('m2.123.4'), 2);
  assert.equal(lib.ownerOfId('123.4'), undefined);
  assert.equal(lib.ownerOfId('m0.1'), undefined);
  assert.equal(lib.ownerOfId(undefined), undefined);
});

test("a command carrying a merged frame's id goes to its agent, as sent; the answer is the client's", async () => {
  const merged = setUp();
  const a = frameAgent('A', m => ({ node: { nodeId: m.params?.['nodeId'] } }));
  const b = frameAgent('B', () => assert.fail('not B'));
  merged.addMerged(a.link, 1);
  merged.addMerged(b.link, 2);
  const { session, send } = client(merged);
  session.register('DOM', { describeNode: () => ({ own: true }) });
  assert.deepEqual(await send('DOM.describeNode', { nodeId: 2 ** 32 + 9 }), {
    id: 1,
    result: { node: { nodeId: 2 ** 32 + 9 } },
  });
  assert.deepEqual(
    a.sessions[0]?.got.map(m => [m.method, m.params]),
    [['DOM.describeNode', { nodeId: 2 ** 32 + 9 }]]
  );
  // The page's own ids stay the page's.
  assert.deepEqual(await send('DOM.describeNode', { nodeId: 9 }), { id: 2, result: { own: true } });
  assert.equal(b.sessions.length, 0);
});

test("the frame agent's error is the client's", async () => {
  const merged = setUp();
  const a = frameAgent('A', () => {
    throw new Error('Could not find object with given id');
  });
  merged.addMerged(a.link, 1);
  const { send } = client(merged);
  const reply = await send('Runtime.callFunctionOn', { objectId: 'm1.5.1', functionDeclaration: 'f' });
  assert.deepEqual(reply?.['error'], { code: -32000, message: 'Could not find object with given id' });
});

test('a fanned-out command runs in the page, then in every frame; their errors are ignored', async () => {
  const merged = setUp();
  const a = frameAgent('A');
  const b = frameAgent('B', () => {
    throw new Error('nope');
  });
  merged.addMerged(a.link, 1);
  merged.addMerged(b.link, 2);
  const { session, send } = client(merged);
  const ran: string[] = [];
  session.register('DOM', { enable: () => void ran.push('page') });
  assert.deepEqual(await send('DOM.enable'), { id: 1, result: {} });
  assert.deepEqual(ran, ['page']);
  assert.deepEqual(
    a.sessions[0]?.got.map(m => m.method),
    ['DOM.enable']
  );
  assert.deepEqual(
    b.sessions[0]?.got.map(m => m.method),
    ['DOM.enable']
  );
});

test("a frame's events reach the client as they are; its answers to the router do not", async () => {
  const merged = setUp();
  const a = frameAgent('A');
  merged.addMerged(a.link, 1);
  const { session, out, send } = client(merged);
  session.register('DOM', { enable: () => {} });
  await send('DOM.enable');
  a.sessions[0]?.emit({ method: 'DOM.documentUpdated', params: {} });
  assert.deepEqual(out, [
    { id: 1, result: {} },
    { method: 'DOM.documentUpdated', params: {} },
  ]);
});

test('each client has a session of its own with a frame', async () => {
  const merged = setUp();
  const a = frameAgent('A');
  merged.addMerged(a.link, 1);
  const one = client(merged);
  const two = client(merged);
  for (const { session } of [one, two]) session.register('DOM', { enable: () => {} });
  await one.send('DOM.enable');
  await two.send('DOM.enable');
  assert.equal(a.sessions.length, 2);
});

test("a frame linked later (the iframe's next document) is set up as the client set up the others", async () => {
  const merged = setUp();
  const first = frameAgent('A');
  merged.addMerged(first.link, 1);
  const { session, send } = client(merged);
  session.register('DOM', { enable: () => {}, disable: () => {} });
  await send('DOM.enable');
  first.link.close();
  assert.equal(first.sessions[0]?.closed, true);
  const next = frameAgent('A');
  merged.addMerged(next.link, 1);
  assert.deepEqual(
    next.sessions[0]?.got.map(m => m.method),
    ['DOM.enable']
  );
  // A disable drops the enable: nothing to set up then.
  await send('DOM.disable');
  next.link.close();
  const last = frameAgent('A');
  merged.addMerged(last.link, 1);
  assert.equal(last.sessions.length, 0);
});

test("the client's reset closes its sessions with the frames, and forgets its setup", async () => {
  const merged = setUp();
  const a = frameAgent('A');
  merged.addMerged(a.link, 1);
  const { session, send } = client(merged);
  session.register('DOM', { enable: () => {} });
  await send('DOM.enable');
  session.reset();
  assert.equal(a.sessions[0]?.closed, true);
  const next = frameAgent('A');
  merged.addMerged(next.link, 1);
  assert.equal(next.sessions.length, 0);
});

test('a command waiting for a frame whose link closes is answered with an error', async () => {
  const merged = setUp();
  const a = frameAgent('A');
  // Never answers.
  a.link.openSession = (open => () => {
    const session = open();
    return { ...session, send: () => {} };
  })(a.link.openSession.bind(a.link));
  merged.addMerged(a.link, 1);
  const { send } = client(merged);
  const reply = send('DOM.describeNode', { backendNodeId: 2 ** 32 + 1 });
  await new Promise(resolve => setTimeout(resolve));
  a.link.close();
  assert.deepEqual((await reply)?.['error'], { code: -32000, message: 'Inspected target navigated or closed' });
});

test('a command by frame id goes to that frame', async () => {
  const merged = setUp();
  merged.registerRoutes('Page', { routeBy: { 'Page.getResourceTree': ['frameId'] } });
  const a = frameAgent('FRAME-A', () => ({ from: 'A' }));
  merged.addMerged(a.link, 1);
  const { send } = client(merged);
  assert.deepEqual(await send('Page.getResourceTree', { frameId: 'FRAME-A' }), { id: 1, result: { from: 'A' } });
});

test('each merged document gets a namespace of its own; one linked again keeps its own', () => {
  const merged = setUp();
  const one = {} as Element;
  const two = {} as Element;
  assert.equal(merged.nsFor(one), 1);
  assert.equal(merged.nsFor(two), 2);
  // The frame's next document (no namespace told), then that one linked again.
  assert.equal(merged.nsFor(one), 3);
  assert.equal(merged.nsFor(one, 3), 3);
  // A namespace the element was not given last is not given again, to it or another.
  assert.equal(merged.nsFor(one, 1), 4);
  assert.equal(merged.nsFor(two, 4), 5);
});

/** A frame agent that announces a context, of namespace `ns`, on Runtime.enable. */
function withContext(frameId: string, ns: number) {
  const agent = frameAgent(frameId);
  const open = agent.link.openSession.bind(agent.link);
  agent.link.openSession = () => {
    const session = open();
    const record = agent.sessions[agent.sessions.length - 1];
    return {
      ...session,
      send(text) {
        session.send(text);
        if (JSON.parse(text).method !== 'Runtime.enable') return;
        const id = ns * 2 ** 32 + 1;
        record?.emit({
          method: 'Runtime.executionContextCreated',
          params: { context: { id, uniqueId: `u${id}`, auxData: { frameId } } },
        });
      },
    };
  };
  return agent;
}

const contextEvents = (out: Record<string, unknown>[]) =>
  out
    .filter(m => typeof m['method'] === 'string' && m['method'].startsWith('Runtime.executionContext'))
    .map(m => [m['method'], m['params']]);

const created = (id: number) => [
  'Runtime.executionContextCreated',
  { context: { id, uniqueId: `u${id}`, auxData: { frameId: 'A' } } },
];
const destroyed = (id: number) => [
  'Runtime.executionContextDestroyed',
  { executionContextId: id, executionContextUniqueId: `u${id}` },
];

test("a frame's document gone, its contexts are destroyed for the clients with Runtime enabled, before its next one's", async () => {
  const merged = setUp();
  merged.registerRoutes('Runtime', { fanOut: ['Runtime.enable', 'Runtime.disable'] });
  const first = withContext('A', 1);
  merged.addMerged(first.link, 1);
  const enabled = client(merged);
  const other = client(merged);
  enabled.session.register('Runtime', { enable: () => {} });
  other.session.register('DOM', { enable: () => {} });
  await enabled.send('Runtime.enable');
  await other.send('DOM.enable');
  first.link.close();
  const next = withContext('A', 2);
  merged.addMerged(next.link, 2);
  assert.deepEqual(contextEvents(enabled.out), [
    created(2 ** 32 + 1),
    destroyed(2 ** 32 + 1),
    created(2 * 2 ** 32 + 1),
  ]);
  // Nothing for a client without Runtime, nor for one whose reset closed its sessions.
  assert.deepEqual(contextEvents(other.out), []);
  enabled.session.reset();
  const before = enabled.out.length;
  next.link.close();
  assert.equal(enabled.out.length, before);
});

test('a context the frame destroyed itself is not destroyed again when its document goes', async () => {
  const merged = setUp();
  merged.registerRoutes('Runtime', { fanOut: ['Runtime.enable'] });
  const a = withContext('A', 1);
  merged.addMerged(a.link, 1);
  const { session, out, send } = client(merged);
  session.register('Runtime', { enable: () => {} });
  await send('Runtime.enable');
  a.sessions[0]?.emit({ method: destroyed(2 ** 32 + 1)[0], params: destroyed(2 ** 32 + 1)[1] });
  a.link.close();
  assert.equal(out.filter(m => m['method'] === 'Runtime.executionContextDestroyed').length, 1);
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('a fanned-out command waits no longer than the timeout for a frame that does not answer; its late answer is dropped', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const merged = setUp();
    const a = frameAgent('A');
    let late: (() => void) | undefined;
    a.link.openSession = (open => () => {
      const session = open();
      return {
        ...session,
        send: text => {
          late = () => session.send(text);
        },
      };
    })(a.link.openSession.bind(a.link));
    merged.addMerged(a.link, 1);
    const { session, out, send } = client(merged);
    session.register('DOM', { enable: () => {} });
    let answered = false;
    const reply = send('DOM.enable').then(value => {
      answered = true;
      return value;
    });
    await settle();
    mock.timers.tick(999);
    await settle();
    assert.equal(answered, false);
    mock.timers.tick(1);
    assert.deepEqual(await reply, { id: 1, result: {} });
    // The frame answers at last: an answer to the router, not an event of the client's.
    assert.ok(late);
    late();
    await settle();
    assert.deepEqual(out, [{ id: 1, result: {} }]);
  } finally {
    mock.timers.reset();
  }
});

test("a fanned-out command the page's handler fails is the client's error, and never reaches the frames", async () => {
  const merged = setUp();
  const a = frameAgent('A');
  merged.addMerged(a.link, 1);
  const { session, send } = client(merged);
  session.register('DOM', {
    enable: () => {
      throw new Error('page says no');
    },
  });
  const reply = await send('DOM.enable');
  assert.deepEqual(reply?.['error'], { code: -32000, message: 'page says no' });
  assert.equal(a.sessions.length, 0);
  // Nor is it set up in a frame linked later.
  const next = frameAgent('A');
  merged.addMerged(next.link, 2);
  assert.equal(next.sessions.length, 0);
});

test('a frame linked later gets the last params of each fanned-out command, in the order first sent', async () => {
  const merged = setUp();
  merged.registerRoutes('Emulation', { fanOut: ['Emulation.setTouchEmulationEnabled'] });
  const { session, send } = client(merged);
  session.register('DOM', { enable: () => {} });
  session.register('Emulation', { setTouchEmulationEnabled: () => {} });
  await send('DOM.enable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 2 });
  await send('DOM.enable');
  const a = frameAgent('A');
  merged.addMerged(a.link, 1);
  assert.deepEqual(
    a.sessions[0]?.got.map(m => [m.method, m.params]),
    [
      ['DOM.enable', {}],
      ['Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 2 }],
    ]
  );
});

test('a domain registers only its own methods', () => {
  const merged = setUp();
  assert.throws(() => merged.registerRoutes('DOM', { fanOut: ['CSS.enable'] }), /not of DOM/);
});
