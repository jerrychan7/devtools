// Chrome's side of cross-origin iframes as child targets: the reference our agent's child targets
// are to follow (see test-support/oopif-notes.md). Of the agent's side, the parent's view of the
// iframe is checked here, and the whole of it end to end: a parent page and a cross-origin child,
// both with the probe and trusting each other, linked by the handshake, driven as the frontend
// drives Chrome, and compared with Chrome on the same pages.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { CDP_BUNDLE, type Env } from '../../../test-support/conformance.ts';
import {
  chromeSequence,
  FRONTEND_ENABLES,
  fixtureUrl,
  launchOopif,
  OopifPage,
  SCENARIOS,
  THIRD_HOST,
  type Step,
} from '../../../test-support/oopif.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

const methods = (steps: Step[]) => steps.map(s => `${s.session} ${s.method}`);
const attached = (steps: Step[]) => steps.filter(s => s.method === 'Target.attachedToTarget');

test('chrome: each cross-site iframe is a child target of the session of the frame that holds it', async () => {
  assert.ok(env);
  const { setup } = await chromeSequence(env, async () => {});
  const [child, grandchild] = attached(setup).filter(s => s.session !== 'browser');
  // The target is the frame: its targetId is the frame id the parent knew it by, and it is
  // attached before it commits, with no URL yet and paused.
  assert.deepEqual(child, {
    session: 'root',
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 's1',
      targetInfo: {
        targetId: 'id2',
        type: 'iframe',
        title: '',
        url: '',
        attached: true,
        parentId: 'page',
        canAccessOpener: false,
        parentFrameId: 'page',
      },
      waitingForDebugger: true,
    },
  });
  // The grandchild hangs off the child's session, not the root's.
  assert.equal(grandchild?.session, 's1');
  assert.deepEqual(Reflect.get(Reflect.get(Object(grandchild?.params), 'targetInfo'), 'parentFrameId'), 'id2');
  // The parent's frame is swapped out once the child target has it.
  const swap = setup.findIndex(s => s.session === 'root' && s.method === 'Page.frameDetached');
  assert.ok(swap > setup.indexOf(child));
  assert.deepEqual(setup[swap]?.params, { frameId: 'id2', reason: 'swap' });
});

test('chrome: the parent keeps the <iframe> element but not the frame', async () => {
  assert.ok(env);
  const page = await OopifPage.open(env, fixtureUrl(env, 'oopif-parent.html'));
  try {
    const child = await page.child('oopif-child');
    await page.child(THIRD_HOST);
    const root = await page.cdp.send('Page.getFrameTree', {}, page.sessionId);
    assert.equal(root.frameTree.childFrames, undefined);
    const own = await page.cdp.send('Page.getFrameTree', {}, child);
    const doc = await page.cdp.send('DOM.getDocument', {}, page.sessionId);
    const { nodeId } = await page.cdp.send(
      'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: 'iframe' },
      page.sessionId
    );
    const { node } = await page.cdp.send('DOM.describeNode', { nodeId, depth: -1 }, page.sessionId);
    assert.equal(node.frameId, own.frameTree.frame.id);
    assert.equal(node.childNodeCount, 0);
    assert.equal(node.contentDocument, undefined);
    const owner = await page.cdp.send('DOM.getFrameOwner', { frameId: own.frameTree.frame.id }, page.sessionId);
    assert.equal(owner.nodeId, nodeId);
  } finally {
    page.close();
  }
});

test('chrome: input aimed at an iframe on the parent session reaches the iframe', async () => {
  assert.ok(env);
  const page = await OopifPage.open(env, fixtureUrl(env, 'oopif-parent.html'));
  try {
    const child = await page.child('oopif-child');
    // Chrome routes input to an out-of-process iframe by the compositor's hit-test data, which
    // the iframe has only once it has been drawn: wait for frames in both before clicking.
    const drawn = {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true,
    };
    await page.cdp.send('Runtime.evaluate', drawn, child);
    await page.cdp.send('Runtime.evaluate', drawn, page.sessionId);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await page.cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: 50, y: 120, button: 'left', clickCount: 1 },
        page.sessionId
      );
    }
    const clicks = await page.cdp.send('Runtime.evaluate', { expression: 'window.clicks', returnByValue: true }, child);
    // The iframe sits at (0, 100) in the parent.
    assert.deepEqual(clicks.result.value, [
      ['mousedown', 50, 20],
      ['click', 50, 20],
    ]);
  } finally {
    page.close();
  }
});

test('chrome: a cross-site frame keeps its target across reloads and navigations to other sites', async () => {
  assert.ok(env);
  for (const act of [SCENARIOS.reload, SCENARIOS.sameOrigin, SCENARIOS.otherSite(env)]) {
    const { steps } = await chromeSequence(env, act);
    assert.ok(
      !steps.some(s => s.method === 'Target.detachedFromTarget' && Reflect.get(Object(s.params), 'sessionId') === 's1')
    );
    assert.ok(steps.some(s => s.session === 's1' && s.method === 'Page.frameNavigated'));
    assert.ok(steps.some(s => s.session === 'root' && s.method === 'Target.targetInfoChanged'));
  }
});

test('chrome: a frame that comes back to its parent site, or is removed, is detached', async () => {
  assert.ok(env);
  const back = await chromeSequence(env, SCENARIOS.parentOrigin(env));
  assert.deepEqual(methods(back.steps).slice(1, 4), [
    'root Target.detachedFromTarget',
    'root Page.frameAttached',
    'root Page.frameNavigated',
  ]);
  const removed = await chromeSequence(env, SCENARIOS.remove);
  assert.deepEqual(methods(removed.steps), [
    's1 Page.frameDetached',
    's1 Target.detachedFromTarget',
    'root Page.frameDetached',
    'root Target.detachedFromTarget',
  ]);
});

test('ours: the parent keeps the <iframe> element with a frame id but no document, as Chrome', async () => {
  assert.ok(env);
  const page = await env.browser.newPage();
  try {
    await page.goto(fixtureUrl(env, 'oopif-parent.html'));
    // Cross-origin once the child has loaded: before, it holds an about:blank of the parent's.
    await page.waitForFunction(() => {
      try {
        return document.querySelector('iframe')?.contentDocument === null;
      } catch {
        return true;
      }
    });
    await page.addScriptTag({ path: CDP_BUNDLE });
    const results = await page.evaluate(async () => {
      const session = window.DevtoolsAnywhere.createCdpSession();
      const call = (method: string, params: object = {}) =>
        session.call(method, params).catch((e: unknown) => String(e instanceof Error ? e.message : e));
      const get = (value: unknown, name: string): unknown =>
        typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
      const record = (value: unknown): Record<string, unknown> => ({ ...Object(value) });
      const unknown = await call('DOM.getFrameOwner', { frameId: 'nope' });
      await call('DOM.getDocument', { depth: -1 });
      const nodeId = Number(get(await call('DOM.querySelector', { nodeId: 1, selector: 'iframe' }), 'nodeId'));
      const described = get(await call('DOM.describeNode', { nodeId, depth: -1 }), 'node');
      const frameId = String(get(described, 'frameId'));
      return {
        node: record(described),
        frameId,
        nodeId,
        owner: record(await call('DOM.getFrameOwner', { frameId })),
        unknown,
        top: await call('DOM.getFrameOwner', { frameId: 'devtools-anywhere-frame' }),
        tree: await call('Page.getFrameTree'),
      };
    });
    // As Chrome reports it (the test above): a frame id, no children, no document.
    assert.equal(results.node['childNodeCount'], 0);
    assert.deepEqual(results.node['children'], []);
    assert.equal(results.node['contentDocument'], undefined);
    assert.ok(results.frameId.startsWith('devtools-anywhere-frame-'));
    assert.equal(results.owner['nodeId'], results.nodeId);
    assert.equal(typeof results.owner['backendNodeId'], 'number');
    // Chrome's errors (measured): an unknown frame, and one that is not an iframe of the target.
    assert.equal(results.unknown, 'Frame with the given id was not found.');
    assert.equal(results.top, 'Frame with the given id does not belong to the target.');
    assert.equal(Reflect.get(Object(Reflect.get(Object(results.tree), 'frameTree')), 'childFrames'), undefined);
  } finally {
    await page.close();
  }
});

/** A message a client got: an event with the session it came on ('' for the root's). */
interface Received {
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

/** One side of the comparison, set up as the frontend sets up a page and its iframe target. */
interface Side {
  /** A command's result, or its error's message. */
  send(method: string, params?: object, sessionId?: string): Promise<Record<string, unknown> | string>;
  events(): Promise<Received[]>;
  /** The root's target id, the child's session and the child's target id. */
  readonly root: string;
  readonly child: string;
  readonly childTarget: string;
  close(): Promise<void> | void;
}

const get = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

/** The pages compared: the parent on localhost, its iframe on 127.0.0.1, both with the probe, trusting each other. */
function linkedUrl(): string {
  assert.ok(env);
  const childUrl = new URL(fixtureUrl(env, 'frame-link-child.html', '127.0.0.1'));
  childUrl.searchParams.set('parentOrigins', new URL(fixtureUrl(env, '')).origin);
  const parentUrl = new URL(fixtureUrl(env, 'frame-link-parent.html'));
  parentUrl.searchParams.set('frameOrigins', childUrl.origin);
  parentUrl.searchParams.set('child', childUrl.href);
  return parentUrl.href;
}

/** Chrome, through OopifPage, which sets up the child as the frontend does. */
async function chromeSide(): Promise<Side> {
  assert.ok(env);
  const page = await OopifPage.open(env, linkedUrl());
  const child = await page.child('frame-link-child');
  const childTarget = page.children.find(c => c.sessionId === child)?.targetId ?? '';
  await page.cdp.settle();
  return {
    root: page.targetId,
    child,
    childTarget,
    send: (method, params = {}, sessionId = page.sessionId) =>
      // Any method: the comparison reads the replies loosely.
      Reflect.apply(page.cdp.send, page.cdp, [method, params, sessionId]).then(
        (result: unknown) => ({ ...Object(result) }),
        (e: unknown) => String(e instanceof Error ? e.message : e).replace(`${method}: `, '')
      ),
    events: async () =>
      page.cdp.log
        .filter(e => e.sessionId !== '')
        .map(e => ({ ...e, sessionId: e.sessionId === page.sessionId ? '' : e.sessionId })),
    close: () => page.close(),
  };
}

/**
 * Our agent in the parent page, with a flatten client in the page, which sets up the child as the
 * frontend does: Page, Runtime, DOM and Network enabled on the child's session, auto-attach on it
 * too, then resumed.
 */
async function oursSide(): Promise<Side> {
  assert.ok(env);
  const page: Page = await env.browser.newPage();
  await page.goto(linkedUrl());
  await page.waitForFunction(() => 'DevtoolsAnywhere' in window);
  await page.evaluate(() => {
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
    window.__client = {
      log,
      send: (method, params = {}, sessionId = '') =>
        new Promise(resolve => {
          const id = ++seq;
          pending.set(id, resolve);
          void session.dispatch(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        }),
    };
  });
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
  for (const method of FRONTEND_ENABLES) await send(method, {}, child);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
  if (attached.params['waitingForDebugger']) await send('Runtime.runIfWaitingForDebugger', {}, child);
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
    close: () => page.close(),
  };
}

/**
 * What the frontend reads of the iframe's target, with ids named by what they are ('page' the
 * root's target and main frame, 'child' the child's) and fields that differ on every run dropped.
 */
async function view(side: Side) {
  const name = (id: unknown) => (id === side.root ? 'page' : id === side.childTarget ? 'child' : id);
  const all = await side.events();
  const attached = all.find(e => e.sessionId === '' && e.method === 'Target.attachedToTarget')?.params;
  const info = get(attached, 'targetInfo');
  const childInfo = get(await side.send('Target.getTargetInfo', {}, side.child), 'targetInfo');
  const frame = get(get(await side.send('Page.getFrameTree', {}, side.child), 'frameTree'), 'frame');
  const doc = get(await side.send('DOM.getDocument', {}, side.child), 'root');
  // The frontend grafts the child's document under the parent's <iframe> (DOMModel.requestDocument).
  const rootDoc = get(await side.send('DOM.getDocument'), 'root');
  const iframe = get(
    await side.send('DOM.querySelector', { nodeId: get(rootDoc, 'nodeId'), selector: 'iframe' }),
    'nodeId'
  );
  const owner = get(await side.send('DOM.getFrameOwner', { frameId: side.childTarget }), 'nodeId');
  const childOwner = await side.send('DOM.getFrameOwner', { frameId: side.childTarget }, side.child);
  const contexts = (sessionId: string) =>
    all
      .filter(e => e.sessionId === sessionId && e.method === 'Runtime.executionContextCreated')
      .map(e => get(e.params, 'context'))
      .filter(c => get(get(c, 'auxData'), 'frameId') === side.childTarget)
      .map(c => ({ origin: get(c, 'origin'), isDefault: get(get(c, 'auxData'), 'isDefault') }));
  const logged = (sessionId: string) =>
    all
      .filter(e => e.sessionId === sessionId && e.method === 'Runtime.consoleAPICalled')
      .map(e => (Array.isArray(e.params['args']) ? e.params['args'].map(a => get(a, 'value')) : []))
      .filter(args => args[0] === 'child loaded');
  return {
    attached: {
      session: typeof get(attached, 'sessionId'),
      // Not compared: Chrome attaches before the child commits (url and title empty, paused).
      targetInfo: {
        targetId: name(get(info, 'targetId')),
        type: get(info, 'type'),
        attached: get(info, 'attached'),
        parentId: name(get(info, 'parentId')),
        canAccessOpener: get(info, 'canAccessOpener'),
        parentFrameId: name(get(info, 'parentFrameId')),
      },
    },
    targetInfo: {
      targetId: name(get(childInfo, 'targetId')),
      type: get(childInfo, 'type'),
      url: get(childInfo, 'url'),
      parentId: name(get(childInfo, 'parentId')),
      parentFrameId: name(get(childInfo, 'parentFrameId')),
    },
    frame: {
      id: name(get(frame, 'id')),
      parentId: name(get(frame, 'parentId')),
      name: get(frame, 'name'),
      url: get(frame, 'url'),
      securityOrigin: get(frame, 'securityOrigin'),
    },
    document: { documentURL: get(doc, 'documentURL'), baseURL: get(doc, 'baseURL') },
    ownerIsIframe: owner !== undefined && owner === iframe,
    childOwner,
    contexts: { child: contexts(side.child), root: contexts('') },
    console: { child: logged(side.child), root: logged('') },
    history: await side.send('Page.getNavigationHistory', {}, side.child),
  };
}

test('ours: a linked cross-origin iframe is a child target as in Chrome, end to end', async () => {
  const chrome = await chromeSide();
  const ours = await oursSide();
  try {
    const [expected, actual] = [await view(chrome), await view(ours)];
    // Left out, as timing ours cannot have: Chrome attaches the child paused before it commits
    // (waitingForDebugger, empty URL; not in `view`), and the root first has the iframe's
    // initial about:blank frame and context, swapped out (frameDetached reason "swap") once the
    // child target has it. Our parent never reports the cross-origin frame, and the child is
    // linked only once its probe runs, after it committed.
    expected.contexts.root = [];
    assert.deepEqual(actual, expected);
    // As measured (oopif-notes.md): the target is the parent's frame, its main frame hangs off the
    // parent's, and its context, console and document are on its session only.
    assert.equal(actual.attached.targetInfo.parentFrameId, 'page');
    assert.equal(actual.frame.parentId, 'page');
    assert.equal(actual.frame.name, '');
    assert.equal(actual.history, 'Command can only be executed on top-level targets');
    assert.equal(actual.contexts.child.length, 1);
    assert.equal(actual.console.child.length, 1);
    assert.ok(actual.ownerIsIframe);
  } finally {
    await chrome.close();
    await ours.close();
  }
});

test('ours: a detached iframe target starts clean when attached again, as a new Chrome session', async () => {
  const ours = await oursSide();
  try {
    const first = get(await ours.send('DOM.getDocument', {}, ours.child), 'root');
    const evaluated = get(await ours.send('Runtime.evaluate', { expression: 'document.body' }, ours.child), 'result');
    await ours.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    await ours.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    let session: unknown;
    for (const start = Date.now(); session === undefined; await new Promise(r => setTimeout(r, 20))) {
      const again = (await ours.events()).filter(e => e.method === 'Target.attachedToTarget' && e.sessionId === '');
      session = again[1]?.params['sessionId'];
      if (Date.now() - start > 5000) throw new Error('not attached again');
    }
    const child = String(session);
    // The old session's remote object is gone, as in a new Chrome session.
    const stale = await ours.send('Runtime.getProperties', { objectId: get(evaluated, 'objectId') }, child);
    assert.equal(typeof stale, 'string');
    // So are the old session's node ids: the new one has none before its DOM.getDocument.
    const old = await ours.send('DOM.describeNode', { nodeId: get(first, 'nodeId') }, child);
    assert.equal(typeof old, 'string');
    const second = get(await ours.send('DOM.getDocument', {}, child), 'root');
    assert.equal(get(second, 'documentURL'), get(first, 'documentURL'));
    assert.equal(await ours.send('DOM.describeNode', { nodeId: 1 }, ours.child), 'Session with given id not found.');
  } finally {
    await ours.close();
  }
});
