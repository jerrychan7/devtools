// Emulation of the safe area insets in blocks whose text the browser does not give back (a shorthand with env() and
// a longhand after it), where what the page wrote must be known to rewrite them: a block is emulated as Chrome
// emulates it, or it is not emulated and is left as the page wrote it, which Chrome's own emulation then shows.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['DOM.attributeModified', 'CSS.styleSheetAdded']);
  },
  () => env?.close()
);

afterEach(async () => {
  for (const side of [t.chrome, t.ours]) {
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} }).catch(() => {});
    await side.send('CSS.disable').catch(() => {});
    await side.send('DOM.disable').catch(() => {});
  }
  await t.page.evaluate(() => {
    document.querySelectorAll('.sw').forEach(el => el.remove());
    document.adoptedStyleSheets = [];
  });
});

const TOP = 'env(safe-area-inset-top)';
const LEFT = 'env(safe-area-inset-left)';
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/** The paddings and margins of the elements of the test, by id, and the texts of the rules and style attributes. */
const read = () =>
  t.page.evaluate(() => {
    const boxes: Record<string, string> = {};
    const attributes: Record<string, string | null> = {};
    for (const el of document.querySelectorAll('div.sw')) {
      const c = getComputedStyle(el);
      boxes[el.id] = `${c.padding} | ${c.margin}`;
      attributes[el.id] = el.getAttribute('style');
    }
    const texts: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule)
          texts.push(`${rule.selectorText} { ${rule.style.cssText} } ${[...rule.style]}`);
        if ('cssRules' in rule) visit(rule.cssRules as CSSRuleList);
      }
    };
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets])
      if (sheet.ownerNode instanceof Element ? sheet.ownerNode.classList.contains('sw') : true) visit(sheet.cssRules);
    return { boxes, texts, attributes };
  });

type Reading = Awaited<ReturnType<typeof read>>;

/** Runs `code` in the page: `sheet` is the sheet of the test's <style>, `rules` its rules, `el` the element `a`. */
const script = (code: string | undefined) =>
  t.page.evaluate(`(async () => {
    const style = document.getElementById('sw-sheet');
    const sheet = style && style.sheet;
    const rules = sheet && sheet.cssRules;
    const el = document.getElementById('a');
    ${code ?? ''}
  })()`);

interface Case {
  /** The text of the <style>, and the ids of the elements (each of class `sw` and of its id). */
  css?: string;
  ids?: string[];
  /** What the page does before the insets are emulated, while they are, and with the CSS domain (see `client`). */
  before?: string;
  during?: string;
  client?: (side: Side) => Promise<void>;
  /** The elements we do not emulate (their boxes are as without the emulation), where Chrome does. */
  left?: string[];
}

interface Run {
  /** Before the insets are emulated: the blocks as the page left them. */
  bare: Reading;
  on: Reading;
  changed: Reading;
  off: Reading;
  /** As Chrome's own emulation shows the page once the side's emulation ended: what the page's blocks hold. */
  native: Reading;
}

async function run(side: Side, c: Case): Promise<Run> {
  await t.page.evaluate(
    (css, ids) => {
      const style = document.createElement('style');
      style.id = 'sw-sheet';
      style.className = 'sw';
      style.textContent = css;
      document.head.appendChild(style);
      for (const id of ids)
        document.body.insertAdjacentHTML('beforeend', `<div id="${id}" class="sw ${id}">${id}</div>`);
    },
    c.css ?? '',
    c.ids ?? ['a']
  );
  try {
    await script(c.before);
    if (c.client) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      await c.client(side);
    }
    const bare = await read();
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20, left: 6 } });
    await wait(150);
    const on = await read();
    await script(c.during);
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 30, left: 4 } });
    await wait(100);
    const changed = await read();
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await wait();
    const off = await read();
    await t.chrome.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 30, left: 4 } });
    const native = await read();
    await t.chrome.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    // The texts are the emulation's while it runs.
    for (const reading of [on, changed]) {
      reading.texts = [];
      reading.attributes = {};
    }
    return { bare, on, changed, off, native };
  } finally {
    await side.send('CSS.disable').catch(() => {});
    await side.send('DOM.disable').catch(() => {});
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await t.page.evaluate(() => {
      document.querySelectorAll('.sw').forEach(el => el.remove());
      document.adoptedStyleSheets = [];
    });
  }
}

/** Runs `c` on both sides: we emulate as Chrome, or, for the elements of `left`, not at all; the page is left as it was. */
async function check(c: Case): Promise<{ chrome: Run; ours: Run }> {
  const chrome = await run(t.chrome, c);
  const ours = await run(t.ours, c);
  // What the page's blocks hold once the emulation ended, in text and by Chrome's own emulation of them.
  assert.deepEqual(ours.off, chrome.off, 'off');
  assert.deepEqual(ours.native, chrome.native, 'the blocks of the page afterwards');
  for (const moment of ['on', 'changed'] as const)
    for (const id of Object.keys(chrome[moment].boxes)) {
      // Not emulated from the moment the page makes the change the case is about.
      const left = c.left?.includes(id) && (moment === 'changed' || !c.during);
      const expected = left ? ours.off.boxes[id] : chrome[moment].boxes[id];
      assert.equal(ours[moment].boxes[id], expected, `${moment}, ${id}`);
    }
  // Chrome's emulation shows in the case: it is one where the insets matter.
  assert.notDeepEqual(chrome.changed.boxes, chrome.off.boxes);
  return { chrome, ours };
}

/** In the page: `set` and `setText`, setProperty() and the `cssText` setter of an iframe made now. */
const OTHER_REALM = `const frame = document.createElement('iframe'); frame.className = 'sw'; document.body.append(frame);
  const other = frame.contentWindow.CSSStyleDeclaration.prototype; const set = other.setProperty;
  const setText = Object.getOwnPropertyDescriptor(other, 'cssText').set;`;

const SHORT = (inset: string, other = '2px') => `padding: ${inset} ${other}; padding-bottom: 0`;

const RULES: Record<string, Case> = {
  // The rule left is the second of the text, which the first of the text reads like.
  'a rule deleted before another of its selector': {
    css: `.a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} }`,
    before: 'sheet.deleteRule(0)',
    left: ['a'],
  },
  'a rule deleted, and one of its selector inserted': {
    css: `.a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} }`,
    before: `sheet.deleteRule(0); sheet.insertRule('.a { color: green }', 0)`,
    left: ['a'],
  },
  'a rule deleted while the insets are emulated': {
    css: `.a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} }`,
    during: 'sheet.deleteRule(0)',
  },
  'a rule of the same selector inserted between two': {
    css: `.a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} }`,
    before: `sheet.insertRule('.a { margin: ${TOP} 2px; margin-bottom: 0 }', 1)`,
  },
  'a rule added with addRule()': {
    css: `.a { ${SHORT(LEFT)} } .b { ${SHORT(TOP)} }`,
    ids: ['a', 'b'],
    before: `sheet.addRule('.b', 'margin: ${TOP} 2px; margin-bottom: 0', 1)`,
  },
  'the text of the <style> changed': {
    css: `.a { ${SHORT(TOP)} }`,
    before: `style.textContent = '.a { ${SHORT(LEFT, '3px')} }'`,
  },
  'the text of the <style> changed while the insets are emulated': {
    css: `.a { ${SHORT(TOP)} }`,
    during: `style.textContent = '.a { ${SHORT(LEFT, '3px')} }'`,
  },
  'rules of one selector in and out of @media': {
    css: `.a { ${SHORT(TOP)} } @media all { .a { margin: ${LEFT} 2px; margin-bottom: 0 } }`,
  },
  'a rule deleted before an @media with a rule of its selector': {
    css: `.a { ${SHORT(TOP)} } @media all { .a { margin: ${LEFT} 2px; margin-bottom: 0 } }`,
    before: 'sheet.deleteRule(0)',
    left: ['a'],
  },
  'a rule deleted in an @media, before another of its selector': {
    css: `.b { ${SHORT(TOP)} } @media all { .a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} } }`,
    ids: ['a', 'b'],
    before: 'rules[1].deleteRule(0)',
    left: ['a'],
  },
  'a keyframe appended': {
    css: `.a { ${SHORT(TOP)} } @keyframes k { from { ${SHORT(TOP)} } }`,
    before: `rules[1].appendRule('to { ${SHORT(LEFT)} }')`,
  },
  // A: the rule was rewritten and put back, and the page then sets the shorthand to another env().
  'a rule the page sets again after an emulation ended': {
    css: `.a { padding: max(${TOP}, 8px) 16px; padding-bottom: 0 }`,
    client: async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20 } });
      await wait(50);
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await script(
        `rules[0].style.setProperty('padding', '${LEFT} 3px'); rules[0].style.setProperty('padding-bottom', '0')`
      );
    },
  },
  // C: nobody watches, and the page sets the shorthand to another env() by name, then the same longhand.
  'a rule the page sets by name while nobody watches': {
    css: `.a { ${SHORT(TOP)} }`,
    before: `rules[0].style.padding = '${LEFT} 3px'; rules[0].style.paddingBottom = '0'`,
  },
  'a rule the page sets by name to a var(), while nobody watches': {
    css: `.a { --x: ${LEFT}; ${SHORT(TOP)} }`,
    before: `rules[0].style.padding = 'var(--x) 3px'; rules[0].style.paddingBottom = '0'`,
  },
  'a rule the page sets through its style map': {
    css: `.a { ${SHORT(TOP)} }`,
    before: `rules[0].styleMap.set('padding', '${LEFT} 3px'); rules[0].styleMap.set('padding-bottom', '0')`,
    left: ['a'],
  },
  'a rule the page sets through its style map while the insets are emulated': {
    css: `.a { ${SHORT(TOP)} }`,
    during: `rules[0].styleMap.set('padding', '${LEFT} 3px'); rules[0].styleMap.set('padding-bottom', '0')`,
    left: ['a'],
  },
  'a rule the page sets by name while the insets are emulated': {
    css: `.a { ${SHORT(TOP)} }`,
    during: `rules[0].style.padding = '${LEFT} 3px'; rules[0].style.paddingBottom = '0'`,
  },
  'a rule the page sets whole through rule.style': {
    css: `.a { ${SHORT(TOP)} }`,
    before: `rules[0].style = '${SHORT(LEFT, '3px')}'`,
  },
  'a rule built property by property': {
    css: `.a { color: red }`,
    before: `rules[0].style.padding = 'max(${TOP}, 8px) 16px'; rules[0].style.paddingBottom = '0'`,
  },
  'a rule built property by property while the insets are emulated': {
    css: `.a { color: red }`,
    during: `rules[0].style.setProperty('padding', 'max(${TOP}, 8px) 16px'); rules[0].style.setProperty('padding-bottom', '0')`,
  },
  'a rule with an important shorthand, set property by property': {
    css: `.a { color: red }`,
    before: `rules[0].style.setProperty('padding', '${TOP} 2px', 'important');
      rules[0].style.setProperty('padding-left', '1px', 'important')`,
  },
  'a rule with an important longhand after the shorthand': {
    css: `.a { padding: ${TOP} 2px; padding-bottom: 0 !important }`,
  },
  // A write the agent does not see, by the function of a realm made in the same task: the next write it sees
  // finds the block reading another text than its record left.
  'a rule written by the function of another realm, then by name': {
    css: `.a { color: red }`,
    before: `rules[0].style.cssText = '${SHORT(TOP)}'; ${OTHER_REALM}
      set.call(rules[0].style, 'padding', '${LEFT} 3px'); rules[0].style.paddingBottom = '0'`,
    left: ['a'],
  },
  'a rule written by the function of another realm while the insets are emulated': {
    css: `.a { color: red }`,
    during: `rules[0].style.cssText = '${SHORT(TOP)}'; ${OTHER_REALM}
      set.call(rules[0].style, 'padding', '${LEFT} 3px'); rules[0].style.paddingBottom = '0'`,
  },
  'a rule with a property removed and the shorthand set again': {
    css: `.a { ${SHORT(TOP)}; color: red }`,
    before: `rules[0].style.removeProperty('padding-bottom'); rules[0].style.padding = '${LEFT} 3px';
      rules[0].style.paddingBottom = '1px'; rules[0].style.removeProperty('color')`,
  },
};

// Without `ALWAYS` (written-blocks.ts), a block is known only by what the page wrote while someone watched: the
// texts of the <style> and of the rules inserted, and what was written before, are not taken. The cases that are
// known so (`emulated`) are emulated as in Chrome; the others, as in Chrome or not at all.
const EMULATED = new Set([
  'a rule the page sets by name while the insets are emulated',
  'a rule built property by property while the insets are emulated',
]);

for (const [name, c] of Object.entries(RULES))
  test(`a block the browser does not give back is emulated as in Chrome, or left as written: ${name}`, async () => {
    const { chrome, ours } = await leftOrSame(c);
    // Written while the insets are emulated: emulated as in Chrome from then on.
    if (EMULATED.has(name)) {
      assert.deepEqual(ours.changed.boxes, chrome.changed.boxes);
      assert.notDeepEqual(ours.changed.boxes, ours.off.boxes);
    }
  });

/** The sheet of the test's <style>, as the CSS domain names it. */
async function sheetId(side: Side): Promise<string> {
  const { root } = await side.send('DOM.getDocument', {});
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#a' });
  const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
  const id = (matchedCSSRules ?? []).find(m => m.rule.selectorList.text === '.a')?.rule.styleSheetId;
  assert.ok(id);
  return id;
}

/** Sets the declarations of the rule `.a` to `text`, as the Styles pane does. */
async function editRule(side: Side, text: string): Promise<void> {
  const { root } = await side.send('DOM.getDocument', {});
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#a' });
  const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
  const style = (matchedCSSRules ?? []).find(m => m.rule.selectorList.text === '.a')?.rule.style;
  assert.ok(style?.styleSheetId && style.range);
  await side.send('CSS.setStyleTexts', { edits: [{ styleSheetId: style.styleSheetId, range: style.range, text }] });
}

const CLIENT: Record<string, Case> = {
  // An undo puts back the block the page wrote, not the text the rule reads as, which has no shorthand.
  'CSS.setStyleTexts, undone': {
    css: `.a { ${SHORT(TOP)} }`,
    client: async side => {
      await editRule(side, 'color: red');
      await side.send('DOM.undo');
    },
  },
  'CSS.setStyleTexts, undone and done again': {
    css: `.a { ${SHORT(TOP)} }`,
    client: async side => {
      await editRule(side, `${SHORT(LEFT, '5px')}`);
      await side.send('DOM.undo');
      await side.send('DOM.redo');
    },
  },
  'CSS.setStyleTexts under the emulation, undone': {
    css: `.a { ${SHORT(TOP)} }`,
    client: async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20, left: 6 } });
      await wait(50);
      await editRule(side, 'color: red');
      await side.send('DOM.undo');
    },
  },
  // The <style> keeps its text: the rule reads as its old text does, and is not that text.
  'CSS.setStyleSheetText, to another env()': {
    css: `.a { ${SHORT(TOP)} }`,
    client: async side => {
      await side.send('CSS.setStyleSheetText', { styleSheetId: await sheetId(side), text: `.a { ${SHORT(LEFT)} }` });
    },
  },
  'CSS.setStyleSheetText, to no env()': {
    css: `.a { ${SHORT(TOP)} } .b { ${SHORT(TOP)} }`,
    ids: ['a', 'b'],
    client: async side => {
      await side.send('CSS.setStyleSheetText', {
        styleSheetId: await sheetId(side),
        text: `.a { padding: 4px; padding-bottom: 0 } .b { ${SHORT(TOP)} }`,
      });
    },
  },
  'CSS.setStyleSheetText, with a rule taken out': {
    css: `.a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} }`,
    client: async side => {
      await side.send('CSS.setStyleSheetText', { styleSheetId: await sheetId(side), text: `.a { ${SHORT(TOP)} }` });
    },
  },
  // A redo inserts the text the client gave: the rule's own text has no shorthand.
  'CSS.addRule, undone and done again': {
    css: `.a { ${SHORT(LEFT)} }`,
    client: async side => {
      await side.send('CSS.addRule', {
        styleSheetId: await sheetId(side),
        ruleText: `.a { margin: ${TOP} 2px; margin-bottom: 0 }`,
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
      });
      await side.send('DOM.undo');
      await side.send('DOM.redo');
    },
  },
  'CSS.addRule': {
    css: `.a { ${SHORT(LEFT)} } .a { ${SHORT(TOP)} }`,
    client: async side => {
      await side.send('CSS.addRule', {
        styleSheetId: await sheetId(side),
        ruleText: `.a { margin: ${TOP} 2px; margin-bottom: 0 }`,
        location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
      });
    },
  },
};

// An edit undone puts the rule back by its text, where the block is not known: a shorthand the browser gives as
// longhands with no value is lost (docs/limitations.md). Under `ALWAYS` the text of the <style> was taken.
const UNDONE = new Set(['CSS.setStyleTexts, undone', 'CSS.setStyleTexts under the emulation, undone']);
const UNDONE_WHY = 'an undo puts a rule not known by its writes back by its text (docs/limitations.md)';

for (const [name, c] of Object.entries(CLIENT))
  test(
    `a sheet the client edited is emulated as in Chrome, or left as written: ${name}`,
    UNDONE.has(name) ? { todo: UNDONE_WHY } : {},
    async () => void (await leftOrSame(c))
  );

const BLOCK = `padding: max(${TOP}, 8px) 16px; padding-bottom: 0`;
const INLINE: Record<string, string> = {
  cssText: `el.style.cssText = '${BLOCK}'`,
  byName: `el.style.padding = 'max(${TOP}, 8px) 16px'; el.style.paddingBottom = '0'`,
  setProperty: `el.style.setProperty('padding', 'max(${TOP}, 8px) 16px'); el.style.setProperty('padding-bottom', '0', 'important')`,
  dashed: `el.style['padding'] = 'max(${TOP}, 8px) 16px'; el.style['padding-bottom'] = '0'`,
  style: `el.style = '${BLOCK}'`,
  setAttribute: `el.setAttribute('style', '${BLOCK}')`,
  shorthand: `el.style.padding = '${TOP} 16px'`,
  margin: `el.style.cssText = 'color: red'; el.style.margin = '${LEFT} 2px'; el.style.marginInlineStart = '1px';
    el.style.marginTop = '${TOP}'`,
  // What a framework does to a style it keeps: each property set again, one removed, the whole set again.
  again: `el.style.padding = '${LEFT} 1px'; el.style.paddingBottom = '0'; el.style.color = 'red';
    el.style.padding = 'max(${TOP}, 8px) 16px'; el.style.paddingBottom = '0'; el.style.removeProperty('color')`,
  logical: `el.style.direction = 'rtl'; el.style.paddingInlineStart = '${LEFT}'; el.style.padding = '${TOP} 2px';
    el.style.paddingRight = '1px'`,
  // A value left open, which the browser serializes as written: what is set after it is not in that value.
  openValue: `el.style.cssText = '--x: f(a'; el.style.setProperty('padding-top', '${TOP}')`,
  openAttribute: `el.setAttribute('style', '--x: f(a'); el.style.paddingTop = '${TOP}'; el.style.paddingLeft = '${LEFT}'`,
  openInside: `el.style.cssText = '--x: calc(${TOP}'; el.style.setProperty('padding-top', 'var(--x)')`,
  attributeThenName: `el.setAttribute('style', 'color: red'); el.style.padding = 'max(${TOP}, 8px) 16px';
    el.style.paddingBottom = '0'`,
  // The sides of an important shorthand read `name:  !important`.
  important: `el.style.setProperty('padding', 'max(${TOP}, 8px) 16px', 'important');
    el.style.setProperty('padding-bottom', '0')`,
  importantText: `el.style.cssText = 'padding: max(${TOP}, 8px) 16px !important'; el.style.paddingBottom = '0'`,
  cssFloat: `el.style.padding = 'max(${TOP}, 8px) 16px'; el.style.paddingBottom = '0'; el.style.cssFloat = 'left'`,
};

const PARTIAL = new Set(['margin']);
// A known limit (docs/limitations.md, Order of declarations): a logical property before a pending shorthand whose
// side was set after it is listed after the shorthand's sides, in a block not known by the page's writes.
const ORDER_WHY = 'the order of a block written a declaration at a time (docs/limitations.md)';

for (const [name, write] of Object.entries(INLINE)) {
  test(`an inline style the page writes through the CSSOM is emulated as in Chrome (${name}, during)`, async () => {
    const { ours } = await check({ during: write });
    assert.notDeepEqual(ours.changed.boxes, ours.off.boxes);
  });
  // Written while nobody watched (written-blocks.ts, ALWAYS): what it was written in is not known. A block whose
  // text has an env() of its own is rewritten by it, but for the sides it reads with no value (`partial`).
  test(
    `an inline style written before the emulation is emulated as in Chrome or not at all (${name}, before)`,
    name === 'logical' ? { todo: ORDER_WHY } : {},
    async () => void (await leftOrSame({ before: write }, PARTIAL.has(name)))
  );
}

/**
 * Runs `c` on both sides: the page is left as Chrome leaves it, and each element is emulated as in Chrome or not
 * at all.
 */
async function leftOrSame(c: Case, partial = false): Promise<{ chrome: Run; ours: Run }> {
  const chrome = await run(t.chrome, c);
  const ours = await run(t.ours, c);
  assert.deepEqual(ours.off, chrome.off);
  assert.deepEqual(ours.native, chrome.native);
  // Not emulated: as the page left the block at that moment, before the insets and after the change of `during`.
  const bare = { on: ours.bare, changed: ours.off };
  if (!partial)
    for (const moment of ['on', 'changed'] as const)
      for (const id of Object.keys(chrome[moment].boxes))
        assert.ok(
          ours[moment].boxes[id] === chrome[moment].boxes[id] || ours[moment].boxes[id] === bare[moment].boxes[id],
          `${moment}, ${id}: ${ours[moment].boxes[id]}, Chrome ${chrome[moment].boxes[id]}`
        );
  return { chrome, ours };
}

const UNKNOWN: Record<string, string> = {
  // The attribute set again to what it reads: the block is then what that text gives, with no shorthand.
  attributeAgain: `el.style.cssText = '${BLOCK}'; el.setAttribute('style', el.getAttribute('style'))`,
  styleMap: `el.style.cssText = '${BLOCK}'; el.attributeStyleMap.set('padding', '${LEFT} 16px');
    el.attributeStyleMap.set('padding-bottom', '0')`,
  object: `el.style.cssText = '${BLOCK}'; el.style.padding = { toString: () => '${LEFT} 16px' }; el.style.paddingBottom = '0'`,
  many: `el.style.cssText = '${BLOCK}'; for (let i = 0; i < 40; i++) { el.style.color = 'red'; el.style.opacity = '0.5' }`,
  // Writes the agent does not see, which leave the block reading as its record gives it: the element's observer
  // tells them (written-blocks.ts, sealing).
  otherRealm: `el.style.cssText = '${BLOCK}'; ${OTHER_REALM}
    set.call(el.style, 'padding', '${LEFT} 3px'); el.style.paddingBottom = '0'`,
  otherRealmOnly: `el.style.cssText = '${BLOCK}'; ${OTHER_REALM}
    set.call(el.style, 'padding', '${LEFT} 3px'); set.call(el.style, 'padding-bottom', '0')`,
  otherRealmText: `el.style.cssText = '${BLOCK}'; ${OTHER_REALM}
    setText.call(el.style, 'padding: ${LEFT} 3px; padding-bottom: 0')`,
  attributeBetween: `el.style.cssText = '${BLOCK}'; el.setAttribute('style', 'padding: ${LEFT} 3px');
    el.style.paddingBottom = '0'`,
  defined: `el.style.cssText = '${BLOCK}'; el.setAttribute('style', 'padding: ${LEFT} 3px');
    Object.defineProperty(el.style, 'paddingBottom', { value: '0' })`,
  // A style taken by another realm's getter is of no element known: it has no record.
  otherGetter: `${OTHER_REALM}
    const get = Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLElement.prototype, 'style').get;
    get.call(el).cssText = '${BLOCK}'`,
};

for (const [name, write] of Object.entries(UNKNOWN))
  for (const when of ['before', 'during'] as const)
    test(`an inline style written in a way that is not followed is left as written (${name}, ${when})`, async () => {
      if (name === 'defined' && when === 'during') {
        // While the accessors are there, the property defined is one of the style object, not the CSS property
        // Chrome sets (docs/limitations.md, Following the page's writes). The block left is emulated as Chrome's
        // own emulation shows it.
        const ours = await run(t.ours, { during: write });
        assert.equal(ours.off.attributes['a'], `padding: ${LEFT} 3px`);
        assert.deepEqual(ours.changed.boxes, ours.native.boxes);
        return;
      }
      // Emulated as Chrome emulates it, or not at all: nothing else.
      await leftOrSame({ [when]: write });
    });

test('rules deleted and inserted in turn are left as written', async () => {
  // The rule of the padding is no longer where the sheet's text has it, and the rule inserted was inserted while
  // nobody watched: neither is emulated, and both read as in Chrome once the emulation ends.
  await leftOrSame({
    css: `.a { ${SHORT(LEFT)} } .b { color: red } .a { ${SHORT(TOP)} }`,
    before: `sheet.deleteRule(1); sheet.insertRule('.c { color: blue }', 0); sheet.deleteRule(1);
      sheet.insertRule('.a { margin: ${TOP} 2px; margin-bottom: 0 }', 1)`,
  });
});

// A known limit (docs/limitations.md): a rule's block tells no one of its changes, so writes the agent does not
// see that leave the block reading as before are not told from none.
test(
  'a rule written only by the functions of another realm is left as written',
  { todo: 'a rule gives no sign of a write that leaves its text as it was (docs/limitations.md)' },
  async () => {
    await check({
      css: `.a { color: red }`,
      before: `rules[0].style.cssText = '${SHORT(TOP)}'; ${OTHER_REALM}
        set.call(rules[0].style, 'padding', '${LEFT} 3px'); set.call(rules[0].style, 'padding-bottom', '0')`,
      left: ['a'],
    });
  }
);

test('an inline style written through the CSSOM is shown as the page wrote it, and written a few times', async () => {
  const shown = async (side: Side) => {
    await t.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="a" class="sw a">a</div>'));
    await script(`el.style.padding = 'max(${TOP}, 8px) 16px'; el.style.paddingBottom = '0'`);
    await side.send('DOM.enable');
    await side.send('CSS.enable');
    // What a page's own observer is told of the emulation's writes.
    await t.page.evaluate(() => {
      const w = window as unknown as { swRecords: number };
      w.swRecords = 0;
      new MutationObserver(records => (w.swRecords += records.length)).observe(document.getElementById('a') as Node, {
        attributes: true,
      });
    });
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20 } });
    await wait(50);
    const { root } = await side.send('DOM.getDocument', {});
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#a' });
    const inline = await side.send('CSS.getInlineStylesForNode', { nodeId });
    const matched = await side.send('CSS.getMatchedStylesForNode', { nodeId });
    const { attributes } = await side.send('DOM.getAttributes', { nodeId });
    const style = (s: typeof inline.inlineStyle) => ({
      text: s?.cssText,
      properties: s?.cssProperties.map(p => [p.name, p.value, p.text ?? null]),
    });
    const records = await t.page.evaluate(() => (window as unknown as { swRecords: number }).swRecords);
    const page = await t.page.evaluate(() => document.getElementById('a')?.getAttribute('style'));
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await side.send('CSS.disable');
    await side.send('DOM.disable');
    await t.page.evaluate(() => document.querySelectorAll('.sw').forEach(el => el.remove()));
    return { inline: style(inline.inlineStyle), matched: style(matched.inlineStyle), attributes, records, page };
  };
  const chrome = await shown(t.chrome);
  const ours = await shown(t.ours);
  assert.deepEqual(ours.inline, chrome.inline);
  assert.deepEqual(ours.matched, chrome.matched);
  assert.deepEqual(ours.attributes, chrome.attributes);
  assert.doesNotMatch(JSON.stringify([ours.inline, ours.matched, ours.attributes]), /--da-sai/);
  // Written before CSS was enabled, the block is not known and not emulated: the page's observer gets no record,
  // as in Chrome. The attribute reads as it did: the sides have no value in it.
  assert.equal(chrome.records, 0);
  assert.equal(ours.records, chrome.records);
  assert.equal(ours.page, chrome.page);
});

test('the references of rules inserted and deleted in one job under the emulation are let go', async () => {
  const cdp = await t.page.createCDPSession();
  // The WeakRef objects alive in the page, once collected.
  const references = async () => {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'WeakRef.prototype' });
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId ?? '' });
    const { result: count } = await cdp.send('Runtime.callFunctionOn', {
      objectId: objects.objectId ?? '',
      functionDeclaration: 'function () { return this.length; }',
      returnByValue: true,
    });
    return Number(count.value);
  };
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 20 } });
    const before = await references();
    await t.page.evaluate(block => {
      const sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [sheet];
      for (let i = 0; i < 5000; i++) {
        sheet.insertRule(`.x${i} { ${block} }`, 0);
        sheet.deleteRule(0);
      }
      document.adoptedStyleSheets = [];
    }, SHORT(TOP));
    await wait(100);
    // Each rule was rewritten, and a reference to its block kept until it was gone: none of them is left.
    const after = await references();
    assert.ok(after - before < 100, `${after - before} references left`);
  } finally {
    await cdp.detach();
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  }
});

test('a write of an inline style gives the page an observer record of its own, and no more', async () => {
  // A page without the agent gets one record for each write of the attribute. Each count uses an observer of
  // its own, taken off after it.
  const count = (write: string) =>
    t.page.evaluate(`(async () => {
      document.body.insertAdjacentHTML('beforeend', '<div id="a" class="sw a">a</div>');
      const el = document.getElementById('a');
      let n = 0;
      const observer = new MutationObserver(records => (n += records.length));
      observer.observe(el, { attributes: true });
      ${write};
      await new Promise(resolve => setTimeout(resolve));
      n += observer.takeRecords().length;
      observer.disconnect();
      el.remove();
      return n;
    })()`);
  const writes = [
    `el.style.cssText = 'color: red'`,
    `el.style.cssText = 'padding: ${TOP} 2px; padding-bottom: 0'`,
    `el.style.padding = '${TOP} 2px'; el.style.paddingBottom = '0'`,
  ];
  const expected = [1, 1, 2];
  const alone: unknown[] = [];
  for (const write of writes) alone.push(await count(write));
  assert.deepEqual(alone, expected, 'not watched');
  await t.ours.send('DOM.enable');
  await t.ours.send('CSS.enable');
  const watched: unknown[] = [];
  for (const write of writes) watched.push(await count(write));
  assert.deepEqual(watched, expected, 'watched');
});
