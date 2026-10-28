// Edge cases of the DOM and CSS domains: template content, and commands sent to nodes they
// cannot act on.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { diffSubset, launch, openPage, VOLATILE } from '../../../test-support/conformance.ts';
import type { Env, EventName, EventParams, TestPage } from '../../../test-support/conformance.ts';

type DomNode = Protocol.DOM.Node;

// Node ids differ between implementations; compare everything else.
for (const key of ['nodeId', 'backendNodeId', 'parentId', 'frameId']) VOLATILE.add(key);

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<template id="tpl"><p class="in-template">hi</p><i></i></template><div id="text-host">text</div>'
    );
    const xml = document.createElementNS('urn:x-test', 'plain');
    xml.id = 'xml';
    document.body.appendChild(xml);
  });
  for (const side of [t.ours, t.chrome]) await side.send('DOM.enable');
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
const byId = (root: DomNode, id: string) => {
  const node = find(root, n => {
    const a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'id' && a[i + 1] === id) return true;
    return false;
  });
  assert.ok(node, `#${id} not found`);
  return node;
};

test('a template lists its content', async () => {
  const [{ root: o }, { root: c }] = await Promise.all([
    t.ours.send('DOM.getDocument', { depth: -1 }),
    t.chrome.send('DOM.getDocument', { depth: -1 }),
  ]);
  const [ours, chrome] = [byId(o, 'tpl'), byId(c, 'tpl')];
  assert.ok(ours.templateContent);
  assert.deepEqual(diffSubset(ours, chrome), []);

  // Nodes inside the content can be found and pushed.
  const { nodeId } = await t.ours.send('DOM.querySelector', {
    nodeId: ours.templateContent.nodeId,
    selector: '.in-template',
  });
  assert.notEqual(nodeId, 0);
});

test('querySelector on a text node fails', async () => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
  const text = byId(root, 'text-host').children?.[0];
  assert.ok(text);
  for (const method of ['DOM.querySelector', 'DOM.querySelectorAll'] as const) {
    await assert.rejects(t.ours.send(method, { nodeId: text.nodeId, selector: '*' }), /Not a container node/);
  }
  await assert.rejects(
    t.ours.send('DOM.getNodesForSubtreeByStyle', { nodeId: text.nodeId, computedStyles: [] }),
    /Not a container node/
  );
});

test('CSS.addRule rejects a rule that is not a style rule and leaves the sheet unchanged', async () => {
  await t.ours.send('CSS.enable');
  const { styleSheetId } = await t.ours.send('CSS.createStyleSheet', { frameId: 'x' });
  const before = await t.ours.send('CSS.getStyleSheetText', { styleSheetId });
  await assert.rejects(
    t.ours.send('CSS.addRule', {
      styleSheetId,
      ruleText: '@media (min-width: 1px) { a { color: red } }',
      location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    })
  );
  assert.equal((await t.ours.send('CSS.getStyleSheetText', { styleSheetId })).text, before.text);
});

test('CSS.setEffectivePropertyValueForNode on an element without a style fails cleanly', async () => {
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
  await assert.rejects(
    t.ours.send('CSS.setEffectivePropertyValueForNode', {
      nodeId: byId(root, 'xml').nodeId,
      propertyName: 'color',
      value: 'red',
    }),
    /no inline style/
  );
});

/** Waits until our side has emitted at least `count` events of `method`. */
async function oursEvents<E extends EventName>(page: TestPage, method: E, count = 1): Promise<EventParams<E>[]> {
  const start = Date.now();
  for (;;) {
    const events = await page.ours.events(method);
    if (events.length >= count) return events;
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${method}: ${events.length}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

test('a subtree moved elsewhere has its children sent again', async () => {
  const p = await openPage(env as Env, ['DOM.childNodeInserted', 'DOM.setChildNodes']);
  await p.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="from"><p id="moved"><b>x</b> y</p></div><div id="to"></div>'
    )
  );
  const { root } = await p.ours.send('DOM.getDocument', { depth: -1 });
  await p.ours.clear();
  await p.page.evaluate(() => document.getElementById('to')?.appendChild(document.getElementById('moved') as Node));
  const [inserted] = await oursEvents(p, 'DOM.childNodeInserted');
  assert.ok(inserted);
  assert.equal(inserted.node.children, undefined);
  await p.ours.clear();
  const { nodeId } = await p.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#moved b' });
  assert.notEqual(nodeId, 0);
  // The client receives the children of the moved node before the node id.
  const [sent] = await oursEvents(p, 'DOM.setChildNodes');
  assert.equal(sent?.parentId, inserted.node.nodeId);
  await p.page.close();
});

test('nodes inserted later in the same batch are not used as the previous node', async () => {
  const p = await openPage(env as Env, []);
  await p.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="batch"><i id="x"></i></div>'));
  const { root } = await p.ours.send('DOM.getDocument', { depth: -1 });
  const x = byId(root, 'x');
  await p.ours.clear();
  await p.page.evaluate(() => {
    const parent = document.getElementById('batch');
    if (!parent) throw new Error('#batch not found');
    const a = document.createElement('a');
    parent.append(a);
    parent.insertBefore(document.createElement('b'), a);
  });
  const events = await oursEvents(p, 'DOM.childNodeInserted', 2);
  assert.deepEqual(
    events.map(e => [e.node.localName, e.previousNodeId]),
    [
      ['a', x.nodeId],
      ['b', x.nodeId],
    ]
  );
  await p.page.close();
});

test('CSS.setStyleSheetText keeps the style sheet id', async () => {
  const p = await openPage(env as Env, ['CSS.styleSheetAdded']);
  await p.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="restyled"></div>'));
  await p.ours.send('CSS.enable');
  const { root } = await p.ours.send('DOM.getDocument', { depth: -1 });
  const { styleSheetId } = await p.ours.send('CSS.createStyleSheet', { frameId: 'x' });
  await p.ours.send('CSS.setStyleSheetText', { styleSheetId, text: '#restyled { color: red; }' });
  const { matchedCSSRules } = await p.ours.send('CSS.getMatchedStylesForNode', {
    nodeId: byId(root, 'restyled').nodeId,
  });
  assert.ok(matchedCSSRules?.some(m => m.rule.styleSheetId === styleSheetId));
  await p.page.close();
});

test('replacing the text of a <style> reports its new style sheet', async () => {
  const p = await openPage(env as Env, []);
  await p.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'replaced';
    style.textContent = 'a { color: red }';
    document.head.appendChild(style);
  });
  await p.ours.send('CSS.enable');
  await p.ours.clear();
  await p.page.evaluate(() => {
    const style = document.getElementById('replaced');
    if (style) style.textContent = 'a { color: blue }';
  });
  await oursEvents(p, 'CSS.styleSheetAdded');
  await oursEvents(p, 'CSS.styleSheetRemoved');
  await p.page.close();
});

test('DOM.setAttributesAsText keeps the case of SVG attributes', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML('beforeend', '<svg id="svg-attrs" viewBox="0 0 1 1"></svg>')
  );
  const attrs = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = byId(root, 'svg-attrs');
      await side.send('DOM.setAttributesAsText', { nodeId, name: 'viewBox', text: 'viewBox="0 0 2 2"' });
      return (await side.send('DOM.getAttributes', { nodeId })).attributes;
    })
  );
  assert.deepEqual(attrs[0], ['id', 'svg-attrs', 'viewBox', '0 0 2 2']);
  assert.deepEqual(attrs[0], attrs[1]);
});

test('DOM.copyTo does not copy a forced pseudo-class state', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML('beforeend', '<div id="copy-from"><span>a</span></div><div id="copy-to"></div>')
  );
  await t.ours.send('CSS.enable');
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1 });
  const from = byId(root, 'copy-from').nodeId;
  await t.ours.send('CSS.forcePseudoState', { nodeId: from, forcedPseudoClasses: ['hover'] });
  await t.ours.send('DOM.copyTo', { nodeId: from, targetNodeId: byId(root, 'copy-to').nodeId });
  await t.ours.send('CSS.forcePseudoState', { nodeId: from, forcedPseudoClasses: [] });
  const marked = await t.page.evaluate(() => document.querySelectorAll('[data-devtools-anywhere-force]').length);
  assert.equal(marked, 0);
});

test('DOM.performSearch: Chrome order, shadow trees, and errors of getSearchResults', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<section id="search-host">section text</section>');
    const host = document.getElementById('search-host');
    if (host) host.attachShadow({ mode: 'open' }).innerHTML = '<b>section in shadow</b>';
  });
  const names = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      await side.send('DOM.getDocument', { depth: -1 });
      const { searchId, resultCount } = await side.send('DOM.performSearch', { query: 'section' });
      const { nodeIds } = await side.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount });
      return Promise.all(nodeIds.map(async nodeId => (await side.send('DOM.describeNode', { nodeId })).node.nodeName));
    })
  );
  // Text matches come first, the one in the shadow tree right after its host.
  assert.deepEqual(names[0], names[1]);
  assert.ok(names[0]?.includes('#text'));

  const { searchId, resultCount } = await t.ours.send('DOM.performSearch', { query: 'section' });
  await assert.rejects(
    t.ours.send('DOM.getSearchResults', { searchId: 'unknown', fromIndex: 0, toIndex: 1 }),
    /No search session with given id found/
  );
  await assert.rejects(
    t.ours.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount + 1 }),
    /Invalid search result range/
  );
});

test('DOM.getOuterHTML of the document includes the doctype', async () => {
  const [ours, chrome] = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      const { root } = await side.send('DOM.getDocument', { depth: 0 });
      return (await side.send('DOM.getOuterHTML', { nodeId: root.nodeId })).outerHTML;
    })
  );
  assert.match(ours ?? '', /^<!DOCTYPE html>/);
  assert.equal(ours?.slice(0, 30), chrome?.slice(0, 30));
});

test('CSS.setStyleTexts keeps disabled and invalid declarations', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML('beforeend', '<div id="styled-o"></div><div id="styled-c"></div>')
  );
  const [ours, chrome] = await Promise.all(
    (
      [
        [t.ours, 'styled-o'],
        [t.chrome, 'styled-c'],
      ] as const
    ).map(async ([side, id]) => {
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId: byId(root, id).nodeId });
      assert.ok(inlineStyle?.styleSheetId && inlineStyle.range);
      const { styles } = await side.send('CSS.setStyleTexts', {
        edits: [
          {
            styleSheetId: inlineStyle.styleSheetId,
            range: inlineStyle.range,
            // The Styles pane comments a property out when it is unchecked.
            text: 'color: rgb(1, 2, 3); /* width: 1px; */ colr: red;',
          },
        ],
      });
      return styles[0]?.cssProperties
        .filter(p => p.text)
        .map(({ name, value, disabled, parsedOk }) => ({ name, value, disabled, parsedOk }));
    })
  );
  assert.deepEqual(ours, chrome);
  assert.deepEqual(
    ours?.map(p => [p.name, p.disabled, p.parsedOk]),
    [
      ['color', false, undefined],
      ['width', true, undefined],
      ['colr', false, false],
    ]
  );
});

test('Overlay.highlightNode follows its element when the page scrolls', async () => {
  const boxes = () =>
    t.page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-devtools-anywhere="overlay"] > div'), d => {
        const r = d.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      }).slice(0, 4)
    );
  const rect = (q: number[]) => {
    const [left = 0, top = 0, , , right = 0, bottom = 0] = q;
    return [left, top, right - left, bottom - top];
  };
  await t.page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.id = 'scroll-spacer';
    spacer.style.height = '3000px';
    document.body.append(spacer);
  });
  const { root } = await t.ours.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.box' });
  await t.ours.send('Overlay.highlightNode', { nodeId, highlightConfig: {} });
  const before = await boxes();
  // Scroll, then wait for the frame that redraws.
  await t.page.evaluate(
    () =>
      new Promise(r => {
        scrollTo(0, 100);
        requestAnimationFrame(() => requestAnimationFrame(r));
      })
  );
  const { model } = await t.ours.send('DOM.getBoxModel', { nodeId });
  const moved = await boxes();
  assert.notDeepEqual(moved, before);
  assert.deepEqual(moved, [model.margin, model.border, model.padding, model.content].map(rect));
  await t.ours.send('Overlay.hideHighlight');
  await t.page.evaluate(() => {
    scrollTo(0, 0);
    document.getElementById('scroll-spacer')?.remove();
  });
});

test('getDocument drops search results', async () => {
  for (const side of [t.ours, t.chrome]) {
    const { searchId } = await side.send('DOM.performSearch', { query: 'plain' });
    await side.send('DOM.getDocument', {});
    await assert.rejects(side.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 }));
  }
});

test('disable takes the attachShadow wrapper off', async () => {
  // The wrapper pushing late shadow roots is on while the client follows the tree.
  await t.ours.send('DOM.getDocument', {});
  await t.page.evaluate(() => Reflect.set(window, '__attachShadow', Element.prototype.attachShadow));
  await t.ours.send('DOM.disable');
  const restored = await t.page.evaluate(
    () => Element.prototype.attachShadow !== Reflect.get(window, '__attachShadow')
  );
  assert.ok(restored);
});

test('DOM.setAttributesAsText keeps the place of an attribute set again', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="reorder-ours" class="a" data-b="1"></div><div id="reorder-chrome" class="a" data-b="1"></div>'
    )
  );
  const html = await Promise.all(
    (
      [
        [t.ours, 'reorder-ours'],
        [t.chrome, 'reorder-chrome'],
      ] as const
    ).map(async ([side, id]) => {
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = byId(root, id);
      await side.send('DOM.setAttributesAsText', { nodeId, name: 'class', text: 'class="b"' });
      return t.page.evaluate(id => document.getElementById(id)?.outerHTML.replace(id, ''), id);
    })
  );
  assert.equal(html[0], '<div id="" class="b" data-b="1"></div>');
  assert.equal(html[0], html[1]);
});

test('DOM.getContentQuads of a text node', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML('beforeend', '<p id="quads-text" style="width: 40px">some words to wrap</p>')
  );
  const quads = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const text = byId(root, 'quads-text').children?.[0];
      assert.ok(text);
      return (await side.send('DOM.getContentQuads', { nodeId: text.nodeId })).quads;
    })
  );
  const [ours, chrome] = quads;
  assert.ok(ours && ours.length > 1);
  assert.deepEqual(ours, chrome);
});

test('CSS.getBackgroundColors blends translucent backgrounds of the ancestors and shadow hosts, none for a pseudo-element', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<style>#bg-pseudo::before { content: "x"; background: rgba(0, 0, 255, 0.5) }</style>
      <div style="background: rgb(200, 0, 0)">
        <div style="background: rgba(0, 200, 0, 0.5)"><span id="bg-plain">a</span><span id="bg-pseudo">b</span></div>
        <div id="bg-host" style="background: rgba(0, 0, 200, 0.5)"></div>
      </div>`
    );
    // A transparent child of a shadow root: the host and its ancestors are behind it.
    document.getElementById('bg-host')?.attachShadow({ mode: 'open' }).append(document.createElement('span'));
    document.querySelector('#bg-host')?.shadowRoot?.firstElementChild?.append('c');
  });
  // Chrome looks at what is painted under the element: it has to be on screen and painted.
  await t.page.evaluate(async () => {
    window.scrollTo(0, 0);
    for (let i = 0; i < 2; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const colors = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
      const result: (string[] | undefined)[] = [];
      const colorsOf = async (nodeId: number) =>
        (await side.send('CSS.getBackgroundColors', { nodeId })).backgroundColors;
      result.push(await colorsOf(byId(root, 'bg-plain').nodeId));
      const inShadow = byId(root, 'bg-host').shadowRoots?.[0]?.children?.[0];
      assert.ok(inShadow);
      result.push(await colorsOf(inShadow.nodeId));
      const before = byId(root, 'bg-pseudo').pseudoElements?.[0];
      assert.ok(before);
      result.push(await colorsOf(before.nodeId));
      return result;
    })
  );
  assert.deepEqual(colors[0], colors[1]);
});

test('CSS.getBackgroundColors reports gradient stops blended over what is behind, none for images', async () => {
  await t.page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div id="bgg-a" style="background-image: linear-gradient(red, blue)">a</div>
      <div id="bgg-b" style="background-image: linear-gradient(rgba(255, 0, 0, 0.5), blue)">b</div>
      <div style="background: linear-gradient(green, yellow)"><b id="bgg-c">c</b></div>
      <div style="background: rgba(0, 0, 0, 0.5)"><i id="bgg-d">d</i></div>
      <div style="background: rgba(0, 0, 0, 0.3)"><i id="bgg-e">e</i></div>
      <div id="bgg-f" style="background: url(data:image/png;base64,AAAA) red">f</div>`
    );
  });
  await t.page.evaluate(async () => {
    window.scrollTo(0, 0);
    for (let i = 0; i < 2; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const colors = await Promise.all(
    [t.ours, t.chrome].map(async side => {
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1, pierce: true });
      const result: (string[] | undefined)[] = [];
      for (const id of ['bgg-a', 'bgg-b', 'bgg-c', 'bgg-d', 'bgg-e', 'bgg-f'])
        result.push((await side.send('CSS.getBackgroundColors', { nodeId: byId(root, id).nodeId })).backgroundColors);
      return result;
    })
  );
  assert.deepEqual(colors[0], colors[1]);
});
