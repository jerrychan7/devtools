import type { Protocol } from 'devtools-protocol';
import { splitTopLevel } from '../../core/selectors';
import { nestingParent } from './rules';

/** Expressions of a media query list, as Chrome reports them in `mediaList`. */
export function mediaList(text: string): Protocol.CSS.MediaQuery[] {
  return splitTopLevel(text, ',').map(query => {
    const expressions: Protocol.CSS.MediaQueryExpression[] = [];
    for (const m of query.matchAll(/\(\s*([\w-]+)\s*:\s*(-?[\d.]+)([a-z%]*)\s*\)/gi)) {
      const value = Number(m[2]);
      const unit = (m[3] ?? '').toLowerCase();
      // In media queries em and rem are relative to the initial font size (medium, 16px by
      // default), not to the font size of the root element.
      const scale = unit === 'px' ? 1 : unit === 'em' || unit === 'rem' ? 16 : null;
      expressions.push({
        value,
        unit,
        feature: (m[1] ?? '').toLowerCase(),
        ...(scale !== null && { computedLength: value * scale }),
      });
    }
    return { expressions, active: matchMedia(query.trim()).matches };
  });
}

/**
 * The source of a <style>, in two versions of the same length (indices are shared): `text`
 * without comments, to match selectors in (they may quote attribute values), and `braces`
 * also without strings and url(), where braces delimit blocks. Located rules are cached.
 */
export interface Source {
  text: string;
  braces: string;
  located: WeakMap<CSSStyleRule, Located | null>;
}

export interface Located {
  selectors: string[];
  open: number;
  close: number;
}

/** The source last read, kept while the <style> text does not change. */
export let lastSource: { raw: string; source: Source } | null = null;

export const blank = (m: string) => ' '.repeat(m.length);

export function sourceOf(sheet: CSSStyleSheet): Source | null {
  const owner = sheet.ownerNode;
  if (!(owner instanceof HTMLStyleElement) || owner.sheet !== sheet) return null;
  const raw = owner.textContent;
  if (lastSource?.raw !== raw) {
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, blank);
    const braces = text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|url\([^)]*\)/gi, blank);
    lastSource = { raw, source: { text, braces, located: new WeakMap() } };
  }
  return lastSource.source;
}

/** A pattern for a selector, allowing any white space between its tokens. */
export function selectorPattern(selector: string): string {
  return selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s*([>~]|\\\+)\s*/g, '\\s*$1\\s*')
    .replace(/ +/g, '\\s+');
}

/** The index of the `}` closing the block whose `{` is at `open`. */
export function blockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return i;
  }
  return source.length;
}

/**
 * Where a style rule is in the source, as written: its selectors and the range of its block
 * (from its `{` to its `}`). Nested rules are looked for in the block of their parent only.
 */
export function locate(source: Source, rule: CSSStyleRule): Located | null {
  const cached = source.located.get(rule);
  if (cached !== undefined) return cached;
  const result = find(source, rule);
  source.located.set(rule, result);
  return result;
}

export function find(source: Source, rule: CSSStyleRule): Located | null {
  const parts = splitTopLevel(rule.selectorText, ',').map(p => p.trim());
  const parent = nestingParent(rule);
  let from = 0;
  let to = source.text.length;
  if (parent) {
    if (!(parent instanceof CSSStyleRule)) return null;
    const outer = locate(source, parent);
    if (!outer) return null;
    from = outer.open;
    to = outer.close;
  }
  // The CSSOM adds the `&` an author may leave out: `.x` becomes `& .x`.
  const pattern = parts
    .map(p => (parent && p.startsWith('& ') ? `(&\\s+)?${selectorPattern(p.slice(2))}` : `()${selectorPattern(p)}`))
    .join('\\s*,\\s*');
  const m = new RegExp(`(?:^|[{;}])\\s*${pattern}\\s*\\{`, 'y');
  for (let i = from; i < to; i++) {
    // Rules start after a delimiter outside strings.
    if (i > from && !/[{;}]/.test(source.braces[i] ?? '')) continue;
    m.lastIndex = i;
    const match = m.exec(source.text);
    if (!match) continue;
    const open = i + match[0].length - 1;
    return {
      selectors: parts.map((p, k) => (parent && p.startsWith('& ') && !match[k + 1] ? p.slice(2) : p)),
      open,
      close: blockEnd(source.braces, open),
    };
  }
  return null;
}

/**
 * Nested selectors as written in the source, where Chrome shows them so. null when the source
 * is unknown (a <link>, a constructed sheet) or the rule is not found in it.
 */
export function sourceSelectors(sheet: CSSStyleSheet, rule: CSSStyleRule, parts: string[]): string[] | null {
  if (!(nestingParent(rule) instanceof CSSStyleRule)) return null;
  if (!parts.some(p => p.startsWith('& '))) return null;
  const source = sourceOf(sheet);
  return source === null ? null : (locate(source, rule)?.selectors ?? null);
}

/**
 * Rules of a shadow tree for its host: the selector is `:host`, `:host(<arg>)` or
 * `:host-context(<arg>)` and pseudo-classes. Returns whether a host matches, or null.
 */
export function hostMatcher(selector: string): ((host: Element) => boolean) | null {
  let matcher = hostMatchers.get(selector);
  if (matcher === undefined) hostMatchers.set(selector, (matcher = parseHost(selector)));
  return matcher;
}

/** Host matchers by selector. */
export const hostMatchers = new Map<string, ((host: Element) => boolean) | null>();

export function parseHost(selector: string): ((host: Element) => boolean) | null {
  const m = /^:host(-context)?(?:\((.*)\))?(.*)$/.exec(selector);
  if (!m) return null;
  const arg = m[2];
  const rest = m[3] ?? '';
  if (/[\s>+~]/.test(rest.replace(/\([^)]*\)/g, ''))) return null;
  if (!m[1]) {
    const own = `${arg ? `:is(${arg})` : '*'}${rest}`;
    return host => host.matches(own);
  }
  if (!arg) return null;
  // The host or any of its ancestors, across shadow boundaries.
  return host => {
    if (!host.matches(`*${rest}`)) return false;
    for (let node: Element | null = host; node;) {
      if (node.matches(arg)) return true;
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
    }
    return false;
  };
}
