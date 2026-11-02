// Same-origin iframes in the CSS domain: the styles of their nodes, from the rules of their own
// document in their own viewport, and the style sheets of their documents, announced with their
// frame and removed with it, against Chrome's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, waitForBoth } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;

const STYLED = '/packages/devtools-anywhere/test-support/frame-styled.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, ['CSS.styleSheetAdded', 'CSS.styleSheetRemoved']);
  // A narrow iframe with a <link> and a <style>, and a srcdoc one with a <style>, loaded.
  await t.page.evaluate(
    src =>
      Promise.all(
        [
          (f: HTMLIFrameElement) => {
            f.id = 'styled';
            f.src = src;
            f.style.width = '300px';
          },
          (f: HTMLIFrameElement) => {
            f.id = 'sd';
            f.srcdoc = '<style>.sd { color: rgb(9, 9, 9) }</style><p class="sd" id="sd-p">srcdoc</p>';
          },
        ].map(
          init =>
            new Promise(resolve => {
              const frame = document.createElement('iframe');
              init(frame);
              frame.onload = resolve;
              document.body.append(frame);
            })
        )
      ),
    STYLED
  );
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  const next = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
  if (node.contentDocument) next.push(node.contentDocument);
  for (const child of next) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const hasId = (id: string) => (n: DomNode) =>
  (n.attributes ?? []).some((v, i) => i % 2 === 0 && v === 'id' && n.attributes?.[i + 1] === id);

/** The names of the frames: an iframe's id for its frame, `top` for the others. */
async function frameNames(side: Side): Promise<Map<string, string>> {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const names = new Map<string, string>();
  for (const id of ['styled', 'sd']) {
    const frameId = find(root, hasId(id))?.frameId;
    if (frameId) names.set(frameId, id);
  }
  return names;
}

/** Headers in a form both sides share: frames by name, URLs without the origin. */
async function headers(side: Side, events: Protocol.CSS.StyleSheetAddedEvent[]) {
  const names = await frameNames(side);
  return events
    .map(({ header: h }) => ({
      frame: names.get(h.frameId) ?? 'top',
      sourceURL: h.sourceURL.replace(/^http:\/\/[^/]+/, ''),
      origin: h.origin,
      isInline: h.isInline,
      isMutable: h.isMutable,
      isConstructed: h.isConstructed,
      disabled: h.disabled,
      hasOwner: h.ownerNode !== undefined,
    }))
    .filter(h => h.frame !== 'top')
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function compareAdded() {
  const [o, c] = [await t.ours.events('CSS.styleSheetAdded'), await t.chrome.events('CSS.styleSheetAdded')];
  const [ours, chrome] = [await headers(t.ours, o), await headers(t.chrome, c)];
  assert.deepEqual(ours, chrome);
  return chrome;
}

const clear = () => Promise.all([t.ours.clear(), t.chrome.clear()]);

async function nodeId(side: Side, id: string): Promise<number> {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = find(root, hasId(id));
  assert.ok(node, `#${id}`);
  return node.nodeId;
}

/** What both sides should agree on in a rule match. */
const rules = (matches: Protocol.CSS.RuleMatch[] | undefined) =>
  (matches ?? [])
    .filter(m => m.rule.origin !== 'user-agent')
    .map(({ rule }) => ({
      selector: rule.selectorList.text,
      origin: rule.origin,
      media: (rule.media ?? []).map(m => ({ text: m.text, active: m.mediaList?.map(q => q.active) })),
      containers: (rule.containerQueries ?? []).map(c => c.text),
      declared: declared(rule.style),
    }));

/** The declarations written in a style. */
const declared = (style: Protocol.CSS.CSSStyle | undefined) =>
  (style?.cssProperties ?? []).filter(p => p.text).map(p => `${p.name}: ${p.value}`);

async function matched(side: Side, id: string) {
  const m = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, id) });
  return {
    matched: rules(m.matchedCSSRules),
    inline: declared(m.inlineStyle),
    inherited: (m.inherited ?? []).map(e => ({ matched: rules(e.matchedCSSRules), inline: declared(e.inlineStyle) })),
  };
}

describe('styles of nodes in iframes', () => {
  for (const id of ['inner', 'sd-p']) {
    test(`getMatchedStylesForNode #${id}: the rules of its own document`, async () => {
      const [ours, chrome] = await Promise.all([matched(t.ours, id), matched(t.chrome, id)]);
      assert.deepEqual(ours, chrome);
    });
  }

  test("media and container queries hold in the iframe's viewport", async () => {
    const { matched: chrome } = await matched(t.chrome, 'inner');
    const selectors = chrome.map(r => r.declared.join());
    assert.ok(selectors.includes('margin-left: 7px'), 'the narrow @media rule matches');
    assert.ok(selectors.includes('margin-right: 5px'), 'the @container rule matches');
    assert.ok(!chrome.some(r => r.selector.includes('.note')), 'rules of the top page do not');
  });

  test('getComputedStyleForNode uses the window of the node', async () => {
    const pick = async (side: Side) => {
      const { computedStyle } = await side.send('CSS.getComputedStyleForNode', { nodeId: await nodeId(side, 'inner') });
      const names = ['color', 'margin-left', 'margin-right', 'letter-spacing', 'font-weight', 'font-size', 'width'];
      return computedStyle.filter(p => names.includes(p.name)).sort((a, b) => a.name.localeCompare(b.name));
    };
    const [ours, chrome] = await Promise.all([pick(t.ours), pick(t.chrome)]);
    assert.deepEqual(ours, chrome);
    assert.equal(chrome.length, 7);
  });

  test('getInlineStylesForNode and getBackgroundColors', async () => {
    await t.page.evaluate(() => document.querySelector('#styled')?.scrollIntoView());
    const pick = async (side: Side) => {
      const id = await nodeId(side, 'inner');
      const inline = await side.send('CSS.getInlineStylesForNode', { nodeId: id });
      const bg = await side.send('CSS.getBackgroundColors', { nodeId: id });
      return { inline: declared(inline.inlineStyle), bg };
    };
    const [ours, chrome] = await Promise.all([pick(t.ours), pick(t.chrome)]);
    assert.deepEqual(ours, chrome);
  });
});

describe('style sheets', () => {
  test('the sheets of iframe documents are announced with their frame', async () => {
    const chrome = await compareAdded();
    // The <link> and the <style> of the narrow iframe, the <style> of the srcdoc one.
    assert.equal(chrome.length, 3);
  });

  test('sheets an iframe adopts or a script adds there', async () => {
    await clear();
    await t.page.evaluate(() => {
      const win = document.querySelector<HTMLIFrameElement>('#styled')?.contentWindow as
        | (Window & typeof globalThis)
        | null
        | undefined;
      if (!win) throw new Error('no iframe');
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync('.adopted { color: red }');
      win.document.adoptedStyleSheets = [sheet];
      const style = win.document.createElement('style');
      style.textContent = '.scripted { color: red }';
      win.document.head.append(style);
    });
    await waitForBoth(t, 'CSS.styleSheetAdded', 2);
    const chrome = await compareAdded();
    assert.equal(chrome.length, 2);
  });

  test('a navigating iframe takes its sheets along, and brings those of its new document', async () => {
    await clear();
    await t.page.evaluate(
      () =>
        new Promise(resolve => {
          const frame = document.querySelector<HTMLIFrameElement>('#sd');
          if (!frame) throw new Error('no iframe');
          frame.onload = resolve;
          frame.srcdoc = '<style>.a { color: red }</style><style>.b { color: red }</style>';
        })
    );
    const [removedOurs, removedChrome] = await waitForBoth(t, 'CSS.styleSheetRemoved');
    const [addedOurs, addedChrome] = await waitForBoth(t, 'CSS.styleSheetAdded', 2);
    assert.equal(removedOurs.length, removedChrome.length);
    assert.equal(addedOurs.length, addedChrome.length);
    await compareAdded();
  });

  test('a removed iframe takes its sheets along', async () => {
    await clear();
    await t.page.evaluate(() => document.querySelector('#sd')?.remove());
    const [ours, chrome] = await waitForBoth(t, 'CSS.styleSheetRemoved', 2);
    assert.equal(ours.length, chrome.length);
  });
});
