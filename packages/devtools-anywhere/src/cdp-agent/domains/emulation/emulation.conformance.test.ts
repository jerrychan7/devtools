// Emulation of media. Chrome and we both act on the same page, so each side emulates, measures and clears
// in turn. Vision deficiencies are in vision.conformance.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { CDPSession } from 'puppeteer-core';
import { launch, sameOnBoth, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';
import { openEmulationPage } from '../../../../test-support/emulation-fixture.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openEmulationPage(env, [
      'DOM.attributeModified',
      'DOM.attributeRemoved',
      'CSS.styleSheetAdded',
      'CSS.styleSheetChanged',
    ]);
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
    (side: Side) => side.send('Emulation.setEmulatedMedia', { media: '', features: [] }),
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
  await t.ours.send('Emulation.setEmulatedMedia', { media: '' });
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
        .send('Emulation.setEmulatedMedia', { media: '' })
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
      side => side.send('Emulation.setEmulatedMedia', { media: '' }),
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
    side => side.send('Emulation.setEmulatedMedia', { media: '' }),
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
    await side.send('Emulation.setEmulatedMedia', { features: [] });
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
      await side.send('Emulation.setEmulatedMedia', { features: [] });
      await side.send('CSS.disable');
    },
    measure
  );
  assert.equal(r.decoration, 'rgb(7, 0, 0)');
});

const LIGHT: Protocol.Emulation.MediaFeature = { name: 'prefers-color-scheme', value: 'light' };
const REDUCE: Protocol.Emulation.MediaFeature = { name: 'prefers-reduced-motion', value: 'reduce' };
const NO_PREFERENCE: Protocol.Emulation.MediaFeature = { name: 'prefers-reduced-motion', value: 'no-preference' };

test('omitted media and features are cleared, as media "" and features [] clear them', async () => {
  const r = await sameOnBoth(t, async side => {
    const seen: Awaited<ReturnType<typeof measure>>[] = [];
    await side.send('Emulation.setEmulatedMedia', { media: 'print', features: [LIGHT] });
    seen.push(await measure());
    // The features are omitted: the call takes back those this session set.
    await side.send('Emulation.setEmulatedMedia', { media: 'print' });
    seen.push(await measure());
    // The media is omitted: the call takes back the media type.
    await side.send('Emulation.setEmulatedMedia', { features: [LIGHT] });
    seen.push(await measure());
    await side.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    seen.push(await measure());
    return seen;
  });
  const [both, printOnly, lightOnly, cleared] = r;
  assert.equal(both?.color, 'rgb(1, 0, 0)');
  assert.equal(both?.background, 'rgb(0, 3, 0)');
  assert.equal(printOnly?.background, 'rgb(0, 3, 0)');
  assert.notEqual(printOnly?.color, 'rgb(1, 0, 0)');
  assert.equal(lightOnly?.color, 'rgb(1, 0, 0)');
  assert.notEqual(lightOnly?.background, 'rgb(0, 3, 0)');
  assert.notEqual(cleared?.color, 'rgb(1, 0, 0)');
  assert.notEqual(cleared?.background, 'rgb(0, 3, 0)');
});

/** One step of `twoSessions`: a call of one of a side's two sessions (0 or 1), or the end of one. */
type Step = { call: 0 | 1; params: Protocol.Emulation.SetEmulatedMediaRequest } | { end: 0 | 1 };

/** A side's two sessions for `twoSessions`: a call of one, and the end of one as its client going does. */
interface Pair {
  call(which: 0 | 1, params: Protocol.Emulation.SetEmulatedMediaRequest): Promise<unknown>;
  end(which: 0 | 1): Promise<unknown>;
}

/** Two sessions of `side` on the page: Chrome's own CDP sessions, or two of our agent (`window.__sessions`). */
async function pairOf(side: Side): Promise<Pair> {
  if (side === t.chrome) {
    const cdp: [CDPSession, CDPSession] = [await t.page.createCDPSession(), await t.page.createCDPSession()];
    return {
      call: (which, params) => cdp[which].send('Emulation.setEmulatedMedia', params),
      end: which => cdp[which].detach(),
    };
  }
  await t.page.evaluate(() => {
    window.__sessions = [window.DevtoolsAnywhere.createCdpSession(), window.DevtoolsAnywhere.createCdpSession()];
  });
  return {
    call: (which, params) =>
      t.page.evaluate(
        (which, params) => window.__sessions?.[which]?.call('Emulation.setEmulatedMedia', params),
        which,
        params
      ),
    end: which => t.page.evaluate(which => window.__sessions?.[which]?.reset(), which),
  };
}

/**
 * Plays `steps` on each side with two sessions of its own, and reads the page after each step: the two sides
 * must read the same. Both sessions end after the steps, so that nothing is left emulated.
 */
async function twoSessions<T>(steps: readonly Step[], read: () => Promise<T>): Promise<T[]> {
  return sameOnBoth(t, async side => {
    const pair = await pairOf(side);
    const ended = new Set<0 | 1>();
    const end = async (which: 0 | 1) => {
      if (ended.has(which)) return;
      ended.add(which);
      await pair.end(which);
    };
    try {
      const seen: T[] = [];
      for (const step of steps) {
        if ('end' in step) await end(step.end);
        else await pair.call(step.call, step.params);
        seen.push(await read());
      }
      return seen;
    } finally {
      await end(0);
      await end(1);
    }
  });
}

test('features another session set are kept by a call of its own that omits them', async () => {
  const r = await twoSessions(
    [
      { call: 0, params: { features: [LIGHT] } },
      // Its features omitted: the light of the first session stays, and the print type is on.
      { call: 1, params: { media: 'print' } },
      // Its media omitted: the print type goes, and the light stays.
      { call: 1, params: { features: [REDUCE] } },
      // The first session takes its light back: the reduced motion of the second one stays.
      { call: 0, params: { features: [] } },
    ],
    measure
  );
  const [first, printed, reduced, taken] = r;
  assert.equal(first?.color, 'rgb(1, 0, 0)');
  assert.notEqual(first?.background, 'rgb(0, 3, 0)');
  assert.equal(printed?.color, 'rgb(1, 0, 0)');
  assert.equal(printed?.background, 'rgb(0, 3, 0)');
  assert.equal(reduced?.color, 'rgb(1, 0, 0)');
  assert.notEqual(reduced?.background, 'rgb(0, 3, 0)');
  assert.equal(reduced?.borderLeft, 'rgb(0, 0, 5)');
  assert.notEqual(taken?.color, 'rgb(1, 0, 0)');
  assert.equal(taken?.borderLeft, 'rgb(0, 0, 5)');
});

test("a session's end takes back its features, and the media type whichever session set it", async () => {
  // The light scheme is read on its own: the reduced motion rule of the page is for the screen only.
  const r = await twoSessions(
    [{ call: 0, params: { features: [LIGHT] } }, { call: 1, params: { media: 'print' } }, { end: 0 }],
    measure
  );
  const [, printed, ended] = r;
  assert.equal(printed?.color, 'rgb(1, 0, 0)');
  assert.equal(printed?.background, 'rgb(0, 3, 0)');
  assert.notEqual(ended?.color, 'rgb(1, 0, 0)');
  assert.notEqual(ended?.background, 'rgb(0, 3, 0)');
});

test('a session that never called takes the media type back when it ends', async () => {
  const r = await twoSessions([{ call: 1, params: { media: 'print' } }, { end: 0 }], measure);
  const [printed, ended] = r;
  assert.equal(printed?.background, 'rgb(0, 3, 0)');
  assert.notEqual(ended?.background, 'rgb(0, 3, 0)');
});

test('a call takes back a feature name another session set since, and does not restore the value it hid', async () => {
  const r = await twoSessions(
    [
      { call: 0, params: { features: [REDUCE] } },
      { call: 1, params: { features: [NO_PREFERENCE] } },
      { call: 1, params: { features: [LIGHT] } },
    ],
    measure
  );
  const [first, overwritten, taken] = r;
  assert.equal(first?.borderLeft, 'rgb(0, 0, 5)');
  assert.notEqual(overwritten?.borderLeft, 'rgb(0, 0, 5)');
  assert.equal(taken?.color, 'rgb(1, 0, 0)');
  assert.notEqual(taken?.borderLeft, 'rgb(0, 0, 5)');
});

test('a call takes back a feature name it set before, even where another session has set it since', async () => {
  const r = await twoSessions(
    [
      { call: 0, params: { features: [NO_PREFERENCE] } },
      { call: 1, params: { features: [REDUCE] } },
      { call: 0, params: { features: [] } },
    ],
    measure
  );
  const [first, since, taken] = r;
  assert.notEqual(first?.borderLeft, 'rgb(0, 0, 5)');
  assert.equal(since?.borderLeft, 'rgb(0, 0, 5)');
  assert.notEqual(taken?.borderLeft, 'rgb(0, 0, 5)');
});

test('a value Chrome does not read takes its feature back, whichever session set it', async () => {
  const r = await twoSessions(
    [
      { call: 0, params: { features: [LIGHT] } },
      { call: 1, params: { features: [{ name: 'prefers-color-scheme', value: 'blue' }] } },
    ],
    measure
  );
  assert.equal(r[0]?.color, 'rgb(1, 0, 0)');
  assert.notEqual(r[1]?.color, 'rgb(1, 0, 0)');
});

test('a feature name is compared as written: Chrome takes no other spelling of one', async () => {
  // Both values: the page's own scheme is light or dark, and a name that is accepted changes the measure only
  // when its value is the other one.
  const none = await both(...media({}));
  for (const value of ['light', 'dark'] as const) {
    for (const name of ['Prefers-Color-Scheme', 'prefers-color-schem\\65', ' prefers-color-scheme']) {
      assert.deepEqual(await both(...media({ features: [{ name, value }] })), none, `${name}: ${value}`);
    }
  }
});

test('prefers-reduced-data is not emulated: Chrome leaves its queries to the browser', async () => {
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'reduced-data-css';
    style.textContent = '@media (prefers-reduced-data: reduce) { #reduced-data { font-size: 19px } }';
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<div id="reduced-data"></div>');
  });
  try {
    const size = await both(
      (side: Side) =>
        side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-data', value: 'reduce' }] }),
      (side: Side) => side.send('Emulation.setEmulatedMedia', { media: '', features: [] }),
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('reduced-data') ?? document.body).fontSize)
    );
    assert.notEqual(size, '19px');
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('reduced-data-css')?.remove();
      document.getElementById('reduced-data')?.remove();
    });
  }
});

/**
 * Polls `read` until it gives `expected`, or gives up after a few seconds with what it last read: the
 * browser chooses an image's candidate, and applies a media change, a little after the page's task.
 */
async function until<T>(read: () => Promise<T>, expected: T, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value === expected || Date.now() - start > timeout) return value;
    await new Promise(r => setTimeout(r, 20));
  }
}

/**
 * Reads `read` until it has given the same value for a few hundred milliseconds, for a value the
 * browser settles on after a change, when there is no particular value to wait for.
 */
async function steady<T>(read: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let last = await read();
  let since = Date.now();
  while (Date.now() - since < 250 && Date.now() - start < 3000) {
    await new Promise(r => setTimeout(r, 25));
    const value = await read();
    if (value !== last) {
      last = value;
      since = Date.now();
    }
  }
  return last;
}

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
    const r = await sameOnBoth(t, async side => {
      const base = await until(() => shown('pici'), '?pic-img');
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      const printed = await until(() => shown('pici'), '?pic-source');
      await side.send('Emulation.setEmulatedMedia', { media: '' });
      return { base, printed, cleared: await until(() => shown('pici'), '?pic-img') };
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
    const r = await sameOnBoth(t, async side => {
      await t.page.evaluate(() => document.getElementById('pic2s')?.setAttribute('media', 'print'));
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      const printed = await until(() => shown('pic2i'), '?pic2-source');
      // The page sets another media while the emulation rewrites this one: the page's value is its own.
      await t.page.evaluate(() => document.getElementById('pic2s')?.setAttribute('media', 'screen'));
      const during = await until(() => shown('pic2i'), '?pic2-img');
      await side.send('Emulation.setEmulatedMedia', { media: '' });
      const cleared = await until(() => shown('pic2i'), '?pic2-source');
      const media = await t.page.evaluate(() => document.getElementById('pic2s')?.getAttribute('media'));
      return { printed, during, cleared, media };
    });
    assert.deepEqual(r, { printed: '?pic2-source', during: '?pic2-img', cleared: '?pic2-source', media: 'screen' });
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
    const r = await sameOnBoth(t, async side => {
      const tag = side === t.chrome ? 'chrome' : 'ours';
      // Dark, whatever the browser's own scheme is: the 100px slot, the larger candidate.
      await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await make(`sz-base-${tag}`);
      const base = await until(() => chosen(`sz-base-${tag}`), 'b');
      await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await make(`sz-light-${tag}`);
      const light = await until(() => chosen(`sz-light-${tag}`), 'a');
      await side.send('Emulation.setEmulatedMedia', { features: [] });
      await make(`sz-cleared-${tag}`);
      // Cleared, the browser's own scheme is back, whichever it is: compared with Chrome's, not assumed.
      return { base, light, cleared: await steady(() => chosen(`sz-cleared-${tag}`)) };
    });
    assert.deepEqual(r.base, 'b');
    assert.deepEqual(r.light, 'a');
  } finally {
    await t.page.evaluate(() => document.querySelectorAll('img[id^="sz-"]').forEach(img => img.remove()));
  }
});

test("an image's sizes are split as CSS splits them: a comma in a comment, a length right after its condition", async () => {
  const SIZES = [
    '/* , */ (prefers-color-scheme: light) /* a, b */ 10px, 100px',
    '(prefers-color-scheme: light)10px, 100px',
  ];
  const make = (id: string, sizes: string) =>
    t.page.evaluate(
      ([id, sizes]) => {
        const img = document.createElement('img');
        img.id = id;
        img.sizes = sizes;
        const url = (name: string) => `/packages/devtools-anywhere/test-support/assets/pixel.png?${id}-${name}`;
        img.srcset = `${url('a')} 10w, ${url('b')} 100w`;
        document.body.append(img);
      },
      [id, sizes] as const
    );
  try {
    const r = await sameOnBoth(t, async side => {
      const tag = side === t.chrome ? 'chrome' : 'ours';
      const out: string[] = [];
      for (const [i, sizes] of SIZES.entries()) {
        await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
        await make(`szc-dark-${i}-${tag}`, sizes);
        out.push(await until(() => chosen(`szc-dark-${i}-${tag}`), 'b'));
        await side.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: 'light' }],
        });
        await make(`szc-light-${i}-${tag}`, sizes);
        out.push(await until(() => chosen(`szc-light-${i}-${tag}`), 'a'));
      }
      await side.send('Emulation.setEmulatedMedia', { features: [] });
      return out;
    });
    assert.deepEqual(r, ['b', 'a', 'b', 'a']);
  } finally {
    await t.page.evaluate(() => document.querySelectorAll('img[id^="szc-"]').forEach(img => img.remove()));
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
    const r = await sameOnBoth(t, async side => {
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      const printed = await read();
      await side.send('Emulation.setEmulatedMedia', { media: '' });
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
    const r = await sameOnBoth(t, async side => {
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
      await side.send('Emulation.setEmulatedMedia', { media: '' });
      await t.page.evaluate(() => document.getElementById('lk2')?.remove());
      return { loaded, cleared: await read() };
    });
    assert.deepEqual(r, { loaded: '2px', cleared: 'normal' });
  } finally {
    await t.page.evaluate(() => document.getElementById('lk2')?.remove());
  }
});

test("a sheet's own media list the page sets under the emulation is emulated in the same task", async () => {
  // Each step changes the list, and reads #em's word spacing in the same task: print applies the rule.
  // The list is not edited entry by entry (deleteMedium() of an entry the emulation rewrote finds none:
  // the page reads the rewritten text), so the steps set it, and append to it.
  const step = (id: string, how: 'set' | 'append', text: string) =>
    t.page.evaluate(
      ([id, how, text]) => {
        const sheet = (document.getElementById(id) as HTMLLinkElement).sheet;
        if (!sheet) throw new Error('the link has no sheet');
        if (how === 'set') sheet.media.mediaText = text;
        else sheet.media.appendMedium(text);
        return getComputedStyle(document.getElementById('em') ?? document.body).wordSpacing;
      },
      [id, how, text] as const
    );
  const r = await sameOnBoth(t, async side => {
    const id = side === t.chrome ? 'sml-chrome' : 'sml-ours';
    await t.page.evaluate(async id => {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = 'data:text/css,%23em%7Bword-spacing%3A9px%7D';
      const loaded = new Promise(r => link.addEventListener('load', r));
      document.head.append(link);
      await loaded;
    }, id);
    try {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      await side.send('Emulation.setEmulatedMedia', { media: 'print' });
      // The link is the sheet with a data: URL. Only its events are counted: the setUp's <style>, whose @media
      // rules the emulation rewrites, may be told of the rewrite too (a separate matter).
      const linkId = (await side.events('CSS.styleSheetAdded')).find(e => e.header.sourceURL.startsWith('data:'))
        ?.header.styleSheetId;
      assert.ok(linkId, 'the CSS domain knows the link');
      await side.clear();
      const words = [
        await step(id, 'set', 'screen'),
        await step(id, 'set', 'print'),
        await step(id, 'append', 'screen'),
        await step(id, 'set', 'screen'),
      ];
      // A change told a moment late would be counted too: the events of the moment after the steps are waited for.
      await t.page.evaluate(() => new Promise(r => setTimeout(r, 200)));
      // Chrome sends nothing for a change of the list alone, and so do we.
      const changed = (await side.events('CSS.styleSheetChanged')).filter(e => e.styleSheetId === linkId);
      return { words, changed: changed.length };
    } finally {
      try {
        await t.page.evaluate(id => document.getElementById(id)?.remove(), id);
      } finally {
        await side.send('Emulation.setEmulatedMedia', {});
        await side.send('CSS.disable');
        await side.send('DOM.disable');
      }
    }
  });
  assert.deepEqual(r, { words: ['0px', '9px', '9px', '0px'], changed: 0 });
});

/** A task of the page later: the emulation's observers have rewritten what the page wrote. */
const nextTask = () => t.page.evaluate(() => new Promise(r => setTimeout(r)));

const insets = (side: Side, top?: number) =>
  side.send('Emulation.setSafeAreaInsetsOverride', { insets: top === undefined ? {} : { top } });

test('a text the page writes over a rewritten one keeps its strings, comment marks in them included', async () => {
  const TEXT = 'content: "/*"; color: rgb(1, 2, 3); --x: "*/"';
  const read = () =>
    t.page.evaluate(() => {
      const el = document.getElementById('cm');
      const rule = (document.getElementById('cms') as HTMLStyleElement).sheet?.cssRules[0];
      if (!el || !(rule instanceof CSSStyleRule)) throw new Error('the element and its rule are not there');
      const ruled = getComputedStyle(document.getElementById('cm2') ?? document.body);
      return {
        attribute: el.getAttribute('style'),
        color: getComputedStyle(el).color,
        x: getComputedStyle(el).getPropertyValue('--x'),
        rule: rule.style.cssText,
        ruleColor: ruled.color,
        ruleX: ruled.getPropertyValue('--x'),
      };
    });
  const r = await sameOnBoth(t, async side => {
    await t.page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<style id="cms">#cm2 { padding-top: env(safe-area-inset-top, 7px) }</style>' +
          '<div id="cm" style="padding-top: env(safe-area-inset-top, 7px)">cm</div><div id="cm2">cm2</div>'
      );
    });
    try {
      await insets(side, 5);
      await nextTask();
      // Both texts are rewritten now: the page writes another over each, by the attribute and by the CSSOM.
      await t.page.evaluate(text => {
        document.getElementById('cm')?.setAttribute('style', text);
        const rule = (document.getElementById('cms') as HTMLStyleElement).sheet?.cssRules[0];
        if (rule instanceof CSSStyleRule) rule.style.cssText = text;
      }, TEXT);
      await nextTask();
      const during = await read();
      await insets(side);
      await nextTask();
      return { during, after: await read() };
    } finally {
      await insets(side);
      await t.page.evaluate(() => document.querySelectorAll('#cm, #cm2, #cms').forEach(el => el.remove()));
    }
  });
  assert.equal(r.during.attribute, TEXT);
  assert.equal(r.during.color, 'rgb(1, 2, 3)');
  assert.equal(r.during.ruleColor, 'rgb(1, 2, 3)');
  assert.deepEqual(r.after, r.during);
});
