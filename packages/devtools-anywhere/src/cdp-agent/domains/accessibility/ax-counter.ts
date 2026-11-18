// Generated text of a pseudo-element, as Chrome names it: the computed `content` keeps counter()
// and quotes as written, so their text is worked out here. Chrome leaves counters out of the
// rendered text and keeps them in the alternative text; quotes only work in the rendered text.
// Counters come from counter-reset, counter-increment, counter-set and the list-item counter of
// lists, along the document. Part of accessibility.js (ax-name.ts).
import { isElement, styleOf } from '../../core/realm';
import { attr, domChildren, hasAttr } from './ax-tree';

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
 * The list-item counter an element resets, increments and sets without its counter-* properties
 * saying so, in that order: lists reset it, list items increment it (down in a reversed ol), and
 * an li's value sets it.
 */
function listItem(el: Element, style: CSSStyleDeclaration): (number | null)[] {
  const ol = el.localName === 'ol' ? (el as HTMLOListElement) : null;
  let reset: number | null = null;
  if (ol || el.localName === 'ul' || el.localName === 'menu') {
    const items = [...el.children].filter(c => styleOf(c).display === 'list-item').length;
    const start = ol && hasAttr(ol, 'start') ? ol.start : ol?.reversed ? items : 1;
    reset = ol?.reversed ? start + 1 : start - 1;
  }
  const item = style.display === 'list-item';
  const parent = el.parentElement;
  const value = item && el.localName === 'li' ? attr(el, 'value') : null;
  return [
    reset,
    item ? (parent?.localName === 'ol' && (parent as HTMLOListElement).reversed ? -1 : 1) : null,
    value !== null && /^\s*-?\d+\s*$/.test(value) ? Number(value) : null,
  ];
}

/**
 * Walks the document in order up to the pseudo-element `pseudo` of `target`, past the elements
 * not shown: `onElement` at each element, `onPseudo` at each generated pseudo-element up to the
 * target's (included), `onLeave` as an element ends.
 */
function walkTo(
  target: Element,
  pseudo: Pseudo,
  onElement: (el: Element, style: CSSStyleDeclaration) => void,
  onPseudo: (el: Element, which: Pseudo, style: CSSStyleDeclaration) => void,
  onLeave: (el: Element) => void = () => {}
): void {
  let done = false;
  const visitPseudo = (el: Element, which: Pseudo) => {
    const style = styleOf(el, which);
    if (generated(style)) onPseudo(el, which, style);
    done = el === target && which === pseudo;
  };
  const visit = (el: Element) => {
    const style = styleOf(el);
    if (style.display === 'none') return;
    onElement(el, style);
    visitPseudo(el, '::before');
    for (const child of domChildren(el)) if (!done && isElement(child)) visit(child);
    if (done) return;
    visitPseudo(el, '::after');
    onLeave(el);
  };
  const root = target.ownerDocument.documentElement;
  if (root) visit(root);
}

/**
 * The instances of counter `name` in scope at the pseudo-element `pseudo` of `target`, outermost
 * first: each element and generated pseudo-element resets, increments then sets its counters. A
 * counter's instance lasts until its element's parent ends.
 */
export function counterValues(target: Element, pseudo: Pseudo, name: string): number[] {
  const instances: { value: number; scope: Node | null }[] = [];
  const apply = (style: CSSStyleDeclaration, scope: Node | null, implicit: (number | null)[] = []) => {
    (['counter-reset', 'counter-increment', 'counter-set'] as const).forEach((property, i) => {
      const pairs = counterPairs(style.getPropertyValue(property), i % 2);
      const own = implicit[i];
      if (own != null && !pairs.some(p => p[0] === name)) pairs.push([name, own]);
      for (const [counter, value] of pairs) {
        if (counter !== name) continue;
        const top = instances[instances.length - 1];
        if (!i || !top) instances.push({ value, scope });
        else if (i === 1) top.value += value;
        else top.value = value;
      }
    });
  };
  walkTo(
    target,
    pseudo,
    (el, style) => apply(style, el.parentNode, name === 'list-item' ? listItem(el, style) : []),
    (el, _, style) => apply(style, el),
    el => {
      while (instances[instances.length - 1]?.scope === el) instances.pop();
    }
  );
  return instances.map(i => i.value);
}

/** A counter's number in a list style; the styles not written here, and numbers out of a style's range, are decimal. */
export function counterText(n: number, style = 'decimal'): string {
  const symbol = { disc: '•', circle: '◦', square: '■' }[style];
  if (symbol) return symbol;
  const kind = style.replace(/^(lower|upper)-/, '');
  let out = '';
  if (kind === 'roman' && n > 0 && n < 4000) {
    // Each decimal digit from the units up, with its place's one, five and ten.
    for (let i = 0; n; i += 2, n = Math.floor(n / 10)) {
      const [one = '', five = '', ten = ''] = 'ivxlcdm'.slice(i, i + 3);
      const d = n % 10;
      out = (d % 5 > 3 ? one + (d > 5 ? ten : five) : (d > 4 ? five : '') + one.repeat(d % 5)) + out;
    }
  } else if (/^(alpha|latin|greek)$/.test(kind) && n > 0) {
    const letters = kind === 'greek' ? 'αβγδεζηθικλμνξοπρστυφχψω' : 'abcdefghijklmnopqrstuvwxyz';
    for (; n > 0; n = Math.floor((n - 1) / letters.length)) out = letters[(n - 1) % letters.length] + out;
  } else out = (style === 'decimal-leading-zero' && n >= 0 && n < 10 ? '0' : '') + n;
  return style.startsWith('upper-') ? out.toUpperCase() : out;
}

const STRING = /"((?:[^"\\]|\\.)*)"/g;
const unescape = (text = '') => text.replace(/\\(.)/g, '$1');

/** How deep in quotes the pseudo-element `pseudo` of `target` starts: the quotes generated before it, in order. */
function quoteDepth(target: Element, pseudo: Pseudo): number {
  let depth = 0;
  walkTo(
    target,
    pseudo,
    () => {},
    (el, which, style) => {
      if (el === target && which === pseudo) return;
      for (const [, , open] of style.content
        .split(/\s\/\s/)[0]
        ?.matchAll(/"(?:[^"\\]|\\.)*"|(no-)?(open|close)-quote/g) ?? [])
        if (open) depth = Math.max(0, depth + (open === 'open' ? 1 : -1));
    }
  );
  return depth;
}

/**
 * The text of a `content` value: its strings, then counters as numbers in their list styles in
 * the alternative text (`alt`), and quotes from the `quotes` property in the rendered text, where
 * a counter is a NUL character for the caller to take out once spaces at line edges are dropped.
 */
export function contentText(content: string, el: Element, pseudo: Pseudo, alt: boolean): string {
  let out = '';
  let depth: number | undefined;
  const re =
    /"((?:[^"\\]|\\.)*)"|(counters?)\(\s*([\w-]+)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*(?:,\s*([\w-]+))?\s*\)|(no-)?(open|close)-quote/g;
  for (const [, text, fn, name = '', sep, style, no, quote] of content.matchAll(re)) {
    if (quote) {
      depth ??= quoteDepth(el, pseudo);
      if (quote === 'close') depth = Math.max(0, depth - 1);
      const value = styleOf(el, pseudo).quotes;
      const pair = value === 'auto' ? ['“', '”', '‘', '’'] : [...value.matchAll(STRING)].map(m => unescape(m[1]));
      if (!no && !alt && pair.length) out += pair[Math.min(depth, pair.length / 2 - 1) * 2 + +(quote === 'close')];
      if (quote === 'open') depth++;
    } else if (fn) {
      // Not named in the rendered text, where it still holds its place on the line.
      if (!alt) out += '\0';
      else {
        const values = counterValues(el, pseudo, name);
        const all = values.length ? values : [0];
        out += (fn === 'counters' ? all : all.slice(-1)).map(n => counterText(n, style)).join(unescape(sep));
      }
    } else out += unescape(text);
  }
  return out;
}
