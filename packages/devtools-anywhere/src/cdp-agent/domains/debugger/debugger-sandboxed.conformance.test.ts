// Debugger and DOMDebugger in a sandboxed iframe merged into the page's agent
// (core/merged-frames.ts), against Chrome, which keeps the iframe in the page's target: its
// scripts are reported on the page's session, in the iframe's execution context, and its script
// and object ids are answered there.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

let env: Env | undefined;
let ours: MergedSide | undefined;
let chrome: MergedSide | undefined;

before(async () => {
  env = await launchOopif();
  chrome = await chromeSide(env);
  // Runtime's routes are this test's own until the Runtime domain registers its table: the
  // sandboxed frame's execution context is reported on Runtime.enable.
  ours = await oursSide(env, {
    Runtime: { routeBy: { 'Runtime.evaluate': ['contextId'] }, fanOut: ['Runtime.enable', 'Runtime.disable'] },
  });
  for (const side of [chrome, ours]) await side.send('Debugger.enable');
});
after(async () => {
  await ours?.close();
  await chrome?.close();
  await env?.close();
});

const sides = () => {
  assert.ok(chrome && ours);
  return [chrome, ours] as const;
};

/** The sandboxed frame's latest execution context id: the iframe's initial about:blank had one before. */
async function sandboxedContext(side: MergedSide): Promise<unknown> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const frameId = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  const created = (await side.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  return get(created?.params['context'], 'id');
}

/** The probe's scriptParsed in the sandboxed frame's context, waited for. */
async function probeParsed(side: MergedSide): Promise<Record<string, unknown>> {
  const contextId = await sandboxedContext(side);
  for (let i = 0; i < 50; i++) {
    const event = (await side.events()).find(
      e =>
        e.method === 'Debugger.scriptParsed' &&
        e.params['executionContextId'] === contextId &&
        String(e.params['url']).endsWith('/probe.iife.js')
    );
    if (event) return event.params;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no scriptParsed of the probe in the sandboxed frame');
}

test("the sandboxed frame's scripts are reported in its context, as in Chrome", async () => {
  const [c, o] = await Promise.all(sides().map(probeParsed));
  assert.ok(c && o);
  assert.equal(o['url'], c['url']);
  assert.equal(o['isModule'], c['isModule']);
  // Ours are in the frame's namespace, so that the page's commands route by them.
  assert.match(String(o['scriptId']), /^m\d+\./);
});

test("getScriptSource of the sandboxed frame's script returns its text, as in Chrome", async () => {
  const sources = [];
  for (const side of sides()) {
    const parsed = await probeParsed(side);
    const reply = await side.send('Debugger.getScriptSource', { scriptId: parsed['scriptId'] });
    sources.push(typeof reply === 'string' ? reply : get(reply, 'scriptSource'));
  }
  assert.equal(typeof sources[0], 'string');
  assert.ok(sources[1] === sources[0], `ours: ${String(sources[1]).slice(0, 200)}`);
});

test('setBreakpointByUrl and removeBreakpoint answer, as in Chrome', async () => {
  for (const side of sides()) {
    const reply = await side.send('Debugger.setBreakpointByUrl', { lineNumber: 0, urlRegex: 'nothing-matches' });
    const id = get(reply, 'breakpointId');
    assert.equal(typeof id, 'string');
    assert.deepEqual(get(reply, 'locations'), []);
    assert.deepEqual(await side.send('Debugger.removeBreakpoint', { breakpointId: id }), {});
  }
});

test("getEventListeners of the sandboxed frame's window lists its listeners, as in Chrome", async () => {
  const results = [];
  for (const side of sides()) {
    const contextId = await sandboxedContext(side);
    await side.send('Runtime.evaluate', {
      expression: 'addEventListener("message", () => {}, { capture: true })',
      contextId,
    });
    const win = await side.send('Runtime.evaluate', { expression: 'window', contextId, objectGroup: 'g' });
    const reply = await side.send('DOMDebugger.getEventListeners', { objectId: get(get(win, 'result'), 'objectId') });
    const listeners = get(reply, 'listeners');
    assert.ok(Array.isArray(listeners), String(reply));
    results.push(
      listeners
        .filter(l => get(l, 'type') === 'message')
        .map(l => ({ useCapture: get(l, 'useCapture'), handler: get(get(l, 'handler'), 'type') }))
        // The order of a target's listeners is not aligned (the frame link's comes first here).
        .sort((a, b) => Number(b.useCapture) - Number(a.useCapture))
    );
  }
  assert.deepEqual(results[1], results[0]);
  assert.ok(results[0]?.some(l => l.useCapture === true));
});
