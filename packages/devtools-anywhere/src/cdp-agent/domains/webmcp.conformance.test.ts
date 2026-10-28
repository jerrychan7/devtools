import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLATILE, diffSubset, launch, openPage } from '../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../test-support/conformance.ts';
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
  // A changed tool is removed and added again, and the two event lists have no common order:
  // a tool is there while it was added more often than removed, as last announced.
  const tools = new Map<string, Protocol.WebMCP.Tool>();
  const count = new Map<string, number>();
  for (const e of await side.events('WebMCP.toolsAdded'))
    for (const tool of e.tools) {
      tools.set(tool.name, tool);
      count.set(tool.name, (count.get(tool.name) ?? 0) + 1);
    }
  for (const e of await side.events('WebMCP.toolsRemoved'))
    for (const tool of e.tools) count.set(tool.name, (count.get(tool.name) ?? 0) - 1);
  for (const [name, n] of count) if (n <= 0) tools.delete(name);
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
    <form toolname="manual" tooldescription="Waits for the user."><input name="a"><button>Go</button></form>
    <form toolname="rejects" tooldescription="Responds with a rejection." toolautosubmit><input name="a"></form>
  \`);
  document.querySelector('form[toolname=manual]').addEventListener('submit', event => event.preventDefault());
  document.querySelector('form[toolname=rejects]').addEventListener('submit', event => {
    event.preventDefault();
    event.respondWith(Promise.reject(new RangeError('rejected')));
  });
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
      return tools.size === 9 ? tools : undefined;
    }, "Chrome's tools");
    const ours = await until(async () => {
      const tools = await toolsOf(t.ours);
      return tools.size === 9 ? tools : undefined;
    }, 'our tools');
    for (const [name, tool] of chrome) {
      const own = ours.get(name);
      assert.ok(own, `missing ${name}`);
      assert.deepEqual(diffSubset(own, tool), [], name);
      assert.equal('backendNodeId' in own, 'backendNodeId' in tool, `${name}: backendNodeId`);
    }
    // The registration's own frame, not the probe's wrapper around registerTool.
    const [frame] = ours.get('greet')?.stackTrace?.callFrames ?? [];
    assert.ok(frame, 'greet has its registration stack');
    assert.doesNotMatch(frame.url, /\/(devtools-anywhere|probe)\.iife\.js/, 'the first frame is the page script');
    assert.equal(frame.lineNumber, 3, 'the first frame is the registerTool call');
  });

  test('tools registered after enable are added', async () => {
    await t.page.evaluate(() =>
      Reflect.get(document, 'modelContext').registerTool({
        name: 'later',
        description: 'Registered after enable.',
        execute: () => 'later',
      })
    );
    for (const side of [t.chrome, t.ours]) await until(async () => (await toolsOf(side)).get('later'), 'the new tool');
    await compareInvocation(t, 'later', {});
  });

  test('disable forgets the tools, enable announces them again', async () => {
    const errors: string[] = [];
    const announced: string[][] = [];
    for (const side of [t.chrome, t.ours]) {
      const frameId = (await toolsOf(side)).get('plain')?.frameId ?? '';
      await side.send('WebMCP.disable');
      // Disabling removes the tools without events: the ones announced before are forgotten too.
      await side.clear();
      errors.push(
        await side.send('WebMCP.invokeTool', { frameId, toolName: 'plain', input: {} }).then(
          () => 'no error',
          // Puppeteer prefixes Chrome's message with the method; our harness does not.
          (error: unknown) =>
            (error instanceof Error ? error.message : String(error)).replace(/^Protocol error \([^)]*\): /, '')
        )
      );
      await side.send('WebMCP.enable');
      announced.push(
        await until(async () => {
          const names = (await side.events('WebMCP.toolsAdded')).flatMap(e => e.tools.map(x => x.name));
          return names.length >= 10 ? names.sort() : undefined;
        }, 'the tools again')
      );
    }
    assert.equal(errors[1], errors[0]);
    assert.deepEqual(announced[1], announced[0]);
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
      assert.deepEqual(names, ['later', 'manual', 'nothing', 'plain', 'rejects', 'search', 'slow', 'throws']);
    }
  });
});

describe('WebMCP, edge cases of the browser API', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
  });

  test('a tool registered as a class instance keeps the fields of its prototype', async () => {
    await t.page.evaluate(() => {
      class Tool {
        get name() {
          return 'classy';
        }
        get description() {
          return 'Defined by a class.';
        }
        execute() {
          return 'classy';
        }
      }
      Reflect.get(document, 'modelContext').registerTool(new Tool());
    });
    await t.chrome.send('WebMCP.enable');
    await t.ours.send('WebMCP.enable');
    await compareInvocation(t, 'classy', {});
  });

  test('concurrent calls of one tool each respond with their own result', async () => {
    await t.page.evaluate(() =>
      Reflect.get(document, 'modelContext').registerTool({
        name: 'delayed',
        description: 'Answers after a delay.',
        execute: (input: { who: string; ms: number }) =>
          new Promise(resolve => setTimeout(() => resolve({ who: input.who }), input.ms)),
      })
    );
    const frameId = await until(async () => (await toolsOf(t.ours)).get('delayed')?.frameId, 'delayed');
    const [slow, fast] = await Promise.all([
      invoke(t.ours, frameId, 'delayed', { who: 'slow', ms: 300 }),
      invoke(t.ours, frameId, 'delayed', { who: 'fast', ms: 0 }),
    ]);
    assert.deepEqual(slow.responded.output, { who: 'slow' });
    assert.deepEqual(fast.responded.output, { who: 'fast' });
  });

  test('a result that is not JSON responds like Chrome', async () => {
    await t.page.evaluate(() => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      Reflect.get(document, 'modelContext').registerTool({
        name: 'cyclic',
        description: 'Returns a cycle.',
        execute: () => cyclic,
      });
    });
    await compareInvocation(t, 'cyclic', {});
  });

  test('a failing getTools() is not an unhandled rejection of the page', async () => {
    await t.ours.send('WebMCP.disable');
    const rejections = await t.page.evaluate(() => {
      const context = Reflect.get(document, 'modelContext');
      Reflect.set(window, '__rejections', 0);
      window.addEventListener('unhandledrejection', () =>
        Reflect.set(window, '__rejections', Reflect.get(window, '__rejections') + 1)
      );
      context.getTools = () => Promise.reject(new Error('unloading'));
      return 0;
    });
    await t.ours.send('WebMCP.enable');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await t.page.evaluate(() => Reflect.get(window, '__rejections')), rejections);
  });
});

describe('WebMCP, disabling with a pending invocation', () => {
  let t: TestPage;
  before(async () => {
    assert.ok(env);
    t = await openPage(env, [...EVENTS]);
    await t.page.evaluate(() => Object.defineProperty(document, 'modelContext', { value: undefined }));
    await t.page.evaluate(() =>
      document.body.insertAdjacentHTML(
        'beforeend',
        '<form toolname="manual" tooldescription="Waits for the user."><input name="a"><button>Go</button></form>'
      )
    );
    await t.ours.send('WebMCP.enable');
  });

  test('no events after disable, and the form stops waiting for the submit', async () => {
    const frameId = await until(async () => (await toolsOf(t.ours)).get('manual')?.frameId, 'the form tool');
    await t.ours.send('WebMCP.invokeTool', { frameId, toolName: 'manual', input: { a: 'x' } });
    await until(async () => (await t.ours.events('WebMCP.toolInvoked'))[0], 'the invocation');
    await t.ours.send('WebMCP.disable');
    const agentInvoked = await t.page.evaluate(() => {
      const form = document.querySelector('form[toolname=manual]');
      if (!(form instanceof HTMLFormElement)) throw new Error('no form');
      let invoked: unknown = 'not submitted';
      form.addEventListener('submit', event => {
        invoked = Reflect.get(event, 'agentInvoked');
        event.preventDefault();
      });
      form.requestSubmit();
      return invoked ?? false;
    });
    assert.notEqual(agentInvoked, true);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(await t.ours.events('WebMCP.toolResponded'), []);
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

  test('a form without toolautosubmit waits for the user, and can be cancelled', async () => {
    const frameId = (side: Side) => until(async () => (await toolsOf(side)).get('manual')?.frameId, 'the manual form');
    const cancelled: string[] = [];
    const submitted: Protocol.WebMCP.ToolRespondedEvent[] = [];
    for (const side of [t.chrome, t.ours]) {
      const id = await frameId(side);
      const first = await side.send('WebMCP.invokeTool', { frameId: id, toolName: 'manual', input: { a: 'x' } });
      await until(
        async () => (await side.events('WebMCP.toolInvoked')).find(e => e.invocationId === first.invocationId),
        'the invocation'
      );
      await side.send('WebMCP.cancelInvocation', { invocationId: first.invocationId });
      const canceled = await until(
        async () => (await side.events('WebMCP.toolResponded')).find(e => e.invocationId === first.invocationId),
        'the cancellation'
      );
      cancelled.push(canceled.status);

      const second = await side.send('WebMCP.invokeTool', { frameId: id, toolName: 'manual', input: { a: 'y' } });
      await until(
        async () => (await side.events('WebMCP.toolInvoked')).find(e => e.invocationId === second.invocationId),
        'the invocation'
      );
      await new Promise(r => setTimeout(r, 100));
      assert.equal(
        (await side.events('WebMCP.toolResponded')).find(e => e.invocationId === second.invocationId),
        undefined,
        'waits for the submit'
      );
      await t.page.evaluate(() => {
        const form = document.querySelector('form[toolname=manual]');
        if (form instanceof HTMLFormElement) form.requestSubmit();
      });
      submitted.push(
        await until(
          async () => (await side.events('WebMCP.toolResponded')).find(e => e.invocationId === second.invocationId),
          'the submit'
        )
      );
    }
    assert.deepEqual(cancelled, ['Canceled', 'Canceled']);
    const [chrome, ours] = submitted;
    assert.ok(chrome && ours);
    assert.deepEqual(diffSubset(ours, chrome), []);
  });

  test('respondWith with a rejected promise', async () => {
    const { ours } = await compareInvocation(t, 'rejects', { a: 'x' });
    assert.equal(ours.responded.status, 'Error');
  });

  test('forms added and changed after enable', async () => {
    await t.page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<form toolname="added" tooldescription="Added later." toolautosubmit><input name="b" required></form>'
      );
      document.querySelector('form[toolname=manual]')?.setAttribute('tooldescription', 'Changed.');
    });
    const seen: Protocol.WebMCP.Tool[][] = [];
    for (const side of [t.chrome, t.ours])
      seen.push(
        await until(async () => {
          const tools = await toolsOf(side);
          const added = tools.get('added');
          const manual = tools.get('manual');
          return added && manual?.description === 'Changed.' ? [added, manual] : undefined;
        }, 'the new and changed forms')
      );
    const [chrome, ours] = seen;
    assert.ok(chrome && ours);
    assert.deepEqual(diffSubset(ours, chrome), []);
  });

  test('changes to steps and option texts update the schema', async () => {
    await t.page.evaluate(() => {
      document.querySelector('form[toolname=search] [name=ratio]')?.setAttribute('step', '0.25');
      const option = document.querySelector('form[toolname=search] option[value=top]');
      if (option?.firstChild) option.firstChild.nodeValue = 'Best';
    });
    const schema = await until(async () => {
      const properties = Reflect.get(Object((await toolsOf(t.ours)).get('search')?.inputSchema), 'properties');
      const ratio = Reflect.get(Object(Reflect.get(Object(properties), 'ratio')), 'multipleOf');
      return ratio === 0.25 ? properties : undefined;
    }, 'the new step');
    assert.deepEqual(Reflect.get(Object(Reflect.get(Object(schema), 'sort')), 'anyOf'), [
      { type: 'string', const: 'new', title: 'Newest' },
      { type: 'string', const: 'top', title: 'Best' },
    ]);
  });

  test('removed forms are reported', async () => {
    await t.page.evaluate(() => document.querySelector('form[toolname=nobutton]')?.remove());
    for (const side of [t.chrome, t.ours]) {
      const names = await until(async () => {
        const tools = await toolsOf(side);
        return tools.has('nobutton') ? undefined : [...tools.keys()].sort();
      }, 'the removal');
      assert.deepEqual(names, ['added', 'manual', 'rejects', 'search']);
    }
  });
});
