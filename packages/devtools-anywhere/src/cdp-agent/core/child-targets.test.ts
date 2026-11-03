// askChild, the agent's own commands to an iframe's agent (the Input domain's forwarding, the
// Target domain's questions): what the iframe's agent answered, its error, or one of askChild's
// own when the link closes or the agent does not answer. A stand-in link, bundled for Node.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ChildLink, askChild as AskChild } from './child-targets.ts';

let askChild: typeof AskChild;

before(async () => {
  const bundled = await build({
    entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'child-targets.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const code = bundled.outputFiles[0]?.text ?? '';
  const loaded: { askChild: typeof AskChild } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );
  askChild = loaded.askChild;
});

/** A link whose iframe agent answers each command with `answer` (nothing if it returns undefined). */
function linkAnswering(answer: (id: unknown) => object | undefined) {
  const messageListeners = new Set<(message: string) => void>();
  const closeListeners = new Set<() => void>();
  const link: ChildLink = {
    owner: {} as Element,
    frameId: 'F',
    send(message) {
      const { id }: { id: unknown } = JSON.parse(message);
      const response = answer(id);
      if (response) queueMicrotask(() => messageListeners.forEach(l => l(JSON.stringify({ id, ...response }))));
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    openSession: () => assert.fail('no session'),
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => closeListeners.forEach(l => l()),
  };
  return link;
}

test('resolves with the result the iframe agent answered', async () => {
  const link = linkAnswering(() => ({ result: { ok: 1 } }));
  assert.deepEqual(await askChild(link, 'Input.insertText', { text: 'a' }, 1000), { ok: 1 });
});

test("rejects with the iframe agent's error as it answered it", async () => {
  const link = linkAnswering(() => ({ error: { code: -32000, message: 'Not supported in the page: x' } }));
  await assert.rejects(askChild(link, 'Input.dispatchKeyEvent', {}, 1000), {
    code: -32000,
    message: 'Not supported in the page: x',
  });
});

test('rejects when the iframe agent does not answer in time', async () => {
  const link = linkAnswering(() => undefined);
  await assert.rejects(askChild(link, 'Input.dispatchMouseEvent', {}, 10), { code: -32000 });
});

test('rejects when the link closes before the answer', async () => {
  const link = linkAnswering(() => undefined);
  const asked = askChild(link, 'Input.dispatchMouseEvent', {}, 1000);
  link.close();
  await assert.rejects(asked, { code: -32000 });
});

test('rejects on a link closed already, without asking', async () => {
  const link = linkAnswering(() => assert.fail('asked a closed link'));
  link.onClose = listener => {
    listener();
    return () => {};
  };
  await assert.rejects(askChild(link, 'Input.dispatchMouseEvent', {}, 1000), { code: -32000 });
});
