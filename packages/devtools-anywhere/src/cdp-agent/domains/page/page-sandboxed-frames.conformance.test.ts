// Sandboxed iframes without allow-same-origin, whose same-origin document is opaque: in the Page
// domain, against Chrome's. Chrome keeps them in the page's frame tree, with no child target.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { VOLATILE, diffSubset, launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, EventName, TestPage } from '../../../../test-support/conformance.ts';
import { fixtureUrl, launchOopif } from '../../../../test-support/oopif.ts';
import { chromeSide, get, type MergedSide, oursSide } from '../../../../test-support/merged-sides.ts';

for (const key of ['id', 'parentId', 'parentFrameId']) VOLATILE.add(key);

const BASE = '/packages/devtools-anywhere/test-support/';
const EVENTS: EventName[] = [
  'Page.frameAttached',
  'Page.frameNavigated',
  'Page.frameDetached',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
];

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, [...EVENTS, 'Target.attachedToTarget', 'Network.requestWillBeSent']);
  for (const side of [t.ours, t.chrome]) {
    await side.send('Page.enable');
    await side.send('Network.enable');
  }
  for (const side of [t.ours, t.chrome])
    await side.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
});
after(() => env?.close());

async function recorded() {
  const read = async (side: TestPage['ours']) => {
    const all: { method: string; params: unknown }[] = [];
    for (const method of EVENTS)
      for (const params of await side.events(method)) {
        const { stack: _, ...rest } = params as { stack?: unknown };
        all.push({ method, params: rest });
      }
    return all;
  };
  return Promise.all([read(t.ours), read(t.chrome)]);
}

/** Checks on each side that the request to `marker` has the loader of the frame's navigation. */
async function sameLoader(marker: string) {
  for (const side of [t.ours, t.chrome]) {
    let sent: Protocol.Network.RequestWillBeSentEvent | undefined;
    for (let i = 0; i < 100 && !sent; i++) {
      sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes(marker));
      if (!sent) await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(sent, marker);
    const navigated = (await side.events('Page.frameNavigated')).find(e => e.frame.id === sent.frameId);
    assert.equal(sent.loaderId, navigated?.frame.loaderId, marker);
  }
}

const sequence = (events: { method: string }[]) => events.map(e => e.method);

/** Adds sandboxed iframes, then waits until both sides sent frameStoppedLoading for each. */
async function add(frames: [id: string, sandbox: string, src: string | null][]) {
  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(
    `Promise.all(${JSON.stringify(frames)}.map(([id, sb, src]) => new Promise(r => {
      const f = document.createElement('iframe'); f.id = id; f.setAttribute('sandbox', sb);
      if (src) f.src = src; else f.srcdoc = '<b>x</b>';
      f.onload = r; document.body.append(f);
    })))`
  );
  await waitForBoth(t, 'Page.frameStoppedLoading', frames.length);
}

test('sandboxed iframes are attached and navigated in the page, with no child target', async () => {
  await add([
    ['s1', 'allow-scripts', `${BASE}frame-child.html?n=s1#x`],
    ['s2', '', `${BASE}frame-other.html?n=s2`],
    ['s3', 'allow-scripts', null],
  ]);
  const [ours, chrome] = await recorded();
  // Each frame's events in Chrome's order; across frames the order may differ.
  for (const id of ['s1', 's2', 's3']) {
    const of = (events: typeof ours) => {
      const frameId = (
        events.find(e => (e.params as { frame?: { name?: string } }).frame?.name === id)?.params as
          | Protocol.Page.FrameNavigatedEvent
          | undefined
      )?.frame.id;
      return events.filter(e => {
        const p = e.params as { frameId?: string; frame?: { id: string } };
        return (p.frameId ?? p.frame?.id) === frameId;
      });
    };
    assert.deepEqual(sequence(of(ours)), sequence(of(chrome)), id);
    assert.deepEqual(diffSubset(of(ours), of(chrome)), [], id);
  }
  assert.deepEqual(await t.chrome.events('Target.attachedToTarget'), []);
  assert.deepEqual(await t.ours.events('Target.attachedToTarget'), []);
  await sameLoader('n=s1');
  await sameLoader('n=s2');
});

test('getFrameTree lists them with ids the same as DOM and Network give', async () => {
  const [ours, chrome] = await Promise.all([t.ours.send('Page.getFrameTree'), t.chrome.send('Page.getFrameTree')]);
  assert.deepEqual(diffSubset(ours, chrome), []);
  for (const side of [t.ours, t.chrome]) {
    const { frameTree } = await side.send('Page.getFrameTree');
    const s1 = frameTree.childFrames?.find(c => c.frame.name === 's1')?.frame;
    assert.ok(s1);
    const { root } = await side.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#s1' });
    const { node } = await side.send('DOM.describeNode', { nodeId });
    assert.equal(node.frameId, s1.id);
    const sent = (await side.events('Network.requestWillBeSent')).find(e => e.request.url.includes('n=s1'));
    assert.equal(sent?.frameId, s1.id);
  }
});

test('a sandboxed iframe navigating, then removed', async () => {
  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(
    `new Promise(r => { const f = document.getElementById('s2'); f.onload = r; f.src = '${BASE}frame-child.html?n=s2b'; })`
  );
  await waitForBoth(t, 'Page.frameStoppedLoading', 1);
  let [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
  await sameLoader('n=s2b');

  await Promise.all([t.ours.clear(), t.chrome.clear()]);
  await t.page.evaluate(`document.getElementById('s2').remove()`);
  await waitForBoth(t, 'Page.frameDetached', 1);
  [ours, chrome] = await recorded();
  assert.deepEqual(sequence(ours), sequence(chrome));
  assert.deepEqual(diffSubset(ours, chrome), []);
});

// The same iframe merged into the page's agent (core/merged-frames.ts): its page loads the probe,
// whose agent links to the page's. Chrome's frame is the same; the page's agent reports it.
describe('a sandboxed iframe merged into the page', () => {
  let oopif: Env | undefined;
  const sides: { ours?: MergedSide; chrome?: MergedSide } = {};
  before(async () => {
    oopif = await launchOopif();
    sides.chrome = await chromeSide(oopif);
    sides.ours = await oursSide(oopif);
  });
  after(async () => {
    await sides.ours?.close();
    await sides.chrome?.close();
    await oopif?.close();
  });

  const both = () => {
    const { ours, chrome } = sides;
    assert.ok(ours && chrome);
    return [ours, chrome] as const;
  };

  /** The iframe's frame, from the page's frame tree (`method`: getFrameTree or getResourceTree). */
  async function childOf(side: MergedSide, method = 'Page.getFrameTree') {
    const children = get(get(await side.send(method), 'frameTree'), 'childFrames');
    const child = Array.isArray(children) ? children[0] : undefined;
    const frame = get(child, 'frame');
    assert.ok(frame);
    return { frame, id: String(get(frame, 'id')), resources: get(child, 'resources') };
  }

  /** Runs a script in the iframe's latest execution context. */
  async function inFrame(side: MergedSide, expression: string) {
    const { id } = await childOf(side);
    const created = (await side.events()).findLast(
      e => e.method === 'Runtime.executionContextCreated' && get(get(e.params['context'], 'auxData'), 'frameId') === id
    );
    return side.send('Runtime.evaluate', { contextId: get(created?.params['context'], 'id'), expression });
  }

  /** Polls `get` till it gives a value, for up to 5 s; undefined if it never does. */
  async function poll<T>(get: () => Promise<T | undefined>): Promise<T | undefined> {
    for (let i = 0; i < 100; i++) {
      const value = await get();
      if (value !== undefined) return value;
      await new Promise(r => setTimeout(r, 50));
    }
    return undefined;
  }

  /** The URL of sandboxed-child.html, trusting the parent, with `n` in its query. */
  function childUrl(n: string) {
    const next = new URL(fixtureUrl(oopif as Env, 'sandboxed-child.html'));
    next.searchParams.set('parentOrigins', new URL(fixtureUrl(oopif as Env, '')).origin);
    next.searchParams.set('n', n);
    return next.href;
  }

  /** The URLs frame `frameId` was reported navigated to since event `from`, once it stopped loading. */
  async function navigatedSince(side: MergedSide, frameId: string, from: number) {
    const stopped = await poll(async () =>
      (await pageEventsOf(side, frameId, from)).some(e => e.method === 'Page.frameStoppedLoading') ? true : undefined
    );
    assert.ok(stopped, 'frameStoppedLoading');
    const navigated = (await pageEventsOf(side, frameId, from)).filter(e => e.method === 'Page.frameNavigated');
    return navigated.map(e => get(get(e.params, 'frame'), 'url'));
  }

  /** The Page events of frame `frameId` since event `from`. */
  async function pageEventsOf(side: MergedSide, frameId: string, from: number) {
    return (await side.events())
      .slice(from)
      .filter(e => e.method.startsWith('Page.') && (e.params['frameId'] ?? get(e.params['frame'], 'id')) === frameId);
  }

  test('a navigation within its document is reported once, on the page', async () => {
    const results = [];
    for (const side of both()) {
      const { id } = await childOf(side);
      const from = (await side.events()).length;
      await inFrame(side, `history.pushState(null, '', '#pushed')`);
      const within = async () =>
        (await pageEventsOf(side, id, from)).filter(e => e.method === 'Page.navigatedWithinDocument');
      await poll(async () => ((await within()).length > 0 ? true : undefined));
      // A while longer, for any second report.
      await new Promise(r => setTimeout(r, 200));
      const events = await within();
      results.push(events.map(e => ({ url: e.params['url'], type: e.params['navigationType'] })));
    }
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[1]?.length, 1);
    assert.match(String(results[1]?.[0]?.url), /#pushed$/);
  });

  test("its own navigation: the page reports the document's URL, not the iframe's src, once", async () => {
    const results = [];
    for (const side of both()) {
      const { id } = await childOf(side);
      const from = (await side.events()).length;
      await inFrame(side, `location.href = ${JSON.stringify(childUrl('2'))}`);
      const navigated = await navigatedSince(side, id, from);
      const { frame } = await childOf(side);
      results.push({ navigated, tree: { url: get(frame, 'url'), securityOrigin: get(frame, 'securityOrigin') } });
    }
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[1]?.navigated.length, 1);
    assert.match(String(results[1]?.navigated[0]), /n=2$/);
    assert.match(String(results[1]?.tree.url), /n=2$/);
  });

  test("Page.navigate takes the frame's id and navigates it, as in Chrome", async () => {
    const results = [];
    for (const side of both()) {
      const { id } = await childOf(side);
      const from = (await side.events()).length;
      const reply = await side.send('Page.navigate', { url: childUrl('3'), frameId: id });
      assert.equal(get(reply, 'frameId'), id);
      const navigated = await navigatedSince(side, id, from);
      const { frame } = await childOf(side);
      results.push({ navigated, tree: get(frame, 'url') });
    }
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[1]?.navigated.length, 1);
    assert.match(String(results[1]?.tree), /n=3$/);
  });

  test('a navigation waiting for its URL when Page is disabled is not reported', async () => {
    const [ours, chrome] = both();
    // Chrome: the same navigation, so that both show the same document after.
    const { id } = await childOf(chrome);
    const from = (await chrome.events()).length;
    await inFrame(chrome, `location.href = ${JSON.stringify(childUrl('4'))}`);
    await navigatedSince(chrome, id, from);
    // Ours: disabled as soon as the iframe loads, while the page waits for its agent to tell the URL.
    await ours.send('Runtime.evaluate', {
      expression: `document.querySelector('iframe').addEventListener('load', () => {
        window.__disabledAt = window.__client.log.length;
        void window.__client.send('Page.disable');
      }, { once: true })`,
    });
    await inFrame(ours, `location.href = ${JSON.stringify(childUrl('4'))}`);
    const at = await poll(async () => {
      const value = get(
        get(await ours.send('Runtime.evaluate', { expression: 'window.__disabledAt' }), 'result'),
        'value'
      );
      return typeof value === 'number' ? value : undefined;
    });
    assert.ok(at !== undefined, 'disabled');
    // Past the longest wait for the URL (twice merged.ts's URL_TIMEOUT): as in Chrome, nothing.
    await new Promise(r => setTimeout(r, 2500));
    const later = (await ours.events()).slice(at).filter(e => e.method.startsWith('Page.'));
    assert.deepEqual(later, []);
    await ours.send('Page.enable');
    assert.match(String(get((await childOf(ours)).frame, 'url')), /n=4$/);
  });

  test('getResourceTree lists the frame with the resources of its document', async () => {
    const results = [];
    for (const side of both()) {
      const { frame, resources } = await childOf(side, 'Page.getResourceTree');
      const listed = Array.isArray(resources) ? resources : [];
      results.push({
        url: get(frame, 'url'),
        // The agent's own scripts: Chrome lists them, the agent does not.
        resources: listed
          .filter(r => !String(get(r, 'url')).includes('/dist-test/'))
          .map(r => [get(r, 'url'), get(r, 'type')]),
      });
    }
    assert.deepEqual(results[0], results[1]);
  });
});
