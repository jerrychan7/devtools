import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

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
<img id=noalt src=x.png>
<img id=emptyalt alt="" src=x.png>
<svg id=svg><title>Svg t</title></svg>
<div id=own aria-owns="ownee">owner</div><span id=ownee>ownee</span>
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

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.evaluate(
    (html, base) => {
      document.title = 'AX';
      document.body.innerHTML = html;
      // The fixture's own focus would differ between the sides' runs.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.__session = window.DevtoolsAnywhere.createCdpSession({
        loadAccessibility: () => import(base + '/packages/devtools-anywhere/dist/accessibility.js'),
      });
    },
    FIXTURE,
    env.baseUrl
  );
});
after(() => env?.close());

/** The DOM node id of `#id` on one side. */
async function nodeIdOf(side: Side, id: string) {
  const { root } = await side.send('DOM.getDocument', { depth: 0 });
  return (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` })).nodeId;
}

/** Ids and links between nodes differ between the sides; Chrome's internal role numbers are its own. */
function comparable(node: Protocol.Accessibility.AXNode) {
  return JSON.parse(
    JSON.stringify(node, (key, value: unknown) =>
      ['nodeId', 'parentId', 'childIds', 'backendDOMNodeId', 'chromeRole', 'frameId'].includes(key) ? undefined : value
    )
  ) as unknown;
}

/** The node and its relatives as roles and names: what the page cannot see (inline text boxes) left out. */
function outline(nodes: Protocol.Accessibility.AXNode[]) {
  return nodes
    .filter(n => n.role?.value !== 'InlineTextBox')
    .map(n => `${String(n.role?.value)}${n.name ? `:${String(n.name.value)}` : ''}`);
}

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
    for (const id of ['nv', 'ul', 'tb', 'th1', 'h1', 'pp', 'own', 'ownee', 'pr', 'sp', 'dp']) {
      const [ours, chrome] = await Promise.all(
        [t.ours, t.chrome].map(async side =>
          side.send('Accessibility.getPartialAXTree', { nodeId: await nodeIdOf(side, id), fetchRelatives: true })
        )
      );
      assert.ok(ours && chrome);
      // Chrome's list markers have no DOM node.
      const nodes = (r: typeof ours) => outline(r.nodes).filter(s => !s.startsWith('ListMarker'));
      assert.deepEqual(nodes(ours), nodes(chrome), `#${id}`);
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
