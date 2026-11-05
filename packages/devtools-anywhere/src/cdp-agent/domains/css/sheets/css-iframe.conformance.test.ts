// Same-origin iframes in the CSS domain: the styles of their nodes, from the rules of their own
// document in their own viewport, and the style sheets of their documents, announced with their
// frame and removed with it, against Chrome's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, waitForBoth } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';

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

/** The id of the frame of the iframe `#id`. */
async function frameOf(side: Side, id: string): Promise<string> {
  const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
  const frameId = find(root, hasId(id))?.frameId;
  assert.ok(frameId, `frame of #${id}`);
  return frameId;
}

/** A computed style of `#inner` in the styled iframe, as the page sees it. */
const innerStyle = (name: string) =>
  t.page.evaluate(name => {
    const doc = document.querySelector<HTMLIFrameElement>('#styled')?.contentDocument;
    const el = doc?.querySelector('#inner');
    if (!doc?.defaultView || !el) throw new Error('no #inner');
    return doc.defaultView.getComputedStyle(el).getPropertyValue(name);
  }, name);

describe('editing styles in iframes', () => {
  test('createStyleSheet makes one inspector sheet per frame, in its document', async () => {
    await clear();
    const ids = await Promise.all(
      [t.ours, t.chrome].map(async side => {
        const frameId = await frameOf(side, 'styled');
        const a = await side.send('CSS.createStyleSheet', { frameId });
        const b = await side.send('CSS.createStyleSheet', { frameId });
        const forced = await side.send('CSS.createStyleSheet', { frameId, force: true });
        const top = await side.send('CSS.createStyleSheet', {
          frameId: (await side.send('Page.getResourceTree')).frameTree.frame.id,
        });
        return [
          a.styleSheetId === b.styleSheetId,
          forced.styleSheetId !== a.styleSheetId,
          top.styleSheetId !== a.styleSheetId,
        ];
      })
    );
    assert.deepEqual(ids[0], ids[1]);
    assert.deepEqual(ids[1], [true, true, true]);
    // Two inspector sheets in the iframe, announced with its frame (the top one is left out).
    // Chrome also sees the <style> elements we add, as sheets of the page: those are left out,
    // as are ownerNode and isMutable, where ours differ for the top frame too.
    const pick = async (side: Side) =>
      (await headers(side, await side.events('CSS.styleSheetAdded')))
        .filter(h => h.origin === 'inspector')
        .map(h => `${h.frame} ${h.sourceURL} ${h.isInline}`);
    const [ours, chrome] = [await pick(t.ours), await pick(t.chrome)];
    assert.deepEqual(ours, chrome);
    assert.equal(chrome.length, 2);
  });

  test('createStyleSheet of an unknown frame fails like in Chrome', async () => {
    const errors = await Promise.all(
      [t.ours, t.chrome].map(side =>
        side.send('CSS.createStyleSheet', { frameId: 'nope' }).then(
          () => 'resolved',
          (e: Error) => e.message.replace(/^Protocol error \(CSS\.createStyleSheet\): /, '')
        )
      )
    );
    assert.equal(errors[0], errors[1]);
  });

  test('a rule added to the iframe inspector sheet applies there', async () => {
    const { styleSheetId } = await t.ours.send('CSS.createStyleSheet', { frameId: await frameOf(t.ours, 'styled') });
    const { rule } = await t.ours.send('CSS.addRule', {
      styleSheetId,
      ruleText: '#inner { word-spacing: 3px; }',
      location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    });
    assert.equal(rule.origin, 'inspector');
    assert.equal(await innerStyle('word-spacing'), '3px');
    const { matchedCSSRules } = await t.ours.send('CSS.getMatchedStylesForNode', {
      nodeId: await nodeId(t.ours, 'inner'),
    });
    assert.ok(matchedCSSRules?.some(m => m.rule.styleSheetId === styleSheetId));
  });

  test('setStyleTexts and setRuleSelector edit the rules of an iframe sheet', async () => {
    const { matchedCSSRules } = await t.ours.send('CSS.getMatchedStylesForNode', {
      nodeId: await nodeId(t.ours, 'inner'),
    });
    const match = matchedCSSRules?.find(m => m.rule.selectorList.text === '#inner' && m.rule.origin === 'regular');
    const { styleSheetId, style, selectorList } = match?.rule ?? {};
    const selectorRange = selectorList?.selectors[0]?.range;
    assert.ok(styleSheetId && style?.range && selectorRange);
    const { styles } = await t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId, range: style.range, text: 'color: rgb(4, 5, 6); padding: 2px;' }],
    });
    assert.equal(styles[0]?.cssProperties.find(p => p.name === 'color')?.value, 'rgb(4, 5, 6)');
    assert.equal(await innerStyle('color'), 'rgb(4, 5, 6)');
    // A selector #inner no longer matches: the rule stops applying in the iframe, and is back with the old one.
    const { selectorList: list } = await t.ours.send('CSS.setRuleSelector', {
      styleSheetId,
      range: selectorRange,
      selector: '#inner.none',
    });
    assert.equal(list.text, '#inner.none');
    // The iframe's rules are of its own realm: `instanceof CSSStyleRule` of the top page fails on them.
    const selectors = () =>
      t.page.evaluate(() =>
        [...(document.querySelector<HTMLIFrameElement>('#styled')?.contentDocument?.styleSheets ?? [])].flatMap(sheet =>
          [...sheet.cssRules].flatMap(r =>
            'selectorText' in r && typeof r.selectorText === 'string' ? [r.selectorText] : []
          )
        )
      );
    assert.ok((await selectors()).includes('#inner.none'));
    assert.notEqual(await innerStyle('color'), 'rgb(4, 5, 6)');
    const range = list.selectors[0]?.range;
    assert.ok(range);
    await t.ours.send('CSS.setRuleSelector', { styleSheetId, range, selector: '#inner' });
    assert.ok(!(await selectors()).includes('#inner.none'));
    assert.equal(await innerStyle('color'), 'rgb(4, 5, 6)');
  });

  test('setStyleTexts edits the inline style of an iframe element', async () => {
    const { inlineStyle } = await t.ours.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(t.ours, 'inner') });
    assert.ok(inlineStyle?.styleSheetId && inlineStyle.range);
    await t.ours.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: inlineStyle.styleSheetId, range: inlineStyle.range, text: 'font-weight: 300' }],
    });
    assert.equal(await innerStyle('font-weight'), '300');
  });
});

// Chrome and we both act on the same page: each side forces, measures and un-forces in turn.
describe('forced pseudo-classes in iframes', () => {
  before(() =>
    t.page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('#styled')?.contentDocument;
      if (!doc) throw new Error('no iframe');
      const style = doc.createElement('style');
      // Holds in the narrow iframe only.
      style.textContent = '@media (max-width: 400px) { #inner:focus { outline-color: rgb(7, 8, 9) } }';
      doc.head.append(style);
    })
  );

  async function forced(side: Side, classes: string[]) {
    const id = await nodeId(side, 'inner');
    await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: classes });
    try {
      const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId: id });
      return {
        selectors: rules(matchedCSSRules).map(r => r.selector),
        decoration: await innerStyle('text-decoration-line'),
        outline: await innerStyle('outline-color'),
      };
    } finally {
      await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
    }
  }

  test('forcePseudoState applies the rules of the iframe, in its viewport', async () => {
    const ours = await forced(t.ours, ['hover', 'focus']);
    const chrome = await forced(t.chrome, ['hover', 'focus']);
    assert.deepEqual(ours, chrome);
    assert.equal(chrome.decoration, 'underline');
    assert.equal(chrome.outline, 'rgb(7, 8, 9)');
  });

  test('un-forcing takes the states back', async () => {
    const ours = await forced(t.ours, []);
    const chrome = await forced(t.chrome, []);
    assert.deepEqual(ours, chrome);
    assert.equal(chrome.decoration, 'none');
  });

  // The layer order hangs on a media query that holds in the narrow iframe only, not in the top
  // page; widening the iframe while forced flips it, which the forced rules must follow.
  test('the layer order of forced rules follows the media queries of the iframe', async () => {
    await t.page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('#styled')?.contentDocument;
      if (!doc) throw new Error('no iframe');
      const style = doc.createElement('style');
      style.textContent =
        '@media (max-width: 400px) { @layer wide, narrow; } @layer narrow { #inner:focus { column-gap: 1px } } ' +
        '@layer wide { #inner:focus { column-gap: 2px } }';
      doc.head.append(style);
    });
    const width = (px: string) =>
      t.page.evaluate(px => {
        const frame = document.querySelector<HTMLIFrameElement>('#styled');
        if (!frame?.contentWindow) throw new Error('no iframe');
        const win = frame.contentWindow;
        return new Promise<void>(resolve => {
          win.addEventListener('resize', () => requestAnimationFrame(() => resolve()), { once: true });
          frame.style.width = px;
        });
      }, px);
    const run = async (side: Side) => {
      const id = await nodeId(side, 'inner');
      await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['focus'] });
      try {
        const narrow = await innerStyle('column-gap');
        await width('500px');
        const wide = await innerStyle('column-gap');
        return { narrow, wide };
      } finally {
        await side.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
        await width('300px');
      }
    };
    const ours = await run(t.ours);
    const chrome = await run(t.chrome);
    assert.deepEqual(ours, chrome);
    assert.deepEqual(chrome, { narrow: '1px', wide: '2px' });
  });

  test('removing the iframe un-forces its elements', async () => {
    const id = await nodeId(t.ours, 'inner');
    await t.ours.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['hover'] });
    assert.equal(await innerStyle('text-decoration-line'), 'underline');
    await t.page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('#styled');
      Object.assign(window, { detachedInner: frame?.contentDocument?.querySelector('#inner') });
      frame?.remove();
    });
    // The forced element is let go once anything is forced again, as Chrome forgets removed nodes.
    const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
    const app = find(root, hasId('app'));
    assert.ok(app);
    await t.ours.send('CSS.forcePseudoState', { nodeId: app.nodeId, forcedPseudoClasses: ['hover'] });
    await t.ours.send('CSS.forcePseudoState', { nodeId: app.nodeId, forcedPseudoClasses: [] });
    const marker = await t.page.evaluate(() =>
      (Reflect.get(window, 'detachedInner') as Element | undefined)?.getAttribute('data-devtools-anywhere-force')
    );
    assert.equal(marker, null);
  });
});
