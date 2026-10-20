// CSS.forcePseudoState. Chrome and we both act on the same page, so each side forces,
// measures and un-forces in turn.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from './harness.ts';
import type { Env, Side, TestPage } from './harness.ts';

type DomNode = Protocol.DOM.Node;

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  #fo:hover { outline-color: rgb(1, 2, 3) }
  .f-order:hover { color: rgb(10, 0, 0) }
  .f-order.x { color: rgb(20, 0, 0) }
  .f-order:hover { background-color: rgb(0, 0, 5) }
  .f-order:not(:hover) { border-left-color: rgb(0, 6, 0) }
  .f-order:focus::before { content: "F" }
  @media (min-width: 1px) { .f-media:active { color: rgb(30, 0, 0) } }
  #fv:visited { color: rgb(40, 0, 0); font-weight: 700; display: none }
`;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.evaluate(style => {
    const s = document.createElement('style');
    s.textContent = style;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="fo" class="f-order x">fo</div><div id="fm" class="f-media">fm</div><a id="fv" href="#fv-never">fv</a>'
    );
  }, STYLE);
  for (const side of [t.ours, t.chrome]) {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
  }
});
after(() => env?.close());

function find(node: DomNode, predicate: (n: DomNode) => boolean): DomNode | null {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const attr = (node: DomNode, name: string): string | undefined => {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
};

/** Forces `classes` on #id through one side, runs `measure`, then un-forces. */
async function withForced<T>(side: Side, id: string, classes: string[], measure: (nodeId: number) => Promise<T> | T) {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const node = find(root, n => attr(n, 'id') === id);
  assert.ok(node);
  const nodeId = node.nodeId;
  await side.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
  try {
    return await measure(nodeId);
  } finally {
    await side.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  }
}

const computed = (id: string, pseudo?: string) =>
  t.page.evaluate(
    (id, pseudo) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`#${id} not found`);
      const style = getComputedStyle(el, pseudo);
      return {
        color: style.color,
        background: style.backgroundColor,
        outline: style.outlineColor,
        content: style.content,
      };
    },
    id,
    pseudo ?? null
  );

async function both<T>(id: string, classes: string[], measure: (side: Side, nodeId: number) => Promise<T>) {
  return {
    ours: await withForced(t.ours, id, classes, nodeId => measure(t.ours, nodeId)),
    chrome: await withForced(t.chrome, id, classes, nodeId => measure(t.chrome, nodeId)),
  };
}

test(':hover applies, and later rules of equal specificity still win', async () => {
  const { ours, chrome } = await both('fo', ['hover'], () => computed('fo'));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.color, 'rgb(20, 0, 0)');
  assert.equal(ours.background, 'rgb(0, 0, 5)');
  assert.equal(ours.outline, 'rgb(1, 2, 3)');
});

test(':active inside @media', async () => {
  const { ours, chrome } = await both('fm', ['active'], () => computed('fm'));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.color, 'rgb(30, 0, 0)');
});

test('a forced :focus creates the ::before it selects', async () => {
  const { ours, chrome } = await both('fo', ['focus'], () => computed('fo', '::before'));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.content, '"F"');
});

test('a forced :visited changes only the properties Chrome lets :visited change', async () => {
  const layout = () =>
    t.page.evaluate(() => {
      const el = document.getElementById('fv');
      if (!el) throw new Error('#fv not found');
      const style = getComputedStyle(el);
      return { weight: style.fontWeight, display: style.display };
    });
  const { ours, chrome } = await both('fv', ['visited'], () => layout());
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, { weight: '400', display: 'inline' });
});

test('the Styles pane shows the forced rules as matching', async () => {
  const summarize = (r: Protocol.CSS.GetMatchedStylesForNodeResponse) => {
    assert.ok(r.matchedCSSRules);
    return r.matchedCSSRules
      .filter(m => m.rule.origin === 'regular')
      .map(m => [m.rule.selectorList.text, m.matchingSelectors]);
  };
  const { ours, chrome } = await both('fo', ['hover'], (side, nodeId) =>
    side.send('CSS.getMatchedStylesForNode', { nodeId }).then(summarize)
  );
  assert.deepEqual(ours, chrome);
  // A forced :hover no longer matches its negation.
  assert.ok(!ours.some(([selector]) => selector === '.f-order:not(:hover)'));
});

test('the marker attribute is not visible to the client', async () => {
  const seen = await withForced(t.ours, 'fo', ['hover'], async nodeId => {
    const { attributes } = await t.ours.send('DOM.getAttributes', { nodeId });
    const { outerHTML } = await t.ours.send('DOM.getOuterHTML', { nodeId });
    return { attributes, outerHTML };
  });
  assert.deepEqual(seen.attributes, ['id', 'fo', 'class', 'f-order x']);
  assert.doesNotMatch(seen.outerHTML, /devtools-anywhere/);
});

test('un-forcing restores the original styles', async () => {
  const before = await computed('fo');
  await withForced(t.ours, 'fo', ['hover'], () => {});
  assert.deepEqual(await computed('fo'), before);
  const leftovers = await t.page.evaluate(() => document.querySelectorAll('[data-devtools-anywhere]').length);
  assert.equal(leftovers, 0);
});

test('a forced element taken out of the document is no longer forced', async () => {
  const results: Awaited<ReturnType<typeof computed>>[] = [];
  for (const side of [t.ours, t.chrome]) {
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    const node = find(root, n => attr(n, 'id') === 'fo');
    assert.ok(node);
    await side.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: ['hover'] });
    await t.page.evaluate(() => {
      const el = document.getElementById('fo');
      if (!el) throw new Error('#fo not found');
      el.remove();
      document.body.prepend(el);
    });
    results.push(await computed('fo'));
  }
  assert.deepEqual(results[0], results[1]);
  const leftovers = await t.page.evaluate(() => document.querySelectorAll('[data-devtools-anywhere]').length);
  assert.equal(leftovers, 0);
});

test('forcing does not change the DOM, even next to a <style> in the body', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<section id="fd"><style>#fd-a:hover { color: rgb(40, 0, 0) } #fd > :nth-child(2) { color: rgb(0, 40, 0) }</style>` +
        `<div id="fd-a">a</div></section>` +
        `<style>#fd-b:hover { color: rgb(50, 0, 0) }</style><style>#fd-b:not(.z) { color: rgb(60, 0, 0) }</style><div id="fd-b">b</div>`
    );
  });
  const snapshot = () =>
    t.page.evaluate(() => {
      const section = document.getElementById('fd');
      const a = document.getElementById('fd-a');
      if (!section || !a) throw new Error('#fd not found');
      return {
        count: section.childElementCount,
        nth: a.matches(':nth-child(2)'),
        body: document.body.childElementCount,
      };
    });
  const before = await snapshot();
  await t.page.evaluate(() => {
    const records: MutationRecord[] = [];
    const w = window as Window & { fdRecords?: MutationRecord[]; fdObserver?: MutationObserver };
    w.fdRecords = records;
    w.fdObserver = new MutationObserver(r => records.push(...r));
    w.fdObserver.observe(document, { childList: true, subtree: true });
  });
  const { ours, chrome } = await both('fd-a', ['hover'], async () => ({
    ...(await snapshot()),
    ...(await computed('fd-a')),
  }));
  assert.deepEqual(ours, chrome);
  assert.equal(ours.color, 'rgb(0, 40, 0)');
  assert.deepEqual({ count: ours.count, nth: ours.nth, body: ours.body }, before);
  // A later sheet's rule of equal specificity still wins over the forced copy.
  const b = await both('fd-b', ['hover'], () => computed('fd-b'));
  assert.deepEqual(b.ours, b.chrome);
  assert.equal(b.ours.color, 'rgb(60, 0, 0)');
  const records = await t.page.evaluate(() => {
    const w = window as Window & { fdRecords?: MutationRecord[]; fdObserver?: MutationObserver };
    w.fdObserver?.disconnect();
    return (w.fdRecords || []).filter(r => r.type === 'childList').length;
  });
  assert.equal(records, 0);
});

test('@layer order and !important match Chrome', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = `
      @layer base, top;
      @layer top { #fl { color: rgb(0, 0, 70) } }
      @layer base { #fl:hover { color: rgb(70, 0, 0); background-color: rgb(1, 1, 1) !important } }
      #fl:hover { outline-color: rgb(0, 70, 0) }
      @layer top { #fl { background-color: rgb(2, 2, 2) !important } }
      #fl:not(.z) { outline-color: rgb(0, 80, 0) }
    `;
    document.head.appendChild(s);
    const later = document.createElement('style');
    later.textContent = `@layer base { #fl { border-left-color: rgb(9, 9, 9) } }`;
    document.head.appendChild(later);
    const s2 = new CSSStyleSheet();
    s2.replaceSync('@layer base { #fl:hover { border-left-color: rgb(3, 3, 3) } }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s2];
    document.body.insertAdjacentHTML('beforeend', '<div id="fl">fl</div>');
  });
  const read = () =>
    t.page.evaluate(() => {
      const el = document.getElementById('fl');
      if (!el) throw new Error('#fl not found');
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor, s.outlineColor, s.borderLeftColor];
    });
  const { ours, chrome } = await both('fl', ['hover'], read);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, ['rgb(0, 0, 70)', 'rgb(1, 1, 1)', 'rgb(0, 80, 0)', 'rgb(3, 3, 3)']);
});

test('an anonymous @layer keeps its place among the layers', async () => {
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = `
      @layer early { #fy { color: rgb(1, 0, 0); outline-color: rgb(1, 0, 0); text-decoration-color: rgb(1, 0, 0) !important } }
      @layer {
        #fy:hover { color: rgb(2, 0, 0); background-color: rgb(2, 0, 0); outline-color: rgb(2, 0, 0) }
        #fy:hover { border-left-color: rgb(2, 0, 0) !important; border-right-color: rgb(2, 0, 0) !important }
        #fy:hover { border-bottom-color: rgb(2, 0, 0) !important; text-decoration-color: rgb(2, 0, 0) !important }
        #fy:not(.z) { outline-color: rgb(3, 0, 0) }
      }
      @layer late { #fy { background-color: rgb(4, 0, 0) } #fy { border-right-color: rgb(4, 0, 0); border-bottom-color: rgb(4, 0, 0) !important } }
      #fy { border-left-color: rgb(5, 0, 0); border-right-color: rgb(5, 0, 0) }
      @layer { #fy { border-top-color: rgb(6, 0, 0) } }
      @layer early { #fy:hover { border-top-color: rgb(7, 0, 0) } }
    `;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML('beforeend', '<div id="fy">fy</div>');
  });
  const read = () =>
    t.page.evaluate(() => {
      const el = document.getElementById('fy');
      if (!el) throw new Error('#fy not found');
      const s = getComputedStyle(el);
      return [
        s.color,
        s.backgroundColor,
        s.outlineColor,
        s.borderLeftColor,
        s.borderRightColor,
        s.borderTopColor,
        s.borderBottomColor,
        s.textDecorationColor,
      ];
    });
  const { ours, chrome } = await both('fy', ['hover'], read);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, [
    'rgb(2, 0, 0)',
    'rgb(4, 0, 0)',
    'rgb(3, 0, 0)',
    'rgb(2, 0, 0)',
    'rgb(2, 0, 0)',
    'rgb(6, 0, 0)',
    'rgb(2, 0, 0)',
    'rgb(1, 0, 0)',
  ]);
});

/** Adds `css` and `<div id>`, then reads colors of #id with :hover forced, through both sides. */
async function hoverColors(id: string, css: string) {
  await t.page.evaluate(
    (id, css) => {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML('beforeend', `<div id="${id}">${id}</div>`);
    },
    id,
    css
  );
  const read = () =>
    t.page.evaluate(id => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`#${id} not found`);
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor, s.outlineColor, s.borderLeftColor, s.borderRightColor, s.borderTopColor];
    }, id);
  return both(id, ['hover'], read);
}

test('an anonymous @layer nested in a named one keeps its place, !important included', async () => {
  const { ours, chrome } = await hoverColors(
    'fn',
    `
      @layer pre { #fn { border-right-color: rgb(9, 0, 0) !important } }
      @layer outer {
        @layer first { #fn { color: rgb(1, 0, 0); outline-color: rgb(1, 0, 0) !important } }
        @layer {
          #fn:hover { color: rgb(2, 0, 0); background-color: rgb(2, 0, 0) }
          #fn:hover { outline-color: rgb(2, 0, 0) !important; border-left-color: rgb(2, 0, 0) !important }
        }
        @layer second { #fn { background-color: rgb(3, 0, 0); border-left-color: rgb(3, 0, 0) !important } }
      }
      @layer outer2 {
        @layer { #fn:hover { border-right-color: rgb(2, 0, 0) !important; border-top-color: rgb(2, 0, 0) !important } }
        @layer z { #fn { border-top-color: rgb(3, 0, 0) !important } }
      }
    `
  );
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, [
    'rgb(2, 0, 0)',
    'rgb(3, 0, 0)',
    'rgb(1, 0, 0)',
    'rgb(2, 0, 0)',
    'rgb(9, 0, 0)',
    'rgb(2, 0, 0)',
  ]);
});

test('layers first named in a false @media or @supports are not ordered there', async () => {
  const { ours, chrome } = await hoverColors(
    'fc',
    `
      @media (max-width: 1px) { @layer cl { } }
      @supports (not (display: block)) { @layer cm { } }
      @media (min-width: 1px) { @layer cn { } }
      @layer { #fc:hover { color: rgb(2, 0, 0); background-color: rgb(2, 0, 0); outline-color: rgb(2, 0, 0) } }
      @layer cl { #fc { color: rgb(4, 0, 0) } }
      @layer cm { #fc { background-color: rgb(4, 0, 0) } }
      @layer cn { #fc { outline-color: rgb(4, 0, 0) } }
    `
  );
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours.slice(0, 3), ['rgb(4, 0, 0)', 'rgb(4, 0, 0)', 'rgb(2, 0, 0)']);
});

test('layers first named in @container are ordered there, whatever the container', async () => {
  const { ours, chrome } = await hoverColors(
    'fq',
    `
      @container (max-width: 1px) { @layer cq { } }
      @container (min-width: 1px) { @layer cr { } }
      @layer { #fq:hover { color: rgb(2, 0, 0); background-color: rgb(2, 0, 0) } }
      @layer cq { #fq { color: rgb(4, 0, 0) } }
      @layer cr { #fq { background-color: rgb(4, 0, 0) } }
    `
  );
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours.slice(0, 2), ['rgb(2, 0, 0)', 'rgb(2, 0, 0)']);
});

test('the layer order follows a @media condition changing while forced', async () => {
  await t.page.setViewport({ width: 800, height: 600 });
  await t.page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = `
      @media (max-width: 500px) { @layer vw { } }
      @layer { #fw:hover { color: rgb(2, 0, 0) } }
      @layer vw { #fw { color: rgb(4, 0, 0) } }
    `;
    document.head.appendChild(s);
    document.body.insertAdjacentHTML('beforeend', '<div id="fw">fw</div>');
  });
  const color = () =>
    t.page.evaluate(() => {
      const el = document.getElementById('fw');
      if (!el) throw new Error('#fw not found');
      return getComputedStyle(el).color;
    });
  // The probe rebuilds on the MediaQueryList change event, which fires on a later rendering
  // update: poll for the expected value (bounded) instead of a fixed delay, then read it.
  const settle = (expected: string) =>
    t.page
      .waitForFunction(
        (want: string) => {
          const el = document.getElementById('fw');
          return el !== null && getComputedStyle(el).color === want;
        },
        { timeout: 2000 },
        expected
      )
      .then(
        () => undefined,
        () => undefined
      );
  // Narrow, `vw` is named before the anonymous layer, which then wins; wide, after it.
  const measure = async () => {
    const wide = await color();
    await t.page.setViewport({ width: 400, height: 600 });
    await settle('rgb(2, 0, 0)');
    const narrow = await color();
    await t.page.setViewport({ width: 800, height: 600 });
    await settle('rgb(4, 0, 0)');
    return [wide, narrow, await color()];
  };
  try {
    const { ours, chrome } = await both('fw', ['hover'], measure);
    assert.deepEqual(ours, chrome);
    assert.deepEqual(ours, ['rgb(4, 0, 0)', 'rgb(2, 0, 0)', 'rgb(4, 0, 0)']);
  } finally {
    await t.page.setViewport({ width: 800, height: 600 });
  }
});

test("the page's adopted style sheets are kept, and reassigning them keeps the forced styles", async () => {
  const result = await withForced(t.ours, 'fo', ['hover'], async () => {
    await t.page.evaluate(() => {
      const extra = new CSSStyleSheet();
      extra.replaceSync('#fa-none { color: red }');
      document.adoptedStyleSheets = [extra];
    });
    return computed('fo');
  });
  assert.equal(result.background, 'rgb(0, 0, 5)');
  const count = await t.page.evaluate(() => document.adoptedStyleSheets.length);
  assert.equal(count, 1);
});
