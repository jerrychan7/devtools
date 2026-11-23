// What the page writes over a text the safe area emulation rewrote (a style attribute, a rule's declarations),
// and what it reads once the emulation ends: the same as under Chrome's own emulation, on the same page. Each
// side emulates, lets the page write, and clears in turn.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
  },
  () => env?.close()
);

// Whatever a test left on either side, failed or not, is ended before the next one.
afterEach(async () => {
  for (const side of [t.chrome, t.ours])
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} }).catch(() => {});
});

const settle = () => t.page.evaluate(() => new Promise(r => setTimeout(r)));

/** What the page writes to #wr, an element with an inline style, and to the rules of #wr-sheet. */
const WRITES: Record<string, string> = {
  // A function that is not closed, in a rule: the semicolon the browser writes after it is not its own.
  rule: `rule.style.cssText = 'padding-left: env(safe-area-inset-left, 2px); color:red; --x: foo(a;b'`,
  inline: `el.style.cssText = 'padding-left: env(safe-area-inset-left, 2px); --x: foo(a;b'`,
  // A comment that is not closed, and empty declarations: the attribute is the page's text, byte for byte.
  comment: `el.setAttribute('style', 'color:red; padding-left: env(safe-area-inset-left, 2px); /* x; background-color: blue')`,
  empties: `el.setAttribute('style', ';;color:red;; ;padding-left: env(safe-area-inset-left, 2px);;')`,
  // A style the page sets as text after an edit of one property: the browser's text, its last semicolon included.
  cssom: `el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px); margin: 0');
    el.style.setProperty('color', 'red');
    await new Promise(resolve => setTimeout(resolve));
    el.style.cssText = 'padding-top: env(safe-area-inset-top, 9px); --x: "/*;*/"'`,
  // A property set after the attribute: the env() takes its value back as the page wrote it.
  edited: `el.setAttribute('style', 'PADDING-TOP:env(safe-area-inset-top, 7px);;color:blue');
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('margin', '1px')`,
  // A value left open in the attribute the page set, then a property set through the CSSOM: the browser writes the
  // new declaration after the open value, where the text read again would take it into that value.
  openFunction: `el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 1px); --x: f(a');
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openString: `el.style.cssText = 'padding-top: env(safe-area-inset-top, 1px); --x: "a';
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openQuote: `el.style.cssText = "padding-top: env(safe-area-inset-top, 1px); --x: 'a";
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openBracket: `el.style.cssText = 'padding-top: env(safe-area-inset-top, 1px); --x: [a';
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openBrace: `el.style.cssText = 'padding-top: env(safe-area-inset-top, 1px); --x: {a';
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openUrl: `el.style.cssText = 'padding-top: env(safe-area-inset-top, 1px); --x: url(abc';
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openThenEnv: `el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 1px); --x: f(a');
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('padding-left', 'env(safe-area-inset-left, 3px)');
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('color', 'blue')`,
  openInRule: `rule.style.cssText = 'padding-left: env(safe-area-inset-left, 2px); --x: f(a';
    await new Promise(resolve => setTimeout(resolve, 50));
    rule.style.setProperty('color', 'blue')`,
  // The same in an SVG element, whose style attribute is set as text.
  openInSvg: `el.innerHTML = '<svg><rect id="wr-in"/></svg>';
    const rect = el.querySelector('rect');
    rect.setAttribute('style', 'padding-top: env(safe-area-inset-top, 1px); --x: f(a');
    await new Promise(resolve => setTimeout(resolve, 50));
    rect.style.setProperty('color', 'blue')`,
  // A declaration the emulation did not change keeps the text the browser wrote for it, not the page's.
  serialized: `el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 1px); color: rgb(1,0,0)');
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('margin-left', '2px')`,
  // The priority of a declaration the emulation changed is written as the browser writes it.
  priority: `el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 1px) !IMPORTANT; color:red');
    await new Promise(resolve => setTimeout(resolve, 50));
    el.style.setProperty('margin-left', '2px')`,
  // A rule the sheet's text gave an !important declaration before a plain one keeps the order of the two, changed
  // by the page or not: its text set whole would be read with the !important one last.
  ruleOrder: `second.style.setProperty('color', 'blue')`,
  ruleUntouched: ``,
};
const read = () =>
  t.page.evaluate(() => {
    const el = document.getElementById('wr');
    const sheet = document.getElementById('wr-sheet');
    const rule = sheet instanceof HTMLStyleElement ? sheet.sheet?.cssRules[0] : undefined;
    const second = sheet instanceof HTMLStyleElement ? sheet.sheet?.cssRules[1] : undefined;
    const style = getComputedStyle(el ?? document.body);
    const inner = document.getElementById('wr-in');
    const innerStyle = inner && getComputedStyle(inner);
    return {
      attribute: el?.getAttribute('style'),
      rule: rule instanceof CSSStyleRule ? rule.style.cssText : null,
      second: second instanceof CSSStyleRule ? second.style.cssText : null,
      x: style.getPropertyValue('--x'),
      padding: `${style.paddingTop} ${style.paddingLeft}`,
      color: style.color,
      marginLeft: style.marginLeft,
      inner: inner && innerStyle && [inner.getAttribute('style'), innerStyle.getPropertyValue('--x'), innerStyle.color],
    };
  });
for (const [name, write] of Object.entries(WRITES))
  test(`a text the page writes under the emulation reads as in Chrome once the emulation ends (${name})`, async () => {
    const run = async (side: Side) => {
      await t.page.evaluate(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<div id="wr" class="wr" style="padding-top: env(safe-area-inset-top, 1px)">wr</div>'
        );
        const style = document.createElement('style');
        style.id = 'wr-sheet';
        style.textContent =
          '.wr { padding-left: env(safe-area-inset-left, 1px) }' +
          '.wr-second { padding-left: env(safe-area-inset-left, 1px) !important; color: red }';
        document.head.appendChild(style);
      });
      try {
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
        await settle();
        await t.page.evaluate(
          `(async () => {
          const el = document.getElementById('wr');
          const [rule, second] = document.getElementById('wr-sheet').sheet.cssRules;
          ${write}
        })()`
        );
        // Longer than the wait of a rewrite the page's writes hold back.
        await new Promise(resolve => setTimeout(resolve, 300));
        const during = await read();
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
        await settle();
        // The attribute and the rule read the emulation's text while it runs: only the values are compared then.
        const values = { x: during.x, padding: during.padding, color: during.color, inner: during.inner?.slice(1) };
        return { during: values, after: await read() };
      } finally {
        await t.page.evaluate(() => document.querySelectorAll('#wr, #wr-sheet').forEach(el => el.remove()));
      }
    };
    const r = await run(t.chrome);
    const ours = await run(t.ours);
    if (name === 'openThenEnv') {
      // What the page declares after an open value is not rewritten (docs/limitations.md): its inset is not emulated
      // while the emulation runs. Nothing is lost: once it ends, the page reads as under Chrome's.
      assert.deepEqual(ours.after, r.after);
      assert.deepEqual([r.during.padding, ours.during.padding], ['5px 6px', '5px 0px']);
    } else assert.deepEqual(ours, r);
    assert.equal(
      r.after.second,
      'padding-left: env(safe-area-inset-left, 1px) !important; color: ' + (name === 'ruleOrder' ? 'blue;' : 'red;')
    );
    if (name === 'comment')
      assert.equal(
        r.after.attribute,
        'color:red; padding-left: env(safe-area-inset-left, 2px); /* x; background-color: blue'
      );
    if (name === 'rule') assert.equal(r.after.x, 'foo(a;b');
  });

// The order of a block's declarations (`style[i]`) while the emulation runs, after the page sets a property, and
// once the emulation ends, with the text read then. Chrome moves a property set where a later declaration is its
// logical or physical counterpart (padding-inline-start before padding-top) to the end of the block, so a rewrite
// that sets such a property puts the block's order back.
const L = 'env(safe-area-inset-left, 1px)';
const T = 'env(safe-area-inset-top, 1px)';
const BLOCKS: Record<string, string> = {
  logicalFirst: `padding-inline-start: ${L}; overflow-wrap: break-word; padding-top: ${T}`,
  logicalMiddle: `color: red; padding-inline-start: ${L}; overflow-wrap: break-word; padding-top: 3px; margin: 0`,
  logicalLast: `padding-top: ${T}; overflow-wrap: break-word; padding-inline-start: ${L}`,
  important: `padding-inline-start: ${L} !important; overflow-wrap: break-word; padding-top: ${T}; color: red`,
  importantPhysical: `padding-top: ${T} !important; padding-inline-start: ${L}; overflow-wrap: break-word`,
  logicalShorthand: `padding-inline: ${L} ${T}; overflow-wrap: break-word; padding-top: ${T}; color: red`,
  physicalShorthand: `padding: ${T} 2px; overflow-wrap: break-word; padding-inline-start: 3px`,
  border: `border: ${T} solid red; overflow-wrap: break-word; border-inline-start-width: 2px`,
  inset: `inset-inline-start: ${L}; position: relative; top: ${T}; inline-size: ${L}; color: red; height: 9px`,
  margins: `margin-block: ${T}; margin-left: ${L}; overflow-wrap: break-word; margin-inline-end: ${L}`,
  // A physical longhand after the logical one, which the browser writes into the shorthand before both: the
  // block's text no longer tells the order the cascade goes by.
  paddingAround: `padding: 1px; padding-inline-start: ${L}; padding-left: 2px`,
  marginAround: `margin: 1px; margin-inline-start: ${L}; margin-left: 2px`,
  insetAround: `position: relative; inset: 1px; inset-inline-start: ${L}; left: 2px`,
  shorthandAfter: `padding-inline-start: ${L}; padding: 1px; padding-left: 2px; color: red`,
  shorthandImportant: `padding: 1px !important; padding-inline-start: ${L} !important; padding-left: 2px !important`,
  // A shorthand whose value is pending: its sides have no value of their own to set.
  pendingAround: `--x: 1px; padding: var(--x); padding-inline-start: ${L}; padding-left: 2px`,
  pendingAfter: `--x: 1px; padding-inline-start: ${L}; overflow-wrap: break-word; padding: var(--x) 3px`,
  // A custom property with no value, after the logical property: it is added again as it was.
  emptyCustom: `padding-inline-start: ${L}; --e:; padding-left: 2px`,
  // The sides of a pending shorthand of which one was set after it: they have no value to be added again with, and
  // the rule is set from the text it was written in.
  pendingBroken: `--x: 1px; padding-inline-start: ${L}; padding: var(--x); padding-left: 2px`,
  // A value left open, which the text read again would take the next declarations into: last in the block.
  openValue: `padding-inline-start: ${L}; overflow-wrap: break-word; padding-top: ${T}; --x: f(a`,
};
const PAGE_SETS: Record<string, string> = {
  untouched: '',
  color: `style.setProperty('color', 'blue')`,
  logical: `style.setProperty('padding-inline-end', '4px')`,
};
const readOrder = () =>
  t.page.evaluate(() => {
    const el = document.getElementById('od');
    const sheet = document.getElementById('od-sheet');
    const rule = sheet instanceof HTMLStyleElement ? sheet.sheet?.cssRules[0] : undefined;
    const computed = getComputedStyle(el ?? document.body);
    const boxOf = (c: CSSStyleDeclaration) => [c.padding, c.margin, c.borderWidth, c.top, c.left, c.width];
    return {
      rule: rule instanceof CSSStyleRule ? Array.from(rule.style) : null,
      inline: el instanceof HTMLElement ? Array.from(el.style) : null,
      ruleText: rule instanceof CSSStyleRule ? rule.style.cssText : null,
      attribute: el?.getAttribute('style'),
      box: boxOf(computed),
      // The values of the element the rule alone styles.
      ruleBox: boxOf(getComputedStyle(document.getElementById('od-rule') ?? document.body)),
    };
  });
// A known limit (docs/limitations.md, Order of declarations): the rule's text keeps the logical property after the
// shorthand's sides once the emulation ends, where the page wrote the rule while the insets were emulated.
const BROKEN = 'a logical property before the sides of a pending shorthand (docs/limitations.md)';
for (const [block, declarations] of Object.entries(BLOCKS))
  for (const [set, write] of Object.entries(PAGE_SETS))
    test(
      `a rewritten block keeps the order of its declarations as in Chrome (${block}, ${set})`,
      block === 'pendingBroken' && set !== 'untouched' ? { todo: BROKEN } : {},
      async () => {
        const run = async (side: Side) => {
          await t.page.evaluate(text => {
            document.body.insertAdjacentHTML(
              'beforeend',
              `<div id="od" style="${text}">od</div><div id="od-rule" class="od">od</div>`
            );
            const style = document.createElement('style');
            style.id = 'od-sheet';
            style.textContent = `#od-none, .od { ${text} }`;
            document.head.appendChild(style);
          }, declarations);
          try {
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
            await settle();
            const on = await readOrder();
            await t.page.evaluate(
              `for (const style of [document.getElementById('od-sheet').sheet.cssRules[0].style,
              document.getElementById('od').style]) { ${write} }`
            );
            await new Promise(resolve => setTimeout(resolve, 300));
            const written = await readOrder();
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
            await settle();
            // The texts read the emulation's values while it runs: the order and the computed values are compared then.
            const shown = ({ rule, inline, box, ruleBox }: typeof on) => ({ rule, inline, box, ruleBox });
            const after = await readOrder();
            // Emulated a second time, the block the first emulation left is rewritten as the first one was.
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, left: 6 } });
            await settle();
            const again = await readOrder();
            await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
            await settle();
            return { on: shown(on), written: shown(written), after, again: shown(again), last: await readOrder() };
          } finally {
            await t.page.evaluate(() =>
              document.querySelectorAll('#od, #od-rule, #od-sheet').forEach(el => el.remove())
            );
          }
        };
        const r = await run(t.chrome);
        const ours = await run(t.ours);
        // Without `ALWAYS` (written-blocks.ts) the rule is not known by the text of its <style>: where its text does
        // not hold all it declares, it is rewritten by that text, a declaration at a time (docs/limitations.md, Order
        // of declarations, and Partial changes).
        const empties =
          block === 'logicalShorthand' ? set === 'logical' : /^(pendingAround|pendingBroken|emptyCustom)$/.test(block);
        const MOMENTS = ['on', 'written', 'after', 'again', 'last'] as const;
        // The rule's order and the computed values are Chrome's at each moment, whatever follows; but for the sides
        // of a pending shorthand of which another was set after it, ahead of which a logical property is listed
        // (pendingBroken), and for a side the page's write leaves unemulated (logicalShorthand, set while emulated).
        for (const moment of MOMENTS) {
          if (block === 'logicalShorthand' && set === 'logical' && moment === 'again') {
            // Rewritten by its own text: the sides it reads with no value stay as they are, the others are emulated.
          } else if (block === 'logicalShorthand' && set === 'logical' && moment !== 'on') {
            // Emulated as in Chrome, or as the block reads without the emulation.
            for (const key of ['ruleBox', 'box'] as const)
              assert.ok(
                JSON.stringify(ours[moment][key]) === JSON.stringify(r[moment][key]) ||
                  JSON.stringify(ours[moment][key]) === JSON.stringify(ours.after[key]),
                `${moment}, ${key}`
              );
          } else {
            assert.deepEqual(ours[moment].ruleBox, r[moment].ruleBox);
            assert.deepEqual(ours[moment].box, r[moment].box);
          }
          if (block !== 'pendingBroken') assert.deepEqual(ours[moment].rule, r[moment].rule);
          else
            assert.deepEqual(ours[moment].rule?.slice(1, 5), [
              'padding-top',
              'padding-right',
              'padding-bottom',
              'padding-inline-start',
            ]);
        }
        if (empties && set !== 'untouched') {
          // A block the browser writes with an empty value once the page has set a property of it (the sides of a
          // pending shorthand of which one was set since, a custom property with no value): its other declarations
          // keep their var() text once the emulation ends (docs/limitations.md, Partial changes), in the style
          // attribute and, where the page wrote it while the insets were emulated, in the rule. The text is Chrome's
          // but for the var() around each env().
          const unwrapped = (text: string | null | undefined) =>
            text?.replace(/var\(--da-sai-[a-z-]+, (env\([^()]*\))\)/g, '$1');
          for (const moment of ['after', 'last'] as const) {
            assert.equal(unwrapped(ours[moment].ruleText), r[moment].ruleText);
            assert.equal(unwrapped(ours[moment].attribute), r[moment].attribute);
          }
          assert.match(r.after.attribute ?? '', /(padding-inline-start|padding-top|--e): ; /);
        } else if (block !== 'pendingBroken') assert.deepEqual(ours, r);
        else assert.equal(ours.after.attribute, r.after.attribute);
      }
    );
