// Emulation of the safe area insets: env(safe-area-inset-*) in the page's styles, and the insets the
// page's own script reads. Chrome and we both act on the same page, so each side emulates, measures and
// clears in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, sameOnBoth, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  #sa {
    padding-top: env(safe-area-inset-top, 7px);
    padding-left: env(safe-area-max-inset-left, calc(1px + 2px));
    margin: env(safe-area-inset-bottom) 0 0;
    --right: env(safe-area-inset-right, 9px);
    width: calc(10px + var(--right));
  }
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['DOM.attributeModified', 'DOM.attributeRemoved', 'CSS.styleSheetChanged']);
    await t.page.evaluate(style => {
      const s = document.createElement('style');
      s.textContent = style;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML('beforeend', '<div id="sa">sa</div>');
    }, STYLE);
  },
  () => env?.close()
);

const measure = () =>
  t.page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('sa') ?? document.body);
    return {
      paddingTop: style.paddingTop,
      paddingLeft: style.paddingLeft,
      marginTop: style.marginTop,
      width: style.width,
    };
  });

/** The measures under `insets`, on each side in turn, cleared after each: the same on both. */
const underInsets = (insets: Protocol.Emulation.SafeAreaInsets) =>
  sameOnBoth(t, async side => {
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets });
    try {
      return await measure();
    } finally {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  });

const settle = () => t.page.evaluate(() => new Promise(r => setTimeout(r)));

test('safe area insets, with fallbacks, shorthands and custom properties', async () => {
  const r = await underInsets({ top: 5, leftMax: 3, bottom: 4, right: 6 });
  assert.deepEqual([r.paddingTop, r.paddingLeft, r.marginTop, r.width], ['5px', '3px', '4px', '16px']);
});

test('insets not set keep their real value', async () => {
  await underInsets({ top: 8 });
  await underInsets({});
});

test("the Styles pane shows the env() a sheet's rule wrote, not the inset it is rewritten to", async () => {
  const shown = await sameOnBoth(t, async side => {
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await side.send('DOM.enable');
    await side.send('CSS.enable');
    try {
      const { root } = await side.send('DOM.getDocument', {});
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#sa' });
      const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
      return (matchedCSSRules ?? []).flatMap(m =>
        m.rule.style.cssProperties.filter(p => p.name === 'padding-top').map(p => p.value)
      );
    } finally {
      await side.send('CSS.disable');
      await side.send('DOM.disable');
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  });
  assert.ok(shown.length > 0);
  for (const value of shown) assert.equal(value, 'env(safe-area-inset-top, 7px)');
});

test('a rule inside @media keeps the env() the page wrote, in the Styles pane and the sheet text', async () => {
  const css = '@media (min-width: 1px) { #sa-media { padding-top: env(safe-area-inset-top, 7px) } }';
  await t.page.evaluate(text => {
    const style = document.createElement('style');
    style.id = 'sa-media-css';
    style.textContent = text;
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<div id="sa-media"></div>');
  }, css);
  try {
    const shown = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      try {
        const { root } = await side.send('DOM.getDocument', {});
        const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#sa-media' });
        const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
        const matched = (matchedCSSRules ?? []).filter(m => m.rule.origin === 'regular');
        const values = matched.flatMap(m =>
          m.rule.style.cssProperties.filter(p => p.name === 'padding-top').map(p => p.value)
        );
        const sheetId = matched[0]?.rule.styleSheetId;
        const text = sheetId ? (await side.send('CSS.getStyleSheetText', { styleSheetId: sheetId })).text : undefined;
        return { values, text };
      } finally {
        await side.send('CSS.disable');
        await side.send('DOM.disable');
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      }
    });
    assert.ok(shown.values.length > 0);
    for (const value of shown.values) assert.equal(value, 'env(safe-area-inset-top, 7px)');
    assert.equal(shown.text, css);
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('sa-media-css')?.remove();
      document.getElementById('sa-media')?.remove();
    });
  }
});

test('a later change of the insets sets the sides it gives, and a sheet added since takes them too', async () => {
  const read = () =>
    t.page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('late') ?? document.body);
      return { top: style.paddingTop, right: style.paddingRight, left: style.paddingLeft };
    });
  try {
    const r = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, right: 6 } });
      await t.page.evaluate(() => {
        const style = document.createElement('style');
        style.id = 'late-sheet';
        style.textContent =
          '#late { padding-top: env(safe-area-inset-top, 1px); padding-right: env(safe-area-inset-right); padding-left: env(safe-area-inset-left, 2px) }';
        document.head.appendChild(style);
        document.body.insertAdjacentHTML('beforeend', '<div id="late">late</div>');
      });
      await settle();
      const first = await read();
      // Only the left inset is set now: the top and the right are the real insets again.
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { left: 3 } });
      await settle();
      const second = await read();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      return { first, second, cleared: await read() };
    });
    assert.deepEqual(r.first, { top: '5px', right: '6px', left: '0px' });
    assert.deepEqual(r.second, { top: '0px', right: '0px', left: '3px' });
    assert.deepEqual(r.cleared, { top: '0px', right: '0px', left: '0px' });
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('late-sheet')?.remove();
      document.getElementById('late')?.remove();
    });
  }
});

test('a rule under @supports with a string in its condition keeps the env() the page wrote, in the sheet text', async () => {
  const css = '@supports (font-family: "A") { #sa-sup { padding-top: env(safe-area-inset-top, 7px) } }';
  await t.page.evaluate(text => {
    const style = document.createElement('style');
    style.id = 'sa-supports-css';
    style.textContent = text;
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<div id="sa-sup"></div>');
  }, css);
  try {
    const shown = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      try {
        const { root } = await side.send('DOM.getDocument', {});
        const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#sa-sup' });
        const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
        const matched = (matchedCSSRules ?? []).filter(m => m.rule.origin === 'regular');
        const values = matched.flatMap(m =>
          m.rule.style.cssProperties.filter(p => p.name === 'padding-top').map(p => p.value)
        );
        const sheetId = matched[0]?.rule.styleSheetId;
        const text = sheetId ? (await side.send('CSS.getStyleSheetText', { styleSheetId: sheetId })).text : undefined;
        return { values, text };
      } finally {
        await side.send('CSS.disable');
        await side.send('DOM.disable');
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      }
    });
    assert.ok(shown.values.length > 0);
    for (const value of shown.values) assert.equal(value, 'env(safe-area-inset-top, 7px)');
    assert.equal(shown.text, css);
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('sa-supports-css')?.remove();
      document.getElementById('sa-sup')?.remove();
    });
  }
});

test('a rule nested in a rule with env() shows the change the page made to it before CSS was enabled', async () => {
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'sa-nested-css';
    style.textContent = '.sa-nest { padding-top: env(safe-area-inset-top, 7px); .sa-nest-c { color: red } }';
    document.head.append(style);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="sa-nest" class="sa-nest"><span id="sa-nest-c" class="sa-nest-c">x</span></div>'
    );
    // Before anything watches the sheet: the change is not seen, and must not be lost once it is.
    const parent = style.sheet?.cssRules[0] as CSSGroupingRule | undefined;
    const child = parent?.cssRules[0] as CSSStyleRule | undefined;
    if (child) child.style.color = 'blue';
  });
  try {
    const colors = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      try {
        const { root } = await side.send('DOM.getDocument', {});
        const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#sa-nest-c' });
        const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
        // Distinct values: a declaration of a sheet served from the CSSOM may be listed twice (the same on
        // both sides without the emulation), which is not what this test is about.
        return [
          ...new Set(
            (matchedCSSRules ?? [])
              .filter(m => m.rule.origin === 'regular')
              .flatMap(m => m.rule.style.cssProperties.filter(p => p.name === 'color').map(p => p.value))
          ),
        ];
      } finally {
        await side.send('CSS.disable');
        await side.send('DOM.disable');
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      }
    });
    assert.deepEqual(colors, ['blue']);
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('sa-nested-css')?.remove();
      document.getElementById('sa-nest')?.remove();
    });
  }
});

test('a @keyframes rule with env() is served as the page wrote it, in the sheet text', async () => {
  const css = '@keyframes sa-slide { from { top: env(safe-area-inset-top, 7px) } to { top: 0 } }';
  await t.page.evaluate(text => {
    const style = document.createElement('style');
    style.id = 'sa-keyframes-css';
    style.textContent = text;
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<div id="sa-kf" style="animation: sa-slide 1s"></div>');
  }, css);
  try {
    const text = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      try {
        const { root } = await side.send('DOM.getDocument', {});
        const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#sa-kf' });
        const { cssKeyframesRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
        const sheetId = cssKeyframesRules?.[0]?.keyframes[0]?.styleSheetId;
        return sheetId ? (await side.send('CSS.getStyleSheetText', { styleSheetId: sheetId })).text : undefined;
      } finally {
        await side.send('CSS.disable');
        await side.send('DOM.disable');
        await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      }
    });
    assert.equal(text, css);
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('sa-keyframes-css')?.remove();
      document.getElementById('sa-kf')?.remove();
    });
  }
});

test("ending the emulation gives back the text of the page's rules, as the CSSOM reads it", async () => {
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'clear-sheet';
    style.textContent =
      '.clear-me { padding-top: env(safe-area-inset-top, 7px); margin: 0 env(safe-area-inset-right) }';
    document.head.appendChild(style);
  });
  try {
    const r = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, right: 2 } });
      await settle();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      return t.page.evaluate(() => {
        const style = document.getElementById('clear-sheet');
        const rule = style instanceof HTMLStyleElement ? Array.from(style.sheet?.cssRules ?? [])[0] : undefined;
        return rule instanceof CSSStyleRule ? { cssText: rule.cssText, top: rule.style.paddingTop } : null;
      });
    });
    assert.deepEqual(r, {
      cssText: '.clear-me { padding-top: env(safe-area-inset-top, 7px); margin: 0 env(safe-area-inset-right); }',
      top: 'env(safe-area-inset-top, 7px)',
    });
  } finally {
    await t.page.evaluate(() => document.getElementById('clear-sheet')?.remove());
  }
});

test('the insets reach a shadow tree and a same-origin frame', async () => {
  await t.page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'sa-host';
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<style>#inner { padding-top: env(safe-area-inset-top, 4px) }</style><div id="inner">in</div>';
    document.body.appendChild(host);
    const frame = document.createElement('iframe');
    frame.id = 'sa-frame';
    frame.srcdoc = '<style>#f { padding-top: env(safe-area-inset-top, 4px) }</style><div id="f">f</div>';
    document.body.appendChild(frame);
  });
  await t.page.evaluate(() => new Promise(r => setTimeout(r, 100)));
  const read = () =>
    t.page.evaluate(() => {
      const inner = document.getElementById('sa-host')?.shadowRoot?.getElementById('inner');
      const frame = document.getElementById('sa-frame');
      const f = (frame instanceof HTMLIFrameElement && frame.contentDocument?.getElementById('f')) || null;
      return {
        shadow: inner ? getComputedStyle(inner).paddingTop : null,
        frame: f ? getComputedStyle(f).paddingTop : null,
      };
    });
  try {
    const r = await sameOnBoth(t, async side => {
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      const during = await read();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      return { during, cleared: await read() };
    });
    assert.deepEqual(r.during, { shadow: '5px', frame: '5px' });
    assert.deepEqual(r.cleared, { shadow: '0px', frame: '0px' });
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('sa-host')?.remove();
      document.getElementById('sa-frame')?.remove();
    });
  }
});

test("the Computed pane lists the custom properties the page declares, not the emulation's", async () => {
  const r = await sameOnBoth(t, async side => {
    await side.send('DOM.enable');
    await side.send('CSS.enable');
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5, rightMax: 3 } });
    await settle();
    const { root } = await side.send('DOM.getDocument', { depth: -1 });
    const customs = async (selector: string) => {
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { computedStyle } = await side.send('CSS.getComputedStyleForNode', { nodeId });
      return computedStyle.map(p => p.name).filter(name => name.startsWith('--'));
    };
    const result = { sa: await customs('#sa'), html: await customs('html') };
    await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await side.send('CSS.disable');
    await side.send('DOM.disable');
    return result;
  });
  assert.deepEqual(r.sa, ['--right']);
  assert.deepEqual(r.html, []);
});

test('an inset that is not an int32 fails, as Chrome fails it', async () => {
  for (const side of [t.chrome, t.ours]) {
    await assert.rejects(
      side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5.5 } }),
      /Invalid parameters/
    );
    await assert.rejects(
      side.send('Emulation.setSafeAreaInsetsOverride', { insets: { right: 2147483648 } }),
      /Invalid parameters/
    );
  }
});

test('an inline style with env() is emulated, and so is a style the page writes', async () => {
  await t.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="inl">inl</div>'));
  const read = () =>
    t.page.evaluate(() => {
      const style = getComputedStyle(document.getElementById('inl') ?? document.body);
      return { top: style.paddingTop, left: style.paddingLeft };
    });
  try {
    const r = await sameOnBoth(t, async side => {
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

test('an edit of a style under the emulation is undone to the text the page wrote', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="und" style="padding-top: env(safe-area-inset-top, 7px)">und</div>'
    )
  );
  try {
    const r = await sameOnBoth(t, async side => {
      await side.send('DOM.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#und' });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // The emulation takes effect, so that what follows is measured under it.
      const during = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('und') ?? document.body).paddingTop
      );
      await side.send('DOM.setAttributeValue', {
        nodeId,
        name: 'style',
        value: 'padding-top: env(safe-area-inset-top, 9px)',
      });
      await settle();
      await side.send('DOM.undo');
      await settle();
      const { attributes } = await side.send('DOM.getAttributes', { nodeId });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      const cleared = await t.page.evaluate(() => document.getElementById('und')?.getAttribute('style'));
      await side.send('DOM.disable');
      return { during, undone: attributes[attributes.indexOf('style') + 1], cleared };
    });
    assert.equal(r.during, '5px');
    assert.equal(r.undone, 'padding-top: env(safe-area-inset-top, 7px)');
    assert.equal(r.cleared, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    await t.page.evaluate(() => document.getElementById('und')?.remove());
  }
});

test('an outerHTML edit under the emulation is undone to the text the page wrote', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="oh" style="padding-top: env(safe-area-inset-top, 7px)">oh</div>'
    )
  );
  try {
    const r = await sameOnBoth(t, async side => {
      await side.send('DOM.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#oh' });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // The emulation takes effect, so that what follows is measured under it.
      const during = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('oh') ?? document.body).paddingTop
      );
      // The markup drops the style and adds another declaration: the rewritten attribute is removed.
      await side.send('DOM.setOuterHTML', { nodeId, outerHTML: '<div id="oh" style="color: red">oh</div>' });
      await settle();
      await side.send('DOM.undo');
      await settle();
      const { root: again } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId: back } = await side.send('DOM.querySelector', { nodeId: again.nodeId, selector: '#oh' });
      const { attributes } = await side.send('DOM.getAttributes', { nodeId: back });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      const cleared = await t.page.evaluate(() => document.getElementById('oh')?.getAttribute('style'));
      await side.send('DOM.disable');
      return { during, undone: attributes[attributes.indexOf('style') + 1], cleared };
    });
    assert.equal(r.during, '5px');
    assert.equal(r.undone, 'padding-top: env(safe-area-inset-top, 7px)');
    assert.equal(r.cleared, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    await t.page.evaluate(() => document.getElementById('oh')?.remove());
  }
});

test('a style the page changes in part under the emulation keeps the text the emulation replaced', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="part" style="padding-top: env(safe-area-inset-top, 7px)">part</div>'
    )
  );
  try {
    const r = await sameOnBoth(t, async side => {
      await t.page.evaluate(() =>
        document.getElementById('part')?.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)')
      );
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // Another declaration of the style, set by the page's script: the padding is still the inset's.
      await t.page.evaluate(() => {
        const el = document.getElementById('part');
        if (el) el.style.opacity = '0.5';
      });
      await settle();
      const during = await t.page.evaluate(() => {
        const el = document.getElementById('part');
        return { padding: getComputedStyle(el ?? document.body).paddingTop, opacity: el?.style.opacity };
      });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      const after = await t.page.evaluate(() => {
        const el = document.getElementById('part');
        return { padding: el?.style.paddingTop, opacity: el?.style.opacity };
      });
      return { during, after };
    });
    assert.deepEqual(r.during, { padding: '5px', opacity: '0.5' });
    assert.deepEqual(r.after, { padding: 'env(safe-area-inset-top, 7px)', opacity: '0.5' });
  } finally {
    await t.page.evaluate(() => document.getElementById('part')?.remove());
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

test('an element taken out of the page while the emulation rewrites it gets its own text back', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="gone" style="padding-top: env(safe-area-inset-top, 7px)">gone</div>'
    )
  );
  try {
    const r = await sameOnBoth(t, async side => {
      await t.page.evaluate(() =>
        document.getElementById('gone')?.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)')
      );
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // The emulation takes effect on the element before it is taken out.
      const during = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('gone') ?? document.body).paddingTop
      );
      // Taken out while rewritten, the emulation ends, and the element is put back.
      await t.page.evaluate(() => {
        const el = document.getElementById('gone');
        Reflect.set(window, 'gone', el);
        el?.remove();
      });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await t.page.evaluate(() => {
        const el: unknown = Reflect.get(window, 'gone');
        if (el instanceof HTMLElement) document.body.append(el);
      });
      await settle();
      const style = await t.page.evaluate(() => document.getElementById('gone')?.getAttribute('style') ?? null);
      return { during, style };
    });
    assert.equal(r.during, '5px');
    assert.equal(r.style, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    await t.page.evaluate(() => document.getElementById('gone')?.remove());
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
    const r = await sameOnBoth(t, async side => {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#inl' });
      await side.clear();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      // Under the emulation: the rewrite is in place, so that what the client is shown is compared with it.
      const padding = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('inl') ?? document.body).paddingTop
      );
      const during = await side.events('DOM.attributeModified');
      const { attributes } = await side.send('DOM.getAttributes', { nodeId });
      const { outerHTML } = await side.send('DOM.getOuterHTML', { nodeId });
      const { inlineStyle } = await side.send('CSS.getInlineStylesForNode', { nodeId });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      const after = await side.events('DOM.attributeModified');
      await side.send('CSS.disable');
      await side.send('DOM.disable');
      return { padding, during, after, attributes, outerHTML, css: inlineStyle?.cssText };
    });
    assert.equal(r.padding, '5px');
    assert.deepEqual(r.during, []);
    assert.deepEqual(r.after, []);
    assert.deepEqual(r.attributes.slice(2), ['style', 'padding-top: env(safe-area-inset-top, 7px)']);
    assert.match(r.outerHTML, /style="padding-top: env\(safe-area-inset-top, 7px\)"/);
    assert.equal(r.css, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    await t.page.evaluate(() => document.getElementById('inl')?.remove());
  }
});

test("a rule's declaration the page read before the emulation is no change of its sheet", async () => {
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'read-sheet';
    style.textContent = '.read-me { padding-top: env(safe-area-inset-top, 7px) }';
    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', '<div id="read-me" class="read-me">read</div>');
  });
  try {
    const r = await sameOnBoth(t, async side => {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#read-me' });
      const { matchedCSSRules } = await side.send('CSS.getMatchedStylesForNode', { nodeId });
      const styleSheetId = (matchedCSSRules ?? []).find(m => m.rule.selectorList.text === '.read-me')?.rule
        .styleSheetId;
      // A script of the page takes the rule's style before the emulation rewrites it.
      await t.page.evaluate(() => {
        const style = document.getElementById('read-sheet');
        const rule = style instanceof HTMLStyleElement ? Array.from(style.sheet?.cssRules ?? [])[0] : undefined;
        if (rule instanceof CSSStyleRule) void rule.style.paddingTop;
      });
      await side.clear();
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      const during = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('read-me') ?? document.body).paddingTop
      );
      const changed = await side.events('CSS.styleSheetChanged');
      const text = styleSheetId ? (await side.send('CSS.getStyleSheetText', { styleSheetId })).text : null;
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await settle();
      await side.send('CSS.disable');
      await side.send('DOM.disable');
      return { during, changed: changed.length, text };
    });
    assert.equal(r.during, '5px');
    assert.equal(r.changed, 0);
    assert.equal(r.text, '.read-me { padding-top: env(safe-area-inset-top, 7px) }');
  } finally {
    await t.page.evaluate(() => {
      document.getElementById('read-sheet')?.remove();
      document.getElementById('read-me')?.remove();
    });
  }
});
