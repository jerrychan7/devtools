// The Styles pane of the DevTools frontend built from the official sources, against the in-page
// CDP agent: editing a value, unchecking and checking a property, adding and removing one,
// changing a selector and adding a rule, each checked in the page's computed style and in the
// style sheet's text. Skipped when the frontend has not been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
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

// After the rule the first tests edit: an @container and the @keyframes of an animation.
const MORE =
  'body { container-type: inline-size }\n@container (min-width: 0px) { p.e2e { margin-right: 3px } }\n' +
  '#e2e { animation: kf 100s paused }\n@keyframes kf { from { opacity: 0.5 } to { opacity: 1 } }\n';
const CSS = '.e2e {\n  color: red;\n  padding: 1px;\n}\n' + MORE;

setUpAndTearDown(
  async () => {
    if (!built) return;
    ({ env, page, frontend } = await openRealFrontend(errors));
    await page.evaluate(css => {
      const s = document.createElement('style');
      s.id = 'e2e-style';
      s.textContent = css;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML('beforeend', '<p class="e2e" id="e2e">styled</p>');
    }, CSS);
    await showView('elements');
    // Selects the paragraph in the Elements tree.
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

/** The first element of the frontend, shadow DOM included, matching `selector` and `text`. */
async function find(selector: string, text?: string): Promise<ElementHandle<Element>> {
  return waitFor(async () => {
    const handle = await frontend.evaluateHandle(
      (selector, text) => {
        const walk = (root: Document | ShadowRoot): Element | null => {
          for (const el of root.querySelectorAll(selector))
            if (text === undefined || el.textContent?.trim() === text) return el;
          for (const el of root.querySelectorAll('*')) {
            const found = el.shadowRoot && walk(el.shadowRoot);
            if (found) return found;
          }
          return null;
        };
        return walk(document);
      },
      selector,
      text
    );
    return handle.asElement() as ElementHandle<Element> | null;
  });
}

/** The computed `property` of #e2e, and the text of the sheet holding `.e2e`, from the frontend. */
async function state(property: string) {
  const computed = await page.evaluate(p => {
    const el = document.getElementById('e2e');
    return el ? getComputedStyle(el).getPropertyValue(p) : '';
  }, property);
  const at = await page.evaluate(() => {
    const box = document.getElementById('e2e')?.getBoundingClientRect();
    return box ? { x: Math.round(box.left + 2), y: Math.round(box.top + 2) } : { x: 0, y: 0 };
  });
  const text = await frontend.evaluate(async at => {
    // The built frontend has no type declarations; only this much of it is used.
    type Host = {
      InspectorFrontendHost: {
        InspectorFrontendHostInstance: {
          sendMessageToBackend(message: string): void;
          events: { addEventListener(type: string, listener: (event: { data: unknown }) => void): void };
        };
      };
      InspectorFrontendHostAPI: { Events: { DispatchMessage: string } };
    };
    const src = document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '';
    const { InspectorFrontendHost, InspectorFrontendHostAPI }: Host = await (
      await import(src)
    ).modules['core/host/host.js']();
    const host = InspectorFrontendHost.InspectorFrontendHostInstance;
    // The session the frontend uses, asked directly, with ids out of the frontend's range.
    const pending = new Map<number, (result: unknown) => void>();
    host.events.addEventListener(InspectorFrontendHostAPI.Events.DispatchMessage, ({ data }) => {
      const msg: { id?: number; result?: unknown } = typeof data === 'string' ? JSON.parse(data) : {};
      if (msg.id) pending.get(msg.id)?.(msg.result);
    });
    let id = 9e8 + Math.floor(Math.random() * 1e6);
    const call = (method: string, params: object) =>
      new Promise<Record<string, unknown>>(resolve => {
        pending.set(++id, result => resolve(result && typeof result === 'object' ? { ...result } : {}));
        host.sendMessageToBackend(JSON.stringify({ id, method, params }));
      });
    // The sheet of the rule matching #e2e with `.e2e` in its selector.
    const { backendNodeId } = await call('DOM.getNodeForLocation', at);
    const { nodeIds } = await call('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
    const nodeId = Array.isArray(nodeIds) ? nodeIds[0] : undefined;
    const { matchedCSSRules } = await call('CSS.getMatchedStylesForNode', { nodeId });
    const rules = Array.isArray(matchedCSSRules) ? matchedCSSRules : [];
    const rule: unknown = rules
      .map(m => (m && typeof m === 'object' ? Reflect.get(m, 'rule') : null))
      .find(r => r && typeof r === 'object' && JSON.stringify(Reflect.get(r, 'selectorList')).includes('.e2e'));
    const styleSheetId = rule && typeof rule === 'object' ? Reflect.get(rule, 'styleSheetId') : undefined;
    const { text } = await call('CSS.getStyleSheetText', { styleSheetId });
    return typeof text === 'string' ? text : '';
  }, at);
  return { computed, text };
}

/** The element matching `selector` in the Styles pane's section of the rule `rule`. */
// The section whose header (`head`) reads `rule` and that has one: the pane may show a rule twice.
async function inRule(rule: string, selector: string, head = '.selector'): Promise<ElementHandle<Element>> {
  return waitFor(async () => {
    const handle = await frontend.evaluateHandle(
      (rule, selector, head) => {
        const walk = (root: Document | ShadowRoot): Element | null => {
          for (const el of root.querySelectorAll(head))
            if (el.textContent?.trim() === rule) {
              const found = el.closest('.styles-section')?.querySelector(selector);
              if (found) return found;
            }
          for (const el of root.querySelectorAll('*')) {
            const found = el.shadowRoot && walk(el.shadowRoot);
            if (found) return found;
          }
          return null;
        };
        return walk(document);
      },
      rule,
      selector,
      head
    );
    return handle.asElement() as ElementHandle<Element> | null;
  });
}

/** Whether an editor of the Styles pane has the focus. */
const editing = () =>
  frontend.evaluate(() => {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active instanceof HTMLElement && active.isContentEditable;
  });

/** Clicks `target` until an editor has the focus. */
async function edit(target: () => Promise<ElementHandle<Element>>) {
  await waitFor(async () => {
    await (await target()).click();
    await new Promise(r => setTimeout(r, 300));
    return editing();
  });
}

/** Types `text` into the editor that has the focus, and commits it. */
async function type(text: string) {
  await waitFor(editing);
  // Its suggestions keep up with slow typing only.
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.type(text, { delay: 40 });
  await page.keyboard.press('Enter');
  // Committing moves on to the next property's editor: leave it.
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('Escape');
}

test('the Styles pane edits a value, as written in the sheet', { skip }, async () => {
  await edit(() => find('.webkit-css-property', 'color'));
  await page.keyboard.press('Tab');
  await type('blue');
  await waitFor(async () => (await state('color')).computed === 'rgb(0, 0, 255)');
  assert.equal((await state('color')).text, '.e2e {\n  color: blue;\n  padding: 1px;\n}\n' + MORE);
});

test('unchecking a property comments it out, checking it brings it back', { skip }, async () => {
  const box = async () => {
    const name = await find('.webkit-css-property', 'padding');
    const handle = await name.evaluateHandle(el => el.closest('li')?.querySelector('input[type=checkbox]'));
    return handle.asElement() as ElementHandle<Element>;
  };
  // Shown on hover only: clicked as a script would.
  await (await box()).evaluate(el => el instanceof HTMLElement && el.click());
  await waitFor(async () => (await state('padding-top')).computed === '0px');
  assert.match((await state('padding')).text, /\/\* padding: 1px; \*\//);
  // Shown on hover only: clicked as a script would.
  await (await box()).evaluate(el => el instanceof HTMLElement && el.click());
  await waitFor(async () => (await state('padding-top')).computed === '1px');
  assert.equal((await state('padding')).text, '.e2e {\n  color: blue;\n  padding: 1px;\n}\n' + MORE);
});

test('adding a property and removing it', { skip }, async () => {
  // A click past the last property starts a new one.
  await edit(() => inRule('.e2e', '.sidebar-pane-closing-brace'));
  // A colon, not Tab, ends the name: Tab would take the suggestion shown.
  await page.keyboard.type('margin:', { delay: 40 });
  await page.keyboard.type('3px', { delay: 40 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await state('margin-top')).computed === '3px');
  assert.match((await state('margin')).text, /margin: 3px;/);
  // An empty name removes it.
  await edit(() => find('.webkit-css-property', 'margin'));
  await page.keyboard.press('End');
  for (let i = 0; i < 'margin'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await state('margin-top')).computed !== '3px');
  assert.doesNotMatch((await state('margin')).text, /margin: 3px/);
});

test('changing the selector writes it as typed', { skip }, async () => {
  await edit(() => find('.selector', '.e2e'));
  await type('.e2e,  #e2e');
  await waitFor(async () => (await state('color')).text.startsWith('.e2e,  #e2e {'));
  assert.equal((await state('color')).computed, 'rgb(0, 0, 255)');
});

test("editing an @container's condition", { skip }, async () => {
  await edit(() => find('.query-text', '(min-width: 0px)'));
  await type('(min-width: 99999px)');
  await waitFor(async () => (await state('margin-right')).computed === '0px');
  assert.match((await state('margin-right')).text, /@container \(min-width: 99999px\) \{/);
});

test('a new rule from the toolbar applies to the element', { skip }, async () => {
  await (await find('[aria-label="New style rule"]')).click();
  // The new rule's selector is being edited: keep it (Tab), then type a property.
  await waitFor(editing);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('Tab');
  await new Promise(r => setTimeout(r, 300));
  await waitFor(editing);
  await page.keyboard.type('outline-style:', { delay: 40 });
  await page.keyboard.type('dotted', { delay: 40 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await state('outline-style')).computed === 'dotted');
  assert.deepEqual(errors, []);
});
