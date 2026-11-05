// The Styles pane of the real DevTools frontend while another client (a second session of the
// in-page agent) edits the same style sheet: unlike Chrome, the frontend is sent
// CSS.styleSheetChanged and shows the other client's text, without errors. Skipped when the
// frontend has not been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'puppeteer-core';
import type { Env } from '../../support/browser.ts';
import {
  built,
  frontendHelpers,
  openRealFrontend,
  skip,
  waitFor,
  setUpAndTearDown,
} from '../../support/real-frontend.ts';

let env: Env | undefined;
let page: Page;
let frontend: Frame;
const errors: string[] = [];
const { showView } = frontendHelpers(() => frontend);

setUpAndTearDown(
  async () => {
    if (!built) return;
    ({ env, page, frontend } = await openRealFrontend(errors));
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = 'sess-style';
      s.textContent = '.sess {\n  color: red;\n}\n';
      document.head.appendChild(s);
      document.body.insertAdjacentHTML('beforeend', '<p class="sess" id="sess">styled</p>');
    });
    await showView('elements');
    await waitFor(() =>
      frontend.evaluate(() => {
        const find = (root: Document | ShadowRoot): Element | null => {
          for (const li of root.querySelectorAll('li'))
            if (li.textContent.startsWith('<p') && li.textContent.includes('styled')) return li;
          for (const el of root.querySelectorAll('*')) {
            const found = el.shadowRoot && find(el.shadowRoot);
            if (found) return found;
          }
          return null;
        };
        const li = find(document);
        li?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return !!li;
      })
    );
  },
  () => env?.close()
);

/** The text of the Styles pane's sections, shadow DOM included. */
const sections = () =>
  frontend.evaluate(() => {
    // A section's properties are in shadow trees of its own.
    const deep = (node: Node): string =>
      node instanceof Text
        ? node.data
        : node instanceof HTMLStyleElement
          ? ''
          : [...(node instanceof Element && node.shadowRoot ? [node.shadowRoot] : []), ...Array.from(node.childNodes)]
              .map(deep)
              .join('');
    const found: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('.styles-section')) found.push(deep(el).replace(/\s+/g, ' '));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return found.join('\n');
  });

/** Calls `method` on a second session of the agent, made once. */
const other = (method: string, params: object) =>
  page.evaluate(
    async (method, params) => {
      type Session = ReturnType<typeof window.DevtoolsAnywhere.createCdpSession>;
      let s = Reflect.get(window, '__other') as Session | undefined;
      if (!s) {
        s = window.DevtoolsAnywhere.createCdpSession();
        Reflect.set(window, '__other', s);
        await s.call('DOM.enable', {});
        await s.call('CSS.enable', {});
      }
      return JSON.stringify(await s.call(method, params));
    },
    method,
    params
  ) as Promise<string>;

/** The other session's id of the sheet holding `.sess`. */
async function otherSheet(): Promise<string> {
  const { root } = JSON.parse(await other('DOM.getDocument', {})) as { root: { nodeId: number } };
  const { nodeId } = JSON.parse(await other('DOM.querySelector', { nodeId: root.nodeId, selector: '#sess' })) as {
    nodeId: number;
  };
  const { matchedCSSRules } = JSON.parse(await other('CSS.getMatchedStylesForNode', { nodeId })) as {
    matchedCSSRules: { rule: { styleSheetId?: string; selectorList: { text: string } } }[];
  };
  const id = matchedCSSRules.find(m => m.rule.selectorList.text === '.sess')?.rule.styleSheetId;
  assert.ok(id);
  return id;
}

test("another client's setStyleSheetText and addRule show in the frontend's Styles pane", { skip }, async () => {
  await waitFor(async () => (await sections()).includes('color: red'));
  const styleSheetId = await otherSheet();
  await other('CSS.setStyleSheetText', { styleSheetId, text: '.sess {\n  color: orange;\n}\n' });
  await waitFor(async () => (await sections()).includes('color: orange'));
  await other('CSS.addRule', {
    styleSheetId,
    ruleText: '#sess { margin-left: 7px }',
    location: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 0 },
  });
  await waitFor(async () => (await sections()).includes('margin-left: 7px'));
  const text = (JSON.parse(await other('CSS.getStyleSheetText', { styleSheetId })) as { text: string }).text;
  assert.equal(text, '.sess {\n  color: orange;\n}\n#sess { margin-left: 7px }');
  assert.deepEqual(errors, []);
});
