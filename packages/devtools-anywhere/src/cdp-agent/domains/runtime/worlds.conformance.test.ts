// Isolated worlds (Page.createIsolatedWorld) and bindings (Runtime.addBinding), against Chrome's:
// what the Animations panel uses to follow a scroller's scrolling.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { diffSubset, launch, openPage, setUpAndTearDown, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, [
      'Runtime.executionContextCreated',
      'Runtime.executionContextDestroyed',
      'Runtime.bindingCalled',
    ]);
    await t.page.evaluate(() => {
      const scroller = document.body.appendChild(document.createElement('div'));
      scroller.id = 'scroller';
      scroller.style.cssText = 'height: 100px; overflow: scroll';
      scroller.innerHTML = '<div style="height: 1000px"></div>';
    });
    for (const side of [t.ours, t.chrome]) {
      await side.send('Runtime.enable');
      await side.send('DOM.enable');
    }
  },
  () => env?.close()
);

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

/** The error message a command fails with, undefined if it succeeds. */
const failure = (side: Side, run: (side: Side) => Promise<unknown>) =>
  run(side).then(
    () => undefined,
    (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Protocol error \([\w.]+\): /, '')
  );

/** The code of the error our agent answers `method` with (Puppeteer drops Chrome's: read off its raw replies). */
const ourErrorCode = (method: string, params: object) =>
  t.page.evaluate(
    (m, p) =>
      window.__session.call(m, p).then(
        () => undefined,
        (e: unknown) => (e instanceof Error && 'code' in e ? e.code : undefined)
      ),
    method,
    params
  );

const topFrameId = async (side: Side) => (await side.send('Page.getFrameTree')).frameTree.frame.id;

/** The world named `name` of the top frame. */
const world = async (side: Side, name: string) =>
  (await side.send('Page.createIsolatedWorld', { frameId: await topFrameId(side), worldName: name }))
    .executionContextId;

/** `expression`'s value in context `contextId` (the top page's when undefined). */
const valueIn = async (side: Side, expression: string, contextId?: number) => {
  const { result, exceptionDetails } = await side.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    ...(contextId === undefined ? {} : { contextId }),
  });
  return exceptionDetails ? `throws ${result.description?.split('\n')[0]}` : result.value;
};

/** The bindingCalled events of `name`, with whether each came from context `contextId`. */
const calls = async (side: Side, name: string, contextId: number) =>
  (await side.events('Runtime.bindingCalled'))
    .filter(e => e.name === name)
    .map(e => ({ payload: e.payload, here: e.executionContextId === contextId }));

describe('isolated worlds', () => {
  test('createIsolatedWorld announces a context of the frame, and gives the same one again for a name', async () => {
    await both(side => side.clear());
    const [[oursId, oursAgain], [chromeId, chromeAgain]] = await both(async side => [
      await world(side, 'conformance-world'),
      await world(side, 'conformance-world'),
    ]);
    assert.equal(oursAgain, oursId);
    assert.equal(chromeAgain, chromeId);
    const [ours, chrome] = await waitForBoth(t, 'Runtime.executionContextCreated');
    const strip = (events: Protocol.Runtime.ExecutionContextCreatedEvent[], id: number, frameId: string) =>
      events
        .filter(e => e.context.name === 'conformance-world')
        .map(({ context: { id: contextId, origin, name, auxData } }) => ({
          origin,
          name,
          isId: contextId === id,
          auxData: { ...auxData, frameId: auxData?.['frameId'] === frameId },
        }));
    const oursEvents = strip(ours, oursId, await topFrameId(t.ours));
    assert.equal(oursEvents.length, 1);
    assert.deepEqual(oursEvents, strip(chrome, chromeId, await topFrameId(t.chrome)));
  });

  test('createIsolatedWorld refuses a frame that does not exist', async () => {
    const [ours, chrome] = await both(side =>
      failure(side, s => s.send('Page.createIsolatedWorld', { frameId: 'nope', worldName: 'x' }))
    );
    assert.equal(ours, chrome);
    assert.ok(ours);
  });

  test('Runtime.enable announces the worlds made before, newest first among the contexts', async () => {
    await both(async side => {
      await world(side, 'conformance-before-enable');
      await side.send('Runtime.disable');
      await side.clear();
      await side.send('Runtime.enable');
    });
    const [ours, chrome] = await both(async side =>
      (await side.events('Runtime.executionContextCreated'))
        // Puppeteer's own worlds are Chrome's only.
        .filter(e => !e.context.name.startsWith('__puppeteer'))
        .map(e => e.context.name || 'default')
    );
    assert.deepEqual(ours, chrome);
  });

  test('a world sees the DOM, and keeps its globals from the page and the page its own from it', async () => {
    const [ours, chrome] = await both(async side => {
      const id = await world(side, 'conformance-globals');
      await valueIn(side, 'globalThis.conformanceWorldOnly = 1; window.conformanceAlsoWorld = 2', id);
      return [
        await valueIn(side, 'document.getElementById("scroller").id', id),
        await valueIn(side, '[typeof conformanceWorldOnly, typeof conformanceAlsoWorld, window === globalThis]', id),
        await valueIn(side, '[typeof conformanceWorldOnly, typeof conformanceAlsoWorld]'),
      ];
    });
    assert.deepEqual(ours, chrome);
  });
});

describe('bindings', () => {
  test('a binding named for a world is a global there, not in the page, and reports its calls', async () => {
    const [ours, chrome] = await both(async side => {
      await side.clear();
      await side.send('Runtime.addBinding', { name: 'conformanceReport', executionContextName: 'conformance-bound' });
      const id = await world(side, 'conformance-bound');
      const seen = [
        await valueIn(side, 'typeof conformanceReport', id),
        await valueIn(side, 'typeof conformanceReport'),
        await valueIn(side, 'conformanceReport.length', id),
        await valueIn(side, 'conformanceReport(1)', id),
        await valueIn(side, 'conformanceReport("a", "b")', id),
        await valueIn(side, 'conformanceReport("hello")', id),
      ];
      await new Promise(resolve => setTimeout(resolve, 100));
      return { seen, calls: await calls(side, 'conformanceReport', id) };
    });
    assert.deepEqual(ours, chrome);
    assert.deepEqual(ours.calls, [{ payload: 'hello', here: true }]);
  });

  test('a binding without a context name is a global of the page too', async () => {
    // One side after the other, each with a name of its own: both put it on the page's window.
    const seen: unknown[] = [];
    for (const side of [t.ours, t.chrome]) {
      const name = side === t.ours ? 'conformanceOurs' : 'conformanceChrome';
      await side.clear();
      await side.send('Runtime.addBinding', { name });
      seen.push({
        call: await valueIn(side, `${name}("main")`),
        page: await t.page.evaluate(name => typeof (window as unknown as Record<string, unknown>)[name], name),
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      seen.push((await side.events('Runtime.bindingCalled')).map(e => e.payload));
    }
    assert.deepEqual(seen.slice(0, 2), seen.slice(2));
    assert.deepEqual(seen[1], ['main']);
  });

  test('removeBinding leaves the function, whose calls are no longer reported', async () => {
    const [ours, chrome] = await both(async side => {
      await side.send('Runtime.addBinding', {
        name: 'conformanceRemoved',
        executionContextName: 'conformance-removed',
      });
      const id = await world(side, 'conformance-removed');
      await side.send('Runtime.removeBinding', { name: 'conformanceRemoved' });
      await side.send('Runtime.removeBinding', { name: 'conformanceNeverAdded' });
      await side.clear();
      const seen = await valueIn(side, 'typeof conformanceRemoved + conformanceRemoved("gone")', id);
      // Added again, its calls are reported again.
      await side.send('Runtime.addBinding', {
        name: 'conformanceRemoved',
        executionContextName: 'conformance-removed',
      });
      await valueIn(side, 'conformanceRemoved("back")', id);
      await new Promise(resolve => setTimeout(resolve, 100));
      return { seen, calls: await calls(side, 'conformanceRemoved', id) };
    });
    assert.deepEqual(ours, chrome);
  });

  test('addBinding refuses a context id together with a name, or one that does not exist', async () => {
    const both_ = { name: 'x', executionContextId: 1, executionContextName: 'y' };
    const unknown = { name: 'x', executionContextId: 999999 };
    const [ours, chrome] = await both(async side => [
      await failure(side, s => s.send('Runtime.addBinding', both_)),
      await failure(side, s => s.send('Runtime.addBinding', unknown)),
    ]);
    assert.deepEqual(ours, chrome);
    // InvalidParams, as read off Chrome's raw replies.
    assert.equal(await ourErrorCode('Runtime.addBinding', both_), -32602);
    assert.equal(await ourErrorCode('Runtime.addBinding', unknown), -32602);
  });
});

describe('a scroll listener in a world, as the Animations panel adds it', () => {
  // AnimationDOMNode.addScrollEventListener (front_end/core/sdk/AnimationModel.ts) and
  // scrollListenerInPage (front_end/core/sdk/PageFunctions.ts).
  const LISTEN = `function (id, binding, name) {
    if ('scrollingElement' in this && !this.scrollingElement) return;
    const scrollingElement = 'scrollingElement' in this ? this.scrollingElement : this;
    this[name] = () => {
      globalThis[binding](JSON.stringify({ scrollTop: scrollingElement.scrollTop, scrollLeft: scrollingElement.scrollLeft, id }));
    };
    this.addEventListener('scroll', this[name], true);
  }`;
  const UNLISTEN = `function (name) {
    this.removeEventListener('scroll', this[name]);
    delete this[name];
  }`;

  test('reports the scroller scrolled by the page, and leaves nothing the page sees', async () => {
    const objects = await both(async side => {
      await side.clear();
      await side.send('Runtime.addBinding', {
        name: '__conformance_scroll__',
        executionContextName: 'conformance-animations',
      });
      const id = await world(side, 'conformance-animations');
      const { root } = await side.send('DOM.getDocument');
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#scroller' });
      const { object } = await side.send('DOM.resolveNode', { nodeId, executionContextId: id });
      const objectId = object.objectId ?? '';
      const result = await side.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: LISTEN,
        arguments: [{ value: 7 }, { value: '__conformance_scroll__' }, { value: '__conformance_listener__' }],
      });
      return { id, objectId, result };
    });
    assert.deepEqual(diffSubset(objects[0].result, objects[1].result), []);
    await t.page.evaluate(() => document.getElementById('scroller')?.scrollTo(0, 300));
    await waitForBoth(t, 'Runtime.bindingCalled');
    const [ours, chrome] = await both(async side =>
      calls(side, '__conformance_scroll__', objects[side === t.ours ? 0 : 1].id)
    );
    assert.deepEqual(ours, chrome);
    assert.deepEqual(ours[0], { payload: '{"scrollTop":300,"scrollLeft":0,"id":7}', here: true });
    // The page sees no binding and no listener property of the world.
    assert.deepEqual(
      await t.page.evaluate(() => [
        typeof (window as unknown as Record<string, unknown>)['__conformance_scroll__'],
        Object.keys(document.getElementById('scroller') ?? {}),
      ]),
      ['undefined', []]
    );

    // Removed: like Chrome, it still reports, as the panel removes it without the `capture` flag
    // it was added with.
    await both(async side => {
      await side.send('Runtime.callFunctionOn', {
        objectId: objects[side === t.ours ? 0 : 1].objectId,
        functionDeclaration: UNLISTEN,
        arguments: [{ value: '__conformance_listener__' }],
      });
      await side.clear();
    });
    await t.page.evaluate(() => document.getElementById('scroller')?.scrollTo(0, 0));
    await new Promise(resolve => setTimeout(resolve, 200));
    const [oursAfter, chromeAfter] = await both(side =>
      calls(side, '__conformance_scroll__', objects[side === t.ours ? 0 : 1].id)
    );
    assert.deepEqual(oursAfter, chromeAfter);
    // The property it was kept in is gone all the same.
    assert.deepEqual(
      await both(async side => {
        const { result } = await side.send('Runtime.callFunctionOn', {
          objectId: objects[side === t.ours ? 0 : 1].objectId,
          functionDeclaration: 'function () { return typeof this.__conformance_listener__; }',
          returnByValue: true,
        });
        return result.value;
      }),
      ['undefined', 'undefined']
    );
  });

  test("DOM.resolveNode refuses a context that does not exist with Chrome's error", async () => {
    const [ours, chrome] = await both(async side => {
      const { root } = await side.send('DOM.getDocument');
      return failure(side, s => s.send('DOM.resolveNode', { nodeId: root.nodeId, executionContextId: 999999 }));
    });
    assert.equal(ours, chrome);
  });
});

describe('what a world keeps from the page', () => {
  test("a world's undeclared globals and top-level `this` properties are not the page's", async () => {
    const [ours, chrome] = await both(async side => {
      const id = await world(side, 'conformance-leak');
      await valueIn(side, 'conformanceLeak = 1; this.conformanceThis = 3', id);
      return [
        await valueIn(side, '[typeof conformanceLeak, typeof conformanceThis]', id),
        await t.page.evaluate(() => {
          const page = window as unknown as Record<string, unknown>;
          return [typeof page['conformanceLeak'], typeof page['conformanceThis']];
        }),
      ];
    });
    assert.deepEqual(ours, chrome);
    // Both sides share the page: what either left there would show on both.
    assert.deepEqual(ours, [
      ['number', 'number'],
      ['undefined', 'undefined'],
    ]);
  });

  test("a world's global is a Window, and the node a function is called on is the page's node", async () => {
    const [ours, chrome] = await both(async side => {
      const id = await world(side, 'conformance-identity');
      const { root } = await side.send('DOM.getDocument');
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#scroller' });
      const { object } = await side.send('DOM.resolveNode', { nodeId, executionContextId: id });
      const { result } = await side.send('Runtime.callFunctionOn', {
        objectId: object.objectId ?? '',
        functionDeclaration: `function () {
          return [
            window instanceof Window,
            document.body.contains(this),
            getComputedStyle(this).overflowY,
            this === document.getElementById('scroller'),
          ];
        }`,
        returnByValue: true,
      });
      return result.value;
    });
    assert.deepEqual(ours, chrome);
  });
});

describe('sessions', () => {
  /** A second session on each side, and the bindingCalled events it got. */
  async function secondSessions() {
    const cdp = await t.page.createCDPSession();
    const chromeSeen: string[] = [];
    cdp.on('Runtime.bindingCalled', e => chromeSeen.push(e.payload));
    await t.page.evaluate(() => {
      const session = window.DevtoolsAnywhere.createCdpSession();
      const seen: string[] = [];
      session.onMessage(m => {
        const msg = JSON.parse(m) as { method?: string; params?: { payload: string } };
        if (msg.method === 'Runtime.bindingCalled' && msg.params) seen.push(msg.params.payload);
      });
      window.__sessions = [session];
      (window as unknown as Record<string, unknown>)['__secondSeen'] = seen;
    });
    return {
      chrome: {
        send: (method: string, params: object) => cdp.send(method as never, params as never),
        seen: () => chromeSeen,
      },
      ours: {
        send: (method: string, params: object) =>
          t.page.evaluate((m, p) => window.__sessions?.[0]?.call(m, p), method, params),
        seen: () => t.page.evaluate(() => (window as unknown as Record<string, string[]>)['__secondSeen'] ?? []),
      },
    };
  }

  test('a binding of the page added by two sessions reports each call to both', async () => {
    const second = await secondSessions();
    const result = [];
    for (const [side, other, name] of [
      [t.ours, second.ours, 'conformanceSharedOurs'],
      [t.chrome, second.chrome, 'conformanceSharedChrome'],
    ] as const) {
      await side.clear();
      await side.send('Runtime.addBinding', { name });
      await other.send('Runtime.addBinding', { name });
      await t.page.evaluate(name => (window as unknown as Record<string, (s: string) => void>)[name]?.('both'), name);
      await new Promise(resolve => setTimeout(resolve, 100));
      result.push([(await side.events('Runtime.bindingCalled')).map(e => e.payload), await other.seen()]);
    }
    assert.deepEqual(result[0], result[1]);
    assert.deepEqual(result[0], [['both'], ['both']]);
  });

  test('a world of a name has the same id in every session', async () => {
    const second = await secondSessions();
    const same = [];
    for (const [side, other] of [
      [t.ours, second.ours],
      [t.chrome, second.chrome],
    ] as const) {
      const frameId = await topFrameId(side);
      const a = await side.send('Page.createIsolatedWorld', { frameId, worldName: 'conformance-shared' });
      const b = (await other.send('Page.createIsolatedWorld', { frameId, worldName: 'conformance-shared' })) as {
        executionContextId: number;
      };
      same.push(a.executionContextId === b.executionContextId);
    }
    assert.deepEqual(same, [true, true]);
  });
});

describe('worlds of iframes', () => {
  test("a frame's world is made again, with a new id, for each document it loads", async () => {
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { id: 'w', onload: resolve });
          frame.srcdoc = '<p>one</p>';
          document.body.append(frame);
        })
    );
    const ids = await both(async side => {
      await side.send('Runtime.addBinding', { name: 'conformanceInFrame', executionContextName: 'conformance-frame' });
      const { frameTree } = await side.send('Page.getFrameTree');
      const frameId = frameTree.childFrames?.find(child => child.frame.name === 'w')?.frame.id ?? '';
      const { executionContextId } = await side.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'conformance-frame',
      });
      await side.clear();
      return executionContextId;
    });
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = document.getElementById('w') as HTMLIFrameElement;
          frame.onload = resolve;
          frame.srcdoc = '<p>two</p>';
        })
    );
    const [ours, chrome] = await both(async (side: Side) => {
      const old = ids[side === t.ours ? 0 : 1];
      const deadline = Date.now() + 5000;
      let next: Protocol.Runtime.ExecutionContextDescription | undefined;
      while (!next && Date.now() < deadline) {
        next = (await side.events('Runtime.executionContextCreated')).find(
          e => e.context.name === 'conformance-frame'
        )?.context;
        if (!next) await new Promise(resolve => setTimeout(resolve, 20));
      }
      const destroyed = (await side.events('Runtime.executionContextDestroyed')).some(
        e => e.executionContextId === old
      );
      return {
        destroyed,
        renewed: !!next && next.id !== old,
        // The binding comes with the world's new document.
        binding: next && (await valueIn(side, 'typeof conformanceInFrame', next.id)),
      };
    });
    assert.deepEqual(ours, chrome);
    assert.deepEqual(ours, { destroyed: true, renewed: true, binding: 'function' });
  });
});
