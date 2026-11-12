// The color scheme under an emulated preference: the page's color-scheme values that name both schemes follow
// it, as Chrome's do (color-scheme.ts). What a box shows of its used scheme is read through what depends on
// it: a CanvasText, a text field's background, and light-dark(). Both preferences are emulated, as the system
// may be dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, setUpAndTearDown, type Env, type Side, type TestPage } from '../../../../test-support/conformance.ts';
import { openEmulationPage } from '../../../../test-support/emulation-fixture.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openEmulationPage(env, []);
  },
  () => env?.close()
);

type Preference = 'light' | 'dark';
const PREFERENCES: Preference[] = ['light', 'dark'];

/** What a box reads of its used scheme: CanvasText, a text field's background, light-dark(), under each preference. */
const SCHEME: Record<Preference, { ct: string; field: string; ld: string }> = {
  light: { ct: 'rgb(0, 0, 0)', field: 'rgb(255, 255, 255)', ld: 'rgb(1, 0, 0)' },
  dark: { ct: 'rgb(255, 255, 255)', field: 'rgb(59, 59, 59)', ld: 'rgb(0, 0, 1)' },
};

/** A box that shows its used scheme, with `attributes` on it and `inner` in it. */
const box = (id: string, attributes: string, inner = '') =>
  `<div id="${id}" ${attributes}>${inner}<span data-ct style="color: CanvasText">x</span><input><span data-ld style="color: light-dark(rgb(1, 0, 0), rgb(0, 0, 1))">y</span></div>`;

/** Puts `html` in the page, and a sheet with `css`; the returned function takes both out again. */
async function inPage(html: string, css = ''): Promise<() => Promise<void>> {
  const args: [string, string] = [html, css];
  await t.page.evaluate(([html, css]) => {
    const style = document.createElement('style');
    style.id = 'cs-css';
    style.textContent = css;
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', `<div id="cs-root">${html}</div>`);
  }, args);
  return () =>
    t.page.evaluate(() => {
      document.getElementById('cs-css')?.remove();
      document.getElementById('cs-root')?.remove();
    });
}

/** What a box reads of its used scheme (null when the box is not in the page). */
type Shown = { ct: string; field: string; ld: string } | null;

/** What each box of `ids` reads now, as the page shows it. */
const readBoxes = (ids: string[]): Promise<Record<string, Shown>> =>
  t.page.evaluate(
    (ids: string[]) =>
      Object.fromEntries(
        ids.map(id => {
          const el = document.getElementById(id);
          const ct = el?.querySelector('[data-ct]');
          const field = el?.querySelector('input');
          const ld = el?.querySelector('[data-ld]');
          return [
            id,
            ct && field && ld
              ? {
                  ct: getComputedStyle(ct).color,
                  field: getComputedStyle(field).backgroundColor,
                  ld: getComputedStyle(ld).color,
                }
              : null,
          ];
        })
      ) as Record<string, Shown>,
    ids
  );

/** Emulates `preference` on `side` while `run` measures, and clears the emulation after. */
async function underPreference<T>(side: Side, preference: Preference, run: () => Promise<T>): Promise<T> {
  await side.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: preference }] });
  try {
    return await run();
  } finally {
    await side.send('Emulation.setEmulatedMedia', { media: '', features: [] });
  }
}

/** What each side gives for `run`, run on each in turn: the two must give the same. */
async function sameOnBoth<T>(run: (side: Side) => Promise<T>): Promise<T> {
  const results: T[] = [];
  for (const side of [t.chrome, t.ours]) results.push(await run(side));
  const [chrome, ours] = results;
  assert.deepEqual(ours, chrome);
  return chrome as T;
}

/** Each box of `ids` under each preference, as the two sides show it; the boxes must show `SCHEME`. */
async function followsPreference(ids: string[]) {
  for (const preference of PREFERENCES) {
    const shown = await sameOnBoth(side => underPreference(side, preference, () => readBoxes(ids)));
    for (const id of ids) assert.deepEqual(shown[id], SCHEME[preference], `${id} under ${preference}`);
  }
}

test('a color-scheme naming light and dark follows the preference: in a style attribute and in a sheet', async () => {
  const cleanup = await inPage(
    [
      box('cs-inline', 'style="color-scheme: light dark"'),
      box('cs-sheet', 'class="cs-ld"'),
      box('cs-reversed', 'style="color-scheme: dark light"'),
    ].join(''),
    '.cs-ld { color-scheme: light dark }'
  );
  try {
    await followsPreference(['cs-inline', 'cs-sheet', 'cs-reversed']);
  } finally {
    await cleanup();
  }
});

test('only keeps its place, the other names are kept, and !important is kept', async () => {
  const cleanup = await inPage(
    [
      box('cs-only', 'style="color-scheme: only light dark"'),
      box('cs-only-first', 'style="color-scheme: only dark light"'),
      box('cs-only-last', 'style="color-scheme: dark light only"'),
      box('cs-named', 'style="color-scheme: light dark foo"'),
      box('cs-important', 'style="color-scheme: light dark !important"'),
      box('cs-sheet-only', 'class="cs-only-sheet"'),
    ].join(''),
    '.cs-only-sheet { color-scheme: only light dark !important }'
  );
  try {
    await followsPreference(['cs-only', 'cs-only-first', 'cs-only-last', 'cs-named', 'cs-important', 'cs-sheet-only']);
  } finally {
    await cleanup();
  }
});

test('a value naming one scheme, normal, or that Chrome does not read keeps what Chrome gives it', async () => {
  const ids = ['cs-light', 'cs-dark', 'cs-only-light', 'cs-only-dark', 'cs-normal', 'cs-bad', 'cs-bad-number'];
  const cleanup = await inPage(
    [
      box('cs-light', 'style="color-scheme: light"'),
      box('cs-dark', 'style="color-scheme: dark"'),
      box('cs-only-light', 'style="color-scheme: only light"'),
      box('cs-only-dark', 'style="color-scheme: only dark"'),
      box('cs-normal', 'style="color-scheme: normal"'),
      // Not valid (only in the middle, and a number): Chrome ignores them, the page's own scheme is light.
      box('cs-bad', 'style="color-scheme: light only dark"'),
      box('cs-bad-number', 'style="color-scheme: light dark 123"'),
    ].join('')
  );
  try {
    const shown = await sameOnBoth(side => underPreference(side, 'dark', () => readBoxes(ids)));
    assert.equal(shown['cs-dark']?.ct, 'rgb(255, 255, 255)');
    assert.equal(shown['cs-light']?.ct, 'rgb(0, 0, 0)');
    assert.equal(shown['cs-normal']?.ct, 'rgb(0, 0, 0)');
    assert.equal(shown['cs-bad']?.ct, 'rgb(0, 0, 0)');
    assert.equal(shown['cs-bad-number']?.ct, 'rgb(0, 0, 0)');
    assert.equal(shown['cs-only-dark']?.ct, 'rgb(255, 255, 255)');
    // Under the light preference they keep their scheme too: they do not follow it.
    const light = await sameOnBoth(side => underPreference(side, 'light', () => readBoxes(ids)));
    assert.equal(light['cs-dark']?.ct, 'rgb(255, 255, 255)');
    assert.equal(light['cs-only-dark']?.ct, 'rgb(255, 255, 255)');
    assert.equal(light['cs-light']?.ct, 'rgb(0, 0, 0)');
  } finally {
    await cleanup();
  }
});

test('an element inside one that names both schemes is in the scheme of its ancestor', async () => {
  const cleanup = await inPage(`<div id="cs-parent" style="color-scheme: light dark">${box('cs-child', '')}</div>`);
  try {
    await followsPreference(['cs-child']);
  } finally {
    await cleanup();
  }
});

test(':root naming both schemes is followed by what is in the page', async () => {
  const cleanup = await inPage(box('cs-in-root', ''), ':root { color-scheme: light dark }');
  try {
    await followsPreference(['cs-in-root']);
  } finally {
    await cleanup();
  }
});

test('a <meta name="color-scheme"> follows the preference, and so do the changes of its content', async () => {
  const cleanup = await inPage(box('cs-plain', ''));
  /** Puts a meta of `name` and `content` in the head, in place of the one of the test. */
  const setMeta = (name: string, content: string) => {
    const args: [string, string] = [name, content];
    return t.page.evaluate(([name, content]) => {
      document.querySelector('meta[data-cs]')?.remove();
      const meta = document.createElement('meta');
      meta.setAttribute('data-cs', '');
      meta.setAttribute('name', name);
      meta.setAttribute('content', content);
      document.head.append(meta);
    }, args);
  };
  const read = async (): Promise<Shown> => (await readBoxes(['cs-plain']))['cs-plain'] ?? null;
  try {
    for (const preference of PREFERENCES) {
      const steps = await sameOnBoth(side =>
        underPreference(side, preference, async () => {
          const seen: Shown[] = [];
          await setMeta('color-scheme', 'light dark');
          seen.push(await read());
          await setMeta('color-scheme', 'only light');
          seen.push(await read());
          await setMeta('color-scheme', 'only dark light');
          seen.push(await read());
          // The name is compared ASCII case-insensitively.
          await setMeta('COLOR-SCHEME', 'dark light');
          seen.push(await read());
          await setMeta('color-scheme', 'normal');
          seen.push(await read());
          await t.page.evaluate(() => document.querySelector('meta[data-cs]')?.remove());
          return seen;
        })
      );
      assert.deepEqual(steps, [SCHEME[preference], SCHEME.light, SCHEME[preference], SCHEME[preference], SCHEME.light]);
    }
  } finally {
    await t.page.evaluate(() => document.querySelector('meta[data-cs]')?.remove());
    await cleanup();
  }
});

test('a style the page sets through the CSSOM, and a rule it inserts, follow the preference', async () => {
  const cleanup = await inPage(box('cs-set', '') + box('cs-inserted', 'class="cs-inserted"'));
  try {
    for (const preference of PREFERENCES) {
      const shown = await sameOnBoth(side =>
        underPreference(side, preference, async () => {
          await t.page.evaluate(() => {
            const set = document.getElementById('cs-set');
            if (set) set.style.colorScheme = 'light dark';
            const sheet = document.createElement('style');
            sheet.id = 'cs-inserted-sheet';
            document.head.append(sheet);
            sheet.sheet?.insertRule('.cs-inserted { color-scheme: light dark }', 0);
          });
          return readBoxes(['cs-set', 'cs-inserted']);
        })
      );
      await t.page.evaluate(() => {
        document.getElementById('cs-inserted-sheet')?.remove();
        document.getElementById('cs-set')?.style.removeProperty('color-scheme');
      });
      assert.deepEqual(shown['cs-set'], SCHEME[preference]);
      assert.deepEqual(shown['cs-inserted'], SCHEME[preference]);
    }
  } finally {
    await t.page.evaluate(() => document.getElementById('cs-inserted-sheet')?.remove());
    await cleanup();
  }
});

test("the Styles pane, the sheet's text and the DOM show the page's own values, not the rewritten ones", async () => {
  const cleanup = await inPage(
    [box('cs-styles', 'style="color-scheme: light dark"'), box('cs-sheet-styles', 'class="cs-sheet-styles"')].join(''),
    '.cs-sheet-styles { color-scheme: light dark }'
  );
  await t.page.evaluate(() => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'color-scheme');
    meta.setAttribute('content', 'only light dark');
    meta.setAttribute('data-cs', '');
    document.head.append(meta);
  });
  try {
    const shown = await sameOnBoth(side =>
      underPreference(side, 'dark', async () => {
        await side.send('DOM.enable');
        await side.send('CSS.enable');
        const { root } = await side.send('DOM.getDocument', {});
        const node = async (selector: string) =>
          (await side.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
        const inline = await side.send('CSS.getInlineStylesForNode', { nodeId: await node('#cs-styles') });
        const matched = await side.send('CSS.getMatchedStylesForNode', { nodeId: await node('#cs-sheet-styles') });
        const meta = await side.send('DOM.getAttributes', { nodeId: await node('meta[data-cs]') });
        const sheetId = (matched.matchedCSSRules ?? []).find(m => m.rule.origin === 'regular')?.rule.styleSheetId;
        const sheet = sheetId ? await side.send('CSS.getStyleSheetText', { styleSheetId: sheetId }) : undefined;
        await side.send('CSS.disable');
        await side.send('DOM.disable');
        return {
          inline: inline.inlineStyle?.cssProperties.filter(p => p.name === 'color-scheme').map(p => p.value),
          matched: (matched.matchedCSSRules ?? []).flatMap(m =>
            m.rule.style.cssProperties.filter(p => p.name === 'color-scheme').map(p => p.value)
          ),
          meta: meta.attributes.slice(meta.attributes.indexOf('content') + 1)[0],
          sheet: sheet?.text,
        };
      })
    );
    // Each style lists its declared value, and then the longhand it holds: both are the page's own.
    assert.deepEqual(shown.inline, ['light dark', 'light dark']);
    assert.deepEqual(shown.matched, ['light dark', 'light dark']);
    assert.equal(shown.meta, 'only light dark');
    assert.match(shown.sheet ?? '', /color-scheme: light dark/);
  } finally {
    await t.page.evaluate(() => document.querySelector('meta[data-cs]')?.remove());
    await cleanup();
  }
});
