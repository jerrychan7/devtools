// A linked cross-origin iframe's lifecycle and nesting, ours against Chrome on the same pages: a
// parent on localhost, its iframe on 127.0.0.1, which has one of its own on THIRD_HOST, all with
// the probe and trusting each other (oopif-sides.ts, `nested`), driven as the frontend drives
// Chrome. What Chrome does is in test-support/oopif-notes.md (Lifecycle, Nesting).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeSide, get, oursSide, type Received, type Side } from '../../../../test-support/oopif-sides.ts';
import { fixtureUrl, launchOopif, THIRD_HOST } from '../../../../test-support/oopif.ts';
import type { Env } from '../../../../test-support/conformance.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

/** Waits until no event has come for a while. */
async function settle(side: Side) {
  for (let seen = -1, now = 0; seen !== now; await new Promise(r => setTimeout(r, 400))) {
    seen = now;
    now = (await side.events()).length;
  }
}

/**
 * The events that show the targets and the child's frame coming and going, as lines: sessions
 * named root, s1, s2… in the order they were attached, ids by what they are or in order of
 * appearance. Of the frames, only the child's own (its target's main frame); of targetInfoChanged
 * and documentUpdated, which Chrome may send more than once, the first.
 */
function lifecycle(side: Side, all: Received[], from: number): string[] {
  const sessions = new Map<string, string>([['', 'root']]);
  for (const e of all) {
    const id = e.params['sessionId'];
    if (e.method === 'Target.attachedToTarget' && typeof id === 'string') sessions.set(id, `s${sessions.size}`);
  }
  const ids = new Map<unknown, string>([
    [side.root, 'page'],
    [side.childTarget, 'child'],
  ]);
  const name = (id: unknown) => {
    if (typeof id === 'string' && sessions.has(id)) return sessions.get(id);
    if (!ids.has(id)) ids.set(id, `id${ids.size - 1}`);
    return ids.get(id);
  };
  const lines: string[] = [];
  for (const { sessionId, method, params } of all.slice(from)) {
    const session = sessions.get(sessionId) ?? sessionId;
    const frameId = get(params, 'frameId') ?? get(get(params, 'frame'), 'id');
    let line: string | undefined;
    if (method === 'Target.attachedToTarget' || method === 'Target.detachedFromTarget')
      line = `${session} ${method} ${name(params['sessionId'])}`;
    else if (method === 'Target.targetInfoChanged' && session === 'root')
      line = `${session} ${method} ${name(get(params['targetInfo'], 'targetId'))}`;
    else if (/^Page\.frame(Attached|Navigated)$/.test(method) && frameId === side.childTarget)
      line = `${session} ${method} child`;
    else if (method === 'DOM.documentUpdated' && session === 's1') line = `${session} ${method}`;
    else if (method === 'Runtime.consoleAPICalled' && get(get(params['args'], '0'), 'value') === 'child loaded')
      line = `${session} console`;
    if (line && !(/targetInfoChanged|documentUpdated/.test(line) && lines.includes(line))) lines.push(line);
  }
  return lines;
}

/** Each side's lifecycle lines after `act`, the iframe nesting another. */
async function both(act: (side: Side) => Promise<unknown>): Promise<{ chrome: string[]; ours: string[] }> {
  assert.ok(env);
  const lines: string[][] = [];
  for (const open of [chromeSide, oursSide]) {
    const side = await open(env, { nested: true });
    try {
      await settle(side);
      const from = (await side.events()).length;
      await act(side);
      // A navigation's events come after a pause: the next document loads first.
      await new Promise(r => setTimeout(r, 1000));
      await settle(side);
      lines.push(lifecycle(side, await side.events(), from));
    } finally {
      await side.close();
    }
  }
  const [chrome = [], ours = []] = lines;
  return { chrome, ours };
}

/** The child's next document: the same page, which nests the grandchild again. */
const RELOADED = [
  's1 Target.detachedFromTarget s2',
  's1 Page.frameNavigated child',
  'root Target.targetInfoChanged child',
  's1 DOM.documentUpdated',
  's1 console',
  's1 Target.attachedToTarget s3',
  's3 console',
];

test('a reloaded iframe keeps its target and session, its old child goes and a new one comes, as in Chrome', async () => {
  const { chrome, ours } = await both(side => side.run('setTimeout(() => location.reload()); 0', true));
  assert.deepEqual(chrome, RELOADED);
  assert.deepEqual(ours, chrome);
});

test('so does an iframe going to another page of its origin, as in Chrome', async () => {
  const { chrome, ours } = await both(side =>
    side.run("setTimeout(() => { location.href = location.href + '&again'; }); 0", true)
  );
  assert.deepEqual(chrome, RELOADED);
  assert.deepEqual(ours, chrome);
});

test('and one the parent points at another site, whose own iframe is then same-origin with it, as in Chrome', async () => {
  const { chrome, ours } = await both(side =>
    side.run(
      `const f = document.getElementById('child'); const u = new URL(f.src); u.hostname = '${THIRD_HOST}'; f.src = u.href; 0`
    )
  );
  // The grandchild, on the same site as its parent now, is a frame of the child's target, not a
  // target of its own: its console is on the child's session.
  assert.deepEqual(chrome, [...RELOADED.slice(0, 5), 's1 console']);
  // Ours misses what a same-origin iframe logs before its load event (docs/usage.md, same-origin
  // iframes), in an iframe target's page as in a top one.
  assert.deepEqual(ours, chrome.slice(0, -1));
});

test('an iframe back on its parent origin is detached and a frame of the parent again, with the same id', async () => {
  assert.ok(env);
  const url = fixtureUrl(env, 'frame-child.html');
  const { chrome, ours } = await both(side =>
    side.run(`document.getElementById('child').src = ${JSON.stringify(url)}; 0`)
  );
  assert.deepEqual(chrome, [
    'root Target.detachedFromTarget s1',
    'root Page.frameAttached child',
    'root Page.frameNavigated child',
  ]);
  // Unlike Chrome, which drops the grandchild's session with its parent's without a word, ours
  // detaches it first, on the child's session, as on any other navigation of the child.
  assert.deepEqual(ours, ['s1 Target.detachedFromTarget s2', ...chrome]);
});

test('a removed iframe is detached from the inside out, as in Chrome', async () => {
  const { chrome, ours } = await both(side => side.run("document.getElementById('child').remove(); 0"));
  assert.deepEqual(chrome, ['s1 Target.detachedFromTarget s2', 'root Target.detachedFromTarget s1']);
  assert.deepEqual(ours, chrome);
});

/** What the frontend reads of the grandchild's target, on its session and on the child's. */
async function grandchild(side: Side) {
  const all = await side.events();
  const attached = all.find(e => e.sessionId === side.child && e.method === 'Target.attachedToTarget')?.params;
  const session = String(get(attached, 'sessionId'));
  const info = get(attached, 'targetInfo');
  const targetId = get(info, 'targetId');
  const name = (id: unknown) =>
    id === side.root ? 'page' : id === side.childTarget ? 'child' : id === targetId ? 'grandchild' : id;
  const frame = get(get(await side.send('Page.getFrameTree', {}, session), 'frameTree'), 'frame');
  const doc = get(await side.send('DOM.getDocument', {}, session), 'root');
  const childDoc = get(await side.send('DOM.getDocument', {}, side.child), 'root');
  const iframe = get(
    await side.send('DOM.querySelector', { nodeId: get(childDoc, 'nodeId'), selector: '#grandchild' }, side.child),
    'nodeId'
  );
  const owner = get(await side.send('DOM.getFrameOwner', { frameId: targetId }, side.child), 'nodeId');
  return {
    targetInfo: {
      targetId: name(targetId),
      type: get(info, 'type'),
      parentId: name(get(info, 'parentId')),
      parentFrameId: name(get(info, 'parentFrameId')),
    },
    frame: { id: name(get(frame, 'id')), parentId: name(get(frame, 'parentId')), origin: get(frame, 'securityOrigin') },
    documentURL: get(doc, 'documentURL'),
    ownerIsIframe: owner !== undefined && owner === iframe,
    console: all
      .filter(
        e =>
          e.method === 'Runtime.consoleAPICalled' &&
          get(get(e.params['args'], '1'), 'value') === get(frame, 'securityOrigin')
      )
      .map(e => (e.sessionId === session ? 'grandchild' : e.sessionId === side.child ? 'child' : 'root')),
    evaluated: get(
      get(await side.send('Runtime.evaluate', { expression: 'window.marker' }, session), 'result'),
      'value'
    ),
  };
}

test("a cross-origin iframe's own is a target on its session, end to end, as in Chrome", async () => {
  assert.ok(env);
  const views = [];
  for (const open of [chromeSide, oursSide]) {
    const side = await open(env, { nested: true });
    try {
      await settle(side);
      views.push(await grandchild(side));
    } finally {
      await side.close();
    }
  }
  const [expected, actual] = views;
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual?.targetInfo, {
    targetId: 'grandchild',
    type: 'iframe',
    parentId: 'child',
    parentFrameId: 'child',
  });
  assert.deepEqual(actual?.console, ['grandchild']);
});
