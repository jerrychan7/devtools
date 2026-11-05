// A style sheet from another origin: page scripts cannot read its rules, so the CSS
// domain fetches a copy (the server sends CORS headers for .css files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    const crossUrl =
      env.baseUrl.replace('localhost', '127.0.0.1') + '/packages/devtools-anywhere/test-support/assets/cross.css';
    await t.page.evaluate(
      href =>
        new Promise<void>(resolve => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.onload = () => resolve();
          document.head.appendChild(link);
        }),
      crossUrl
    );
    const readable = await t.page.evaluate(() => {
      try {
        return !!document.styleSheets[document.styleSheets.length - 1]?.cssRules;
      } catch {
        return false;
      }
    });
    assert.equal(readable, false, 'the sheet must not be readable from the page');
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const summarize = (matches: Protocol.CSS.RuleMatch[] | undefined) => {
  assert.ok(matches);
  return matches
    .filter(m => m.rule.origin === 'regular')
    .map(m => ({
      selector: m.rule.selectorList.text,
      media: (m.rule.media || []).map(x => x.text),
      declared: m.rule.style.cssProperties.filter(p => p.text).map(p => `${p.name}: ${p.value}`),
    }));
};

async function matched(side: Side, predicate: (n: DomNode) => boolean) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const node = find(root, predicate);
  assert.ok(node);
  return side.send('CSS.getMatchedStylesForNode', { nodeId: node.nodeId });
}

for (const [name, predicate] of [
  ['#app', (n: DomNode) => (n.attributes || []).includes('app')],
  ['section', (n: DomNode) => n.localName === 'section'],
] as const) {
  test(`rules from the cross-origin sheet match ${name}`, async () => {
    const [ours, chrome] = await Promise.all([matched(t.ours, predicate), matched(t.chrome, predicate)]);
    assert.deepEqual(summarize(ours.matchedCSSRules), summarize(chrome.matchedCSSRules));
  });
}

test('the copy is read-only', async () => {
  const ours = await matched(t.ours, n => (n.attributes || []).includes('app'));
  const rule = ours.matchedCSSRules?.find(
    m => m.rule.selectorList.text === '#app' && m.rule.origin === 'regular'
  )?.rule;
  assert.ok(rule?.styleSheetId && rule.style.range);
  await assert.rejects(
    t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: rule.styleSheetId, range: rule.style.range, text: 'letter-spacing: 9px;' }],
    }),
    /another origin/
  );
});

/** Calls `method` on a second session of ours, made once. */
const second = (method: string, params: object = {}): Promise<unknown> =>
  t.page
    .evaluate(
      async (method, params) => {
        type Session = ReturnType<typeof window.DevtoolsAnywhere.createCdpSession>;
        let s = Reflect.get(window, '__crossSecond') as Session | undefined;
        if (!s) {
          s = window.DevtoolsAnywhere.createCdpSession();
          Reflect.set(window, '__crossSecond', s);
          await s.call('DOM.enable', {});
          await s.call('CSS.enable', {});
        }
        return JSON.stringify(await s.call(method, params));
      },
      method,
      params
    )
    .then(r => JSON.parse(r) as unknown);

const first = (method: string, params: object = {}): Promise<unknown> =>
  (t.ours.send as (method: string, params: object) => Promise<unknown>)(method, params);

/** The `#app` rule of the cross-origin sheet as a session sees it, and the sheet's text. */
async function appRule(call: (method: string, params?: object) => Promise<unknown>) {
  const { root } = (await call('DOM.getDocument', { depth: -1 })) as { root: DomNode };
  const node = find(root, n => (n.attributes || []).includes('app'));
  assert.ok(node);
  const res = (await call('CSS.getMatchedStylesForNode', {
    nodeId: node.nodeId,
  })) as Protocol.CSS.GetMatchedStylesForNodeResponse;
  const rule = res.matchedCSSRules?.find(m => m.rule.selectorList.text === '#app' && m.rule.origin === 'regular')?.rule;
  assert.ok(rule?.styleSheetId && rule.style.range);
  const { text } = (await call('CSS.getStyleSheetText', { styleSheetId: rule.styleSheetId })) as { text: string };
  return { rule, text };
}

/** The rule once found: a copy may still be loading. */
async function eventually(call: (method: string, params?: object) => Promise<unknown>) {
  for (let i = 0; i < 50; i++) {
    const found = await appRule(call).catch(() => null);
    if (found) return found;
    await new Promise(r => setTimeout(r, 100));
  }
  return appRule(call);
}

test('a second session sees the rules and text of the copy too, and cannot edit it either', async () => {
  const theirs = await eventually(second);
  const mine = await appRule(first);
  assert.equal(theirs.text, mine.text);
  assert.deepEqual(theirs.rule.style.range, mine.rule.style.range);
  await assert.rejects(
    second('CSS.setStyleTexts', {
      edits: [{ styleSheetId: theirs.rule.styleSheetId, range: theirs.rule.style.range, text: 'letter-spacing: 9px;' }],
    }),
    /another origin/
  );
  // Disabled by every session and enabled again: the copy and its text stay.
  await first('CSS.disable');
  await second('CSS.disable');
  await first('CSS.enable');
  await second('CSS.enable');
  assert.equal((await eventually(first)).text, mine.text);
  assert.equal((await eventually(second)).text, mine.text);
});

/**
 * The agent's fetches of the cross-origin file with `query` (the page's own load of it goes on),
 * each answered by `answer`.
 */
async function intercept(query: string, answer: (n: number) => Promise<'ok' | 'fail'>): Promise<() => number> {
  let count = 0;
  answers.set(query, () => answer(++count));
  if (!intercepting) {
    intercepting = true;
    await t.page.setRequestInterception(true);
    t.page.on('request', req => {
      const q = req.url().split('cross.css?')[1];
      const answered = q !== undefined && req.resourceType() !== 'stylesheet' ? answers.get(q) : undefined;
      if (!answered) return void req.continue();
      void answered().then(a => (a === 'ok' ? req.continue() : req.respond({ status: 500, body: '' })));
    });
  }
  return () => count;
}
const answers = new Map<string, () => Promise<'ok' | 'fail'>>();
let intercepting = false;

/** Adds a <link> to the cross-origin file with `query`, once loaded. */
const link = (query: string) =>
  t.page.evaluate(
    href =>
      new Promise<void>(resolve => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = () => resolve();
        document.head.appendChild(l);
      }),
    `${env?.baseUrl.replace('localhost', '127.0.0.1')}/packages/devtools-anywhere/test-support/assets/cross.css?${query}`
  );

/** Every session of ours in the page disables CSS, then the first one enables it again. */
async function unwatched() {
  await first('CSS.disable');
  await t.page.evaluate(async () => {
    const s = Reflect.get(window, '__crossSecond') as
      | ReturnType<typeof window.DevtoolsAnywhere.createCdpSession>
      | undefined;
    await s?.call('CSS.disable', {});
  });
  await first('CSS.enable');
}

test('a session that disabled CSS before its copy came is not told of it', async () => {
  let release = () => {};
  const held = new Promise<void>(r => (release = r));
  const fetches = await intercept('held', async () => (await held, 'ok'));
  await t.ours.clear();
  await link('held');
  for (let i = 0; i < 30 && fetches() < 1; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fetches(), 1, 'the copy is being fetched');
  await first('CSS.disable');
  release();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(await t.ours.events('CSS.styleSheetChanged'), []);
  await first('CSS.enable');
});

test('a copy that could not be fetched is fetched again after every session disabled CSS', async () => {
  const fetches = await intercept('fails-once', async n => (n === 1 ? 'fail' : 'ok'));
  await link('fails-once');
  for (let i = 0; i < 30 && fetches() < 1; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fetches(), 1);
  // Not tried again while some session watches.
  await first('CSS.getStyleSheetText', { styleSheetId: 'none' }).catch(() => {});
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fetches(), 1);
  await unwatched();
  for (let i = 0; i < 30 && fetches() < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fetches(), 2);
});
