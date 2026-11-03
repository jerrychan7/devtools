// Same-origin iframes in the Runtime domain: an execution context per frame document, created and
// destroyed as frames come, navigate and go, against Chrome's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';
const OTHER = '/packages/devtools-anywhere/test-support/frame-other.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [
    'Runtime.executionContextCreated',
    'Runtime.executionContextDestroyed',
    'Runtime.consoleAPICalled',
    'Runtime.exceptionThrown',
  ]);
  // A srcdoc iframe, there before DevTools connects.
  await t.page.evaluate(
    () =>
      new Promise(resolve => {
        const frame = Object.assign(document.createElement('iframe'), { id: 'pre', onload: resolve });
        frame.srcdoc = '<p id="in">pre</p><script>var where = "pre"; let lexical = 1;</script>';
        document.body.append(frame);
      })
  );
  for (const side of [t.ours, t.chrome]) await side.send('Runtime.enable');
});
after(() => env?.close());

/**
 * The default contexts a side announced and destroyed, in order, as frame paths (`top`, `#pre`,
 * …) rather than ids: Chrome also has Puppeteer's isolated worlds.
 */
async function lifecycle(side: Side, frameName: (frameId: string) => Promise<string>) {
  const created = (await side.events('Runtime.executionContextCreated')).filter(e => e.context.auxData?.['isDefault']);
  const ids = new Set(created.map(e => e.context.id));
  const destroyed = (await side.events('Runtime.executionContextDestroyed')).filter(e => ids.has(e.executionContextId));
  return {
    created: await Promise.all(
      created.map(async e => {
        const { id: _, ...context } = e.context;
        return { ...context, frame: await frameName(String(context.auxData?.['frameId'])) };
      })
    ),
    destroyed: destroyed.length,
  };
}

/** A context created or destroyed, as it came. */
type Seen = { created: number; isDefault: boolean } | { destroyed: number };

/**
 * What happened to default contexts, in order: one destroyed is one created before (`known`, if
 * created before these) as a default context, so Puppeteer's isolated worlds are left out.
 */
function navigationOrder(seen: Seen[], known: Seen[] = []) {
  const defaults = new Set([...known, ...seen].flatMap(e => ('created' in e && e.isDefault ? [e.created] : [])));
  return seen.flatMap(e => {
    if ('destroyed' in e) return defaults.has(e.destroyed) ? ['destroyed'] : [];
    return e.isDefault ? ['created'] : [];
  });
}

/** Names frames by the id of their `<iframe>`, from each side's frame tree. */
function namer(side: Side) {
  return async (frameId: string) => {
    const { frameTree } = await side.send('Page.getFrameTree');
    const visit = (tree: Protocol.Page.FrameTree): string | undefined =>
      tree.frame.id === frameId
        ? (tree.frame.name ?? 'top')
        : tree.childFrames?.map(visit).find(name => name !== undefined);
    return visit(frameTree) ?? 'gone';
  };
}

const both = async <T>(fn: (side: Side) => Promise<T>) => Promise.all([fn(t.ours), fn(t.chrome)]);

describe('execution contexts', () => {
  test('Runtime.enable announces the context of each frame, newest first', async () => {
    const [ours, chrome] = await both(side => lifecycle(side, namer(side)));
    assert.deepEqual(
      ours.created.map(c => c.frame),
      chrome.created.map(c => c.frame)
    );
    assert.deepEqual(diffSubset(ours.created, chrome.created), []);
    assert.equal(ours.created.find(c => c.frame === 'pre')?.origin, new URL(env?.baseUrl ?? '').origin);
  });

  test('an iframe gets a context when its document commits, a new one when it navigates', async () => {
    await both(side => side.clear());
    await t.page.evaluate(
      src =>
        new Promise(resolve => {
          document.body.append(Object.assign(document.createElement('iframe'), { id: 'a', src, onload: resolve }));
        }),
      CHILD
    );
    await waitForBoth(t, 'Runtime.executionContextCreated');
    let [ours, chrome] = await both(side => lifecycle(side, namer(side)));
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.deepEqual(
      ours.created.map(c => c.frame),
      ['a']
    );

    // The old context is destroyed before the new one is created: in the order they came, from a
    // session of Chrome's own (the sides keep each event apart) and from ours.
    const chromeOrder = await t.page.createCDPSession();
    const chromeSeen: Seen[] = [];
    chromeOrder.on('Runtime.executionContextCreated', e =>
      chromeSeen.push({ created: e.context.id, isDefault: !!e.context.auxData?.['isDefault'] })
    );
    chromeOrder.on('Runtime.executionContextDestroyed', e => chromeSeen.push({ destroyed: e.executionContextId }));
    await chromeOrder.send('Runtime.enable');
    const oursFrom = await t.page.evaluate(() => window.__ours.length);
    const chromeFrom = chromeSeen.length;
    await t.page.evaluate(
      src =>
        new Promise(resolve => {
          const frame = document.querySelector<HTMLIFrameElement>('#a');
          if (!frame) throw new Error('no #a');
          frame.onload = resolve;
          frame.src = src;
        }),
      OTHER
    );
    await waitForBoth(t, 'Runtime.executionContextCreated', 2);
    [ours, chrome] = await both(side => lifecycle(side, namer(side)));
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.equal(ours.destroyed, 1);
    const oursAll = await t.page.evaluate(() =>
      window.__ours.flatMap((e): Seen[] => {
        if (e.method === 'Runtime.executionContextCreated') {
          const { context } = e.params as Protocol.Runtime.ExecutionContextCreatedEvent;
          return [{ created: context.id, isDefault: !!context.auxData?.['isDefault'] }];
        }
        if (e.method === 'Runtime.executionContextDestroyed') {
          const { executionContextId } = e.params as Protocol.Runtime.ExecutionContextDestroyedEvent;
          return [{ destroyed: executionContextId }];
        }
        return [];
      })
    );
    await chromeOrder.detach();
    assert.deepEqual(navigationOrder(oursAll.slice(oursFrom), oursAll.slice(0, oursFrom)), ['destroyed', 'created']);
    assert.deepEqual(navigationOrder(chromeSeen.slice(chromeFrom), chromeSeen.slice(0, chromeFrom)), [
      'destroyed',
      'created',
    ]);
  });

  test('removing an iframe destroys its context', async () => {
    await both(side => side.clear());
    await t.page.evaluate(() => document.querySelector('#a')?.remove());
    await waitForBoth(t, 'Runtime.executionContextDestroyed');
    const [ours] = await t.ours.events('Runtime.executionContextDestroyed');
    assert.ok(ours?.executionContextUniqueId);
  });
});

/** The default context of the frame named `name` (`top` for the top one) on a side. */
async function contextOf(side: Side, name: string): Promise<number> {
  const nameOf = namer(side);
  for (const e of (await side.events('Runtime.executionContextCreated')).reverse())
    if (e.context.auxData?.['isDefault'] && (await nameOf(String(e.context.auxData['frameId']))) === name)
      return e.context.id;
  throw new Error(`no context for ${name}`);
}

/** Sends the same command on both sides, in the context of the frame `name` on each. */
async function inFrame<T>(name: string, send: (side: Side, contextId: number) => Promise<T>) {
  return both(async side => send(side, await contextOf(side, name)));
}

describe('evaluation in a frame', () => {
  // Every context announced again, to find each frame's.
  before(() =>
    both(async side => {
      await side.send('Runtime.disable');
      await side.clear();
      await side.send('Runtime.enable');
    })
  );

  test('evaluate runs in the context asked for', async () => {
    const [ours, chrome] = await inFrame('pre', (side, contextId) =>
      side.send('Runtime.evaluate', {
        expression: '[where, location.href, window === top]',
        contextId,
        returnByValue: true,
      })
    );
    assert.deepEqual(ours, chrome);
    assert.deepEqual(ours.result.value, ['pre', 'about:srcdoc', false]);
  });

  test("an exception thrown in a frame is reported with the frame's context", async () => {
    const [ours, chrome] = await inFrame('pre', (side, contextId) =>
      side.send('Runtime.evaluate', { expression: 'throw new TypeError("no")', contextId })
    );
    assert.deepEqual(diffSubset(ours, chrome), []);
    assert.equal(ours.exceptionDetails?.executionContextId, await contextOf(t.ours, 'pre'));
  });

  test("REPL bindings and console utilities are the frame's own", async () => {
    // Each side declares its own name: both run in the same page.
    for (const [expression, name] of [
      ['let inPre$ = 2; inPre$', 'pre'],
      ['inPre$', 'pre'],
      ['typeof inPre$', 'top'],
      ['$("#in").textContent', 'pre'],
    ] as const) {
      const [ours, chrome] = await inFrame(name, (side, contextId) =>
        side.send('Runtime.evaluate', {
          expression: expression.replaceAll('inPre$', side === t.ours ? 'inPreOurs' : 'inPreChrome'),
          contextId,
          replMode: true,
          includeCommandLineAPI: true,
          returnByValue: true,
        })
      );
      assert.deepEqual(diffSubset(ours, chrome), [], expression);
    }
  });

  test("callFunctionOn runs in the object's context, or the one asked for", async () => {
    const [ours, chrome] = await inFrame('pre', async (side, contextId) => {
      const { result } = await side.send('Runtime.evaluate', { expression: 'document.body', contextId });
      assert.ok(result.objectId);
      const onObject = await side.send('Runtime.callFunctionOn', {
        objectId: result.objectId,
        functionDeclaration: 'function () { return [this.ownerDocument === document, location.href]; }',
        returnByValue: true,
      });
      const inContext = await side.send('Runtime.callFunctionOn', {
        executionContextId: contextId,
        functionDeclaration: 'function () { return where; }',
        returnByValue: true,
      });
      return [onObject.result.value, inContext.result.value];
    });
    assert.deepEqual(ours, chrome);
    assert.deepEqual(ours, [[true, 'about:srcdoc'], 'pre']);
  });

  test("compileScript and globalLexicalScopeNames take the frame's context", async () => {
    const [ours, chrome] = await inFrame('pre', async (side, executionContextId) => {
      const compiled = await side.send('Runtime.compileScript', {
        expression: '1 +',
        sourceURL: '',
        persistScript: false,
        executionContextId,
      });
      const { names } = await side.send('Runtime.globalLexicalScopeNames', { executionContextId });
      return { compiled, executionContextId, names };
    });
    assert.equal(ours.compiled.exceptionDetails?.text, chrome.compiled.exceptionDetails?.text);
    // Chrome leaves the context out of these details; ours names the one asked for.
    assert.equal(ours.compiled.exceptionDetails?.executionContextId, ours.executionContextId);
    assert.ok(ours.names.includes('lexical') && chrome.names.includes('lexical'));
    const [top] = await both(side => side.send('Runtime.globalLexicalScopeNames', {}));
    assert.ok(!top.names.includes('lexical'));
  });

  test('uniqueContextId picks the context too', async () => {
    const [ours, chrome] = await both(async side => {
      const id = await contextOf(side, 'pre');
      const created = (await side.events('Runtime.executionContextCreated')).find(e => e.context.id === id);
      const uniqueContextId = created?.context.uniqueId;
      assert.ok(uniqueContextId);
      const evaluated = await side.send('Runtime.evaluate', {
        expression: 'where',
        uniqueContextId,
        returnByValue: true,
      });
      const called = await side.send('Runtime.callFunctionOn', {
        uniqueContextId,
        functionDeclaration: 'function () { return where; }',
        returnByValue: true,
      });
      const missing = await side.send('Runtime.evaluate', { expression: '1', uniqueContextId: '1.2' }).then(
        () => 'resolved',
        (e: unknown) => String(e instanceof Error ? e.message : e)
      );
      return [evaluated.result.value, called.result.value, missing];
    });
    assert.deepEqual(ours.slice(0, 2), ['pre', 'pre']);
    assert.deepEqual(ours.slice(0, 2), chrome.slice(0, 2));
    assert.match(String(ours[2]), /uniqueContextId not found/);
    assert.match(String(chrome[2]), /uniqueContextId not found/);
  });

  test('callFunctionOn takes exactly one of objectId, executionContextId and uniqueContextId', async () => {
    const [ours, chrome] = await inFrame('pre', async (side, executionContextId) => {
      const { result } = await side.send('Runtime.evaluate', {
        expression: 'document.body',
        contextId: executionContextId,
      });
      const { objectId } = result;
      assert.ok(objectId);
      const error = (params: Omit<Protocol.Runtime.CallFunctionOnRequest, 'functionDeclaration'>) =>
        side.send('Runtime.callFunctionOn', { ...params, functionDeclaration: 'function () {}' }).then(
          () => 'resolved',
          (e: unknown) => String(e instanceof Error ? e.message : e)
        );
      return [await error({ objectId, executionContextId }), await error({})];
    });
    for (const side of [ours, chrome]) {
      assert.match(
        String(side[0]),
        /ObjectId, executionContextId and uniqueContextId must mutually exclude each other/
      );
      assert.match(String(side[1]), /Either objectId or executionContextId or uniqueContextId must be specified/);
    }
  });

  test('a context that is gone is an error, like in Chrome', async () => {
    const [ours, chrome] = await both(side =>
      side.send('Runtime.evaluate', { expression: '1', contextId: 9999 }).then(
        () => 'resolved',
        (e: unknown) => String(e instanceof Error ? e.message : e)
      )
    );
    assert.match(ours, /Cannot find context with specified id/);
    assert.match(chrome, /Cannot find context with specified id/);
  });

  test('the context of a document its frame navigated away from is gone, Runtime enabled or not', async () => {
    await both(side => side.clear());
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { id: 'stale', onload: resolve });
          frame.srcdoc = '<p>old</p>';
          document.body.append(frame);
        })
    );
    await waitForBoth(t, 'Runtime.executionContextCreated');
    const ids = await both(side => contextOf(side, 'stale'));
    // Nothing follows the frames: the registry is looked at again when the context is asked for.
    await both(side => side.send('Runtime.disable'));
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = document.querySelector<HTMLIFrameElement>('#stale');
          if (!frame) return resolve(null);
          frame.onload = resolve;
          frame.srcdoc = '<p>new</p>';
        })
    );
    const [ours, chrome] = await Promise.all(
      [t.ours, t.chrome].map((side, i) =>
        side.send('Runtime.evaluate', { expression: '1', contextId: ids[i] }).then(
          () => 'resolved',
          (e: unknown) => String(e instanceof Error ? e.message : e)
        )
      )
    );
    await t.page.evaluate(() => document.querySelector('#stale')?.remove());
    await both(async side => {
      await side.clear();
      await side.send('Runtime.enable');
    });
    assert.match(String(ours), /Cannot find context with specified id/);
    assert.match(String(chrome), /Cannot find context with specified id/);
  });
});

describe('console messages and exceptions of a frame', () => {
  /** The context of the frame `#logs`, ours and Chrome's. */
  let logsContext: [number, number] = [0, 0];
  before(async () => {
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { id: 'logs', onload: resolve });
          frame.srcdoc = '<p>logs</p>';
          document.body.append(frame);
        })
    );
    // Its context is announced again, with the others.
    await both(async side => {
      await side.send('Runtime.disable');
      await side.clear();
      await side.send('Runtime.enable');
    });
    logsContext = await both(side => contextOf(side, 'logs'));
  });

  /**
   * Runs `code` as a script of the frame `#logs`. Not through its eval: code evaluated by Puppeteer
   * has muted errors, which the page is not told of.
   */
  const runInFrame = (code: string) =>
    t.page.evaluate(code => {
      const doc = document.querySelector<HTMLIFrameElement>('#logs')?.contentDocument;
      if (!doc) throw new Error('no #logs');
      doc.body.append(Object.assign(doc.createElement('script'), { text: code }));
    }, code);

  test("console calls are reported in the frame's context", async () => {
    await runInFrame('console.log("from the frame", { a: 1 }); console.warn("careful")');
    await waitForBoth(t, 'Runtime.consoleAPICalled', 2);
    const [ours, chrome] = await both(side => side.events('Runtime.consoleAPICalled'));
    assert.deepEqual(diffSubset(ours, chrome), []);
    const [oursContext, chromeContext] = logsContext;
    assert.deepEqual(
      ours.map(e => e.executionContextId),
      [oursContext, oursContext]
    );
    assert.deepEqual(
      chrome.map(e => e.executionContextId),
      [chromeContext, chromeContext]
    );
  });

  test("uncaught errors and rejections are reported in the frame's context", async () => {
    await both(side => side.clear());
    await runInFrame('setTimeout(() => { throw new Error("boom"); }); Promise.reject(new Error("rej"));');
    await waitForBoth(t, 'Runtime.exceptionThrown', 2);
    const [ours, chrome] = await both(side => side.events('Runtime.exceptionThrown'));
    const texts = (events: typeof ours) => events.map(e => e.exceptionDetails.exception?.description?.split('\n')[0]);
    assert.deepEqual(texts(ours).sort(), texts(chrome).sort());
    const [oursContext, chromeContext] = logsContext;
    assert.deepEqual(
      ours.map(e => e.exceptionDetails.executionContextId),
      [oursContext, oursContext]
    );
    assert.deepEqual(
      chrome.map(e => e.exceptionDetails.executionContextId),
      [chromeContext, chromeContext]
    );
  });

  test("a srcdoc document's own scripts are heard while it loads, after its context is created", async () => {
    await both(side => side.clear());
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = Object.assign(document.createElement('iframe'), { id: 'early', onload: resolve });
          frame.srcdoc = '<script>console.log("early")</script>';
          document.body.append(frame);
        })
    );
    await waitForBoth(t, 'Runtime.consoleAPICalled');
    for (const side of [t.ours, t.chrome]) {
      const [log] = await side.events('Runtime.consoleAPICalled');
      const created = await side.events('Runtime.executionContextCreated');
      assert.ok(created.some(e => e.context.id === log?.executionContextId && e.context.auxData?.['isDefault']));
    }
  });

  test('messages of a frame that is gone are kept, in no context', async () => {
    await t.page.evaluate(() => document.querySelector('#logs')?.remove());
    await both(async side => {
      await side.send('Runtime.disable');
      await side.clear();
      await side.send('Runtime.enable');
    });
    const [ours, chrome] = await both(async side =>
      (await side.events('Runtime.consoleAPICalled')).filter(e => e.type === 'warning')
    );
    assert.equal(ours.at(-1)?.executionContextId, 0);
    assert.equal(chrome.at(-1)?.executionContextId, 0);
  });
});
