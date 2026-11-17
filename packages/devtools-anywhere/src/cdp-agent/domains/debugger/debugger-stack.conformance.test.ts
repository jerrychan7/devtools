import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

/**
 * Call frames name the script Debugger.scriptParsed reported for their URL: the frontend asserts that a
 * location has a script id, and resolves the frame's link by it.
 */

let env: Env | undefined;
let t: TestPage;

const SCRIPT = '/packages/devtools-anywhere/test-support/assets/stack.js';

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['Debugger.scriptParsed', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown']);
    for (const side of [t.chrome, t.ours]) {
      await side.send('Runtime.enable');
      await side.send('Debugger.enable');
    }
    await t.page.evaluate(
      src =>
        new Promise(resolve => {
          const s = document.createElement('script');
          s.src = src;
          // The script throws from a timer once it has run.
          s.onload = () => setTimeout(resolve, 50);
          document.head.append(s);
        }),
      SCRIPT
    );
  },
  () => env?.close()
);

async function until<T>(get: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await get();
    if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

const scriptIdOf = (side: Side) =>
  until(async () => (await side.events('Debugger.scriptParsed')).find(e => e.url.endsWith(SCRIPT))?.scriptId);

for (const [name, side] of [
  ['chrome', () => t.chrome],
  ['ours', () => t.ours],
] as const) {
  test(`${name}: a console message's top frame has the script's id`, async () => {
    const scriptId = await scriptIdOf(side());
    const message = await until(async () =>
      (await side().events('Runtime.consoleAPICalled')).find(e => e.args[0]?.value === 'stack.js logged')
    );
    // In Chrome, the console hook of the bundle the harness adds is the top frame: the script's is below.
    const frames = message.stackTrace?.callFrames ?? [];
    const frame = frames.find(f => f.url.endsWith(SCRIPT));
    if (name === 'ours') assert.equal(frame, frames[0]);
    assert.equal(frame?.scriptId, scriptId);
  });

  test(`${name}: an uncaught exception has the script's id`, async () => {
    const scriptId = await scriptIdOf(side());
    const { exceptionDetails } = await until(async () =>
      (await side().events('Runtime.exceptionThrown')).find(e =>
        e.exceptionDetails.exception?.description?.includes('stack.js thrown')
      )
    );
    assert.equal(exceptionDetails.scriptId, scriptId);
    assert.equal(exceptionDetails.stackTrace?.callFrames[0]?.scriptId, scriptId);
  });
}

test('no call frame has an empty script id', async () => {
  const messages = await t.ours.events('Runtime.consoleAPICalled');
  const exceptions = await t.ours.events('Runtime.exceptionThrown');
  const frames = [
    ...messages.flatMap(m => m.stackTrace?.callFrames ?? []),
    ...exceptions.flatMap(e => e.exceptionDetails.stackTrace?.callFrames ?? []),
  ];
  assert.ok(frames.length > 0);
  for (const frame of frames) assert.notEqual(frame.scriptId, '');
});

test('script ids stay the same after Debugger is enabled again', async () => {
  const before = await scriptIdOf(t.ours);
  await t.ours.send('Debugger.disable');
  await t.ours.clear();
  await t.ours.send('Debugger.enable');
  assert.equal(await scriptIdOf(t.ours), before);
});
