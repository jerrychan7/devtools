// Input over a sandboxed iframe merged into the page's agent (core/merged-frames.ts), end to end
// against Chrome: the same commands on the same pages (test-support/merged-sides.ts). Chrome keeps
// the iframe in the page's process and target, and routes the input into it; our page's agent
// forwards it over the merged link to the iframe's. The iframe's page is read in its own execution
// context, on the page's session.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

let env: Env | undefined;

before(async () => {
  env = await launchOopif();
});
after(() => env?.close());

/** Records the input events of a document, named by their targets. */
const RECORD = `(() => {
  window.rec = [];
  const name = t => (t === document ? 'document' : t === window ? 'window' : t.id || t.localName);
  for (const type of ['pointerover', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchend'])
    document.addEventListener(type, e => rec.push([type, name(e.target),
      Math.round(e.clientX ?? e.changedTouches?.[0]?.clientX ?? -1), Math.round(e.clientY ?? e.changedTouches?.[0]?.clientY ?? -1)]), true);
  document.addEventListener('focus', e => rec.push(['focus', e.target.id || e.target.localName]), true);
  if (document.getElementById('target')) {
    document.getElementById('target').insertAdjacentHTML('afterend', '<input id="field">');
    document.body.style.height = '1000px';
  }
})()`;

const DRAWN = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))';

/** The sandboxed frame's latest execution context id. */
async function childContext(side: MergedSide): Promise<unknown> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const frameId = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  const created = (await side.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  const id = get(created?.params['context'], 'id');
  assert.ok(id !== undefined, 'the sandboxed frame has an execution context');
  return id;
}

async function drive(side: MergedSide) {
  const contextId = await childContext(side);
  const evaluate = async (expression: string, inChild = false) => {
    const reply = await side.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(inChild ? { contextId } : {}),
    });
    return get(get(reply, 'result'), 'value');
  };
  const drawn = async () => {
    await evaluate(DRAWN, true);
    await evaluate(DRAWN);
  };
  const take = async () => ({
    root: JSON.parse(String(await evaluate('JSON.stringify(rec.splice(0))'))),
    child: JSON.parse(String(await evaluate('JSON.stringify(rec.splice(0))', true))),
  });
  const send = async (method: string, params: object) => {
    const reply = await side.send(method, params);
    assert.equal(typeof reply, 'object', String(reply));
  };
  const mouse = async (type: string, x: number, y: number, extra: object = {}) => {
    await send('Input.dispatchMouseEvent', { type, x, y, ...extra });
    await drawn();
  };
  await evaluate(RECORD);
  await evaluate(RECORD, true);
  await drawn();
  const frame = JSON.parse(
    String(await evaluate("JSON.stringify(document.getElementById('child').getBoundingClientRect())"))
  );
  const at = async (id: string) => {
    const r = JSON.parse(
      String(await evaluate(`JSON.stringify(document.getElementById('${id}').getBoundingClientRect())`, true))
    );
    return { x: Math.round(frame.left + r.left + 5), y: Math.round(frame.top + r.top + 5) };
  };
  const target = await at('target');
  const field = await at('field');
  const left = { button: 'left', clickCount: 1 };
  const steps: Record<string, unknown> = {};
  await mouse('mouseMoved', target.x, target.y);
  steps['into the iframe'] = await take();
  await mouse('mousePressed', field.x, field.y, left);
  await mouse('mouseReleased', field.x, field.y, left);
  steps['a click in the iframe'] = await take();
  steps['focus'] = [await evaluate('document.activeElement.id'), await evaluate('document.activeElement.id', true)];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  await send('Input.insertText', { text: 'bc' });
  steps['keys'] = await take();
  steps['typed'] = await evaluate("document.getElementById('field').value", true);
  await mouse('mouseWheel', target.x, target.y, { deltaX: 0, deltaY: 30 });
  // Only that the wheel reached the iframe's page: Chrome fires it at the iframe's body there, as
  // it does after a click in the iframe's page in process, which ours does not follow.
  steps['wheel'] = (await take()).child.filter((e: unknown[]) => e[0] === 'wheel').map((e: unknown[]) => e[0]);
  steps['scrolled'] = await evaluate('scrollY', true);
  await evaluate('scrollTo(0, 0)', true);
  await drawn();
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.emulateTouchFromMouseEvent', { type, ...target, button: 'left', clickCount: 1 });
    await drawn();
  }
  // Only the tap's mouse events: Chrome's touch emulation from the mouse, not set up here, fires no
  // touch events in a page of the target's process, ours does, the same in any page.
  const tapped = await take();
  steps['a tap in the iframe'] = {
    root: tapped.root,
    child: tapped.child.filter((e: unknown[]) => ['mousedown', 'mouseup', 'click'].includes(String(e[0]))),
  };
  return steps;
}

/** One side at a time: a page in a background tab draws no frames, which input waits for. */
async function run(open: (env: Env) => Promise<MergedSide>) {
  assert.ok(env);
  const side = await open(env);
  try {
    return await drive(side);
  } finally {
    await side.close();
  }
}

test('mouse, keys, wheel and touch over a sandboxed iframe reach its page as in Chrome', async () => {
  const expected = await run(chromeSide);
  const actual = await run(oursSide);
  assert.deepEqual(actual, expected);
  // One process: unlike a cross-origin iframe's, the iframe's element is hovered in the page too.
  assert.deepEqual(get(expected['into the iframe'], 'root'), [['pointerover', 'child', 5, 75]]);
  assert.equal(expected['typed'], 'abc');
  assert.notEqual(expected['scrolled'], 0);
});
