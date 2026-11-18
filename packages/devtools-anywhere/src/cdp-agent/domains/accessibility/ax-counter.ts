// CSS counters, for the text of a pseudo-element whose content uses counter(): the computed
// `content` keeps counter() as written, so its value is worked out here from counter-reset,
// counter-increment and counter-set along the document. Part of accessibility.js (ax-name.ts).
import { isElement, styleOf } from '../../core/realm';
import { domChildren } from './ax-tree';

type Pseudo = '::before' | '::after';

/** The counters a counter-* value names, with their numbers (`fallback` when none is given). */
function counterPairs(value: string, fallback: number): [string, number][] {
  if (!value || value === 'none') return [];
  const out: [string, number][] = [];
  const tokens = value.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i] ?? '';
    const next = Number(tokens[i + 1]);
    if (tokens[i + 1] !== undefined && /^-?\d+$/.test(tokens[i + 1] ?? '')) {
      out.push([name, next]);
      i++;
    } else out.push([name, fallback]);
  }
  return out;
}

/** Whether a pseudo-element is generated: its content is not none or normal. */
const generated = (style: CSSStyleDeclaration) => style.content !== 'none' && style.content !== 'normal';

/**
 * The value of counter `name` for the pseudo-element `pseudo` of `target`: the document is walked
 * in order up to it, each element and generated pseudo-element resetting, incrementing then
 * setting its counters. A counter's instance lasts until its element's parent ends.
 */
export function counterValue(target: Element, pseudo: Pseudo, name: string): number {
  const instances: { value: number; scope: Node | null }[] = [];
  let result: number | null = null;
  const apply = (style: CSSStyleDeclaration, scope: Node | null) => {
    for (const [property, fallback] of [
      ['counter-reset', 0],
      ['counter-increment', 1],
      ['counter-set', 0],
    ] as const) {
      for (const [counter, value] of counterPairs(style.getPropertyValue(property), fallback)) {
        if (counter !== name) continue;
        const top = instances[instances.length - 1];
        if (property === 'counter-reset' || !top) instances.push({ value, scope });
        else if (property === 'counter-increment') top.value += value;
        else top.value = value;
      }
    }
  };
  const visitPseudo = (el: Element, which: Pseudo) => {
    const style = styleOf(el, which);
    if (generated(style)) apply(style, el);
    if (el === target && which === pseudo) result = instances[instances.length - 1]?.value ?? 0;
  };
  const visit = (el: Element) => {
    const style = styleOf(el);
    if (style.display === 'none') return;
    apply(style, el.parentNode);
    visitPseudo(el, '::before');
    for (const child of domChildren(el)) {
      if (result !== null) return;
      if (isElement(child)) visit(child);
    }
    if (result !== null) return;
    visitPseudo(el, '::after');
    while (instances.length && instances[instances.length - 1]?.scope === el) instances.pop();
  };
  const root = target.ownerDocument.documentElement;
  if (root) visit(root);
  return result ?? 0;
}

/** The text of a `content` value: its strings, with counter() and counters() as decimal numbers. */
export function contentText(content: string, el: Element, pseudo: Pseudo): string {
  let out = '';
  for (const m of content.matchAll(/"((?:[^"\\]|\\.)*)"|counters?\(\s*([\w-]+)[^)]*\)/g)) {
    if (m[2] !== undefined) out += String(counterValue(el, pseudo, m[2]));
    else out += (m[1] ?? '').replace(/\\(.)/g, '$1');
  }
  return out;
}
