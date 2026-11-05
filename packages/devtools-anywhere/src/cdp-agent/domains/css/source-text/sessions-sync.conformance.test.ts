// Every session of our agent serves the same text of a sheet, whichever edits it (unlike Chrome,
// where the others keep the text they had): edits of each kind, undo and redo, a text not known,
// a session enabling CSS late. Each test has a <style> of its own and sessions of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
  },
  () => env?.close()
);

let seq = 0;

/** A session made in the page, its CSS events kept. */
interface Client {
  call(method: string, params?: object): Promise<Record<string, unknown>>;
  /** The CSS.styleSheet* events since the last call, with their sheet ids. */
  events(): Promise<string[]>;
  /** Its id of the sheet holding `.cls`, and the style and selector ranges of that rule. */
  rule(cls: string): Promise<{ sheet: string; style: unknown; selector: unknown }>;
  text(sheet: string): Promise<string>;
}

async function client(css = true): Promise<Client> {
  const name = `c${++seq}`;
  await t.page.evaluate(
    async (name, css) => {
      const s = window.DevtoolsAnywhere.createCdpSession();
      const seen: string[] = [];
      s.onMessage(m => {
        const msg: { method?: string; params?: { styleSheetId?: string; header?: { styleSheetId: string } } } =
          JSON.parse(m);
        if (msg.method?.startsWith('CSS.styleSheet'))
          seen.push(`${msg.method} ${msg.params?.styleSheetId ?? msg.params?.header?.styleSheetId}`);
      });
      Reflect.set(window, name, { s, seen });
      await s.call('DOM.enable', {});
      if (css) await s.call('CSS.enable', {});
    },
    name,
    css
  );
  const call = (method: string, params: object = {}) =>
    t.page
      .evaluate(
        async (name, method, params) => {
          const { s } = Reflect.get(window, name) as { s: ReturnType<typeof window.DevtoolsAnywhere.createCdpSession> };
          return JSON.stringify(await s.call(method, params));
        },
        name,
        method,
        params
      )
      .then(r => JSON.parse(r) as Record<string, unknown>);
  const self: Client = {
    call,
    events: () => t.page.evaluate(name => (Reflect.get(window, name) as { seen: string[] }).seen.splice(0), name),
    async rule(cls) {
      const { root } = (await call('DOM.getDocument')) as { root: { nodeId: number } };
      const { nodeId } = (await call('DOM.querySelector', { nodeId: root.nodeId, selector: `#${cls}` })) as {
        nodeId: number;
      };
      const { matchedCSSRules } = (await call('CSS.getMatchedStylesForNode', { nodeId })) as {
        matchedCSSRules: {
          rule: {
            styleSheetId?: string;
            style: { range?: unknown };
            selectorList: { text: string; selectors: { range?: unknown }[] };
          };
        }[];
      };
      const rule = matchedCSSRules.map(m => m.rule).find(r => r.selectorList.text.split(',')[0] === `.${cls}`);
      assert.ok(rule?.styleSheetId);
      const selectors = rule.selectorList.selectors;
      const first = selectors[0]?.range as { startLine: number; startColumn: number } | undefined;
      const last = selectors[selectors.length - 1]?.range as { endLine: number; endColumn: number } | undefined;
      return {
        sheet: rule.styleSheetId,
        style: rule.style.range,
        selector: first && last && { ...first, endLine: last.endLine, endColumn: last.endColumn },
      };
    },
    text: async sheet => (await call('CSS.getStyleSheetText', { styleSheetId: sheet }))['text'] as string,
  };
  return self;
}

/** A <style> with `css` and an element of class (and id) `cls`; returns `cls`. */
async function sheetWith(css: (cls: string) => string): Promise<string> {
  const cls = `sync${++seq}`;
  await t.page.evaluate(
    (cls, css) => {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML('beforeend', `<p class="${cls}" id="${cls}">x</p>`);
    },
    cls,
    css(cls)
  );
  return cls;
}

const settle = () => new Promise(r => setTimeout(r, 100));

test('setRuleSelector of one session: the other gets the text, styleSheetChanged; the editor no event', async () => {
  const cls = await sheetWith(c => `/* a */\n.${c} {\n  color: red;\n}\n`);
  const [a, b] = [await client(), await client()];
  const { sheet, selector } = await a.rule(cls);
  await settle();
  await Promise.all([a.events(), b.events()]);
  await a.call('CSS.setRuleSelector', { styleSheetId: sheet, range: selector, selector: `.${cls}, i` });
  await settle();
  const text = `/* a */\n.${cls}, i {\n  color: red;\n}\n`;
  assert.equal(await a.text(sheet), text);
  const theirs = (await b.rule(cls)).sheet;
  assert.equal(await b.text(theirs), text);
  assert.deepEqual(await a.events(), []);
  assert.deepEqual(await b.events(), [`CSS.styleSheetChanged ${theirs}`]);
});

test('setMediaText of one session: the other gets the text, and edits it in place', async () => {
  const cls = await sheetWith(c => `@media (min-width: 1px) {\n  .${c} { top: 1px }\n}\n`);
  const [a, b] = [await client(), await client()];
  const { sheet } = await a.rule(cls);
  await a.call('CSS.setMediaText', {
    styleSheetId: sheet,
    range: { startLine: 0, startColumn: 7, endLine: 0, endColumn: 23 },
    text: '(min-width: 2px)',
  });
  const mine = await b.rule(cls);
  assert.deepEqual(mine.style, { startLine: 1, startColumn: 5 + cls.length, endLine: 1, endColumn: 15 + cls.length });
  await b.call('CSS.setStyleTexts', { edits: [{ styleSheetId: mine.sheet, range: mine.style, text: ' top: 2px ' }] });
  const text = `@media (min-width: 2px) {\n  .${cls} { top: 2px }\n}\n`;
  assert.equal(await a.text(sheet), text);
  assert.equal(await b.text(mine.sheet), text);
});

test("undo after another session's edit: the text is taken from the sheet, not the old one", async () => {
  const cls = await sheetWith(c => `.${c} { color: red }\n.${c}-b { top: 1px }\n`);
  await t.page.evaluate(cls => document.getElementById(cls)?.classList.add(`${cls}-b`), cls);
  const [a, b] = [await client(), await client()];
  const r = await a.rule(cls);
  await a.call('DOM.markUndoableState');
  await a.call('CSS.setStyleTexts', { edits: [{ styleSheetId: r.sheet, range: r.style, text: ' color: blue ' }] });
  await a.call('DOM.markUndoableState');
  // The other session edits another rule.
  const { root } = (await b.call('DOM.getDocument')) as { root: { nodeId: number } };
  const { nodeId } = (await b.call('DOM.querySelector', { nodeId: root.nodeId, selector: `#${cls}` })) as {
    nodeId: number;
  };
  const { matchedCSSRules } = (await b.call('CSS.getMatchedStylesForNode', { nodeId })) as {
    matchedCSSRules: { rule: { styleSheetId: string; style: { range: unknown }; selectorList: { text: string } } }[];
  };
  const other = matchedCSSRules.find(m => m.rule.selectorList.text === `.${cls}-b`)?.rule;
  assert.ok(other);
  await b.call('CSS.setStyleTexts', {
    edits: [{ styleSheetId: other.styleSheetId, range: other.style.range, text: ' top: 2px ' }],
  });
  await a.call('DOM.undo');
  // Both rules as the CSSOM has them: the undone color, the other session's top.
  const now = await a.text(r.sheet);
  assert.equal(now, await b.text(other.styleSheetId));
  assert.match(now, new RegExp(`\\.${cls} \\{ color: red;? \\}`));
  assert.match(now, /top: 2px/);
  await a.call('DOM.redo');
  const redone = await a.text(r.sheet);
  assert.equal(redone, await b.text(other.styleSheetId));
  assert.match(redone, /color: blue/);
  assert.match(redone, /top: 2px/);
});

test('undo and redo with no other edit restore the texts as written, in every session', async () => {
  const cls = await sheetWith(c => `.${c} {\n  color: red;\n}\n`);
  const [a, b] = [await client(), await client()];
  const r = await a.rule(cls);
  const theirs = (await b.rule(cls)).sheet;
  await a.call('DOM.markUndoableState');
  await a.call('CSS.addRule', {
    styleSheetId: r.sheet,
    ruleText: `.${cls}-n { left: 1px }`,
    location: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 0 },
  });
  await a.call('DOM.markUndoableState');
  const added = `.${cls} {\n  color: red;\n}\n.${cls}-n { left: 1px }`;
  assert.equal(await b.text(theirs), added);
  await a.call('DOM.undo');
  assert.equal(await b.text(theirs), `.${cls} {\n  color: red;\n}\n`);
  await a.call('DOM.redo');
  assert.equal(await b.text(theirs), added);
});

test('a text one session does not know is served serialized by the others too, the same', async () => {
  const cls = await sheetWith(c => `.${c} { color: red }\n`);
  const [a, b] = [await client(), await client()];
  const r = await a.rule(cls);
  // The page changes the rule: the text is no longer known.
  await t.page.evaluate(cls => {
    const sheet = [...document.styleSheets].find(s => s.cssRules[0]?.cssText.includes(cls));
    sheet?.insertRule(`.${cls}-p { top: 1px }`, 1);
  }, cls);
  const mine = await b.rule(cls);
  await b.call('CSS.setStyleTexts', { edits: [{ styleSheetId: mine.sheet, range: mine.style, text: 'color: blue;' }] });
  const text = await a.text(r.sheet);
  assert.equal(text, await b.text(mine.sheet));
  assert.match(text, /color: blue/);
});

test('a session enabling CSS after an edit gets the edited text, and edits it in place', async () => {
  const cls = await sheetWith(c => `@media (min-width: 1px) {\n  .${c}-m { top: 1px }\n}\n.${c} {\n  color: red;\n}\n`);
  const a = await client();
  const late = await client(false);
  const r = await a.rule(cls);
  await a.call('CSS.setStyleTexts', { edits: [{ styleSheetId: r.sheet, range: r.style, text: ' color: green; ' }] });
  await late.call('CSS.enable');
  const mine = await late.rule(cls);
  const edited = `@media (min-width: 1px) {\n  .${cls}-m { top: 1px }\n}\n.${cls} { color: green; }\n`;
  assert.equal(await late.text(mine.sheet), edited);
  await late.call('CSS.setStyleTexts', {
    edits: [{ styleSheetId: mine.sheet, range: mine.style, text: ' color: navy; ' }],
  });
  assert.equal(await a.text(r.sheet), edited.replace('green', 'navy'));
});
