// Helpers for the tests of style sheet texts and ranges: pages with a style sheet, and the parts
// of CSS domain answers Chrome and our agent are compared on.
import type { Protocol } from 'devtools-protocol';
import type { Side, TestPage } from './conformance.ts';

export async function nodeId(side: Side, selector: string): Promise<number> {
  const { root } = await side.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  return nodeId;
}

let seq = 0;

/**
 * Adds a <style> with `css` (by script) and an element with `html` in a new container; returns
 * the container's selector.
 */
export async function addStyle(t: TestPage, css: string, html: string): Promise<string> {
  const id = `src-${++seq}`;
  await t.page.evaluate(
    (id, css, html) => {
      const style = document.createElement('style');
      style.id = `${id}-style`;
      style.textContent = css;
      document.head.appendChild(style);
      const div = document.createElement('div');
      div.id = id;
      div.innerHTML = html;
      document.body.appendChild(div);
    },
    id,
    css,
    html
  );
  return `#${id}`;
}

const range = (r: Protocol.CSS.SourceRange | undefined) =>
  r && `${r.startLine}:${r.startColumn}-${r.endLine}:${r.endColumn}`;

/** A style as the Styles pane edits it: its text and range, its written properties and theirs. */
export const style = (s: Protocol.CSS.CSSStyle) => ({
  range: range(s.range),
  cssText: s.cssText,
  properties: s.cssProperties.map(p => ({
    name: p.name,
    value: p.value,
    text: p.text,
    range: range(p.range),
    disabled: p.disabled,
    parsedOk: p.parsedOk,
    important: p.important,
  })),
});

/** A rule's selectors, style and the conditions around it, with their ranges. */
export const rule = (r: Protocol.CSS.CSSRule) => ({
  text: r.selectorList.text,
  selectors: r.selectorList.selectors.map(s => ({ text: s.text, range: range(s.range) })),
  nestingSelectors: r.nestingSelectors,
  style: style(r.style),
  media: r.media?.map(m => ({ text: m.text, range: range(m.range) })),
  supports: r.supports?.map(m => ({ text: m.text, range: range(m.range) })),
  containerQueries: r.containerQueries?.map(m => ({ text: m.text, range: range(m.range) })),
  layers: r.layers?.map(m => ({ text: m.text, range: range(m.range) })),
  scopes: r.scopes?.map(m => ({ text: m.text, range: range(m.range) })),
});

/** The rules of the sheet `styleSheetId` that match the element, as `rule` gives them. */
export async function matched(
  side: Side,
  selector: string
): Promise<{ sheet: string; rules: ReturnType<typeof rule>[] }> {
  const res = await side.send('CSS.getMatchedStylesForNode', { nodeId: await nodeId(side, selector) });
  const own = (res.matchedCSSRules ?? []).filter(m => m.rule.origin === 'regular' && m.rule.styleSheetId);
  const sheet = own[own.length - 1]?.rule.styleSheetId ?? '';
  return { sheet, rules: own.filter(m => m.rule.styleSheetId === sheet).map(m => rule(m.rule)) };
}

/** Both sides' matched rules of the element and their sheet's text. */
export async function both(t: TestPage, selector: string) {
  const [ours, chrome] = await Promise.all([matched(t.ours, selector), matched(t.chrome, selector)]);
  const text = (side: Side, styleSheetId: string) =>
    side.send('CSS.getStyleSheetText', { styleSheetId }).then(r => r.text);
  return {
    ours: { ...ours, text: await text(t.ours, ours.sheet) },
    chrome: { ...chrome, text: await text(t.chrome, chrome.sheet) },
  };
}
