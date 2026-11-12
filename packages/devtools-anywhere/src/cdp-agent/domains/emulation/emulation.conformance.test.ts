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
    t = await openPage(env, ['DOM.attributeModified', 'DOM.attributeRemoved']);
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

test('a rule the page inserts through the CSSOM is emulated in the same task', async () => {
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'cssom';
    document.head.append(style);
  });
  // Inserted, read and taken back out within the task: nothing of the sheet is left for the other side.
  const read = () =>
    t.page.evaluate(() => {
      const sheet = (document.getElementById('cssom') as HTMLStyleElement).sheet;
      sheet?.insertRule('@media print { #em { border-left-color: rgb(1, 2, 3) } }', 0);
      sheet?.insertRule('@media not print { #em { border-right-color: rgb(4, 5, 6) } }', 0);
      const style = getComputedStyle(document.getElementById('em') ?? document.body);
      // Not emulated, the right one is the text's own colour (border-right-color is currentcolor).
      const out = { left: style.borderLeftColor, right: style.borderRightColor, color: style.color };
      sheet?.deleteRule(0);
      sheet?.deleteRule(0);
      return out;
    });
  try {
    const r = await both(
      side => side.send('Emulation.setEmulatedMedia', { media: 'print' }),
      side => side.send('Emulation.setEmulatedMedia', {}),
      read
    );
    assert.equal(r.left, 'rgb(1, 2, 3)');
    assert.equal(r.right, r.color);
  } finally {
    await t.page.evaluate(() => document.getElementById('cssom')?.remove());
  }
});

test('a constructed sheet replaced with replaceSync is emulated in the same task', async () => {
  // The sheet is adopted first, then replaced: each time, what is read in the task is the rewrite.
  const read = () =>
    t.page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      sheet.replaceSync('@media print { #em { outline-color: rgb(7, 7, 7) } }');
      const print = getComputedStyle(document.getElementById('em') ?? document.body).outlineColor;
      sheet.replaceSync('@media screen { #em { outline-color: rgb(8, 8, 8) } }');
      const screen = getComputedStyle(document.getElementById('em') ?? document.body).outlineColor;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
      const color = getComputedStyle(document.getElementById('em') ?? document.body).color;
      return { print, screen, color };
    });
  const r = await both(
    side => side.send('Emulation.setEmulatedMedia', { media: 'print' }),
    side => side.send('Emulation.setEmulatedMedia', {}),
    read
  );
  assert.equal(r.print, 'rgb(7, 7, 7)');
  assert.equal(r.screen, r.color);
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

/** What each side gives for `run`, run on each in turn: the two must give the same. */
async function sameOnBoth<T>(run: (side: Side) => Promise<T>): Promise<T> {
  const results: T[] = [];
  for (const side of [t.chrome, t.ours]) results.push(await run(side));
  const [chrome, ours] = results;
  assert.deepEqual(ours, chrome);
  return chrome as T;
}

const settle = () => t.page.evaluate(() => new Promise(r => setTimeout(r)));

/** Waits for the browser to choose the images again (a <picture>'s source, an image's candidate): a few frames. */
const settleImages = () =>
  t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));

test('an inline style with env() is emulated, and so is a style the page writes', async () => {
  await t.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="inl">inl</div>'));
  const read = () =>
    t.page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('inl') ?? document.body);
      return { top: style.paddingTop, left: style.paddingLeft };
    });
  try {
    const r = await sameOnBoth(async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 3 } });
      await t.page.evaluate(() =>
        document
          .getElementById('inl')
          ?.setAttribute(
            'style',
            'padding-top: env(safe-area-inset-top, 7px); padding-left: env(safe-area-inset-left, 9px)'
          )
      );
      const first = await read();
      // The page writes the style again: the new text is the original, rewritten in turn.
      await t.page.evaluate(() =>
        document.getElementById('inl')?.setAttribute('style', 'padding-top: env(safe-area-inset-top, 11px)')
      );
      const written = await read();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      const cleared = await read();
      return { first, written, cleared };
    });
    assert.deepEqual(r.first, { top: '5px', left: '3px' });
    assert.equal(r.written.top, '5px');
  } finally {
    await t.page.evaluate(() => document.getElementById('inl')?.remove());
  }
});

/** A test image's URL: the fixture's own pixel, with a query that names the candidate. */
const image = (name: string) => `/packages/devtools-anywhere/test-support/assets/pixel.png?${name}`;

/** The query of the image the element with `id` shows now (`?name`), once it is chosen. */
const shown = (id: string) =>
  t.page.evaluate(id => {
    const img = document.getElementById(id);
    return img instanceof HTMLImageElement && img.currentSrc ? new URL(img.currentSrc).search : '';
  }, id);

/** The candidate an image shows, by the last letter of its query: `a` or `b`. */
const chosen = async (id: string) => (await shown(id)).slice(-1);

test('a <picture> source with a media query is chosen as the emulation has it', async () => {
  await t.page.evaluate(
    ([source, img]) =>
      document.body.insertAdjacentHTML(
        'beforeend',
        `<picture id="pic"><source id="pics" media="print" srcset="${source}"><img id="pici" src="${img}"></picture>`
      ),
    [image('pic-source'), image('pic-img')]
  );
  try {
    const r = await sameOnBoth(async side => {
      await settleImages();
      const base = await shown('pici');
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      await settleImages();
      const printed = await shown('pici');
      await side.send('Emulation.setEmulatedMedia', {});
      await settleImages();
      return { base, printed, cleared: await shown('pici') };
    });
    assert.deepEqual(r, { base: '?pic-img', printed: '?pic-source', cleared: '?pic-img' });
  } finally {
    await t.page.evaluate(() => document.getElementById('pic')?.remove());
  }
});

test('a <source> media the page sets while emulated is its own once the emulation ends', async () => {
  await t.page.evaluate(
    ([source, img]) =>
      document.body.insertAdjacentHTML(
        'beforeend',
        `<picture id="pic2"><source id="pic2s" media="print" srcset="${source}"><img id="pic2i" src="${img}"></picture>`
      ),
    [image('pic2-source'), image('pic2-img')]
  );
  try {
    const r = await sameOnBoth(async side => {
      await settleImages();
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      await settleImages();
      // The page changes the media while the emulation rewrites it: the new value is its own.
      await t.page.evaluate(() => document.getElementById('pic2s')?.setAttribute('media', 'all'));
      await settleImages();
      await side.send('Emulation.setEmulatedMedia', {});
      await settleImages();
      const media = await t.page.evaluate(() => document.getElementById('pic2s')?.getAttribute('media'));
      return { media, shown: await shown('pic2i') };
    });
    assert.deepEqual(r, { media: 'all', shown: '?pic2-source' });
  } finally {
    await t.page.evaluate(() => document.getElementById('pic2')?.remove());
  }
});

test('the sizes of an <img> are read as the emulation has them, when the image is made', async () => {
  // Made after the emulation, so the browser reads the sizes it is given; each side has its own candidates.
  const make = (id: string) =>
    t.page.evaluate(id => {
      const img = document.createElement('img');
      img.id = id;
      img.sizes = '(prefers-color-scheme: light) 10px, 100px';
      const url = (name: string) => `/packages/devtools-anywhere/test-support/assets/pixel.png?${id}-${name}`;
      img.srcset = `${url('a')} 10w, ${url('b')} 100w`;
      document.body.append(img);
    }, id);
  try {
    const r = await sameOnBoth(async side => {
      const tag = side === t.chrome ? 'chrome' : 'ours';
      await make(`sz-base-${tag}`);
      await settleImages();
      const base = await chosen(`sz-base-${tag}`);
      await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await make(`sz-light-${tag}`);
      await settleImages();
      const light = await chosen(`sz-light-${tag}`);
      await side.send('Emulation.setEmulatedMedia', {});
      await make(`sz-cleared-${tag}`);
      await settleImages();
      return { base, light, cleared: await chosen(`sz-cleared-${tag}`) };
    });
    // Without the emulation the browser's colour scheme is dark: the 100px slot, the larger candidate.
    assert.deepEqual(r, { base: 'b', light: 'a', cleared: 'b' });
  } finally {
    await t.page.evaluate(() => document.querySelectorAll('img[id^="sz-"]').forEach(img => img.remove()));
  }
});

test('a <link> or a <style> with a media query is emulated, and so is a rule of its sheet', async () => {
  const read = () =>
    t.page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('em') ?? document.body);
      return { letter: style.letterSpacing, word: style.wordSpacing };
    });
  await t.page.evaluate(async () => {
    const link = document.createElement('link');
    link.id = 'lk';
    link.rel = 'stylesheet';
    link.media = 'print';
    link.href = 'data:text/css,%23em%7Bletter-spacing%3A7px%7D';
    const loaded = new Promise(r => link.addEventListener('load', r));
    document.head.append(link);
    await loaded;
    const style = document.createElement('style');
    style.id = 'sty';
    style.media = 'print';
    style.textContent = '#em { word-spacing: 9px }';
    document.head.append(style);
  });
  try {
    const r = await sameOnBoth(async side => {
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      const printed = await read();
      await side.send('Emulation.setEmulatedMedia', {});
      return { printed, cleared: await read() };
    });
    assert.deepEqual(r.printed, { letter: '7px', word: '9px' });
    assert.deepEqual(r.cleared, { letter: 'normal', word: '0px' });
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('lk')?.remove();
      document.getElementById('sty')?.remove();
    });
  }
});

test('a <link> with a media query that loads under the emulation is emulated once loaded', async () => {
  const read = () =>
    t.page.evaluate(() => getComputedStyle(document.getElementById('app') ?? document.body).letterSpacing);
  try {
    const r = await sameOnBoth(async side => {
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      await t.page.evaluate(async () => {
        const link = document.createElement('link');
        link.id = 'lk2';
        link.rel = 'stylesheet';
        link.media = 'print';
        link.href = '/packages/devtools-anywhere/test-support/assets/cross.css?delay=300';
        const loaded = new Promise(r => link.addEventListener('load', r));
        document.head.append(link);
        await loaded;
      });
      const loaded = await read();
      await side.send('Emulation.setEmulatedMedia', {});
      await t.page.evaluate(() => document.getElementById('lk2')?.remove());
      return { loaded, cleared: await read() };
    });
    assert.deepEqual(r, { loaded: '2px', cleared: 'normal' });
  } finally {
    await t.page.evaluate(() => document.getElementById('lk2')?.remove());
  }
});

test('the page sees the style attribute it wrote, and the emulation makes no DOM change', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="inl" style="padding-top: env(safe-area-inset-top, 7px)">inl</div>'
    )
  );
  try {
    const r = await sameOnBoth(async side => {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#inl' });
      await side.clear();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      const during = await side.events('DOM.attributeModified');
      const { attributes } = await side.send('DOM.getAttributes', { nodeId });
      const { outerHTML } = await side.send('DOM.getOuterHTML', { nodeId });
      const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      const after = await side.events('DOM.attributeModified');
      await side.send('CSS.disable');
      await side.send('DOM.disable');
      return { during, after, attributes, outerHTML, css: inlineStyle?.cssText };
    });
    assert.deepEqual(r.during, []);
    assert.deepEqual(r.after, []);
    assert.deepEqual(r.attributes.slice(2), ['style', 'padding-top: env(safe-area-inset-top, 7px)']);
    assert.match(r.outerHTML, /style="padding-top: env\(safe-area-inset-top, 7px\)"/);
    assert.equal(r.css, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    await t.page.evaluate(() => document.getElementById('inl')?.remove());
  }
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
