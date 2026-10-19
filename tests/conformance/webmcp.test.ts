import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, diffSubset, launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';
import type { Protocol } from 'devtools-protocol';

for (const key of ['backendNodeId', 'invocationId']) VOLATILE.add(key);

const EVENTS = ['WebMCP.toolsAdded', 'WebMCP.toolsRemoved', 'WebMCP.toolInvoked', 'WebMCP.toolResponded'] as const;

let env: Env | undefined;

before(async () => {
  // WebMCP is still behind flags in Chrome.
  env = await launch(['--enable-features=WebMCP', '--enable-blink-features=WebMCP']);
});
after(() => env?.close());

/** Every tool one side announced and has not removed, by name. */
async function toolsOf(side: Side) {
  const tools = new Map<string, Protocol.WebMCP.Tool>();
  for (const e of await side.events('WebMCP.toolsAdded')) for (const tool of e.tools) tools.set(tool.name, tool);
  for (const e of await side.events('WebMCP.toolsRemoved')) for (const tool of e.tools) tools.delete(tool.name);
  return tools;
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (const start = Date.now(); Date.now() - start < 5000; await new Promise(r => setTimeout(r, 20))) {
    const value = await read();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Invokes a tool on one side; resolves with the invocation's two events. */
async function invoke(side: Side, frameId: string, toolName: string, input: object) {
  const { invocationId } = await side.send('WebMCP.invokeTool', { frameId, toolName, input });
  const responded = await until(
    async () => (await side.events('WebMCP.toolResponded')).find(e => e.invocationId === invocationId),
    `${toolName} to respond`
  );
  const invoked = (await side.events('WebMCP.toolInvoked')).find(e => e.invocationId === invocationId);
  return { invoked, responded };
}

/** Invokes a tool on both sides and checks that our events match Chrome's. */
async function compareInvocation(t: TestPage, toolName: string, input: object) {
  const frameId = (side: Side) =>
    until(async () => (await toolsOf(side)).get(toolName)?.frameId, `${toolName} to be announced`);
  const chrome = await invoke(t.chrome, await frameId(t.chrome), toolName, input);
  const ours = await invoke(t.ours, await frameId(t.ours), toolName, input);
  assert.deepEqual(diffSubset(ours, chrome), [], toolName);
  return { chrome, ours };
}

const REGISTER_TOOLS = `(() => {
  const context = document.modelContext;
  window.__abort = new AbortController();
  context.registerTool({
    name: 'greet',
    description: 'Greets someone.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: input => ({ content: [{ type: 'text', text: 'hi ' + input.who }] }),
  }, { signal: window.__abort.signal });
  context.registerTool({ name: 'plain', description: 'Returns a string.', execute: () => 'plain' });
  context.registerTool({ name: 'nothing', description: 'Returns nothing.', execute: () => {} });
  context.registerTool({
    name: 'throws',
    description: 'Throws.',
    execute: async () => { throw new TypeError('boom'); },
  });
  context.registerTool({
    name: 'slow',
    description: 'Takes a while.',
    execute: () => new Promise(resolve => setTimeout(() => resolve('late'), 2000)),
  });
})()`;

const ADD_FORMS = `(() => {
  document.body.insertAdjacentHTML('beforeend', \`
    <form toolname="search" tooldescription="Searches." toolautosubmit action="/api/echo">
      <input name="q" required toolparamdescription="The query">
      <select name="sort"><option value="new">Newest</option><option value="top">Top</option></select>
      <input type="checkbox" name="exact">
      <input type="number" name="limit">
      <input type="number" name="ratio" step="0.5">
      <textarea name="note"></textarea>
      <input type="radio" name="scope" value="all"><input type="radio" name="scope" value="mine">
      <input type="hidden" name="secret" value="x">
      <button>Go</button>
    </form>
    <form toolname="nobutton" tooldescription="Has no submit button."><input name="a"></form>
  \`);
  window.__submits = [];
  document.querySelector('form[toolname=search]').addEventListener('submit', event => {
    const data = Object.fromEntries(new FormData(event.target));
    window.__submits.push({ agentInvoked: event.agentInvoked, data });
    event.preventDefault();
    event.respondWith(Promise.resolve({ results: [data.q] }));
  });
})()`;

describe('WebMCP, with the browser API', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
    await t.page.evaluate(REGISTER_TOOLS);
    await t.page.evaluate(ADD_FORMS);
    await t.chrome.send('WebMCP.enable');
    await t.ours.send('WebMCP.enable');
  });

  test('tools match Chrome', async () => {
    const chrome = await until(async () => {
      const tools = await toolsOf(t.chrome);
      return tools.size === 7 ? tools : undefined;
    }, "Chrome's tools");
    const ours = await until(async () => {
      const tools = await toolsOf(t.ours);
      return tools.size === 7 ? tools : undefined;
    }, 'our tools');
    for (const [name, tool] of chrome) {
      const own = ours.get(name);
      assert.ok(own, `missing ${name}`);
      assert.deepEqual(diffSubset(own, tool), [], name);
      assert.equal('backendNodeId' in own, 'backendNodeId' in tool, `${name}: backendNodeId`);
    }
    assert.ok(ours.get('greet')?.stackTrace?.callFrames.length, 'greet has its registration stack');
  });

  test('results, errors and thrown exceptions', async () => {
    await compareInvocation(t, 'greet', { who: 'Ada' });
    await compareInvocation(t, 'plain', {});
    await compareInvocation(t, 'nothing', {});
    const { ours } = await compareInvocation(t, 'throws', {});
    assert.equal(ours.responded.exception?.className, 'TypeError');
    await compareInvocation(t, 'search', { nope: 1 });
  });

  test('cancelling a pending invocation', async () => {
    for (const side of [t.chrome, t.ours]) {
      const frameId = (await toolsOf(side)).get('slow')?.frameId ?? '';
      const { invocationId } = await side.send('WebMCP.invokeTool', { frameId, toolName: 'slow', input: {} });
      await side.send('WebMCP.cancelInvocation', { invocationId });
      const responded = await until(
        async () => (await side.events('WebMCP.toolResponded')).find(e => e.invocationId === invocationId),
        'the cancellation'
      );
      assert.equal(responded.status, 'Canceled');
      await assert.rejects(side.send('WebMCP.cancelInvocation', { invocationId: 'nope' }), /Invalid invocation id/);
    }
  });

  test('unknown tools are rejected', async () => {
    for (const side of [t.chrome, t.ours]) {
      const frameId = (await toolsOf(side)).get('greet')?.frameId ?? '';
      await assert.rejects(side.send('WebMCP.invokeTool', { frameId, toolName: 'nope', input: {} }), /Tool not found/);
    }
  });

  test('removed tools are reported', async () => {
    await t.page.evaluate(() => {
      Reflect.get(window, '__abort').abort();
      document.querySelector('form[toolname=nobutton]')?.remove();
    });
    for (const side of [t.chrome, t.ours]) {
      const names = await until(async () => {
        const tools = await toolsOf(side);
        return tools.has('greet') || tools.has('nobutton') ? undefined : [...tools.keys()].sort();
      }, 'the removals');
      assert.deepEqual(names, ['nothing', 'plain', 'search', 'slow', 'throws']);
    }
  });
});

describe('WebMCP, declarative forms emulated', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
    // Our server sees no browser API and falls back to emulating the forms; Chrome is unaffected.
    await t.page.evaluate(() => Object.defineProperty(document, 'modelContext', { value: undefined }));
    await t.page.evaluate(ADD_FORMS);
    await t.chrome.send('WebMCP.enable');
    await t.ours.send('WebMCP.enable');
  });

  test('schemas match Chrome', async () => {
    for (const name of ['search', 'nobutton']) {
      const chrome = await until(async () => (await toolsOf(t.chrome)).get(name), `Chrome's ${name}`);
      const ours = await until(async () => (await toolsOf(t.ours)).get(name), `our ${name}`);
      assert.deepEqual(diffSubset(ours, chrome), [], name);
      assert.deepEqual(ours.inputSchema, chrome.inputSchema, `${name}: inputSchema`);
      assert.ok(ours.backendNodeId, `${name}: backendNodeId`);
    }
  });

  test('the form is filled in and submitted with respondWith', async () => {
    const input = { q: 'cats', sort: 'top', exact: true, limit: 3, scope: 'mine' };
    await compareInvocation(t, 'search', input);
    const submits = await t.page.evaluate(() => Reflect.get(window, '__submits'));
    assert.deepEqual(submits[0], submits[1]);
    assert.deepEqual(submits[1], {
      agentInvoked: true,
      data: { q: 'cats', sort: 'top', exact: 'on', limit: '3', ratio: '', note: '', scope: 'mine', secret: 'x' },
    });
  });

  test('errors: unknown parameters, no submit button', async () => {
    await compareInvocation(t, 'search', { nope: 1 });
    await compareInvocation(t, 'nobutton', { a: 'x' });
  });

  test('removed forms are reported', async () => {
    await t.page.evaluate(() => document.querySelector('form[toolname=nobutton]')?.remove());
    for (const side of [t.chrome, t.ours]) {
      const names = await until(async () => {
        const tools = await toolsOf(side);
        return tools.has('nobutton') ? undefined : [...tools.keys()];
      }, 'the removal');
      assert.deepEqual(names, ['search']);
    }
  });
});
