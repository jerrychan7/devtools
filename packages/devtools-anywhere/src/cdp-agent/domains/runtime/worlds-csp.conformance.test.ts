// Isolated worlds on a page whose CSP forbids eval, against Chrome's: the world is made and
// announced all the same; only running code in it fails in ours (Chrome's worlds are not bound by
// the page's CSP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['Runtime.executionContextCreated']);
    // From now on, the page's own code may not eval.
    await t.page.evaluate(() => {
      const meta = Object.assign(document.createElement('meta'), { httpEquiv: 'Content-Security-Policy' });
      meta.content = "script-src 'self' 'unsafe-inline'";
      document.head.append(meta);
    });
  },
  () => env?.close()
);

/**
 * Our side's commands, sent from a timer of the page: code Puppeteer evaluates is not bound by the
 * page's CSP, a page's task is.
 */
const fromPage = (method: string, params: object = {}) =>
  t.page.evaluate(
    (m, p) =>
      new Promise((resolve, reject) => {
        setTimeout(() => window.__session.call(m, p).then(resolve, (e: unknown) => reject(String(e))));
      }),
    method,
    params
  );

const send = (side: Side, method: string, params: object = {}) =>
  side === t.ours
    ? fromPage(method, params)
    : (side.send as (m: string, p: object) => Promise<unknown>)(method, params);

test('a world is made and announced on a page whose CSP forbids eval', async () => {
  const [ours, chrome] = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      const { frameTree } = (await send(side, 'Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      const { executionContextId } = (await send(side, 'Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'conformance-csp',
      })) as { executionContextId: number };
      await send(side, 'Runtime.enable');
      const created = (await side.events('Runtime.executionContextCreated')).filter(
        e => e.context.name === 'conformance-csp'
      );
      // Enabled again, the contexts are announced again: nothing was left broken.
      await send(side, 'Runtime.disable');
      await send(side, 'Runtime.enable');
      return { id: typeof executionContextId, announced: created.map(e => e.context.id === executionContextId) };
    })
  );
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, { id: 'number', announced: [true] });
});

test('code run in such a world fails with an EvalError, as in the page itself', async () => {
  const { frameTree } = (await fromPage('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await fromPage('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'conformance-csp',
  })) as { executionContextId: number };
  const inWorld = (await fromPage('Runtime.evaluate', { expression: '1 + 1', contextId: executionContextId })) as {
    exceptionDetails?: { executionContextId: number; exception?: { className?: string } };
  };
  const inPage = (await fromPage('Runtime.evaluate', { expression: '1 + 1' })) as {
    exceptionDetails?: { exception?: { className?: string } };
  };
  assert.equal(inWorld.exceptionDetails?.exception?.className, 'EvalError');
  assert.equal(inWorld.exceptionDetails?.executionContextId, executionContextId);
  assert.equal(inPage.exceptionDetails?.exception?.className, 'EvalError');
});

test('an iframe added later still gets its context', async () => {
  await fromPage('Runtime.enable');
  await t.page.evaluate(
    () =>
      new Promise(resolve => {
        const frame = Object.assign(document.createElement('iframe'), { onload: resolve });
        frame.srcdoc = '<p>in</p>';
        document.body.append(frame);
      })
  );
  const frames = new Set(
    (await t.ours.events('Runtime.executionContextCreated'))
      .filter(e => e.context.auxData?.['isDefault'])
      .map(e => e.context.auxData?.['frameId'])
  );
  // The top frame's and the iframe's.
  assert.equal(frames.size, 2);
});
