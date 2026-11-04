// The order of child frames: Chrome lists them in the order it made them, not in tree order. An
// `<iframe>` gets its frame as it is inserted, an `<object>` or `<embed>` later; a moved iframe is
// a new frame, listed last; navigating keeps a frame's place. Against Chrome's.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

const CHILD = '/packages/devtools-anywhere/test-support/frame-child.html';

let env: Env | undefined;
let t: TestPage;

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  for (const side of [t.ours, t.chrome]) await side.send('Page.enable');
});
after(() => env?.close());

/** Names of a frame tree, nested like it: [name, ...children]. */
type Names = [string, ...Names[]];
const namesOf = (tree: Protocol.Page.FrameTree | Protocol.Page.FrameResourceTree): Names => [
  tree.frame.name ?? 'top',
  ...(tree.childFrames ?? []).map(namesOf),
];
const frameTree = async (side: Side) => namesOf((await side.send('Page.getFrameTree')).frameTree);

/**
 * Runs `script`, in which `add(tag, name, where)` makes a frame owner loading the child page and
 * puts it in with `where(element)`; resolves once all loaded. Then compares both frame trees.
 */
async function run(script: string): Promise<Names> {
  await t.page.evaluate(`new Promise(resolve => {
    let loading = 0;
    const add = (tag, name, where = e => document.body.append(e), doc = document) => {
      const e = doc.createElement(tag);
      e.name = name;
      if (tag === 'object') e.data = '${CHILD}';
      else e.src = '${CHILD}';
      loading++;
      e.onload = () => --loading || setTimeout(resolve, 50);
      where(e);
    };
    ${script}
  })`);
  const [ours, chrome] = await Promise.all([frameTree(t.ours), frameTree(t.chrome)]);
  assert.deepEqual(ours, chrome);
  return ours;
}

test('a frame inserted before others comes after them', async () => {
  await run(`add('iframe', 'a');`);
  const ours = await run(`add('iframe', 'b', e => document.body.prepend(e));`);
  assert.deepEqual(ours, ['top', ['a'], ['b']]);
});

test('iframes, <object> and <embed> inserted in one task', async () => {
  const ours = await run(`
    add('object', 'o', e => document.body.prepend(e));
    add('iframe', 'i', e => document.body.prepend(e));
    add('embed', 'e', e => document.body.prepend(e));
    add('iframe', 'j', e => document.body.prepend(e));
  `);
  assert.deepEqual(ours, ['top', ['a'], ['b'], ['i'], ['o'], ['j'], ['e']]);
});

test('a moved iframe is listed last; a navigated one keeps its place', async () => {
  await t.page.evaluate(
    src =>
      new Promise(resolve => {
        const a = document.querySelector<HTMLIFrameElement>('iframe[name=a]');
        const b = document.querySelector<HTMLIFrameElement>('iframe[name=b]');
        if (!a || !b) throw new Error('no iframes');
        let loading = 2;
        a.onload = b.onload = () => --loading || resolve(null);
        document.body.prepend(a);
        b.src = src + '?again';
      }),
    CHILD
  );
  const [ours, chrome] = await Promise.all([frameTree(t.ours), frameTree(t.chrome)]);
  assert.deepEqual(ours, chrome);
  assert.deepEqual(ours, ['top', ['b'], ['i'], ['o'], ['j'], ['e'], ['a']]);
});

test('frames inserted in a child frame, and Page.getResourceTree', async () => {
  const ours = await run(`
    const doc = document.querySelector('iframe[name=b]').contentDocument;
    add('iframe', 'b1', e => doc.body.append(e), doc);
    add('iframe', 'b0', e => doc.body.prepend(e), doc);
  `);
  assert.deepEqual(ours[1], ['b', ['b1'], ['b0']]);
  const [mine, chrome] = await Promise.all(
    [t.ours, t.chrome].map(async side => namesOf((await side.send('Page.getResourceTree')).frameTree))
  );
  assert.deepEqual(mine, chrome);
});
