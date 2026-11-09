// Comments in a style block that read as a declaration, compared with Chrome: Blink reports one
// as a disabled property only when the declaration in it parses (a property it knows, with a
// valid value), with what that means for custom properties, `!important`, shorthands, var(),
// case, vendor prefixes, semicolons and white space.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, both, nodeId, style } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    for (const side of [t.ours, t.chrome]) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

let seq = 0;

/**
 * `.cmN { <block> }` on an element: our rules and text are Chrome's. Unless `none`, Chrome reports
 * some disabled property: both sides reporting none would pass as well.
 */
async function same(block: string, none = false) {
  const cls = `cm${++seq}`;
  await sameRules(`.${cls} { ${block} }\n.${cls} { top: 1px }`, cls, none);
}

/** `css` with an element of class `cls`: our rules, in number and with their ranges, are Chrome's. */
async function sameRules(css: string, cls: string, none = false) {
  const at = await addStyle(t, css, `<p class="${cls}">x</p>`);
  const { ours, chrome } = await both(t, `${at} .${cls}`);
  assert.equal(ours.text, chrome.text);
  assert.ok(chrome.rules.length);
  const disabled = chrome.rules.flatMap(r => r.style.properties.filter(p => p.disabled)).length;
  if (none) assert.equal(disabled, 0);
  else assert.ok(disabled > 0, 'Chrome reports some disabled property');
  assert.equal(ours.rules.length, chrome.rules.length);
  assert.deepEqual(ours.rules, chrome.rules);
}

const sides = () =>
  [
    ['ours', t.ours],
    ['chrome', t.chrome],
  ] as const satisfies readonly (readonly [string, Side])[];

test('notes, unknown properties and invalid values: only a valid declaration is disabled', () =>
  same(`/* note: see ticket */ /* TODO: fix */ /* color: red; */ /* colr: red */ /* color: 12px */ margin: 0`));

test('custom properties', () =>
  same(
    `/* --x: 1 */ /* --y: {a} */ /* --z: ) */ /* --w:  */ /* --v: a!important */ /* --b: !important */ /* --a:; */ color: red`
  ));

test('!important', () =>
  same(
    `/* color: red !important */ /* color: 12px !important */ /* color: red ! IMPORTANT */ /* color: red !important x */ /* color: !important */ top: 0`
  ));

test('shorthands', () =>
  same(
    `/* margin: 1px 2px */ /* background: red url(x.png) no-repeat */ /* font: 12px serif */ /* margin: red */ /* font: bold */ top: 0`
  ));

test('var() values', () =>
  same(
    `/* color: var(--a) */ /* margin: var(--a) 1px */ /* color: var(--a, red) */ /* color: var(a) */ /* color: var( */ top: 0`
  ));

test('case and vendor prefixes', () =>
  same(
    `/* COLOR: RED */ /* Color: red */ /* -webkit-box-shadow: 0 0 1px red */ /* -webkit-appearance: none */ /* -moz-appearance: none */ /* -webkit-foo: 1 */ /* -WEBKIT-USER-SELECT: none */ top: 0`
  ));

test('semicolons and white space', () =>
  same(`/*color:red;;*/ /*  color :  red  ;  */ /* color: red; margin: 1px */ /* color: red; garbage */ /*
  color:
  red
*/ top: 0`));

test('CSS-wide keywords and functions', () =>
  same(
    `/* color: inherit */ /* margin: revert-layer */ /* width: calc(1px + 2px) */ /* width: calc(1px + red) */ /* content: "a;b" */ /* color: attr(x) */ /* width: 1px !ie */ top: 0`
  ));

test('comments between declarations keep the cssId pairing and ranges of the others', () =>
  same(`color: red; /* colr: red */ margin: 0; /* color: 12px */ padding: 1px; /* color: blue */ top: 2px`));

test('vendor prefixes Blink keeps whatever the value, lower case only', () =>
  same(
    `/* -webkit-foo: ) */ /* -moz-foo: 1 */ /* -ms-foo: */ /* -o-foo: 1 !important x */ /* -webkit-: 1 */ /* -webkit-box-shadow: 12 */ /* -WEBKIT-FOO: 1 */ /* -khtml-foo: 1 */ /* -internal-foo: 1 */ /* -x-foo: 1 */ /* -epub-caption-side: top */ /* -webkit-foo: 1; color: red */ top: 0`
  ));

test('escaped names and unknown prefixes; a prefix written with an escape is no vendor prefix', () =>
  same(`/* col\\6f r: red */ /* -foo-bar: 1 */ /* \\2d-x: 1 */ /* -\\77 ebkit-foo: ) */ /* color: red;; */ top: 0`));

test(
  'a comment opening in a custom property value',
  { todo: 'Chrome gives `--x:/**/` the value `/*`, the outline none (css-outline.ts)' },
  () => same(`/* --x:/**/ */ top: 0`)
);

test('two rules of one selector differing only in their comments pair in order', () => {
  const cls = `cm${++seq}`;
  return sameRules(
    `.${cls} { /* color: 12px */ top: 0 }\n.${cls} { /* color: red */ top: 0 }\n.${cls} { /* colr: red */ top: 0 }`,
    cls
  );
});

test('declarations not in comments: invalid ones are still reported, parsedOk false', async () => {
  const cls = `cm${++seq}`;
  const at = await addStyle(
    t,
    `.${cls} { colr: red; color: 12px; /* color: 12px */ top: 0 }`,
    `<p class="${cls}">x</p>`
  );
  const { ours, chrome } = await both(t, `${at} .${cls}`);
  const invalid = chrome.rules[0]?.style.properties.filter(p => p.parsedOk === false).map(p => p.name);
  assert.deepEqual(invalid, ['colr', 'color']);
  assert.equal(chrome.rules[0]?.style.properties.filter(p => p.disabled).length, 0);
  assert.deepEqual(ours.rules, chrome.rules);
});

/** The first keyframe of `@keyframes <name>`, as each side reports it for `#<name>`. */
async function keyframe(name: string) {
  return Promise.all(
    sides().map(async ([, side]) => {
      const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `#${name}`) });
      const k = res.cssKeyframesRules?.find(r => r.animationName.text === name)?.keyframes[0];
      return k && style(k.style);
    })
  );
}

test('keyframes: the same comments are disabled as in a rule, whatever a keyframe ignores', async () => {
  await addStyle(
    t,
    `@keyframes cmk { 0% { /* animation-name: x */ /* color: red !important */ /* top: 1px */ /* colr: 1 */ /* top: red */ left: 0 } }`,
    `<p id="cmk" style="animation: cmk 100s">x</p>`
  );
  const [ours, chrome] = await keyframe('cmk');
  assert.ok(
    chrome?.properties.some(p => p.disabled),
    'Chrome reports some disabled property'
  );
  assert.deepEqual(ours, chrome);
});

/**
 * The inline style of an element whose style attribute is set to `text`, and of another after
 * setStyleTexts with `text` (its error, if refused), then read again. Each side edits an element
 * of its own: both are connected to one page, where one side's edit would be read by the other.
 */
async function inline(text: string) {
  const id = `cmi${++seq}`;
  await addStyle(t, '', `<p id="${id}a">x</p><p id="${id}ours">y</p><p id="${id}chrome">z</p>`);
  await t.page.evaluate((id, text) => document.getElementById(`${id}a`)?.setAttribute('style', text), id, text);
  const [ours, chrome] = await Promise.all(
    sides().map(async ([name, side]) => {
      const attr = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, `#${id}a`) });
      const own = `#${id}${name}`;
      const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, own) });
      assert.ok(attr.inlineStyle && inlineStyle?.styleSheetId && inlineStyle.range);
      const set = await side
        .send('CSS.setStyleTexts', {
          edits: [{ styleSheetId: inlineStyle.styleSheetId, range: inlineStyle.range, text }],
        })
        .then(
          r => (r.styles[0] ? style(r.styles[0]) : null),
          (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })
        );
      const again = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, own) });
      assert.ok(again.inlineStyle);
      return { attr: style(attr.inlineStyle), set, again: style(again.inlineStyle) };
    })
  );
  return { ours, chrome };
}

type Read = ReturnType<typeof style>;
const isStyle = (s: unknown): s is Read => typeof s === 'object' && s !== null && 'properties' in s;

/** Chrome reports some disabled property in each of the three: both reporting none would pass. */
function someDisabled(chrome: Awaited<ReturnType<typeof inline>>['chrome']) {
  for (const s of [chrome.attr, chrome.set, chrome.again])
    assert.ok(isStyle(s) && s.properties.some(p => p.disabled), 'Chrome reports some disabled property');
}

const LONG = Array.from({ length: 300 }, (_, i) => `--v${i}: ${i}; /* top: ${i}px */`).join(' ');

for (const [label, text] of [
  [
    'notes, invalid values, prefixes and custom properties',
    'color: red; /* foo: bar */ /* color: 12px */ /* color: blue */ /* -webkit-foo: ) */ /* --x: */ /* colr: red */',
  ],
  ['semicolons in a comment', '/* color: red;; */ /* color: red; top: 0 */ /* left: 1px; */ top: 0'],
  [
    '!important and escaped prefixes',
    '/* color: red !important */ /* -\\77 ebkit-foo: ) */ /* -webkit-foo: ) */ top: 0 !important',
  ],
  [
    'comments in strings and values',
    'content: "/* color: red */"; background: url(a.png) /* x */ no-repeat; /* top: 1px */',
  ],
  ['a `;` in a string', 'content: "a;b"; /* top: 1px */'],
  ['white space and no last semicolon', '  color :  red ;/*left:1px*/\n  top: 0  '],
  [
    'lines, a comment across them, declarations past the second',
    'color: red; /* a\n b */\ntop: 0;\n\n  left: 1px; /* top: 2px */',
  ],
  ['CR LF', 'color: red;\r\n/* top: 1px */\r\nleft: 0'],
  ['outside ASCII and the BMP', 'content: "é😀"; /* color: blue */ top: 0'],
  ['a long text', LONG],
  ['comments only', '/* color: blue */'],
] as const)
  test(`inline styles, as written, as in a rule: ${label}`, async () => {
    const { ours, chrome } = await inline(text);
    someDisabled(chrome);
    assert.deepEqual(ours, chrome);
  });

for (const [label, text] of [
  ['empty', ''],
  ['white space only', '   '],
] as const)
  test(`inline styles with no declaration: ${label}`, async () => {
    const { ours, chrome } = await inline(text);
    assert.ok(isStyle(chrome.set));
    assert.deepEqual(chrome.set.properties, []);
    assert.equal(chrome.set.cssText, text);
    assert.deepEqual(ours, chrome);
  });

for (const [label, text] of [
  ['a comment left open', 'color:red /* x'],
  ['a string left open', 'content:"abc'],
  ['an escape at the end', 'color:a\\'],
  ['a `}` and a rule after it', 'color: red; } a { top: 0'],
  ['a `}` in a value, a comment before it', 'color:red /* c */ } x'],
  ['a `}` in a value, then another declaration', 'color:red } ; top: 0'],
  ['a `}` in a function: the block runs to the end', 'color: f( } ; top:0'],
  ['a `)` in brackets: the block runs to the end', 'color:[ ) ; top:0'],
  ['a `}` after a value, then another declaration', 'color: 1} ; top:0'],
  ['a custom property with a `)` in a block in a function', '--x: f(a{b)c}; top:0'],
  ['a custom property with blocks crossing', '--x: [ { ] } ; top:0'],
] as const)
  test(`inline styles left open or with a \`}\`, as Chrome reads them: ${label}`, async () => {
    const { ours, chrome } = await inline(text);
    assert.deepEqual(ours.attr, chrome.attr);
    // Chrome refuses such a text in setStyleTexts and leaves the style as it was; the agent
    // applies it. The refusal comes with another branch: the styleTextFits check of setStyleTexts,
    // in the commit "refuse style texts that are not a rule's style". Once it is merged, the assertions on `ours` below fail, and are to become
    // `assert.deepEqual(ours.set, chrome.set)` and `assert.deepEqual(ours.again, chrome.again)`.
    assert.ok(!isStyle(chrome.set) && chrome.set?.error.includes('Style text is not valid'));
    assert.deepEqual(chrome.again, { range: '0:0-0:0', cssText: '', properties: [] });
    assert.ok(isStyle(ours.set));
    assert.deepEqual(ours.again, ours.set);
    assert.deepEqual(ours.set, ours.attr);
  });

// Each with the names of the declarations Chrome reports, in order.
for (const [label, text, names] of [
  ['a nested rule first', 'a{top:0} color:red', []],
  ['an at-rule with a block, then a declaration', '@media x{} color:red', ['color']],
  ['an at-rule with no block', '@media x; color:red', ['color']],
  ['an at-rule with no block, a string in it', '@charset "x"; color: red', ['color']],
  ['a rule after a value: the value to the `{`', 'color:red /*c*/ a{top:0}', ['color']],
  ['a value with a block, then a declaration', 'color: red a {x} ; left:1px', ['color', 'left']],
  [
    'a rule, a declaration after it to the `;`, a comment',
    'color:red; a{top:0} left:1px; /* top: 1px */',
    ['color', 'top'],
  ],
  [
    'an at-rule with rules in it, then a comment',
    'color:red; @media x{a{b:c}} /* top:1px */ left: 0',
    ['color', 'top', 'left'],
  ],
  ['a block in a function', 'color: f({}) red; top: 0', ['color', 'top']],
  ['a block in a function, between other tokens', 'color: f(a {b} c); top: 0', ['color', 'top']],
  ['what is no declaration, a comment in it', 'junk /* top: 1px */ ; left: 0', ['left']],
  ['`;{}` in a string', 'content: ";{}"; top: 0', ['content', 'top']],
  ['`;{}` in a comment', '/* ; { } */ top: 0', ['top']],
  ['a `;` in a comment in a value', 'top: 0 /* ; */ ; left: 0', ['top', 'left']],
  ['a `]` closing no block', 'color: red ] ; top: 0', ['color', 'top']],
  ['a `)` closing no block', 'color: red ) ; top:0', ['color', 'top']],
  ['a custom property with a block', '--x: {a}; top: 0', ['--x', 'top']],
  ['a custom property with a block first, then more', '--x: {a} b; top:0', ['--x', 'top']],
  ['a custom property with a block last', '--x: a {b}; top:0', ['--x', 'top']],
  ['a custom property with a `}` closing no block', '--x: ( } ); top:0', ['top']],
] as const)
  test(`inline styles with rules and blocks in them, as Chrome reads them: ${label}`, async () => {
    const { ours, chrome } = await inline(text);
    assert.deepEqual(
      chrome.attr.properties.filter(p => p.range !== undefined).map(p => p.name),
      names
    );
    assert.equal(chrome.attr.cssText, text);
    assert.deepEqual(ours, chrome);
  });

test(
  'inline styles: a comment between a name and its `:`',
  {
    todo: 'Chrome names the property `color /*x*/`; the outline names it `color` (css-outline.ts), and textParts() skips the comment looking for the `:` (colonAfter): both would change',
  },
  async () => {
    const { ours, chrome } = await inline('color /*x*/ : red');
    assert.deepEqual(ours, chrome);
  }
);

test('inline styles of one text on two elements, then one given another text', async () => {
  const text = 'color: red; /* top: 1px */';
  const id = `cmc${++seq}`;
  await addStyle(t, '', `<p id="${id}a" style="${text}">x</p><p id="${id}b" style="${text}">y</p>`);
  const read = (el: string) =>
    Promise.all(
      sides().map(async ([, side]) => {
        const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, el) });
        assert.ok(inlineStyle);
        return style(inlineStyle);
      })
    );
  const [a, aChrome] = await read(`#${id}a`);
  const [b, bChrome] = await read(`#${id}b`);
  assert.ok(
    aChrome?.properties.some(p => p.disabled),
    'Chrome reports some disabled property'
  );
  assert.deepEqual([a, b], [aChrome, bChrome]);
  await t.page.evaluate(id => document.getElementById(`${id}a`)?.setAttribute('style', 'left: 0; /* top: 2px */'), id);
  const [a2, a2Chrome] = await read(`#${id}a`);
  const [b2, b2Chrome] = await read(`#${id}b`);
  assert.deepEqual([a2, b2], [a2Chrome, b2Chrome]);
  assert.notDeepEqual(a2, b2);
});

test('inline styles with a nested rule: a comment after it is in what is skipped', async () => {
  const { ours, chrome } = await inline('color: red; a { top: 0 } /* left: 1px */');
  assert.deepEqual(
    chrome.attr.properties.filter(p => p.range !== undefined).map(p => p.name),
    ['color']
  );
  assert.deepEqual(ours, chrome);
});

test('the style attribute removed, then a property set by script', async () => {
  const id = `cmr${++seq}`;
  await addStyle(t, '', `<p id="${id}" style="/* color: blue */">x</p>`);
  const read = () =>
    Promise.all(
      sides().map(async ([, side]) => {
        const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId: await nodeId(side, `#${id}`) });
        assert.ok(inlineStyle);
        return style(inlineStyle);
      })
    );
  const [ours, chrome] = await read();
  assert.ok(
    chrome?.properties.some(p => p.disabled),
    'Chrome reports some disabled property'
  );
  assert.deepEqual(ours, chrome);
  await t.page.evaluate(id => document.getElementById(id)?.removeAttribute('style'), id);
  const [ours2, chrome2] = await read();
  assert.equal(chrome2?.properties.length, 0);
  assert.deepEqual(ours2, chrome2);
  await t.page.evaluate(id => document.getElementById(id)?.style.setProperty('color', 'blue'), id);
  const [ours3, chrome3] = await read();
  assert.ok(chrome3?.properties.some(p => p.name === 'color' && p.range !== undefined));
  assert.deepEqual(ours3, chrome3);
});

test('setStyleTexts, then the page sets a property or the attribute', async () => {
  // Each side edits an element of its own (`inline`); the page changes both alike.
  const id = `cms${++seq}`;
  await addStyle(t, '', `<p id="${id}ours">x</p><p id="${id}chrome">y</p>`);
  const read = () =>
    Promise.all(
      sides().map(async ([name, side]) => {
        const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', {
          nodeId: await nodeId(side, `#${id}${name}`),
        });
        assert.ok(inlineStyle);
        return style(inlineStyle);
      })
    );
  for (const [name, side] of sides()) {
    const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', {
      nodeId: await nodeId(side, `#${id}${name}`),
    });
    assert.ok(inlineStyle?.styleSheetId && inlineStyle.range);
    await side.send('CSS.setStyleTexts', {
      edits: [{ styleSheetId: inlineStyle.styleSheetId, range: inlineStyle.range, text: 'color: red; /* top: 1px */' }],
    });
  }
  const [ours, chrome] = await read();
  assert.ok(
    chrome?.properties.some(p => p.disabled),
    'Chrome reports some disabled property'
  );
  assert.deepEqual(ours, chrome);
  await t.page.evaluate(id => {
    for (const side of ['ours', 'chrome']) document.getElementById(`${id}${side}`)?.style.setProperty('left', '3px');
  }, id);
  const [ours2, chrome2] = await read();
  assert.deepEqual(
    chrome2?.properties.filter(p => p.range !== undefined).map(p => p.name),
    ['color', 'left']
  );
  assert.deepEqual(ours2, chrome2);
  await t.page.evaluate(id => {
    for (const side of ['ours', 'chrome'])
      document.getElementById(`${id}${side}`)?.setAttribute('style', 'top: 0; /* left: 1px */');
  }, id);
  const [ours3, chrome3] = await read();
  assert.ok(
    chrome3?.properties.some(p => p.disabled),
    'Chrome reports some disabled property'
  );
  assert.deepEqual(ours3, chrome3);
});

test('the page replacing CSS.supports and window.CSS changes nothing', async () => {
  let restored: boolean | undefined;
  try {
    const replaced = await t.page.evaluate(() => {
      const w = window as unknown as { CSS: typeof CSS; savedCss?: typeof CSS; savedSupports?: unknown };
      w.savedCss = w.CSS;
      w.savedSupports = CSS.supports;
      CSS.supports = () => false;
      const supported = CSS.supports('color', 'red');
      w.CSS = { supports: () => false } as unknown as typeof CSS;
      return { supported, other: w.CSS !== w.savedCss };
    });
    assert.deepEqual(replaced, { supported: false, other: true });
    await same(`/* color: red */ /* color: 12px */ /* margin: 1px 2px */ /* colr: red */ top: 0`);
    const { ours, chrome } = await inline('/* color: red */ /* color: 12px */ top: 0');
    someDisabled(chrome);
    assert.deepEqual(ours, chrome);
    // A keyframe of its own, added once the page replaced them.
    await addStyle(
      t,
      `@keyframes cmt { 0% { /* color: red */ /* color: 12px */ left: 0 } }`,
      `<p id="cmt" style="animation: cmt 100s">x</p>`
    );
    const [kOurs, kChrome] = await keyframe('cmt');
    assert.ok(
      kChrome?.properties.some(p => p.disabled),
      'Chrome reports some disabled property'
    );
    assert.deepEqual(kOurs, kChrome);
  } finally {
    // Only recorded when it fails: an error of the test above is the one to report.
    try {
      restored = await t.page.evaluate(() => {
        const w = window as unknown as { CSS: typeof CSS; savedCss?: typeof CSS; savedSupports?: typeof CSS.supports };
        if (w.savedCss) w.CSS = w.savedCss;
        if (w.savedCss && w.savedSupports) w.savedCss.supports = w.savedSupports;
        return CSS.supports('color', 'red');
      });
    } catch (e) {
      console.error('restoring CSS failed', e);
    }
  }
  assert.equal(restored, true, 'CSS.supports restored');
});
