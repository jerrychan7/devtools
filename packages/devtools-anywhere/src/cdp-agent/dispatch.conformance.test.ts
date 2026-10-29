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
        window.__session.call(m).then(
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
    const off = window.__session.onMessage(m => out.push(m));
    await window.__session.dispatch('{not json');
    off();
    return out.map(m => JSON.parse(m) as { id?: unknown; error?: { code: number } });
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.id, undefined);
  assert.equal(replies[0]?.error?.code, -32700);
});

test('a malformed message is answered with an invalid request error', async () => {
  const cases: [string, number | string | undefined, string][] = [
    ['null', undefined, 'Message must be an object'],
    ['5', undefined, 'Message must be an object'],
    ['{}', undefined, "Message must have integer 'id' property"],
    ['{"id":true,"method":"Runtime.enable"}', undefined, "Message must have integer 'id' property"],
    ['{"id":1.5,"method":"Runtime.enable"}', undefined, "Message must have integer 'id' property"],
    ['{"id":7}', 7, "Message must have string 'method' property"],
    ['{"id":7,"method":3}', 7, "Message must have string 'method' property"],
    // String ids are accepted (the relay uses them), so the id is echoed back.
    ['{"id":"relay-1"}', 'relay-1', "Message must have string 'method' property"],
  ];
  for (const [message, id, text] of cases) {
    const replies = await t.page.evaluate(async m => {
      const out: string[] = [];
      const off = window.__session.onMessage(r => out.push(r));
      await window.__session.dispatch(m);
      off();
      return out.map(r => JSON.parse(r) as { id?: number | string; error?: { code: number; message: string } });
    }, message);
    assert.equal(replies.length, 1, message);
    assert.equal(replies[0]?.id, id, message);
    assert.equal(replies[0]?.error?.code, -32600, message);
    assert.equal(replies[0]?.error?.message, text, message);
  }
});
