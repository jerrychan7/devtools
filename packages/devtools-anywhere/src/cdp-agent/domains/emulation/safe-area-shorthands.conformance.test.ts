// Emulation of the safe area insets in shorthands the page writes: a shorthand whose one side the page changes keeps its
// other sides under the emulation, and a shorthand the browser reads as empty (a longhand after it) is compared by its
// text. Chrome and we both act on the same page, as safe-area.conformance.test.ts does.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, sameOnBoth, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['DOM.attributeModified', 'DOM.attributeRemoved', 'CSS.styleSheetChanged']);
  },
  () => env?.close()
);

// Whatever a test left on either side (the emulation, CSS, DOM), failed or not, is ended before the next one.
afterEach(async () => {
  for (const side of [t.chrome, t.ours]) {
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} }).catch(() => {});
    await side.send('CSS.disable').catch(() => {});
    await side.send('DOM.disable').catch(() => {});
  }
});

const settle = () => t.page.evaluate(() => new Promise(r => setTimeout(r)));

test('a shorthand the page changes one side of keeps its other sides under the emulation, and after it', async () => {
  // Both sides start from these elements, made anew: the page's changes of one side stay in it.
  const fresh = () =>
    t.page.evaluate(() => {
      document.getElementById('partial-sheet')?.remove();
      document.getElementById('partial')?.remove();
      document.getElementById('partial-rule')?.remove();
      const style = document.createElement('style');
      style.id = 'partial-sheet';
      style.textContent =
        '.partial-rule { padding: env(safe-area-inset-top, 1px) env(safe-area-inset-right, 2px) 0 0 }';
      document.head.appendChild(style);
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="partial" style="padding: env(safe-area-inset-top, 1px) env(safe-area-inset-right, 2px) 0 0">p</div>' +
          '<div id="partial-rule" class="partial-rule">r</div>'
      );
    });
  const read = (id: string) =>
    t.page.evaluate(id => {
      const el = document.getElementById(id);
      const style = getComputedStyle(el ?? document.body);
      return { top: style.paddingTop, left: style.paddingLeft };
    }, id);
  try {
    const r = await sameOnBoth(t, async side => {
      await fresh();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // The page writes the left side alone, of an inline style and of a rule's style.
      await t.page.evaluate(() => {
        const el = document.getElementById('partial');
        if (el) el.style.paddingLeft = '1px';
        const style = document.getElementById('partial-sheet');
        const rule = style instanceof HTMLStyleElement ? style.sheet?.cssRules[0] : undefined;
        if (rule instanceof CSSStyleRule) rule.style.paddingLeft = '3px';
      });
      await settle();
      const during = [await read('partial'), await read('partial-rule')];
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      return { during, after: [await read('partial'), await read('partial-rule')] };
    });
    // The top side is the inset while it is emulated, and the real one, 0, once it ends.
    assert.deepEqual(r.during, [
      { top: '5px', left: '1px' },
      { top: '5px', left: '3px' },
    ]);
    assert.deepEqual(r.after, [
      { top: '0px', left: '1px' },
      { top: '0px', left: '3px' },
    ]);
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('partial-sheet')?.remove();
      document.getElementById('partial')?.remove();
      document.getElementById('partial-rule')?.remove();
    });
  }
});

test('a shorthand with env() keeps it when the page sets another declaration, the browser writing 0 as 0px', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="sh" style="margin: 0 env(safe-area-inset-right, 7px)">sh</div>'
    )
  );
  try {
    const r = await sameOnBoth(t, async side => {
      await t.page.evaluate(() =>
        document.getElementById('sh')?.setAttribute('style', 'margin: 0 env(safe-area-inset-right, 7px)')
      );
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { right: 6 } });
      await settle();
      // The page's script sets another declaration: the browser writes the whole block back, the 0 as 0px.
      await t.page.evaluate(() => {
        const el = document.getElementById('sh');
        if (el) el.style.opacity = '0.5';
      });
      await settle();
      const during = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('sh') ?? document.body).marginRight
      );
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      // A longhand of a shorthand with env() reads as empty (pending substitution): the declaration text is looked at.
      const after = await t.page.evaluate(() => {
        const style = document.getElementById('sh')?.style;
        return { env: style?.cssText.includes('env(safe-area-inset-right, 7px)') ?? false, opacity: style?.opacity };
      });
      return { during, after };
    });
    assert.equal(r.during, '6px');
    assert.deepEqual(r.after, { env: true, opacity: '0.5' });
  } finally {
    await t.page.evaluate(() => document.getElementById('sh')?.remove());
  }
});

test("a page's edit that gives a shorthand with env() a var() keeps the page's value, not the env() it had", async () => {
  // A shorthand with a longhand after it reads as empty (its sides do not share one value), in the rewrite's text and in
  // the page's alike: the values alone do not tell that the page changed it, the declared text does.
  const STYLE = 'padding: env(safe-area-inset-top, 7px) 0 0 0; padding-left: 3px';
  const EDIT = 'padding: var(--pv, 3px) 0 0 0; padding-left: 3px';
  const fresh = () =>
    t.page.evaluate(style => {
      document.getElementById('pvar')?.remove();
      const el = document.createElement('div');
      el.id = 'pvar';
      el.setAttribute('style', style);
      el.textContent = 'pvar';
      document.body.append(el);
    }, STYLE);
  const attribute = () => t.page.evaluate(() => document.getElementById('pvar')?.getAttribute('style') ?? null);
  try {
    const r = await sameOnBoth(t, async side => {
      await fresh();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      await t.page.evaluate(style => document.getElementById('pvar')?.setAttribute('style', style), EDIT);
      await settle();
      const during = {
        padding: await t.page.evaluate(
          () => getComputedStyle(document.getElementById('pvar') ?? document.body).paddingTop
        ),
        text: await attribute(),
      };
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      return { during, after: await attribute() };
    });
    // The page's var() falls back to 3px: that is what its shorthand gives while the emulation runs, and once it ends.
    assert.deepEqual(r, { during: { padding: '3px', text: EDIT }, after: EDIT });
  } finally {
    await t.page.evaluate(() => document.getElementById('pvar')?.remove());
  }
});

test("a page's change that leaves no env() in a rewritten declaration keeps the text the browser wrote", async () => {
  const fresh = () =>
    t.page.evaluate(() => {
      document.getElementById('serial')?.remove();
      const el = document.createElement('div');
      el.id = 'serial';
      el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)');
      el.textContent = 'serial';
      document.body.append(el);
    });
  try {
    const r = await sameOnBoth(t, async side => {
      await fresh();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // The page's new value needs no rewrite, so nothing of the emulation's is written: the attribute keeps the text
      // the browser serialized for the page's change, with its semicolon at the end.
      await t.page.evaluate(() => document.getElementById('serial')?.style.setProperty('padding-top', '0px'));
      await settle();
      const text = await t.page.evaluate(() => document.getElementById('serial')?.getAttribute('style') ?? null);
      const padding = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('serial') ?? document.body).paddingTop
      );
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      return { text, padding };
    });
    assert.deepEqual(r, { text: 'padding-top: 0px;', padding: '0px' });
  } finally {
    await t.page.evaluate(() => document.getElementById('serial')?.remove());
  }
});
