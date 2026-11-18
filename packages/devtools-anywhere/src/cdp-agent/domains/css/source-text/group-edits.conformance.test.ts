// Edits inside group rules, compared with Chrome: each outlines again only the innermost rule
// around it (splice.ts `respliced`), or the top-level rule when the edit leaves it no single rule,
// and the ranges of every rule after it, in the same groups and after them, must move as
// Chrome's do, edit after edit. Each side edits a page of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../../test-support/conformance.ts';
import { addStyle, nodeId, rule, style } from '../../../../../test-support/css-source.ts';

let env: Env | undefined;
let sides: { side: Side; t: TestPage }[] = [];

setUpAndTearDown(
  async () => {
    env = await launch();
    const [a, b] = [await openPage(env, []), await openPage(env, [])];
    sides = [
      { side: a.ours, t: a },
      { side: b.chrome, t: b },
    ];
    for (const { side } of sides) {
      await side.send('DOM.enable');
      await side.send('CSS.enable');
    }
  },
  () => env?.close()
);

/** What a scenario can do to its sheet; each step records what it returns and the state after. */
interface Steps {
  /** Sets the style of the target's rule with selector `selector`. */
  edit(target: string, selector: string, text: string): Promise<void>;
  /** Sets the style of the target's `index`th keyframe of its first animation. */
  keyframe(target: string, index: number, text: string): Promise<void>;
  /** Sets the selector of the target's rule with selector `selector`. */
  selector(target: string, selector: string, text: string): Promise<void>;
  /** Sets the key of the target's `index`th keyframe of its first animation. */
  key(target: string, index: number, text: string): Promise<void>;
  /** Adds a rule where the target's rule with selector `selector` starts. */
  addRule(target: string, selector: string, ruleText: string): Promise<void>;
}

/**
 * Gives a <style> of `css`, with `html` beside it, to `script` on both sides; after each step,
 * the matched rules, keyframes and ranges of each of `targets` and the sheet's text. Errors are
 * compared by their message.
 */
async function scenario(css: string, html: string, targets: string[], script: (s: Steps) => Promise<void>) {
  const results: unknown[] = [];
  for (const { side, t } of sides) {
    const at = await addStyle(t, css, html);
    const steps: unknown[] = [];
    const matchedOf = async (target: string) =>
      side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, `${at} ${target}`) });
    let sheet = '';
    const snapshot = async () => {
      const out: unknown[] = [];
      for (const target of targets) {
        const res = await matchedOf(target);
        const own = (res.matchedCSSRules ?? []).map(m => m.rule).filter(r => r.origin === 'regular' && r.styleSheetId);
        sheet = own[own.length - 1]?.styleSheetId ?? sheet;
        out.push({
          rules: own.filter(r => r.styleSheetId === sheet).map(rule),
          keyframes: res.cssKeyframesRules?.map(k =>
            k.keyframes.map(f => ({ key: f.keyText.text, range: f.keyText.range, style: style(f.style) }))
          ),
        });
      }
      return { out, text: sheet && (await side.send('CSS.getStyleSheetText', { styleSheetId: sheet })).text };
    };
    const step = async (send: () => Promise<unknown>) => {
      const got = await send().then(
        r => r,
        (e: Error) => `error: ${(e.message.split('\n')[0] ?? '').replace(/^Protocol error \([\w.]+\): /, '')}`
      );
      steps.push({ got, after: await snapshot() });
    };
    const ruleOf = async (target: string, selector: string) => {
      const rules = ((await matchedOf(target)).matchedCSSRules ?? []).map(m => m.rule);
      // The last: in this scenario's sheet, added after those of the scenarios before.
      const found = rules.findLast(r => r.selectorList.text === selector);
      const seen = rules.map(r => [r.selectorList.text, r.style.range?.startLine]);
      assert.ok(found?.styleSheetId && found.style.range, `${target} ${selector}: ${JSON.stringify(seen)}`);
      return found as Protocol.CSS.CSSRule & { styleSheetId: string; style: { range: Protocol.CSS.SourceRange } };
    };
    const frameOf = async (target: string, index: number) => {
      const frame = (await matchedOf(target)).cssKeyframesRules?.[0]?.keyframes[index];
      assert.ok(frame?.style.styleSheetId && frame.style.range, `${target} ${index}`);
      return frame;
    };
    await snapshot();
    await script({
      edit: async (target, selector, text) => {
        const r = await ruleOf(target, selector);
        await step(() =>
          side
            .send('CSS.setStyleTexts', { edits: [{ styleSheetId: r.styleSheetId, range: r.style.range, text }] })
            .then(res => res.styles.map(style))
        );
      },
      keyframe: async (target, index, text) => {
        const f = await frameOf(target, index);
        await step(() =>
          side
            .send('CSS.setStyleTexts', {
              edits: [
                {
                  styleSheetId: f.style.styleSheetId as string,
                  range: f.style.range as Protocol.CSS.SourceRange,
                  text,
                },
              ],
            })
            .then(res => res.styles.map(style))
        );
      },
      selector: async (target, selector, text) => {
        const r = await ruleOf(target, selector);
        const [a, b] = [r.selectorList.selectors[0]?.range, r.selectorList.selectors.at(-1)?.range];
        assert.ok(a && b);
        const range = {
          startLine: a.startLine,
          startColumn: a.startColumn,
          endLine: b.endLine,
          endColumn: b.endColumn,
        };
        await step(() =>
          side
            .send('CSS.setRuleSelector', { styleSheetId: r.styleSheetId, range, selector: text })
            .then(res => res.selectorList.selectors.map(s => [s.text, s.range]))
        );
      },
      key: async (target, index, text) => {
        const f = await frameOf(target, index);
        await step(() =>
          side
            .send('CSS.setKeyframeKey', {
              styleSheetId: f.style.styleSheetId as string,
              range: f.keyText.range as Protocol.CSS.SourceRange,
              keyText: text,
            })
            .then(res => [res.keyText.text, res.keyText.range])
        );
      },
      addRule: async (target, selector, ruleText) => {
        const r = await ruleOf(target, selector);
        const s = r.selectorList.selectors[0]?.range;
        assert.ok(s);
        const location = {
          startLine: s.startLine,
          startColumn: s.startColumn,
          endLine: s.startLine,
          endColumn: s.startColumn,
        };
        await step(() =>
          side.send('CSS.addRule', { styleSheetId: r.styleSheetId, location, ruleText }).then(res => rule(res.rule))
        );
      },
    });
    const cssom = await t.page.evaluate(
      at =>
        Array.from((document.getElementById(`${at.slice(1)}-style`) as HTMLStyleElement).sheet?.cssRules ?? []).map(
          r => r.cssText
        ),
      at
    );
    results.push({ steps, cssom });
  }
  const [ours, chrome] = results;
  assert.deepEqual(ours, chrome);
}

test('declarations edited one after another in a sheet wrapped in @layer and @media', async () => {
  const many = Array.from({ length: 300 }, (_, i) => `    .w${i} { color: red; top: ${i}px }`).join('\n');
  const css = `@layer base {
  @media screen {
${many}
    .n1 { color: red; & .in { left: 1px } }
    @supports (display: grid) { .n2 { order: 1 } }
  }
  @keyframes k { from { opacity: 0 } to { opacity: 1 } }
}
.after { color: red }
`;
  const html =
    '<p class="w3" style="animation: k 1s infinite">x</p><p class="w150 n1"><b class="in">y</b></p>' +
    '<p class="n2 after">z</p><p class="w299">w</p>';
  await scenario(css, html, ['p.w3', 'p.w150', 'b.in', 'p.n2', 'p.w299'], async s => {
    await s.edit('p.w150', '.w150', ' color: blue; top: 1500px; left: 2px ');
    await s.edit('p.w3', '.w3', 'color: green');
    await s.edit('p.w150', '.w150', ' color: red ');
    await s.edit('b.in', '& .in', ' left: 22px; right: 3px ');
    await s.edit('p.w150', '.n1', ' color: teal; ');
    // The nested rule kept, at its new offsets.
    await s.selector('b.in', '& .in', '& b.in');
    await s.edit('p.n2', '.n2', ' order: 22 ');
    await s.edit('p.n2', '.after', ' color: navy ');
    await s.edit('p.w3', '.w3', ' color: red; top: 3px ');
    await s.keyframe('p.w3', 1, ' opacity: 0.5 ');
    await s.key('p.w3', 1, '90%');
    await s.keyframe('p.w3', 0, ' opacity: 0.1; ');
    await s.edit('p.w150', '.w150', 'color: blue');
    await s.edit('p.w299', '.w299', 'color: blue; top: 2990px');
  });
});

test('a rule added at the edge of one in a group: the group outlined again', async () => {
  const css =
    '@media screen {\n  @media (min-width: 1px) {\n    .a { color: red }\n    .b { color: red }\n  }\n}\n.c { top: 0 }\n';
  await scenario(css, '<p class="a b c">x</p>', ['p'], async s => {
    await s.addRule('p', '.b', '.a { order: 1 }');
    await s.edit('p', '.b', ' color: blue ');
    await s.edit('p', '.c', ' top: 2px ');
  });
});

test('a style given a nested rule in a group', { todo: 'the rules after it lose their ranges' }, async () => {
  // Chrome keeps the ranges of `.b` and `.c`; here they are lost once the style of `.a` gains a
  // nested rule. The same with splice.ts before respliced went down into groups (e03a858): it is
  // not respliced's.
  const css =
    '@media screen {\n  @media (min-width: 1px) {\n    .a { color: red }\n    .b { color: red }\n  }\n}\n.c { top: 0 }\n';
  await scenario(css, '<p class="a b c"><i>x</i></p>', ['p', 'i'], async s => {
    await s.edit('p', '.a', ' color: red; & i { top: 1px } ');
    await s.edit('p', '.c', ' top: 2px ');
  });
});

test('the same rule edited again and again, past the dead records the outline keeps', async () => {
  const body = Array.from(
    { length: 4 },
    (_, i) => `  .r${i} { ${Array.from({ length: 20 }, (_, j) => `--p${j}: ${j}`).join('; ')} }`
  );
  const css = `@media screen {\n${body.join('\n')}\n}\n.z { top: 0 }\n`;
  await scenario(css, '<p class="r0 r3 z">x</p>', ['p'], async s => {
    for (let i = 0; i < 6; i++) await s.edit('p', '.r0', ` --p0: ${i}; --p1: ${i} `);
    await s.edit('p', '.r3', ' --q: 1 ');
  });
});

test('@container and @starting-style are gone into, @scope is not; groups side by side', async () => {
  const css = `@media screen { .m1 { color: red } }
@media screen { .m2 { color: red } }
@container (min-width: 0px) { .k { color: red; & i { top: 1px } } }
@starting-style { .s { opacity: 0 } }
@scope (.sc) { .t { color: red } color: blue; }
@media screen { .m3 { color: red } }
`;
  const html = '<div class="sc" style="container-type: inline-size"><p class="m1 m2 k s m3 t"><i>x</i></p></div>';
  await scenario(css, html, ['p', 'i'], async s => {
    await s.edit('p', '.m1', ' color: blue; top: 1px ');
    await s.edit('p', '.k', ' color: green; ');
    await s.edit('i', '& i', ' top: 22px ');
    await s.edit('p', '.t', ' color: teal ');
    await s.edit('p', '.m2', ' color: navy ');
    await s.edit('p', '.m3', '');
  });
});

test(
  'a style holding a nested rule given one more with the same selector',
  { todo: 'pairs the wrong nested rule' },
  async () => {
    // Chrome gives the old nested rule its own range; here the CSSOM rule is paired with the first
    // `& .in` of the text, the new one. Both the drill-down and the replacing of the whole top-level
    // rule pair so: it is pairList's (pair.ts), not respliced's.
    const css = '@media screen {\n  .n1 { color: red; & .in { left: 1px } }\n}\n';
    await scenario(css, '<p class="n1"><b class="in">y</b></p>', ['p', 'b'], async s => {
      await s.edit('b', '& .in', ' left: 22px ');
      await s.edit('p', '.n1', ' color: teal; & .in { left: 1px } ');
    });
  }
);
