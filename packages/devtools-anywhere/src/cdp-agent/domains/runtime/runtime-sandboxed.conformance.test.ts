// Runtime in a sandboxed iframe without allow-same-origin, on the page's origin, merged into the
// page's agent (core/frames/merged-frames.ts), against Chrome, which keeps it in the page's target: its
// context, objects and console reach the client on the page's session.
import { test } from 'node:test';
import { setUpAndTearDown } from '../../../../test-support/conformance.ts';
import assert from 'node:assert/strict';
import type { Env } from '../../../../../../tests/support/browser.ts';
import { launchOopif } from '../../../../test-support/oopif/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/oopif/merged-sides.ts';

let env: Env | undefined;
let ours: MergedSide | undefined;
let chrome: MergedSide | undefined;

setUpAndTearDown(
  async () => {
    env = await launchOopif();
    chrome = await chromeSide(env);
    ours = await oursSide(env);
  },
  async () => {
    await ours?.close();
    await chrome?.close();
    await env?.close();
  }
);

const sides = (): MergedSide[] => {
  assert.ok(chrome && ours);
  return [chrome, ours];
};

/** The sandboxed frame's id, from the page's frame tree. */
async function sandboxedFrameId(side: MergedSide): Promise<string> {
  const tree = await side.send('Page.getFrameTree');
  const children = get(get(tree, 'frameTree'), 'childFrames');
  const id = get(get(Array.isArray(children) ? children[0] : undefined, 'frame'), 'id');
  assert.equal(typeof id, 'string');
  return String(id);
}

/** The sandboxed frame's latest context (its initial about:blank had one before, in Chrome). */
async function sandboxedContext(side: MergedSide): Promise<Record<string, unknown>> {
  const frameId = await sandboxedFrameId(side);
  const created = (await side.events()).findLast(
    e =>
      e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === frameId
  );
  const context = created?.params['context'];
  assert.ok(typeof context === 'object' && context !== null, 'the sandboxed frame has an execution context');
  return { ...context };
}

/** An object of the sandboxed frame's: its `marker` wrapped in an object. */
async function childObject(side: MergedSide): Promise<string> {
  const context = await sandboxedContext(side);
  const reply = await side.send('Runtime.evaluate', { expression: '({ marker })', contextId: context['id'] });
  const objectId = get(get(reply, 'result'), 'objectId');
  assert.equal(typeof objectId, 'string');
  return String(objectId);
}

/** Waits for an event matching `match`, from `since` on. */
async function waitFor(side: MergedSide, since: number, match: (e: { method: string; params: object }) => boolean) {
  for (let i = 0; i < 50; i++) {
    const found = (await side.events()).slice(since).find(match);
    if (found) return found;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail('no such event');
}

// Chrome also announces, before, the context of the iframe's initial about:blank, of the page's
// origin, which the frame's agent, loaded with the document, cannot.
test("the sandboxed document's context: default, of its frame, origin '://', as in Chrome", async () => {
  const seen = [];
  for (const side of sides()) {
    const frameId = await sandboxedFrameId(side);
    const context = await sandboxedContext(side);
    const auxData = { ...Object(context['auxData']) };
    seen.push({ origin: context['origin'], name: context['name'], auxData, ofFrame: auxData['frameId'] === frameId });
    delete auxData['frameId'];
  }
  assert.deepEqual(seen[1], seen[0]);
  assert.equal(seen[0]?.origin, '://');
});

test('evaluate, callFunctionOn and getProperties on its objects go there and back, as in Chrome', async () => {
  const results = [];
  for (const side of sides()) {
    const objectId = await childObject(side);
    const called = await side.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { return this.marker + " " + document.title; }',
      returnByValue: true,
    });
    const properties = await side.send('Runtime.getProperties', { objectId, ownProperties: true });
    const own = get(properties, 'result');
    results.push({
      called: get(called, 'result'),
      properties: Array.isArray(own) ? own.map(p => [get(p, 'name'), get(get(p, 'value'), 'value')]) : own,
    });
    await side.send('Runtime.releaseObject', { objectId });
    results.push(await side.send('Runtime.getProperties', { objectId }));
  }
  assert.deepEqual(results.slice(2), results.slice(0, 2));
  assert.deepEqual(get(results[0], 'called'), { type: 'string', value: 'sandboxed child of null sandboxed child' });
});

test('callFunctionOn with an object of the other side fails as in Chrome', async () => {
  const errors = [];
  for (const side of sides()) {
    const objectId = await childObject(side);
    const page = get(get(await side.send('Runtime.evaluate', { expression: '({})' }), 'result'), 'objectId');
    const context = await sandboxedContext(side);
    const call = { functionDeclaration: 'function (o) { return typeof o; }', returnByValue: true };
    // On the page's object with the frame's, in the frame's context with the page's, and the reverse.
    errors.push(await side.send('Runtime.callFunctionOn', { ...call, objectId: page, arguments: [{ objectId }] }));
    errors.push(
      await side.send('Runtime.callFunctionOn', {
        ...call,
        executionContextId: context['id'],
        arguments: [{ objectId: page }],
      })
    );
    errors.push(await side.send('Runtime.callFunctionOn', { ...call, objectId, arguments: [{ objectId: page }] }));
  }
  assert.deepEqual(errors.slice(3), errors.slice(0, 3));
  assert.equal(errors[0], 'Argument should belong to the same JavaScript world as target object');
});

test('globalLexicalScopeNames and compileScript in its context, as in Chrome', async () => {
  const results = [];
  for (const side of sides()) {
    const context = await sandboxedContext(side);
    await side.send('Runtime.evaluate', {
      expression: 'let sandboxedLexical = 1',
      replMode: true,
      contextId: context['id'],
    });
    const names = get(
      await side.send('Runtime.globalLexicalScopeNames', { executionContextId: context['id'] }),
      'names'
    );
    const compiled = await side.send('Runtime.compileScript', {
      expression: '(',
      sourceURL: '',
      persistScript: false,
      executionContextId: context['id'],
    });
    results.push({ names, compiled: get(get(compiled, 'exceptionDetails'), 'text') });
  }
  assert.deepEqual(results[1], results[0]);
});

test("its console messages and uncaught errors reach the page's session, as in Chrome", async () => {
  const results = [];
  for (const side of sides()) {
    const context = await sandboxedContext(side);
    const since = (await side.events()).length;
    await side.send('Runtime.evaluate', {
      expression: 'console.log("from the frame", 1); setTimeout(() => { throw new Error("frame boom"); })',
      contextId: context['id'],
    });
    // This very message, not another the page or the probe may log meanwhile.
    const logged = await waitFor(side, since, e => {
      const args = get(e.params, 'args');
      return (
        e.method === 'Runtime.consoleAPICalled' && Array.isArray(args) && get(args[0], 'value') === 'from the frame'
      );
    });
    // The frame's error, told by its context: ours does not carry its exception (null there).
    const thrown = await waitFor(
      side,
      since,
      e =>
        e.method === 'Runtime.exceptionThrown' &&
        get(get(e.params, 'exceptionDetails'), 'executionContextId') === context['id']
    );
    const args = get(logged.params, 'args');
    const details = get(thrown.params, 'exceptionDetails');
    results.push({
      type: get(logged.params, 'type'),
      args: Array.isArray(args) ? args.map(a => get(a, 'value')) : args,
      context: get(logged.params, 'executionContextId') === context['id'],
      thrown: get(details, 'text'),
    });
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0]?.context, true);
});

test('discardConsoleEntries, releaseObjectGroup and Log.clear answer, as in Chrome', async () => {
  const results = [];
  for (const side of sides()) {
    results.push(await side.send('Runtime.releaseObjectGroup', { objectGroup: 'console' }));
    results.push(await side.send('Runtime.discardConsoleEntries'));
    results.push(await side.send('Log.clear'));
  }
  assert.deepEqual(results.slice(3), results.slice(0, 3));
});
