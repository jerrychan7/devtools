import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    await t.page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div id=g style="display:grid;grid-template-columns:50px 1fr;grid-template-rows:20px 30px;gap:10px 6px;width:300px"><i>a</i><i>b</i><i>c</i></div>
      <div id=f style="display:flex;gap:5px"><b style="margin:2px">x</b><b>y</b></div>
      <div id=c style="container-type:inline-size;width:100px;height:10px"></div>
      <div id=s style="overflow:scroll;scroll-snap-type:x mandatory;scroll-padding:4px;height:50px;width:100px">
        <div style="width:300px;height:10px;scroll-snap-align:start;scroll-margin:3px"></div></div>
      <div id=iso style="width:40px;height:40px"></div>
      <iframe id=fr srcdoc="hi" style="width:120px;height:60px;border:2px solid;padding:3px"></iframe>`
      );
    });
    await t.chrome.send('DOM.enable');
    await t.chrome.send('Overlay.enable');
    await t.ours.send('Overlay.enable');
  },
  () => env?.close()
);

const nodeId = async (side: Side, selector: string) => {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  return (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};

/** The error a command fails with, or null. */
async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^.*?\): /, '').replace(/^Error: /, '') : String(e);
  }
}

/** Shapes the overlay tools drew, by kind: [x, y, width, height] for a rect, [x1, y1, x2, y2] for a line. */
const shapes = (kind: string) =>
  t.page.evaluate(
    k =>
      Array.from(document.querySelectorAll(`[data-devtools-anywhere="overlay-tools"] [data-kind="${k}"]`), e =>
        ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2']
          .filter(a => e.hasAttribute(a))
          .map(a => Number(e.getAttribute(a)))
      ),
    kind
  );

/** Waits for the next frames, when the tools draw. */
const frames = () => t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

const quadRect = (q: number[]) => {
  const [left = 0, top = 0, , , right = 0, bottom = 0] = q;
  return [left, top, right - left, bottom - top];
};

test('errors match Chrome', async () => {
  const red = { r: 255, g: 0, b: 0 };
  const cases: [string, (side: Side) => Promise<unknown>][] = [
    [
      'grid unknown node',
      s =>
        s.send('Overlay.setShowGridOverlays', {
          gridNodeHighlightConfigs: [{ nodeId: 99999, gridHighlightConfig: {} }],
        }),
    ],
    [
      'flex unknown node',
      s =>
        s.send('Overlay.setShowFlexOverlays', {
          flexNodeHighlightConfigs: [{ nodeId: 99999, flexContainerHighlightConfig: {} }],
        }),
    ],
    [
      'container unknown node',
      s =>
        s.send('Overlay.setShowContainerQueryOverlays', {
          containerQueryHighlightConfigs: [{ nodeId: 99999, containerQueryContainerHighlightConfig: {} }],
        }),
    ],
    [
      'snap unknown node',
      s =>
        s.send('Overlay.setShowScrollSnapOverlays', {
          scrollSnapHighlightConfigs: [{ nodeId: 99999, scrollSnapContainerHighlightConfig: {} }],
        }),
    ],
    [
      'isolated unknown node',
      s =>
        s.send('Overlay.setShowIsolatedElements', {
          isolatedElementHighlightConfigs: [{ nodeId: 99999, isolationModeHighlightConfig: {} }],
        }),
    ],
    [
      'hinge negative',
      s => s.send('Overlay.setShowHinge', { hingeConfig: { rect: { x: -1, y: 0, width: 5, height: 5 } } }),
    ],
    [
      'hinge empty',
      s => s.send('Overlay.setShowHinge', { hingeConfig: { rect: { x: 1, y: 0, width: 0, height: 5 } } }),
    ],
    ['hinge off', s => s.send('Overlay.setShowHinge', {})],
    ['frame unknown', s => s.send('Overlay.highlightFrame', { frameId: 'nope', contentColor: red })],
    ...(
      [
        ['cutout negative', { rect: { x: -1, y: 0, width: 9, height: 9 }, shape: 'pill' }],
        ['cutout negative radius', { rect: { x: 1, y: 0, width: 9, height: 9 }, shape: 'pill', borderRadius: -1 }],
        ['cutout shape', { rect: { x: 1, y: 0, width: 9, height: 9 }, shape: 'blob' }],
        ['cutout pill', { rect: { x: 1, y: 0, width: 9, height: 9 }, shape: 'pill' }],
        ['cutout notch', { rect: { x: 1, y: 0, width: 9, height: 9 }, shape: 'notch', upperRadius: 2 }],
        ['cutout circle', { rect: { x: 1, y: 0, width: 9, height: 9 }, shape: 'circle', cx: 2 }],
        ['cutout rectangle', { rect: { x: 1, y: 0, width: 9, height: 9 }, shape: 'rectangle' }],
      ] as const
    ).map(([name, config]): [string, (side: Side) => Promise<unknown>] => [
      name,
      // An unknown shape is what is checked, which the types do not allow.
      s => s.send('Overlay.setShowDisplayCutout', JSON.parse(JSON.stringify({ displayCutoutConfig: config }))),
    ]),
    ['cutout off', s => s.send('Overlay.setShowDisplayCutout', {})],
  ];
  for (const [name, run] of cases) {
    assert.equal(await failure(() => run(t.ours)), await failure(() => run(t.chrome)), name);
  }
});

test('a node that is no grid, or no element, is left out as in Chrome', async () => {
  for (const side of [t.chrome, t.ours]) {
    // The text in the first item of #g, known once the whole tree is.
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    const find = (n: Protocol.DOM.Node): Protocol.DOM.Node | undefined =>
      n.nodeValue === 'a' ? n : (n.children ?? []).map(find).find(Boolean);
    const text = find(root)?.nodeId ?? 0;
    const { nodeId: body } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'body' });
    for (const id of [body, text])
      await side.send('Overlay.setShowGridOverlays', {
        gridNodeHighlightConfigs: [{ nodeId: id, gridHighlightConfig: {} }],
      });
  }
  await frames();
  assert.deepEqual(await shapes('column'), []);
});

test('grid lines and gaps are where Chrome draws them', async () => {
  const gridHighlightConfig = {
    columnLineColor: { r: 1, g: 2, b: 3 },
    rowLineColor: { r: 1, g: 2, b: 3 },
    columnGapColor: { r: 0, g: 0, b: 255, a: 0.2 },
    rowGapColor: { r: 0, g: 0, b: 255, a: 0.2 },
    gridBorderColor: { r: 9, g: 9, b: 9 },
  };
  const ours = await nodeId(t.ours, '#g');
  await t.ours.send('Overlay.setShowGridOverlays', {
    gridNodeHighlightConfigs: [{ nodeId: ours, gridHighlightConfig }],
  });
  const { highlights } = await t.chrome.send('Overlay.getGridHighlightObjectsForTest', {
    nodeIds: [await nodeId(t.chrome, '#g')],
  });
  const grid: unknown = Reflect.get(highlights, 'gridHighlights');
  const first: unknown = Array.isArray(grid) ? grid[0] : undefined;
  /** The distinct coordinates of a path's points on an axis (0 for x, 1 for y). */
  const coords = (key: string, axis: number) => {
    const path: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, key) : undefined;
    const numbers = Array.isArray(path) ? path.filter(v => typeof v === 'number') : [];
    return [...new Set(numbers.filter((_, i) => i % 2 === axis))].sort((a, b) => a - b);
  };
  await frames();
  const ourColumns = [...new Set((await shapes('column')).map(([x1]) => x1))].sort((a, b) => (a ?? 0) - (b ?? 0));
  const ourRows = [...new Set((await shapes('row')).map(([, y1]) => y1))].sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(ourColumns, coords('columns', 0));
  assert.deepEqual(ourRows, coords('rows', 1));
  assert.equal((await shapes('column-gap')).length, 1);
  assert.equal((await shapes('row-gap')).length, 1);
  await t.ours.send('Overlay.setShowGridOverlays', { gridNodeHighlightConfigs: [] });
  await frames();
  assert.deepEqual(await shapes('column'), []);
});

test('flex, container query and scroll snap overlays follow the box models', async () => {
  const border = { color: { r: 1, g: 2, b: 3 } };
  const id = (s: string) => nodeId(t.ours, s);
  await t.ours.send('Overlay.setShowFlexOverlays', {
    flexNodeHighlightConfigs: [
      { nodeId: await id('#f'), flexContainerHighlightConfig: { containerBorder: border, itemSeparator: border } },
    ],
  });
  await t.ours.send('Overlay.setShowContainerQueryOverlays', {
    containerQueryHighlightConfigs: [
      { nodeId: await id('#c'), containerQueryContainerHighlightConfig: { containerBorder: border } },
    ],
  });
  await t.ours.send('Overlay.setShowScrollSnapOverlays', {
    scrollSnapHighlightConfigs: [
      {
        nodeId: await id('#s'),
        scrollSnapContainerHighlightConfig: { snapportBorder: border, snapAreaBorder: border },
      },
    ],
  });
  await frames();
  const model = async (s: string) => (await t.ours.send('DOM.getBoxModel', { nodeId: await id(s) })).model;
  assert.deepEqual(await shapes('flex-container'), [quadRect((await model('#f')).content)]);
  assert.deepEqual(await shapes('flex-item'), [
    quadRect((await model('#f b')).margin),
    quadRect((await model('#f b + b')).margin),
  ]);
  assert.deepEqual(await shapes('container'), [quadRect((await model('#c')).border)]);
  const [x = 0, y = 0, w = 0, h = 0] = quadRect((await model('#s')).padding);
  assert.deepEqual(await shapes('snapport'), [[x + 4, y + 4, w - 8, h - 8]]);
  assert.deepEqual(await shapes('snap-area'), [quadRect((await model('#s > div')).border)]);
  for (const method of [
    'Overlay.setShowFlexOverlays',
    'Overlay.setShowContainerQueryOverlays',
    'Overlay.setShowScrollSnapOverlays',
  ] as const) {
    const key = {
      'Overlay.setShowFlexOverlays': 'flexNodeHighlightConfigs',
      'Overlay.setShowContainerQueryOverlays': 'containerQueryHighlightConfigs',
      'Overlay.setShowScrollSnapOverlays': 'scrollSnapHighlightConfigs',
    }[method];
    await t.ours.send(method, JSON.parse(`{"${key}":[]}`));
  }
});

test('the hinge and the display cutout are drawn where given', async () => {
  const gray = { r: 38, g: 38, b: 38 };
  await t.ours.send('Overlay.setShowHinge', {
    hingeConfig: { rect: { x: 100, y: 0, width: 20, height: 300 }, contentColor: gray },
  });
  await t.ours.send('Overlay.setShowDisplayCutout', {
    displayCutoutConfig: { rect: { x: 10, y: 0, width: 50, height: 20 }, shape: 'rectangle' },
  });
  await frames();
  assert.deepEqual(await shapes('hinge'), [[100, 0, 20, 300]]);
  assert.deepEqual(await shapes('cutout'), [[10, 0, 50, 20]]);
  await t.ours.send('Overlay.setShowHinge', {});
  await t.ours.send('Overlay.setShowDisplayCutout', {});
  await frames();
  assert.deepEqual(await shapes('hinge'), []);
  assert.equal(await t.page.evaluate(() => document.querySelector('[data-devtools-anywhere="overlay-tools"]')), null);
});

test('an isolated element is masked and resized by its handles', async () => {
  await t.ours.send('Overlay.setShowIsolatedElements', {
    isolatedElementHighlightConfigs: [
      {
        nodeId: await nodeId(t.ours, '#iso'),
        isolationModeHighlightConfig: { maskColor: { r: 0, g: 0, b: 0, a: 0.3 }, resizerColor: { r: 9, g: 9, b: 9 } },
      },
    ],
  });
  await frames();
  assert.equal((await shapes('mask')).length, 4);
  const box = await t.page.evaluate(() => document.querySelector('#iso')?.getBoundingClientRect().toJSON());
  const right = (box?.right ?? 0) + 8;
  const middle = (box?.top ?? 0) + 20;
  await t.page.mouse.move(right, middle);
  await t.page.mouse.down();
  await t.page.mouse.move(right + 30, middle, { steps: 3 });
  await t.page.mouse.up();
  assert.equal(await t.page.evaluate(() => document.querySelector<HTMLElement>('#iso')?.style.width), '70px');
  await t.ours.send('Overlay.setShowIsolatedElements', { isolatedElementHighlightConfigs: [] });
});

/** Boxes drawn by highlightNode and highlightFrame. */
const highlightBoxes = () =>
  t.page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-devtools-anywhere="overlay"] > div'), d => {
      const r = d.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height];
    })
  );

test('highlightFrame highlights the content box of the frame owner, the top frame nothing', async () => {
  const { frameTree } = await t.ours.send('Page.getFrameTree');
  const child = frameTree.childFrames?.find(f => f.frame.url === 'about:srcdoc')?.frame.id ?? '';
  await t.ours.send('Overlay.highlightFrame', { frameId: frameTree.frame.id, contentColor: { r: 1, g: 2, b: 3 } });
  assert.deepEqual(await highlightBoxes(), []);
  await t.ours.send('Overlay.highlightFrame', {
    frameId: child,
    contentColor: { r: 1, g: 2, b: 3, a: 0.5 },
    contentOutlineColor: { r: 255, g: 0, b: 0 },
  });
  const { model } = await t.ours.send('DOM.getBoxModel', { nodeId: await nodeId(t.ours, '#fr') });
  const boxes = await highlightBoxes();
  assert.deepEqual(boxes[3], quadRect(model.content));
  // The outline of the content box.
  assert.deepEqual(boxes[4], quadRect(model.content));
  const fills = await t.page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-devtools-anywhere="overlay"] > div'),
      d => d.style.backgroundColor
    )
  );
  assert.deepEqual(fills.slice(0, 4), [
    'rgba(0, 0, 0, 0)',
    'rgba(0, 0, 0, 0)',
    'rgba(0, 0, 0, 0)',
    'rgba(1, 2, 3, 0.5)',
  ]);
  await t.ours.send('Overlay.hideHighlight');
});

test('disable removes the overlays', async () => {
  await t.ours.send('Overlay.setShowHinge', {
    hingeConfig: { rect: { x: 1, y: 1, width: 2, height: 2 }, contentColor: { r: 0, g: 0, b: 0 } },
  });
  await frames();
  assert.equal((await shapes('hinge')).length, 1);
  await t.ours.send('Overlay.disable');
  assert.equal(await t.page.evaluate(() => document.querySelector('[data-devtools-anywhere="overlay-tools"]')), null);
});
