import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';
import { comparable, nodeIdOf, openAxPage, outline } from '../../../../test-support/accessibility.ts';

let env: Env | undefined;
let t: TestPage;

/**
 * Elements of the cases the Accessibility pane shows, each with an id to find it on both sides.
 * Left out: what the page cannot see or Chrome gives in the browser's language (an input
 * button's default label).
 */
const FIXTURE = `
<div id=root><span id=sp>a</span>
<div id=hid aria-hidden=true><p id=hp>hidden</p></div>
<div id=dn style="display:none"><p id=dp>none</p></div>
<div id=vh style="visibility:hidden">vh</div>
<nav id=nv aria-label="Main nav"><ul id=ul><li id=li>one</li></ul></nav>
<div role=presentation id=pr>pres</div>
<button id=lb aria-labelledby="sp hp" title="tt">B</button>
<button id=db aria-describedby=h1>Go</button>
<input id=ph placeholder="Type">
<select id=se><option id=o1>A</option><option id=o2 selected>B</option></select>
<table id=tb><tr><th id=th1>H</th></tr><tr><td id=td1>c</td></tr></table>
<div id=tbx tabindex=0>focusable</div>
<div role=checkbox aria-checked=mixed id=cbx>cb</div>
<input type=checkbox id=nc checked>
<details id=de open><summary id=su>S</summary>D</details>
<h1 id=h1>One</h1>
<p id=pp>Para <b id=bb>bold</b></p>
<input type=range id=rg min=0 max=10 value=3>
<textarea id=ta>t</textarea>
<a id=nolink>no href</a>
<img id=noalt src=x.png><img id=emptyalt alt="" src=x.png>
<svg id=svg><title>Svg t</title></svg>
<div id=own aria-owns="ownee">owner</div><span id=ownee>ownee</span>
<div id=cy1 aria-owns=cy2>A</div><div id=cy2 aria-owns=cy1>B</div>
<div id=cy3 aria-owns=cy4>C</div><div id=cy4><span id=cy5 aria-owns=cy3>D</span></div>
</div>
<header id=bn>Site</header>
<article id=ar><header id=ah>art head</header><footer id=af>art foot</footer></article>
<footer id=ft>foot</footer>
<aside id=as>side</aside>
<section id=sc><header id=sh>H</header></section>
<form id=fm aria-label="F"><label id=wl>Wrapped <input id=wi type=text></label>
<label for=em id=el>Mail</label><input id=em type=email required readonly>
<input id=r1 type=radio name=g checked><input id=pw type=password>
<button id=dis disabled>Dis</button>
<input id=nm type=number value=4>
<input id=sr type=search aria-label="Find">
</form>
<ol id=ol><li id=l1>a<ul><li id=l2>b</li></ul></li></ol>
<div role=tablist id=tl><div role=tab id=tab aria-selected=true aria-controls=pn>Tab</div></div>
<div role=tabpanel id=pn>Panel</div>
<button id=ex aria-expanded=false aria-haspopup=menu>Menu</button>
<div contenteditable id=ce>edit</div>
<h3 id=h3 aria-level=5>lvl</h3>
<div role=heading id=rh>rh</div>
<div role=img aria-label="pic" id=ri></div>
<a href="/x" id=lk title="tip"><img src=x.png alt="logo" id=li2></a>
<section id=sn aria-label=Sec>S</section>
<span id=tt title="only title">tt</span>
<div role=button tabindex=0 id=rb>RB</div>
<progress id=pg value=3 max=10></progress>
<hr id=hr>
<dl id=dl><dt id=dt>T</dt><dd id=dd>D</dd></dl>
<blockquote id=bq>q</blockquote>
<fieldset id=fs><legend id=lg>Leg</legend><input id=fi></fieldset>
<figure id=fg><img src=x.png alt=f id=fim><figcaption id=fc>Cap</figcaption></figure>
<table id=t2><caption id=cap>Cap</caption><thead><tr><th id=c1>A</th></tr></thead><tbody><tr><th id=rh1 scope=row>R</th><td id=c2>v</td></tr></tbody></table>
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openAxPage(env, FIXTURE);
  },
  () => env?.close()
);

const ids = [...FIXTURE.matchAll(/ id=(\w+)/g)].map(m => m[1] ?? '');

describe('Accessibility.getPartialAXTree', () => {
  for (const id of ids)
    test(`#${id}: role, name and its sources, description, value, properties`, async () => {
      const [ours, chrome] = await Promise.all(
        [t.ours, t.chrome].map(async side =>
          side.send('Accessibility.getPartialAXTree', { nodeId: await nodeIdOf(side, id), fetchRelatives: false })
        )
      );
      assert.ok(ours && chrome);
      assert.deepEqual(ours.nodes.map(comparable), chrome.nodes.map(comparable));
    });

  test('fetchRelatives: the children, through ignored ones, and the ancestors', async () => {
    for (const id of [
      'nv',
      'ul',
      'tb',
      'th1',
      'h1',
      'pp',
      'own',
      'ownee',
      'cy1',
      'cy2',
      'cy3',
      'cy4',
      'cy5',
      'pr',
      'sp',
      'dp',
    ]) {
      const [ours, chrome] = await Promise.all(
        [t.ours, t.chrome].map(async side =>
          side.send('Accessibility.getPartialAXTree', { nodeId: await nodeIdOf(side, id), fetchRelatives: true })
        )
      );
      assert.ok(ours && chrome);
      assert.deepEqual(outline(ours.nodes), outline(chrome.nodes), `#${id}`);
    }
  });

  test('the root is the document, named after its title', async () => {
    const [ours, chrome] = await Promise.all(
      [t.ours, t.chrome].map(async side =>
        side.send('Accessibility.getPartialAXTree', { nodeId: await nodeIdOf(side, 'root'), fetchRelatives: true })
      )
    );
    assert.ok(ours && chrome);
    const root = (r: typeof ours) => r.nodes.find(n => n.role?.value === 'RootWebArea');
    const [a, b] = [root(ours), root(chrome)];
    assert.ok(a && b);
    // The URL and focus are each side's page's.
    const props = (n: Protocol.Accessibility.AXNode) =>
      (n.properties ?? []).filter(p => p.name !== 'focused' && p.name !== 'url');
    assert.deepEqual(comparable({ ...a, properties: props(a) }), comparable({ ...b, properties: props(b) }));
  });
});

test('without accessibility.js the commands fail', async () => {
  await assert.rejects(
    t.page.evaluate(async () => {
      const plain = window.DevtoolsAnywhere.createCdpSession();
      const { root } = (await plain.call('DOM.getDocument', {})) as { root: { nodeId: number } };
      await plain.call('Accessibility.getPartialAXTree', { nodeId: root.nodeId });
    }),
    /Not supported in the page/
  );
});

describe('the whole tree', () => {
  test('queryAXTree finds nodes by role and name in a subtree', async () => {
    const queries = [
      { role: 'button' },
      { accessibleName: 'One' },
      { role: 'textbox', accessibleName: 'Type' },
      { role: 'heading' },
      { role: 'none' },
      // Ignored nodes come with their own role and name: those aria-hidden hides; display:none,
      // visibility:hidden and role=presentation leave theirs out of the tree.
      { role: 'paragraph' },
      { accessibleName: 'hidden' },
      { accessibleName: 'none' },
      { accessibleName: 'vh' },
      { accessibleName: 'pres' },
    ];
    for (const query of queries) {
      const [ours, chrome] = await Promise.all(
        [t.ours, t.chrome].map(async side =>
          side.send('Accessibility.queryAXTree', { nodeId: await nodeIdOf(side, 'root'), ...query })
        )
      );
      assert.ok(ours && chrome);
      assert.deepEqual(ours.nodes.map(comparable), chrome.nodes.map(comparable), JSON.stringify(query));
    }
  });

  test('getAXNodeAndAncestors', async () => {
    for (const id of ['th1', 'ownee', 'bb']) {
      const [ours, chrome] = await Promise.all(
        [t.ours, t.chrome].map(async side =>
          side.send('Accessibility.getAXNodeAndAncestors', { nodeId: await nodeIdOf(side, id) })
        )
      );
      assert.ok(ours && chrome);
      assert.deepEqual(outline(ours.nodes), outline(chrome.nodes), `#${id}`);
    }
  });

  test('parentId and childIds agree, as in Chrome, in and out of a closed details', async () => {
    // Each node as its role, whether ignored and its links, by place in the list: ids differ.
    const links = (nodes: Protocol.Accessibility.AXNode[]) => {
      const at = (id: string | undefined) => (id === undefined ? undefined : nodes.findIndex(n => n.nodeId === id));
      return nodes.map(n => ({
        role: n.role?.value,
        ignored: n.ignored,
        parent: at(n.parentId),
        children: n.childIds?.map(at).filter(i => i !== -1),
      }));
    };
    // Added for this test only: a closed details changes how Chrome breaks the fixture's
    // aria-owns cycles.
    await t.page.evaluate(() =>
      document.body.insertAdjacentHTML(
        'beforeend',
        '<details id=dc><summary id=dcs>S</summary><p id=dcp>T<b id=dcb>U</b></p></details>'
      )
    );
    for (const id of ['dcp', 'dcb', 'dcs', 'su']) {
      const [ours, chrome] = await Promise.all(
        [t.ours, t.chrome].map(async side => {
          const nodeId = await nodeIdOf(side, id);
          const partial = await side.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: true });
          const ancestors = await side.send('Accessibility.getAXNodeAndAncestors', { nodeId });
          return { partial: partial.nodes, ancestors: ancestors.nodes };
        })
      );
      assert.ok(ours && chrome);
      for (const nodes of [ours.partial, ours.ancestors])
        for (const node of nodes) {
          const parent = nodes.find(n => n.nodeId === node.parentId);
          if (parent)
            assert.ok(parent.childIds?.includes(node.nodeId), `#${id}: ${node.nodeId} not among its parent's children`);
        }
      assert.deepEqual(links(ours.partial), links(chrome.partial), `#${id} getPartialAXTree`);
      assert.deepEqual(links(ours.ancestors), links(chrome.ancestors), `#${id} getAXNodeAndAncestors`);
    }
    await t.page.evaluate(() => document.getElementById('dc')?.remove());
  });

  test('getRootAXNode and getChildAXNodes walk down to a node', async () => {
    const walk = async (side: Side) => {
      const { node: root } = await side.send('Accessibility.getRootAXNode', {});
      const seen = [outline([root])];
      // Down the first child each time, from the document to the fixture's first text.
      let id = root.nodeId;
      for (let i = 0; i < 5; i++) {
        const { nodes } = await side.send('Accessibility.getChildAXNodes', { id });
        seen.push(outline(nodes));
        const next = nodes[0];
        if (!next) break;
        id = next.nodeId;
      }
      return seen;
    };
    const [ours, chrome] = await Promise.all([walk(t.ours), walk(t.chrome)]);
    assert.deepEqual(ours, chrome);
  });

  test('getFullAXTree: the nodes the page can see, breadth first', async () => {
    const [ours, chrome] = await Promise.all(
      [t.ours, t.chrome].map(side => side.send('Accessibility.getFullAXTree', { depth: 1 }))
    );
    assert.ok(ours && chrome);
    assert.deepEqual(outline(ours.nodes), outline(chrome.nodes));
  });
});

test('the vision deficiency mask is not in the accessibility tree', async () => {
  const count = async () => (await t.ours.send('Accessibility.getFullAXTree', {})).nodes.length;
  const plain = await count();
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  try {
    assert.equal(await count(), plain);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('DOM methods the page replaced do not change the tree', async () => {
  const full = async () => (await t.ours.send('Accessibility.getFullAXTree', {})).nodes.map(comparable);
  const top = (side: Side) => side.send('Accessibility.getFullAXTree', { depth: 1 });
  const before = await full();
  // Replaces the methods and getters the tree reads with ones that lie or throw, keeping the originals.
  await t.page.evaluate(() => {
    const saved: [object, string, PropertyDescriptor][] = [];
    const replace = (proto: object, name: string, desc: PropertyDescriptor) => {
      const original = Object.getOwnPropertyDescriptor(proto, name);
      if (original) saved.push([proto, name, original]);
      Object.defineProperty(proto, name, { ...desc, configurable: true });
    };
    const fail = () => {
      throw new Error('replaced by the page');
    };
    replace(Element.prototype, 'getAttribute', { value: () => 'button' });
    replace(Element.prototype, 'hasAttribute', { value: () => true });
    for (const name of [
      'querySelector',
      'querySelectorAll',
      'closest',
      'matches',
      'getBoundingClientRect',
      'getAttributeNames',
    ])
      replace(Element.prototype, name, { value: fail });
    for (const name of ['querySelector', 'querySelectorAll', 'getElementById'])
      replace(Document.prototype, name, { value: fail });
    replace(DocumentFragment.prototype, 'getElementById', { value: fail });
    replace(Node.prototype, 'getRootNode', { value: fail });
    replace(Node.prototype, 'textContent', { get: () => 'lie' });
    replace(HTMLElement.prototype, 'innerText', { get: fail });
    replace(Element.prototype, 'attributes', { get: fail });
    (window as unknown as { __restoreDom: () => void }).__restoreDom = () => {
      for (const [proto, name, desc] of saved) Object.defineProperty(proto, name, desc);
    };
  });
  try {
    assert.deepEqual(await full(), before);
    const [ours, chrome] = await Promise.all([top(t.ours), top(t.chrome)]);
    assert.deepEqual(outline(ours.nodes), outline(chrome.nodes));
  } finally {
    await t.page.evaluate(() => (window as unknown as { __restoreDom: () => void }).__restoreDom());
  }
});

/**
 * The nodes Chrome has under a control from its user-agent shadow tree, which the page cannot
 * see (ax-virtual.ts): each control's subtree walked down by getChildAXNodes, its nodes whole,
 * its ancestors and children by getPartialAXTree, and queryAXTree over the controls.
 */
describe('control internals', () => {
  /** A node's relatives, and its subtree in depth-first order through getChildAXNodes. */
  const subtree = async (side: Side, id: string) => {
    const nodeId = await nodeIdOf(side, id);
    const partial = await side.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: true });
    const out: unknown[] = [];
    const walk = async (node: Protocol.Accessibility.AXNode, depth: number) => {
      if (node.role?.value === 'InlineTextBox') return;
      out.push({ depth, node: comparable(node) });
      for (const child of (await side.send('Accessibility.getChildAXNodes', { id: node.nodeId })).nodes)
        if (child.parentId === node.nodeId) await walk(child, depth + 1);
    };
    const [self] = partial.nodes;
    assert.ok(self);
    await walk(self, 0);
    return { partial: outline(partial.nodes), subtree: out };
  };
  /** Compares the subtrees of `ids`, then the nodes of `roles` queryAXTree finds under #controls. */
  const compare = async (html: string, ids: string[], roles: string[]) => {
    assert.ok(env);
    const page = await openAxPage(env, `<div id=controls>${html}</div>`);
    try {
      for (const id of ids) {
        const [ours, chrome] = await Promise.all([subtree(page.ours, id), subtree(page.chrome, id)]);
        assert.deepEqual(ours, chrome, `#${id}`);
      }
      for (const role of roles) {
        const [ours, chrome] = await Promise.all(
          [page.ours, page.chrome].map(async side =>
            side.send('Accessibility.queryAXTree', { nodeId: await nodeIdOf(side, 'controls'), role })
          )
        );
        assert.ok(ours && chrome);
        assert.deepEqual(ours.nodes.map(comparable), chrome.nodes.map(comparable), `queryAXTree ${role}`);
      }
    } finally {
      await page.page.close();
    }
  };

  test('select: options in a drop-down popup, in a list box slot, in groups', () =>
    compare(
      `<select id=se1 aria-label=S1><option>A</option><option selected>B</option><option disabled>C</option><option hidden>H</option><option style="display:none">N</option></select>
<select id=se2 aria-label=S2><optgroup id=se2g label=G1><option>a1</option></optgroup><option>x</option><optgroup label=G2 disabled><option>b1</option></optgroup></select>
<select id=se3 size=3 aria-label=S3><option>A</option><option selected>B</option><optgroup label=G><option>c</option></optgroup><option hidden>H</option></select>
<select id=se4 multiple aria-label=S4><option selected>A</option><option selected>B</option><option disabled>C</option></select>
<select id=se5 aria-label=S5></select>
<select id=se6 aria-label=S6 disabled><option>A</option></select>
<select id=se7><option label=LL>text</option><option></option><option>  sp  ace </option></select>`,
      ['se1', 'se2', 'se2g', 'se3', 'se4', 'se5', 'se6', 'se7'],
      ['option', 'group', 'MenuListPopup', 'generic']
    ));

  // Left out: date and time fields, file and image inputs, whose nodes Chrome names in the
  // browser's language.
  test('text fields: placeholder, wrappers, inner editor and its text; other inputs; contenteditable', () =>
    compare(
      `<input id=tf1 aria-label=T value="  a  b "><input id=tf2 aria-label=E>
<input id=tf3 placeholder=PH><input id=tf4 placeholder=PH value=v><input id=tf5 placeholder="">
<input id=tf6 type=search value=q><input id=tf7 type=search placeholder=P>
<input id=tf8 type=password value=sec><input id=tf9 type=number value=4><input id=tf10 type=number placeholder=P value=3>
<input id=tf11 type=email value=a@b><input id=tf12 type=url><input id=tf13 type=tel value=1>
<input id=tf14 list=tfl placeholder=P><input id=tf15 type=search list=tfl><datalist id=tfl><option>z</option></datalist>
<input id=tf16 disabled value=dis><input id=tf17 readonly value=ro>
<textarea id=tf18>line1
line2</textarea><textarea id=tf19>a

b
</textarea><textarea id=tf20 placeholder=TP></textarea><textarea id=tf21 placeholder=P>x</textarea><textarea id=tf22 readonly>r</textarea>
<input id=tf23 type=button value=Btn><input id=tf24 type=reset value=R><input id=tf25 type=submit value=""><input id=tf26 type=button>
<input id=tf27 type=color value=#ff0000><input id=tf28 type=range value=3><input id=tf29 type=checkbox checked><input id=tf30 type=radio>
<div contenteditable id=tf31>edit <b id=tf31b>bold</b></div><div contenteditable id=tf32></div>
<div contenteditable id=tf33>line1<br>line2</div><div role=textbox contenteditable id=tf34>tb</div>
<div contenteditable=plaintext-only id=tf35>pt</div>`,
      Array.from({ length: 35 }, (_, i) => `tf${i + 1}`),
      ['generic', 'StaticText', 'LineBreak', 'textbox', 'combobox']
    ));

  test('svg: title and desc name and describe, never nodes; image or SvgRoot; the elements kept', () =>
    compare(
      `<div><svg id=sv1><title>T1</title><desc>D1</desc><rect width=10 height=10></rect></svg></div>
<div><svg id=sv2 role=img><title>T2</title></svg></div>
<div><svg id=sv3 aria-label=AL><title>T3</title><desc>D3</desc><circle r=4></circle></svg></div>
<div><svg id=sv4><g><title>GT</title><rect width=5 height=5></rect></g><text id=sv4t>Txt<title>TT</title></text><a id=sv4a href="#"><title>AT</title><text>link</text></a></svg></div>
<div><svg id=sv5><desc>OnlyD</desc><rect width=3 height=3></rect></svg></div>
<div><svg id=sv6><rect id=sv6r width=3 height=3><title>RT</title><desc>RD</desc></rect></svg></div>
<div><svg id=sv7><title><b>x</b>Mixed</title><circle r=2></circle></svg></div>
<div><svg id=sv8><title>Root</title><rect width=3 height=3><title>R</title></rect></svg></div>
<div><svg id=sv9><g><rect width=3 height=3></rect></g><g aria-label=GL><circle r=1></circle></g></svg></div>
<div><svg id=sv10><text>hello <tspan>world</tspan></text></svg></div>
<div><svg id=sv11><rect width=3 height=3 tabindex=0></rect><use href="#x"></use><foreignObject width=50 height=20><p>fo</p></foreignObject></svg></div>
<div><svg id=sv12 role=group><title>G</title><rect width=3 height=3><title>R</title></rect></svg></div>
<div><svg id=sv13><svg><title>inner</title><rect width=3 height=3></rect></svg></svg></div>
<div><svg id=sv14><title>  spaced   title </title></svg></div>
<div><svg id=sv15><title></title><desc>dd</desc></svg></div>
<div id=sv16><svg aria-hidden=true><title>H</title><text>x</text></svg></div>
<div><svg id=sv17><defs><rect id=sv17r width=3 height=3><title>in defs</title></rect></defs></svg></div>`,
      Array.from({ length: 17 }, (_, i) => `sv${i + 1}`).concat('sv4t', 'sv4a', 'sv6r'),
      ['image', 'SvgRoot', 'graphics-symbol', 'group', 'link', 'StaticText']
    ));
});
