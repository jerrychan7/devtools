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
  #vd { position: fixed; top: 0; left: 0; width: 20px; height: 20px; background: rgb(200, 40, 40) }
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    await t.page.evaluate(style => {
      const s = document.createElement('style');
      s.textContent = style;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML('beforeend', '<div id="em">em</div><div id="sa">sa</div><div id="vd"></div>');
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

const pixel = async () => {
  const shot = await t.page.screenshot({ clip: { x: 5, y: 5, width: 1, height: 1 }, encoding: 'base64' });
  return t.page.evaluate(async data => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = new OffscreenCanvas(1, 1);
    const g = canvas.getContext('2d');
    g?.drawImage(img, 0, 0);
    return Array.from(g?.getImageData(0, 0, 1, 1).data ?? []);
  }, shot);
};

for (const type of ['achromatopsia', 'deuteranopia', 'protanopia', 'tritanopia', 'reducedContrast'] as const) {
  test(`vision deficiency: ${type}`, async () => {
    const plain = await pixel();
    const seen = await both(
      side => side.send('Emulation.setEmulatedVisionDeficiency', { type }),
      side => side.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' }),
      pixel
    );
    assert.notDeepEqual(seen, plain);
    assert.deepEqual(await pixel(), plain);
  });
}

test('an unknown vision deficiency fails', async () => {
  for (const side of [t.chrome, t.ours]) {
    await assert.rejects(
      side.send('Emulation.setEmulatedVisionDeficiency', { type: 'nope' as 'none' }),
      /Unknown vision deficiency type/
    );
  }
});
