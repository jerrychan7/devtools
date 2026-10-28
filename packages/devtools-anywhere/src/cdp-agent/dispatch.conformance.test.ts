import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../test-support/conformance.ts';
import type { Env, TestPage } from '../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
});
after(() => env?.close());

test('methods inherited from Object.prototype are not found', async () => {
  for (const method of ['Runtime.constructor', 'DOM.toString', 'Page.hasOwnProperty']) {
    const chrome = await t.chrome.send(method as 'Runtime.enable').then(
      () => 'resolved',
      (e: Error) => e.message
    );
    const ours = await t.page.evaluate(
      m =>
        window.__server.call(m).then(
          () => 'resolved',
          (e: Error) => e.message
        ),
      method
    );
    assert.match(chrome, /wasn't found/);
    assert.equal(ours, `'${method}' wasn't found`);
  }
});

test('an unparsable message is answered with a parse error', async () => {
  const replies = await t.page.evaluate(async () => {
    const out: string[] = [];
    const off = window.__server.onMessage(m => out.push(m));
    await window.__server.dispatch('{not json');
    off();
    return out.map(m => JSON.parse(m) as { id?: unknown; error?: { code: number } });
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.id, undefined);
  assert.equal(replies[0]?.error?.code, -32700);
});
