import { splitTopLevel } from './selectors';

/**
 * Evaluates @container conditions for an element, as page scripts cannot ask the browser
 * whether a container query matches. Size features are measured on the content box of the
 * nearest ancestor container of a fitting name and type; style() reads the container's
 * computed custom properties. Conditions that cannot be evaluated (unknown features or units,
 * calc(), scroll-state(), …) are unknown, and an unknown condition does not match.
 */

/** true, false or unknown (null), as in Media Queries' three-valued logic. */
type Kleene = boolean | null;

const SIZE_FEATURES = new Set(['width', 'height', 'inline-size', 'block-size', 'aspect-ratio', 'orientation']);
/** Features needing the block axis (in horizontal writing modes), so a `size` container. */
const BLOCK_FEATURES = new Set(['height', 'block-size', 'aspect-ratio', 'orientation']);

type Item =
  | { kind: 'keyword'; word: string }
  | { kind: 'group'; inner: string }
  | { kind: 'function'; name: string; inner: string };

/** Splits a condition into top-level keywords, parenthesized groups and functions. */
function items(text: string): Item[] | null {
  const result: Item[] = [];
  let i = 0;
  const s = text.trim();
  while (i < s.length) {
    if (/\s/.test(s[i] ?? '')) {
      i++;
      continue;
    }
    const word = /^[\w-]+/.exec(s.slice(i));
    const name = word ? word[0] : '';
    const open = i + name.length;
    if (s[open] === '(') {
      let depth = 0;
      let j = open;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      if (j >= s.length) return null;
      const inner = s.slice(open + 1, j);
      result.push(name ? { kind: 'function', name: name.toLowerCase(), inner } : { kind: 'group', inner });
      i = j + 1;
    } else if (name) {
      result.push({ kind: 'keyword', word: name.toLowerCase() });
      i = open;
    } else {
      return null;
    }
  }
  return result;
}

/** Features a condition queries, to choose the container and report its axes. */
export function queriedFeatures(condition: string): Set<string> {
  const features = new Set<string>();
  const visit = (text: string) => {
    for (const item of items(text) ?? []) {
      if (item.kind === 'group') {
        const name = /^\s*(?:[\d.]+[a-z%]*\s*[<>=]+\s*)?(?:min-|max-)?([a-z-]+)/i.exec(item.inner)?.[1]?.toLowerCase();
        if (name && SIZE_FEATURES.has(name)) features.add(name);
        else visit(item.inner);
      }
    }
  };
  visit(condition);
  return features;
}

/** The axes a query is about, as Chrome reports them on CSSContainerQuery. */
export function queriedAxes(condition: string): {
  physicalAxes?: 'Horizontal' | 'Vertical' | 'Both';
  logicalAxes?: 'Inline' | 'Block' | 'Both';
} {
  const f = queriedFeatures(condition);
  const both = f.has('aspect-ratio') || f.has('orientation');
  const h = both || f.has('width');
  const v = both || f.has('height');
  const i = f.has('inline-size');
  const b = f.has('block-size');
  const result: ReturnType<typeof queriedAxes> = {};
  if (h || v) result.physicalAxes = h && v ? 'Both' : h ? 'Horizontal' : 'Vertical';
  if (i || b) result.logicalAxes = i && b ? 'Both' : i ? 'Inline' : 'Block';
  return result;
}

export const parentOf = (el: Element): Element | null => {
  const root = el.getRootNode();
  return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
};

/**
 * The nearest container from `start` up the flat tree (a slotted element through its slot)
 * named `name` (if any) that can answer `features`.
 */
function findContainer(start: Element | null, name: string, features: Set<string>): Element | null {
  const size = features.size > 0;
  const block = [...features].some(f => BLOCK_FEATURES.has(f));
  for (let el = start; el; el = el.assignedSlot ?? parentOf(el)) {
    const style = getComputedStyle(el);
    if (name && !style.containerName.split(/\s+/).includes(name)) continue;
    if (size) {
      const types = style.containerType.split(/\s+/);
      if (!types.includes(block ? 'size' : 'inline-size') && !types.includes('size')) continue;
    }
    return el;
  }
  return null;
}

interface Box {
  el: Element;
  style: CSSStyleDeclaration;
  width: number;
  height: number;
}

/** The content box of a container, or null when it is not rendered. */
function contentBox(el: Element): Box | null {
  // No box (display: none on it or an ancestor, display: contents): its size is unknown.
  if (!el.getClientRects().length) return null;
  const style = getComputedStyle(el);
  let width = parseFloat(style.width);
  let height = parseFloat(style.height);
  if (Number.isNaN(width) || Number.isNaN(height)) return null;
  if (style.boxSizing === 'border-box') {
    const sum = (...names: string[]) =>
      names.reduce((total, n) => total + (parseFloat(style.getPropertyValue(n)) || 0), 0);
    width -= sum('padding-left', 'padding-right', 'border-left-width', 'border-right-width');
    height -= sum('padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width');
  }
  return { el, style, width, height };
}

/** A length in px, relative units against the container; null for what is not supported. */
function length(value: string, box: Box): number | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const fontSize = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
  switch (unit) {
    case '':
      return n === 0 ? 0 : null;
    case 'px':
      return n;
    case 'em':
      return n * parseFloat(box.style.fontSize);
    case 'rem':
      return n * fontSize(document.documentElement);
    case 'vw':
      return (n * innerWidth) / 100;
    case 'vh':
      return (n * innerHeight) / 100;
    case 'vmin':
      return (n * Math.min(innerWidth, innerHeight)) / 100;
    case 'vmax':
      return (n * Math.max(innerWidth, innerHeight)) / 100;
    case 'in':
      return n * 96;
    case 'cm':
      return (n * 96) / 2.54;
    case 'mm':
      return (n * 96) / 25.4;
    case 'pt':
      return (n * 96) / 72;
    case 'pc':
      return n * 16;
    default:
      return null;
  }
}

function ratio(value: string): number | null {
  const parts = value.split('/').map(p => Number(p.trim()));
  if (parts.some(p => Number.isNaN(p)) || parts.length > 2) return null;
  const [a = NaN, b = 1] = parts;
  return b === 0 ? Infinity : a / b;
}

const compare = (x: number, op: string, y: number): boolean =>
  op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : op === '>=' ? x >= y : Math.abs(x - y) < 1e-6;

const FLIP: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };

/** One size feature: `width`, `min-width: 10px`, `width > 10px`, `10px < width < 20px`. */
function feature(text: string, box: Box | null): Kleene {
  if (!box) return null;
  const horizontal = box.style.writingMode.startsWith('horizontal');
  const sizes: Record<string, number> = {
    width: box.width,
    height: box.height,
    'inline-size': horizontal ? box.width : box.height,
    'block-size': horizontal ? box.height : box.width,
  };
  const actual = (name: string): number | string | null => {
    if (name in sizes) return sizes[name] ?? null;
    if (name === 'aspect-ratio') return box.height ? box.width / box.height : Infinity;
    if (name === 'orientation') return box.height >= box.width ? 'portrait' : 'landscape';
    return null;
  };
  const value = (name: string, raw: string): number | null =>
    name === 'aspect-ratio' ? ratio(raw) : name === 'orientation' ? null : length(raw, box);
  const test = (name: string, op: string, raw: string): Kleene => {
    const have = actual(name);
    if (have === null) return null;
    if (typeof have === 'string') return op === '=' ? have === raw.trim().toLowerCase() : null;
    const want = value(name, raw);
    return want === null ? null : compare(have, op, want);
  };

  const colon = splitTopLevel(text, ':');
  if (colon.length === 2) {
    let name = (colon[0] ?? '').trim().toLowerCase();
    const raw = colon[1] ?? '';
    let op = '=';
    if (name.startsWith('min-')) [name, op] = [name.slice(4), '>='];
    else if (name.startsWith('max-')) [name, op] = [name.slice(4), '<='];
    return SIZE_FEATURES.has(name) ? test(name, op, raw) : null;
  }
  const parts = text.split(/(<=|>=|<|>|=)/).map(p => p.trim());
  if (parts.length === 1) {
    const name = (parts[0] ?? '').toLowerCase();
    const have = actual(name);
    if (have === null) return null;
    return typeof have === 'string' || have !== 0;
  }
  if (parts.length === 3) {
    const [a = '', op = '', b = ''] = parts;
    if (SIZE_FEATURES.has(a.toLowerCase())) return test(a.toLowerCase(), op, b);
    if (SIZE_FEATURES.has(b.toLowerCase())) return test(b.toLowerCase(), FLIP[op] ?? op, a);
    return null;
  }
  if (parts.length === 5) {
    const [v1 = '', op1 = '', name = '', op2 = '', v2 = ''] = parts;
    const n = name.toLowerCase();
    if (!SIZE_FEATURES.has(n)) return null;
    return and([test(n, FLIP[op1] ?? op1, v1), test(n, op2, v2)]);
  }
  return null;
}

function and(values: Kleene[]): Kleene {
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}

function or(values: Kleene[]): Kleene {
  if (values.includes(true)) return true;
  return values.includes(null) ? null : false;
}

/** `style(--x: y)` / `style(--x)` against the computed style of the container. */
function styleQuery(inner: string, container: Element | null): Kleene {
  if (!container) return null;
  const nested = items(inner);
  // style(not (--a: b)), style((--a: b) and (--c: d)).
  if (nested && nested.some(i => i.kind === 'group' || (i.kind === 'keyword' && /^(?:and|or|not)$/.test(i.word)))) {
    return condition(nested, inner => styleQuery(inner, container));
  }
  const colon = inner.indexOf(':');
  const name = (colon < 0 ? inner : inner.slice(0, colon)).trim();
  if (!name.startsWith('--')) return null;
  const actual = getComputedStyle(container).getPropertyValue(name).trim();
  if (colon < 0) return actual !== '';
  return actual === inner.slice(colon + 1).trim();
}

/** A condition of items: `not <x>`, `<x> and <y> …`, `<x> or <y> …`. */
function condition(
  list: Item[],
  leaf: (inner: string) => Kleene,
  fn?: (item: Extract<Item, { kind: 'function' }>) => Kleene
): Kleene {
  const one = (item: Item | undefined): Kleene => {
    if (!item) return null;
    if (item.kind === 'group') {
      const nested = items(item.inner);
      const isCondition =
        nested &&
        nested.length > 0 &&
        (nested[0]?.kind !== 'keyword' || nested[0].word === 'not') &&
        nested.some(i => i.kind !== 'keyword') &&
        !/^\s*[\w-]+\s*(?::|<|>|=|$)/.test(item.inner);
      return nested && isCondition ? condition(nested, leaf, fn) : leaf(item.inner);
    }
    if (item.kind === 'function') return fn ? fn(item) : null;
    return null;
  };
  const first = list[0];
  if (first?.kind === 'keyword' && first.word === 'not') {
    if (list.length !== 2) return null;
    const v = one(list[1]);
    return v === null ? null : !v;
  }
  const operands: Kleene[] = [one(first)];
  let op = '';
  for (let i = 1; i < list.length; i += 2) {
    const k = list[i];
    if (k?.kind !== 'keyword' || (k.word !== 'and' && k.word !== 'or')) return null;
    if (op && op !== k.word) return null;
    op = k.word;
    operands.push(one(list[i + 1]));
  }
  return op === 'or' ? or(operands) : and(operands);
}

/**
 * Whether a @container rule applies to an element. `start` is where the search for the
 * container begins: the parent of an element, or the originating element of a pseudo-element.
 */
export function containerMatches(start: Element | null, name: string, query: string): boolean {
  const list = items(query);
  if (!list) return false;
  const features = queriedFeatures(query);
  const container = findContainer(start, name, features);
  if (!container) return false;
  const box = features.size ? contentBox(container) : null;
  const result = condition(
    list,
    inner => feature(inner, box),
    item => (item.name === 'style' ? styleQuery(item.inner, container) : null)
  );
  return result === true;
}
