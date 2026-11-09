// Emulation of media, safe area insets and vision deficiencies. Chrome and we both act on the same
// page, so each side emulates, measures and clears in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  @media (prefers-color-scheme: light) { #em { color: rgb(1, 0, 0) } }
  @media (prefers-color-scheme: dark) { #em { color: rgb(2, 0, 0) } }
  @media print { #em { background-color: rgb(0, 3, 0) } }
  @media not print { #em { outline-color: rgb(0, 4, 0) } }
  @media screen and (prefers-reduced-motion) { #em { border-left-color: rgb(0, 0, 5) } }
  @media (color-gamut: p3) { #em { border-right-color: rgb(0, 0, 6) } }
  @media (prefers-color-scheme: light) { #em:hover { text-decoration-color: rgb(7, 0, 0) } }
  #sa {
    padding-top: env(safe-area-inset-top, 7px);
    padding-left: env(safe-area-max-inset-left, calc(1px + 2px));
    margin: env(safe-area-inset-bottom) 0 0;
    --right: env(safe-area-inset-right, 9px);
    width: calc(10px + var(--right));
  }
  #vd { position: fixed; top: 0; left: 0; width: 80px; height: 80px; background: rgb(200, 40, 40) }
  .top {
    position: fixed; inset: 20px auto auto 20px; width: 40px; height: 40px;
    margin: 0; padding: 0; border: 0; background: rgb(30, 160, 220);
  }
  #fs:not(:fullscreen) { display: none }
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    await t.page.evaluate(style => {
      const s = document.createElement('style');
      s.textContent = style;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="em">em</div><div id="sa">sa</div><div id="vd"></div><div id="pop" class="top" popover="manual"></div><dialog id="dlg" class="top"></dialog>' +
          '<div id="auto" class="top" popover="auto"></div><div id="hint" class="top" popover="hint"></div>' +
          '<div id="again" class="top" popover="manual"></div><div id="fs" class="top"></div><div id="host"></div>'
      );
      // A popover in a shadow tree: its toggle events do not reach the document.
      const root = document.getElementById('host')?.attachShadow({ mode: 'closed' });
      if (root) {
        root.innerHTML = `<style>${style.match(/\.top \{[^}]*\}/)?.[0] ?? ''}</style><div class="top" popover="manual"></div>`;
        Reflect.set(window, '__shadowPopover', root.lastElementChild);
      }
    }, STYLE);
  },
  () => env?.close()
);

const measure = () =>
  t.page.evaluate(() => {
    const style = (id: string) => getComputedStyle(document.getElementById(id) ?? document.body);
    const em = style('em');
    const sa = style('sa');
    return {
      color: em.color,
      background: em.backgroundColor,
      outline: em.outlineColor,
      borderLeft: em.borderLeftColor,
      borderRight: em.borderRightColor,
      decoration: em.textDecorationColor,
      paddingTop: sa.paddingTop,
      paddingLeft: sa.paddingLeft,
      marginTop: sa.marginTop,
      width: sa.width,
    };
  });

/** What each side gives for `measure` under `set`, cleared with `clear` after. */
async function both<T>(
  set: (side: Side) => Promise<unknown>,
  clear: (side: Side) => Promise<unknown>,
  read: () => Promise<T>
) {
  const results: T[] = [];
  for (const side of [t.chrome, t.ours]) {
    await set(side);
    try {
      results.push(await read());
    } finally {
      await clear(side);
    }
  }
  const [chrome, ours] = results;
  assert.deepEqual(ours, chrome);
  assert.ok(chrome !== undefined);
  return chrome;
}

const media = (params: Protocol.Emulation.SetEmulatedMediaRequest) =>
  [
    (side: Side) => side.send('Emulation.setEmulatedMedia', params),
    (side: Side) => side.send('Emulation.setEmulatedMedia', {}),
    measure,
  ] as const;

test('prefers-color-scheme: light and dark', async () => {
  const light = await both(...media({ features: [{ name: 'prefers-color-scheme', value: 'light' }] }));
  assert.equal(light.color, 'rgb(1, 0, 0)');
  const dark = await both(...media({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] }));
  assert.equal(dark.color, 'rgb(2, 0, 0)');
});

test('the print media type', async () => {
  const print = await both(...media({ media: 'print' }));
  assert.equal(print.background, 'rgb(0, 3, 0)');
  await both(...media({ media: 'screen' }));
});

test('boolean and ordered features, several at once', async () => {
  const r = await both(
    ...media({
      features: [
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'color-gamut', value: 'rec2020' },
        { name: 'prefers-color-scheme', value: 'light' },
      ],
    })
  );
  assert.equal(r.borderLeft, 'rgb(0, 0, 5)');
  assert.equal(r.borderRight, 'rgb(0, 0, 6)');
  await both(...media({ features: [{ name: 'color-gamut', value: 'srgb' }] }));
});

test('unknown features and values are ignored', async () => {
  await both(
    ...media({
      features: [
        { name: 'nope', value: 'x' },
        { name: 'prefers-color-scheme', value: 'blue' },
      ],
    })
  );
});

test('clearing restores the page', async () => {
  const before = await measure();
  await t.ours.send('Emulation.setEmulatedMedia', { media: 'print' });
  await t.ours.send('Emulation.setEmulatedMedia', {});
  assert.deepEqual(await measure(), before);
});

test('emulated media apply to sheets added later', async () => {
  const add = () =>
    t.page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'later';
      s.textContent = '@media print { #em { column-rule-color: rgb(9, 9, 9) } }';
      document.head.append(s);
      return new Promise(r => setTimeout(r));
    });
  const read = () =>
    t.page.evaluate(() => getComputedStyle(document.getElementById('em') ?? document.body).columnRuleColor);
  await both(
    side => side.send('Emulation.setEmulatedMedia', { media: 'print' }).then(add),
    side =>
      side
        .send('Emulation.setEmulatedMedia', {})
        .then(() => t.page.evaluate(() => document.getElementById('later')?.remove())),
    read
  );
});

test('the Styles pane shows the media query as written', async () => {
  const shown = async (side: Side) => {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
    const { root } = await side.send('DOM.getDocument', {});
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#em' });
    const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
    return (matchedCSSRules ?? []).flatMap(m => (m.rule.media ?? []).map(q => q.text));
  };
  const results = [];
  for (const side of [t.chrome, t.ours]) {
    await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    results.push(await shown(side));
    await side.send('Emulation.setEmulatedMedia', {});
    await side.send('CSS.disable');
  }
  assert.deepEqual(results[1], results[0]);
  assert.ok(results[0]?.includes('(prefers-color-scheme: light)'));
});

test('a forced :hover in an emulated @media', async () => {
  const r = await both(
    async side => {
      await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', {});
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#em' });
      await side.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      await t.page.evaluate(() => new Promise(r => setTimeout(r)));
    },
    async side => {
      const { root } = await side.send('DOM.getDocument', {});
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#em' });
      await side.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      await side.send('Emulation.setEmulatedMedia', {});
      await side.send('CSS.disable');
    },
    measure
  );
  assert.equal(r.decoration, 'rgb(7, 0, 0)');
});

const safeArea = (insets: Protocol.Emulation.SafeAreaInsets) =>
  [
    (side: Side) => side.send('Emulation.setSafeAreaInsetsOverride', { insets }),
    (side: Side) => side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} }),
    measure,
  ] as const;

test('safe area insets, with fallbacks, shorthands and custom properties', async () => {
  const r = await both(...safeArea({ top: 5, leftMax: 3, bottom: 4, right: 6 }));
  assert.deepEqual([r.paddingTop, r.paddingLeft, r.marginTop, r.width], ['5px', '3px', '4px', '16px']);
});

test('insets not set keep their real value', async () => {
  await both(...safeArea({ top: 8 }));
  await both(...safeArea({}));
});

/**
 * A pixel of the screenshot, inside #vd and away from the viewport's edges, where Chrome's blur
 * fades out and ours does not; on #vd's right edge for the blur, which changes nothing inside.
 * The shot takes the area around it: a backdrop filter in a 1×1 shot sees only that pixel.
 */
const pixel = async (x = 40) => {
  const shot = await t.page.screenshot({ clip: { x: 0, y: 0, width: 120, height: 80 }, encoding: 'base64' });
  return t.page.evaluate(
    async (data, x) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const g = canvas.getContext('2d');
      g?.drawImage(img, 0, 0);
      return Array.from(g?.getImageData(x, 40, 1, 1).data ?? []);
    },
    shot,
    x
  );
};

type Vision = Protocol.Emulation.SetEmulatedVisionDeficiencyRequest['type'];

/**
 * The pixel each side gives under `type` once `before` ran, `after` running before it is cleared.
 * The two sides' filters round apart by a unit or two.
 */
async function filtered(type: Vision, x = 40, before = async () => {}, after = async () => {}) {
  const results: number[][] = [];
  for (const side of [t.chrome, t.ours]) {
    await side.send('Emulation.setEmulatedVisionDeficiency', { type });
    try {
      await before();
      results.push(await pixel(x));
    } finally {
      await after();
      await side.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
    }
  }
  const [chrome = [], ours = []] = results;
  assert.ok(
    ours.length === 4 && ours.every((v, i) => Math.abs(v - (chrome[i] ?? 0)) <= 2),
    `ours ${JSON.stringify(ours)}, Chrome's ${JSON.stringify(chrome)}`
  );
  return chrome;
}

for (const type of [
  'blurredVision',
  'achromatopsia',
  'deuteranopia',
  'protanopia',
  'tritanopia',
  'reducedContrast',
] as const) {
  test(`vision deficiency: ${type}`, async () => {
    const x = type === 'blurredVision' ? 79 : 40;
    const plain = await pixel(x);
    assert.notDeepEqual(await filtered(type, x), plain);
    assert.deepEqual(await pixel(x), plain);
  });
}

test("a vision deficiency keeps the page's own filter on <html>, applied under it", async () => {
  const set = (filter: string) =>
    t.page.evaluate(f => {
      document.documentElement.style.filter = f;
    }, filter);
  const computed = () => t.page.evaluate(() => getComputedStyle(document.documentElement).filter);
  const without = await filtered('protanopia');
  await set('hue-rotate(120deg)');
  try {
    const own = await pixel();
    await set('');
    assert.notDeepEqual(own, await pixel());
    await set('hue-rotate(120deg)');
    const seen = await filtered('protanopia', 40, async () => assert.equal(await computed(), 'hue-rotate(120deg)'));
    assert.notDeepEqual(seen, own);
    assert.notDeepEqual(seen, without);
  } finally {
    await set('');
  }
});

/** Opens or closes the page's top-layer element `what` (see the fixture). */
const toggle = (what: string, open: boolean) =>
  t.page.evaluate(
    async (what, open) => {
      const el =
        what === 'shadow popover'
          ? (Reflect.get(window, '__shadowPopover') as HTMLElement)
          : (document.getElementById(what) as HTMLElement);
      if (what === 'dlg') {
        if (open) (el as HTMLDialogElement).showModal();
        else (el as HTMLDialogElement).close();
      } else if (what === 'fs') {
        // Full screen needs a user gesture: done from a click below.
        if (!open && document.fullscreenElement) await document.exitFullscreen();
      } else el.togglePopover(open);
      await new Promise(requestAnimationFrame);
    },
    what,
    open
  );

const openFullscreen = async () => {
  await t.page.evaluate(() => {
    const fs = document.getElementById('fs');
    if (fs) fs.onclick = () => void fs.requestFullscreen();
    // Shown for the click only: full screen, it is shown by the style.
    fs?.style.setProperty('display', 'block');
  });
  await t.page.click('#fs');
  await t.page.evaluate(() => document.getElementById('fs')?.style.removeProperty('display'));
  await t.page.waitForFunction(() => document.fullscreenElement !== null);
  await t.page.evaluate(() => new Promise(requestAnimationFrame));
};

for (const [what, name] of [
  ['manual popover', 'pop'],
  ['auto popover', 'auto'],
  ['hint popover', 'hint'],
  ['modal dialog', 'dlg'],
  ['popover in a shadow tree', 'shadow popover'],
  ['full-screen element', 'fs'],
] as const) {
  test(`a ${what} opened after a vision deficiency is filtered too`, async () => {
    const open = () => (name === 'fs' ? openFullscreen() : toggle(name, true));
    const close = () => toggle(name, false);
    await open();
    const plain = await pixel();
    await close();
    const seen = await filtered('deuteranopia', 40, open, close);
    assert.notDeepEqual(seen, plain);
  });
}

test('the filter comes back when the page takes the mask out with the rest of <html>', async () => {
  const seen = await filtered('tritanopia');
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'tritanopia' });
  try {
    // Everything in <html> replaced, then the page's content put back in a new <body>.
    await t.page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      document.documentElement.innerHTML = '';
      document.documentElement.innerHTML = html.replace(/<div data-devtools-anywhere="vision"[^>]*><\/div>/, '');
    });
    await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await pixel(), seen);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('a page opening a popover whenever one opens does not loop with the mask', async () => {
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'deuteranopia' });
  try {
    // For half a second, the page shows #again anew each time it opens: a toggle every task.
    const count = await t.page.evaluate(async () => {
      const again = document.getElementById('again') as HTMLElement;
      let toggles = 0;
      let stop = false;
      const onToggle = (e: Event) => {
        if (stop || e.target !== again || (e as ToggleEvent).newState !== 'open') return;
        toggles++;
        again.hidePopover();
        again.showPopover();
      };
      document.addEventListener('toggle', onToggle, true);
      again.showPopover();
      await new Promise(resolve => setTimeout(resolve, 500));
      stop = true;
      document.removeEventListener('toggle', onToggle, true);
      return toggles;
    });
    assert.ok(count > 0);
    // The page still answers, and #again, opened last, is under the mask.
    assert.notDeepEqual(await pixel(), [30, 160, 220, 255]);
  } finally {
    await toggle('again', false);
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('an unknown vision deficiency fails', async () => {
  for (const side of [t.chrome, t.ours]) {
    await assert.rejects(
      side.send('Emulation.setEmulatedVisionDeficiency', { type: 'nope' as 'none' }),
      /Unknown vision deficiency type/
    );
  }
});

test('the mask is not in the DOM tree', async () => {
  const look = async () => {
    const { root } = await t.ours.send('DOM.getDocument', { depth: -1, pierce: true });
    return JSON.stringify(root).replace(/"(nodeId|backendNodeId|parentId)":\d+/g, '');
  };
  const plain = await look();
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  try {
    const seen = await look();
    assert.equal(seen, plain);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('a page removing the mask whenever it sees it does not loop with it', async () => {
  const seen = await filtered('protanopia');
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'protanopia' });
  try {
    const removals = await t.page.evaluate(async () => {
      let count = 0;
      const observer = new MutationObserver(() => {
        for (const el of document.documentElement.children)
          if (el.getAttribute('data-devtools-anywhere') === 'vision') {
            el.remove();
            count++;
          }
      });
      observer.observe(document.documentElement, { childList: true });
      document.querySelector('[data-devtools-anywhere="vision"]')?.remove();
      await new Promise(resolve => setTimeout(resolve, 500));
      observer.disconnect();
      return count;
    });
    // Put back once a frame at most: about 30 times in half a second, not thousands.
    assert.ok(removals < 100, `${removals} removals`);
    await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await pixel(), seen);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});
