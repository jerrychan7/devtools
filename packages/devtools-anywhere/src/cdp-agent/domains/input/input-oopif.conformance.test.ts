// Input, the overlay and hit testing over a linked cross-origin iframe, end to end against Chrome:
// the same commands on the same pages (test-support/oopif-sides.ts), what the parent and the
// iframe's page get compared. In Chrome the iframe is out of process and the browser routes input
// to it; our parent's agent forwards it over the link to the iframe's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../test-support/conformance.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, oursSide, type Side } from '../../../../test-support/oopif-sides.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

/**
 * Records the page's input events, named by their targets, on the document: Chrome's inspect
 * mode takes them before the page, ours from the window's capture.
 */
const RECORD = `(() => {
  window.rec = [];
  const name = t => (t === document ? 'document' : t === window ? 'window' : t.id || t.localName);
  for (const type of ['pointerover', 'pointerout', 'mouseover', 'mouseout', 'pointerdown', 'pointerup', 'mousedown',
    'mouseup', 'click', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchend'])
    document.addEventListener(type, e => rec.push([type, name(e.target), e.relatedTarget ? name(e.relatedTarget) : null,
      Math.round(e.clientX ?? e.changedTouches?.[0]?.clientX ?? -1), Math.round(e.clientY ?? e.changedTouches?.[0]?.clientY ?? -1)]), true);
  document.addEventListener('focus', e => rec.push(['focus', e.target.id || e.target.localName]), true);
  document.getElementById('target').insertAdjacentHTML('afterend', '<input id="field">');
})()`;

/** Waits for two frames: Chrome routes input to an iframe by hit-test data it has once drawn. */
const DRAWN = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))';

const evaluate = (side: Side, expression: string, sessionId = ''): Promise<unknown> =>
  side.run(expression, sessionId !== '');

/** Lets the input settle in both pages. */
async function drawn(side: Side) {
  await evaluate(side, DRAWN, side.child);
  await evaluate(side, DRAWN);
}

/** Takes what each page recorded since the last call. */
async function take(side: Side) {
  const read = 'JSON.stringify(rec.splice(0))';
  return {
    root: JSON.parse(String(await evaluate(side, read))),
    child: JSON.parse(String(await evaluate(side, read, side.child))),
  };
}

/** Where the iframe's content is in the parent's viewport, and where an element of the iframe is. */
async function places(side: Side) {
  const rect = async (expression: string, sessionId = '') =>
    JSON.parse(String(await evaluate(side, `JSON.stringify(${expression}.getBoundingClientRect())`, sessionId)));
  const frame = await rect("document.getElementById('child')");
  const at = async (id: string) => {
    const r = await rect(`document.getElementById('${id}')`, side.child);
    return {
      x: Math.round(frame.left + r.left + 5),
      y: Math.round(frame.top + r.top + 5),
    };
  };
  return {
    parent: await rect("document.getElementById('parent')"),
    target: await at('target'),
    field: await at('field'),
  };
}

async function setUp(side: Side) {
  await evaluate(
    side,
    RECORD.replace("document.getElementById('target').insertAdjacentHTML('afterend', '<input id=\"field\">');", '')
  );
  await evaluate(side, RECORD, side.child);
  await drawn(side);
}

async function mouse(side: Side, type: string, x: number, y: number, extra: object = {}) {
  const reply = await side.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    ...extra,
  });
  assert.equal(typeof reply, 'object', String(reply));
  await drawn(side);
}

/** Moves, presses and types over the iframe; what each page got at each step. */
async function drive(side: Side) {
  await setUp(side);
  const { parent, target, field } = await places(side);
  const left = { button: 'left', clickCount: 1 };
  const steps: Record<string, unknown> = {};
  await mouse(side, 'mouseMoved', parent.left + 5, parent.top + 5);
  steps['over the parent'] = await take(side);
  await mouse(side, 'mouseMoved', target.x, target.y);
  steps['into the iframe'] = await take(side);
  await mouse(side, 'mouseMoved', parent.left + 5, parent.top + 5);
  steps['back to the parent'] = await take(side);
  await mouse(side, 'mouseMoved', parent.left + 5, parent.bottom + 5);
  steps['on to the parent body'] = await take(side);
  await mouse(side, 'mousePressed', field.x, field.y, left);
  await mouse(side, 'mouseReleased', field.x, field.y, left);
  steps['a click in the iframe'] = await take(side);
  steps['focus'] = [
    await evaluate(side, 'document.activeElement.id'),
    await evaluate(side, 'document.activeElement.id', side.child),
  ];
  for (const [type, extra] of [
    ['keyDown', { text: 'a' }],
    ['keyUp', {}],
  ] as const) {
    assert.equal(
      typeof (await side.send('Input.dispatchKeyEvent', {
        type,
        key: 'a',
        code: 'KeyA',
        ...extra,
      })),
      'object'
    );
  }
  assert.equal(typeof (await side.send('Input.insertText', { text: 'bc' })), 'object');
  steps['keys'] = await take(side);
  steps['typed'] = await evaluate(side, "document.getElementById('field').value", side.child);
  await mouse(side, 'mousePressed', parent.left + 5, parent.top + 5, left);
  await mouse(side, 'mouseMoved', target.x, target.y, { button: 'left', buttons: 1 });
  await mouse(side, 'mouseReleased', target.x, target.y, left);
  steps['pressed in the parent, released in the iframe'] = await take(side);
  await mouse(side, 'mousePressed', target.x, target.y, left);
  await mouse(side, 'mouseMoved', parent.left + 5, parent.bottom + 5, {
    button: 'left',
    buttons: 1,
  });
  await mouse(side, 'mouseReleased', parent.left + 5, parent.bottom + 5, left);
  steps['pressed in the iframe, released in the parent'] = await take(side);
  // Last: the wheel scrolls the iframe's page, which moves what is under the points above.
  await mouse(side, 'mouseWheel', target.x, target.y, {
    deltaX: 0,
    deltaY: 30,
  });
  steps['wheel'] = await take(side);
  steps['scrolled'] = await evaluate(side, 'scrollY', side.child);
  return steps;
}

/**
 * Runs `act` on one side, closed after: one at a time, as a page in a background tab draws no
 * frames, which Chrome's routing of input to the iframe waits for.
 */
async function run<T>(open: (env: Env) => Promise<Side>, act: (side: Side) => Promise<T>): Promise<T> {
  assert.ok(env);
  const side = await open(env);
  try {
    return await act(side);
  } finally {
    await side.close();
  }
}

test('ours: mouse and keys over a cross-origin iframe go to its page as in Chrome', async () => {
  assert.ok(env);
  const expected = await run(chromeSide, drive);
  const actual = await run(oursSide, drive);
  {
    assert.deepEqual(actual, expected);
    // As measured: the parent's document gets nothing of the input over the iframe, not even an
    // over or out, and the iframe's gets none once the mouse has left it; the iframe's page gets
    // it at the point in its own viewport.
    assert.deepEqual(get(expected['into the iframe'], 'root'), []);
    assert.deepEqual(get(expected['back to the parent'], 'child'), []);
    assert.equal(expected['typed'], 'abc');
    // Each process has its press: the release in the iframe's page gets no click there, and the
    // parent's press stays, so the next release over the parent clicks what holds both.
    const across = get(expected['pressed in the parent, released in the iframe'], 'child');
    assert.ok(Array.isArray(across) && across.some(e => e[0] === 'mouseup'));
    assert.ok(!across.some(e => e[0] === 'click'));
    const back = get(expected['pressed in the iframe, released in the parent'], 'root');
    assert.ok(Array.isArray(back) && back.some(e => e[0] === 'click' && e[1] === 'body'));
  }
});

/** Wheels over the iframe scrolled to its end, then to its start: where each page is then. */
async function chain(side: Side) {
  await setUp(side);
  await evaluate(side, "document.body.style.height = '3000px'; scrollTo(0, 0)");
  await evaluate(side, "document.body.style.height = '1000px'; scrollTo(0, 99999)", side.child);
  await drawn(side);
  const frame = JSON.parse(
    String(await evaluate(side, "JSON.stringify(document.getElementById('child').getBoundingClientRect())"))
  );
  const wheel = () =>
    mouse(side, 'mouseWheel', Math.round(frame.left + 50), Math.round(frame.top + 50), { deltaX: 0, deltaY: 120 });
  const where = async () => [await evaluate(side, 'scrollY'), await evaluate(side, 'scrollY', side.child)];
  const before = await where();
  await wheel();
  const atEnd = await where();
  await evaluate(side, 'scrollTo(0, 0)', side.child);
  await drawn(side);
  await wheel();
  return { before, atEnd, atStart: await where() };
}

test('ours: a wheel over a cross-origin iframe that cannot scroll further scrolls its parent, as in Chrome', async () => {
  const expected = await run(chromeSide, chain);
  const actual = await run(oursSide, chain);
  assert.deepEqual(actual, expected);
  // As measured: at its end the iframe passes the scroll to the parent, at its start it scrolls itself.
  assert.equal(expected.atEnd[0], 120);
  assert.deepEqual(expected.atStart, [120, 120]);
});

/** Hit testing over the iframe, a highlight in it and inspect mode across both pages. */
async function overlay(side: Side) {
  await setUp(side);
  const { target } = await places(side);
  const nameOf = async (params: object, sessionId: string) => {
    const node = get(await side.send('DOM.describeNode', params, sessionId), 'node');
    return get(node, 'localName');
  };
  for (const sessionId of ['', side.child]) {
    await side.send('DOM.getDocument', {}, sessionId);
    await side.send('Overlay.enable', {}, sessionId);
  }
  // On the parent, the point over the iframe finds the <iframe> element itself.
  const hit = await side.send('DOM.getNodeForLocation', {
    x: target.x,
    y: target.y,
  });
  const found = await nameOf({ backendNodeId: get(hit, 'backendNodeId') }, '');
  // On the iframe's session, its own geometry: the box model is in its viewport.
  const doc = get(await side.send('DOM.getDocument', {}, side.child), 'root');
  const nodeId = get(
    await side.send('DOM.querySelector', { nodeId: get(doc, 'nodeId'), selector: '#target' }, side.child),
    'nodeId'
  );
  const box = get(await side.send('DOM.getBoxModel', { nodeId }, side.child), 'model');
  const highlight = await side.send(
    'Overlay.highlightNode',
    { nodeId, highlightConfig: { contentColor: { r: 1, g: 2, b: 3, a: 0.5 } } },
    side.child
  );
  // Ours draws it in the iframe's page (Chrome's overlay is not in the page): the content box, fourth.
  const drawnAt = await evaluate(
    side,
    `(() => { const r = document.querySelectorAll('[data-devtools-anywhere="overlay"] > div')[3]?.getBoundingClientRect();
      return r && [r.left, r.top, r.right, r.bottom].map(Math.round); })()`,
    side.child
  );
  // Inspect mode on both targets, as the frontend sets it: the node under the mouse is the iframe's.
  const config = {
    mode: 'searchForNode',
    highlightConfig: { contentColor: { r: 255, g: 0, b: 0, a: 0.5 } },
  };
  for (const sessionId of ['', side.child]) await side.send('Overlay.setInspectMode', config, sessionId);
  const from = (await side.events()).length;
  await mouse(side, 'mouseMoved', target.x, target.y);
  await mouse(side, 'mouseMoved', target.x + 1, target.y);
  await mouse(side, 'mousePressed', target.x, target.y, {
    button: 'left',
    clickCount: 1,
  });
  await mouse(side, 'mouseReleased', target.x, target.y, {
    button: 'left',
    clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 300));
  const inspected = [];
  for (const e of (await side.events()).slice(from).filter(e => e.method.startsWith('Overlay.'))) {
    const session = e.sessionId === '' ? 'root' : e.sessionId === side.child ? 'child' : e.sessionId;
    inspected.push([session, e.method, await nameOf(e.params, e.sessionId)]);
  }
  for (const sessionId of ['', side.child]) await side.send('Overlay.setInspectMode', { mode: 'none' }, sessionId);
  return { found, box, highlight, inspected, page: await take(side), drawnAt };
}

test('ours: hit testing, highlights and inspect mode over a cross-origin iframe as in Chrome', async () => {
  assert.ok(env);
  const { drawnAt: none, ...expected } = await run(chromeSide, overlay);
  const { drawnAt, ...actual } = await run(oursSide, overlay);
  {
    assert.equal(none, undefined);
    assert.deepEqual(actual, expected);
    assert.equal(expected.found, 'iframe');
    assert.deepEqual(expected.inspected, [
      ['child', 'Overlay.nodeHighlightRequested', 'p'],
      ['child', 'Overlay.inspectNodeRequested', 'p'],
    ]);
    // What we draw in the iframe's page is where Chrome's box model has the node.
    const content = get(expected.box, 'content');
    assert.ok(Array.isArray(content));
    assert.deepEqual(drawnAt, [content[0], content[1], content[4], content[5]].map(Math.round));
  }
});

test('ours: a touch that starts over a cross-origin iframe stays with its page till it ends', async () => {
  // Not compared: headless Chrome does not answer touch emulated on the parent over an iframe.
  const steps = await run(oursSide, async side => {
    await setUp(side);
    const { parent, target } = await places(side);
    for (const [type, x, y] of [
      ['mousePressed', target.x, target.y],
      ['mouseMoved', parent.left + 5, parent.bottom + 5],
      ['mouseReleased', parent.left + 5, parent.bottom + 5],
    ] as const) {
      const reply = await side.send('Input.emulateTouchFromMouseEvent', { type, x, y, button: 'left' });
      assert.equal(typeof reply, 'object', String(reply));
    }
    return { ...(await take(side)), target };
  });
  assert.deepEqual(steps.root, []);
  const touches = steps.child.filter((e: unknown[]) => String(e[0]).startsWith('touch'));
  // At the points in the iframe's viewport, the release too, off the iframe.
  assert.deepEqual(
    touches.map((e: unknown[]) => e[0]),
    ['touchstart', 'touchend']
  );
  assert.equal(touches[0][1], 'target');
});
