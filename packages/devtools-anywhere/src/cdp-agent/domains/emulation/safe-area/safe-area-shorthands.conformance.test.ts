// Emulation of the safe area insets in shorthands the page writes: a shorthand whose one side the page changes keeps its
// other sides under the emulation, and a shorthand the browser reads as empty (a longhand after it) is compared by its
// text. Chrome and we both act on the same page, as safe-area.conformance.test.ts does.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, sameOnBoth, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../../test-support/conformance.ts';

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

// A shorthand with env() (or var()) in a rule, with a longhand of its group after it: the browser writes the block
// back as longhands with no value, so the shorthand's text is in no serialization of the rule, and the emulation
// rewrites the block from the text the page wrote it in, where that text is known. Without `ALWAYS`
// (written-blocks.ts) the text of a sheet is not taken: such a block is emulated as in Chrome or not at all, and
// reads as in Chrome once the emulation ends. Each block is written the five ways a page writes a rule, and styles
// an element of each direction.
const TOP = 'env(safe-area-inset-top)';
const LEFT = 'env(safe-area-inset-left)';
const PENDING: Record<string, string> = {
  padding: `padding: ${TOP} 2px; padding-left:3px`,
  longhandFirst: `padding-left:3px; padding: ${TOP} 2px`,
  alone: `padding: ${TOP} 2px`,
  twice: `padding:1px; padding: ${TOP} 4px; padding-left:3px`,
  insetTop: `inset: ${TOP}; top:1px`,
  insetLeft: `inset: ${TOP}; left:1px`,
  margin: `margin: ${TOP} 2px; margin-left:3px`,
  borderWidth: `border-width: ${TOP} 2px; border-left-width:3px`,
  scrollPadding: `scroll-padding: ${TOP} 2px; scroll-padding-left:3px`,
  max: `padding: max(${TOP},8px) 16px; padding-bottom:0`,
  logicalAfter: `padding: ${TOP} 2px; padding-inline-start:3px`,
  logicalShorthand: `padding-inline: ${TOP} 2px; padding-inline-end:3px`,
  important: `padding: ${TOP} 2px !important; padding-left:3px !important; color: red`,
  // A var() shorthand between a logical longhand and a physical one: its sides have no value to be set with.
  between: `--x:3px; padding-inline-start: ${LEFT}; padding: var(--x); padding-left: 2px`,
  betweenMargin: `--x:3px; margin-inline-start: ${LEFT}; margin: var(--x); margin-left: 2px`,
  betweenBorder: `--x:3px; border-inline-start-width: ${LEFT}; border-width: var(--x); border-left-width: 2px`,
  betweenInset: `--x:3px; inset-inline-start: ${LEFT}; inset: var(--x); left: 2px`,
  betweenLonghand: `--x:3px; padding-inline-start: ${LEFT}; padding-left: var(--x)`,
};
/** What the page does to each rule's style while the emulation runs. */
const PENDING_SETS: Record<string, string> = {
  color: `style.setProperty('color', 'blue')`,
  // The last property the block declares, set again: in place.
  last: `style.setProperty(style[style.length - 1], '4px')`,
  logical: `style.setProperty('padding-inline-end', '4px')`,
};
const WAYS = ['style', 'link', 'nested', 'constructed', 'insert'] as const;
const DIRECTIONS = ['direction: ltr', 'direction: rtl', 'writing-mode: vertical-rl'];

/** Writes `block` in a rule each way, with an element of each direction for each rule. */
const writePending = (block: string) =>
  t.page.evaluate(
    async (block, ways, directions) => {
      const add = (id: string, text: string) => {
        const style = document.createElement('style');
        style.id = id;
        style.className = 'sp';
        style.textContent = text;
        document.head.appendChild(style);
        return style;
      };
      add('sp-base', '.sp-el { position: relative; border: 0 solid; width: 50px; height: 20px }');
      add('sp-style', `.sp-style { ${block} }`);
      add('sp-nested', `.sp-nested { color: green; & { ${block} } }`);
      add('sp-insert', '').sheet?.insertRule(`.sp-insert { ${block} }`, 0);
      const constructed = new CSSStyleSheet();
      constructed.replaceSync(`.sp-constructed { ${block} }`);
      document.adoptedStyleSheets = [constructed];
      const link = document.createElement('link');
      link.id = 'sp-link';
      link.className = 'sp';
      link.rel = 'stylesheet';
      link.href = URL.createObjectURL(new Blob([`.sp-link { ${block} }`], { type: 'text/css' }));
      const loaded = new Promise(resolve => link.addEventListener('load', resolve));
      document.head.appendChild(link);
      await loaded;
      for (const way of ways)
        directions.forEach((direction, i) =>
          document.body.insertAdjacentHTML(
            'beforeend',
            `<div class="sp sp-el sp-${way}" id="sp-${way}-${i}" style="${direction}">sp</div>`
          )
        );
    },
    block,
    WAYS,
    DIRECTIONS
  );

const removePending = () =>
  t.page.evaluate(() => {
    document.querySelectorAll('.sp').forEach(el => el.remove());
    document.adoptedStyleSheets = [];
  });

/** The rules of writePending, by the way each was written: run in the page. */
const PENDING_RULES = `(() => {
  const first = id => document.getElementById(id).sheet.cssRules[0];
  return {
    style: first('sp-style'),
    link: first('sp-link'),
    nested: first('sp-nested').cssRules[0],
    constructed: document.adoptedStyleSheets[0].cssRules[0],
    insert: first('sp-insert'),
  };
})()`;

const readPending = () =>
  t.page.evaluate(`(() => {
    const rules = ${PENDING_RULES};
    const out = {};
    for (const [way, rule] of Object.entries(rules)) {
      const boxes = [...document.querySelectorAll('.sp-' + way)].map(el => {
        const c = getComputedStyle(el);
        return [c.padding, c.margin, c.borderWidth, c.inset, c.scrollPadding, c.color].join(' | ');
      });
      out[way] = { order: Array.from(rule.style), text: rule.style.cssText, boxes };
    }
    return out;
  })()`) as Promise<Record<string, { order: string[]; text: string; boxes: string[] }>>;

// A known limit (docs/limitations.md, Order of declarations and Partial changes): a rule not known by the page's
// writes, with a logical property before a var() shorthand whose side is set after it, is written a declaration at
// a time once the page writes it: the logical property is listed after the shorthand's sides, wins over them where
// it sets the same side, and keeps its var() text once the emulation ends.
const BETWEEN = 'a logical property before the sides of a pending shorthand (docs/limitations.md)';
for (const [name, block] of Object.entries(PENDING))
  for (const [set, write] of Object.entries(PENDING_SETS))
    test(
      `a shorthand with env() and a longhand after it is emulated as in Chrome (${name}, ${set})`,
      /^between(?!Longhand)/.test(name) ? { todo: BETWEEN } : {},
      async () => {
        const run = async (side: (typeof t)['chrome']) => {
          await writePending(block);
          try {
            const moments: Record<string, Awaited<ReturnType<typeof readPending>>> = {};
            moments['bare'] = await readPending();
            // The text of the rule is the emulation's while it runs: the order and the values are compared then.
            const during = async (moment: string) => {
              const read = await readPending();
              for (const way of Object.values(read)) way.text = '';
              moments[moment] = read;
            };
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
            // Longer than it takes to fetch the text of the sheet of a file.
            await new Promise(resolve => setTimeout(resolve, 150));
            await during('on');
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20, left: 7 } });
            await settle();
            await during('changed');
            await t.page.evaluate(
              `for (const rule of Object.values(${PENDING_RULES})) { const style = rule.style; ${write} }`
            );
            await new Promise(resolve => setTimeout(resolve, 100));
            await during('written');
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
            await settle();
            moments['off'] = await readPending();
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
            await settle();
            await during('again');
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
            await settle();
            moments['last'] = await readPending();
            return moments;
          } finally {
            await removePending();
          }
        };
        const r = await run(t.chrome);
        const ours = await run(t.ours);
        // Once the emulation ends, the page's rules read as in Chrome: text, order and values.
        for (const moment of ['bare', 'off', 'last'])
          for (const way of WAYS) assert.deepEqual(ours[moment]?.[way], r[moment]?.[way], `${moment}, ${way}`);
        // While it runs, each element is emulated as in Chrome or not at all: as the rule reads without the emulation
        // before the page's write (`bare`) and after it (`off`).
        const unemulated = { on: 'bare', changed: 'bare', written: 'off', again: 'off' };
        for (const [moment, bare] of Object.entries(unemulated))
          for (const way of WAYS)
            ours[moment]?.[way]?.boxes.forEach((box, i) =>
              assert.ok(
                box === r[moment]?.[way]?.boxes[i] || box === ours[bare]?.[way]?.boxes[i],
                `${moment}, ${way} ${i}: ${box}, Chrome ${r[moment]?.[way]?.boxes[i]}`
              )
            );
        // The emulation shows: the inset is in the values while it runs, and not once it ends. Not where the var()
        // shorthand after the env() sets every side over it, in each direction.
        if (/^between(?!Longhand)/.test(name)) return;
        assert.notDeepEqual(r['on']?.['style']?.boxes, r['off']?.['style']?.boxes);
        assert.notDeepEqual(r['on']?.['style']?.boxes, r['changed']?.['style']?.boxes);
      }
    );

const LISTED = 'the longhands listed for a rule rewritten by its own text (docs/limitations.md)';
for (const name of ['max', 'between'])
  test(
    `the Styles pane shows a shorthand with env() and a longhand after it as the page wrote it (${name})`,
    name === 'between' ? { todo: LISTED } : {},
    async () => {
      const run = async (side: (typeof t)['chrome']) => {
        await writePending(PENDING[name] ?? '');
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20, left: 6 } });
        await new Promise(resolve => setTimeout(resolve, 150));
        await side.send('DOM.enable');
        await side.send('CSS.enable');
        try {
          const { root } = await side.send('DOM.getDocument', {});
          const out: Record<string, unknown> = {};
          for (const way of WAYS) {
            const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#sp-${way}-0` });
            const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
            out[way] = (matchedCSSRules ?? [])
              .filter(m => /^(&|\.sp-(?!el))/.test(m.rule.selectorList.text))
              .map(({ rule }) => ({
                selector: rule.selectorList.text,
                text: rule.style.cssText,
                properties: rule.style.cssProperties.map(p => [p.name, p.value, p.text ?? null, p.implicit ?? false]),
                // The names alone: the value Chrome gives a shorthand whose sides do not share one is empty, where we
                // give the one written, with or without the emulation.
                shorthands: rule.style.shorthandEntries.map(entry => entry.name),
              }));
          }
          return out;
        } finally {
          await side.send('CSS.disable');
          await side.send('DOM.disable');
          await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
          await removePending();
        }
      };
      const r = await run(t.chrome);
      const ours = await run(t.ours);
      // The rules of a sheet's own text: each declaration as written, and the longhands the rule holds.
      for (const way of ['style', 'link', 'nested']) assert.deepEqual(ours[way], r[way], way);
      assert.match(JSON.stringify(r['style']), /"padding(-inline-start)?: (max\()?env\(safe-area-inset-(top|left)\)/);
      // A sheet the page made through the CSSOM is shown serialized, by Chrome and by us: nothing of the emulation's.
      assert.doesNotMatch(JSON.stringify(ours), /--da-sai/);
    }
  );

// The other ways a page comes to such a block, and what it does to one: `sheet` is the sheet of a <style> whose
// text is `#pw { color: red } .pw { padding: env(safe-area-inset-top) 2px; padding-left: 3px } .pw-other {}`,
// and `plain` and `rule` its first two rules.
const BLOCK = `padding: ${TOP} 2px; padding-left: 3px`;
const PAGE_WAYS: Record<string, { before?: string; during?: string }> = {
  textDuring: { during: `plain.style.cssText = 'margin: ${TOP} 2px; margin-left: 3px'` },
  textAgain: { during: `rule.style.cssText = 'padding: ${LEFT} 2px; padding-left: 3px'` },
  nestedInsert: { before: `plain.insertRule('& { margin: ${TOP} 2px; margin-left: 3px }')` },
  nestedInsertDuring: { during: `plain.insertRule('& { margin: ${TOP} 2px; margin-left: 3px }')` },
  groupInsert: {
    before: `sheet.insertRule('@media all {}', 3); sheet.cssRules[3].insertRule('.pw { margin: ${TOP} 2px; margin-left: 3px }')`,
  },
  replace: {
    before: `const made = new CSSStyleSheet(); document.adoptedStyleSheets = [made];
      await made.replace('.pw { margin: ${TOP} 2px; margin-left: 3px }')`,
  },
  replaceDuring: {
    during: `const made = new CSSStyleSheet(); document.adoptedStyleSheets = [made];
      made.replaceSync('.pw { margin: ${TOP} 2px; margin-left: 3px }')`,
  },
  // The rules of the sheet's text are found in it past one the page inserted.
  rulesMoved: { before: `sheet.insertRule('.pw { color: green }', 0); sheet.insertRule('.pw { color: green }', 2)` },
  setBefore: { before: `rule.style.setProperty('color', 'blue')` },
  namedDuring: { during: `rule.style.paddingRight = '9px'` },
  // The shorthand set again to another env(), and the longhand after it: the rule reads as before.
  setAgain: {
    during: `rule.style.setProperty('padding', '${LEFT} 2px'); rule.style.setProperty('padding-left', '3px')`,
  },
  // What a declaration after the text does not say: the block is the page's from then on, and nothing is lost.
  removeDuring: { during: `rule.style.removeProperty('padding-left')` },
  wholeDuring: { during: `rule.style.setProperty('padding', '1px')` },
  // The text is not the rule's once a declaration is removed, though the rule comes to read as that text again.
  removedThenSet: {
    during: `rule.style.removeProperty('padding-left');
      rule.style.setProperty('padding', '${LEFT} 2px'); rule.style.setProperty('padding-left', '3px')`,
  },
  builtDuring: {
    during: `plain.style.setProperty('margin', '${TOP} 2px'); plain.style.setProperty('margin-left', '3px')`,
  },
  setTwice: {
    during: `rule.style.setProperty('--n', '1'); rule.style.setProperty('color', 'blue');
      await new Promise(resolve => setTimeout(resolve, 20));
      rule.style.setProperty('--n', '2'); rule.style.setProperty('color', 'green', 'important')`,
  },
};
for (const [name, { before, during }] of Object.entries(PAGE_WAYS))
  test(`a block with a pending shorthand that the page writes through the CSSOM is emulated as in Chrome (${name})`, async () => {
    const read = () =>
      t.page.evaluate(() => {
        const el = document.getElementById('pw');
        const sheet = document.getElementById('pw-sheet');
        const c = getComputedStyle(el ?? document.body);
        const texts: string[] = [];
        const orders: string[][] = [];
        const visit = (rules: CSSRuleList) => {
          for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
              texts.push(rule.style.cssText);
              orders.push(Array.from(rule.style));
            }
            if ('cssRules' in rule) visit(rule.cssRules as CSSRuleList);
          }
        };
        if (sheet instanceof HTMLStyleElement && sheet.sheet) visit(sheet.sheet.cssRules);
        for (const made of document.adoptedStyleSheets) visit(made.cssRules);
        return { box: [c.padding, c.margin, c.color, c.getPropertyValue('--n')], orders, texts };
      });
    const script = (code: string | undefined) =>
      t.page.evaluate(`(async () => {
        const sheet = document.getElementById('pw-sheet').sheet;
        const [plain, rule] = sheet.cssRules;
        ${code ?? ''}
      })()`);
    const run = async (side: (typeof t)['chrome']) => {
      await t.page.evaluate(block => {
        const style = document.createElement('style');
        style.id = 'pw-sheet';
        style.textContent = `#pw { color: red } .pw { ${block} } .pw-other {}`;
        document.head.appendChild(style);
        document.body.insertAdjacentHTML('beforeend', '<div id="pw" class="pw">pw</div>');
      }, BLOCK);
      try {
        await script(before);
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
        await settle();
        await script(during);
        await new Promise(resolve => setTimeout(resolve, 100));
        const on = await read();
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
        await settle();
        const off = await read();
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 7, left: 8 } });
        await settle();
        const again = await read();
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
        await settle();
        // The texts are the emulation's while it runs.
        return { on: { ...on, texts: [] }, off, again: { ...again, texts: [] }, last: await read() };
      } finally {
        await t.page.evaluate(() => {
          document.querySelectorAll('#pw, #pw-sheet').forEach(el => el.remove());
          document.adoptedStyleSheets = [];
        });
      }
    };
    const r = await run(t.chrome);
    const ours = await run(t.ours);
    // As in Chrome once the emulation ends; while it runs, as in Chrome or not emulated.
    assert.deepEqual([ours.off, ours.last], [r.off, r.last]);
    for (const [moment, bare] of [
      ['on', 'off'],
      ['again', 'last'],
    ] as const)
      for (const i of [0, 1])
        assert.ok(
          ours[moment].box[i] === r[moment].box[i] || ours[moment].box[i] === ours[bare].box[i],
          `${moment}: ${ours[moment].box[i]}, Chrome ${r[moment].box[i]}`
        );
    assert.deepEqual(ours.on.box.slice(2), r.on.box.slice(2));
    if (name !== 'wholeDuring') assert.notDeepEqual(r.on.box, r.off.box);
  });

test('an edit of the Styles pane that leaves a pending shorthand with another env() is emulated as in Chrome', async () => {
  const read = () =>
    t.page.evaluate(() => {
      const sheet = document.getElementById('ed-sheet');
      const rule = sheet instanceof HTMLStyleElement ? sheet.sheet?.cssRules[0] : undefined;
      return {
        padding: getComputedStyle(document.getElementById('ed') ?? document.body).padding,
        text: rule instanceof CSSStyleRule ? rule.style.cssText : null,
      };
    });
  // Before the edit, per side: Chrome's, then ours.
  const befores: string[] = [];
  const r = await sameOnBoth(t, async side => {
    await t.page.evaluate(block => {
      const style = document.createElement('style');
      style.id = 'ed-sheet';
      style.textContent = `#ed { ${block} }`;
      document.head.appendChild(style);
      document.body.insertAdjacentHTML('beforeend', '<div id="ed">ed</div>');
    }, BLOCK);
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
    await side.send('DOM.enable');
    await side.send('CSS.enable');
    try {
      const { root } = await side.send('DOM.getDocument', {});
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#ed' });
      const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
      const style = (matchedCSSRules ?? []).find(m => m.rule.selectorList.text === '#ed')?.rule.style;
      assert.ok(style?.styleSheetId && style.range);
      const before = (await read()).padding;
      // The block reads the same once edited: only its text tells the env() is another.
      const text = ` padding: ${LEFT} 2px; padding-left: 3px `;
      await side.send('CSS.setStyleTexts', {
        edits: [{ styleSheetId: style.styleSheetId, range: style.range, text }],
      });
      await settle();
      const edited = (await read()).padding;
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      const off = await read();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 7, left: 8 } });
      await settle();
      befores.push(before);
      return { edited, off, again: (await read()).padding };
    } finally {
      await side.send('CSS.disable');
      await side.send('DOM.disable');
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await t.page.evaluate(() => document.querySelectorAll('#ed, #ed-sheet').forEach(el => el.remove()));
    }
  });
  // The rule of the <style> is not known before the edit (written-blocks.ts, ALWAYS): it is not emulated then. The
  // edit gives its text, which is.
  assert.deepEqual([r.edited, r.off.padding, r.again], ['6px 2px 6px 3px', '0px 2px 0px 3px', '8px 2px 8px 3px']);
  assert.equal(befores[0], '5px 2px 5px 3px');
  assert.ok(['5px 2px 5px 3px', '0px 2px 0px 3px'].includes(befores[1] ?? ''), befores[1]);
});
