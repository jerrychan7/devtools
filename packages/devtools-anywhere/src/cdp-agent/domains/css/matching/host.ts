import { isElement, isShadowRoot } from '../../../core/realm';

/**
 * Rules of a shadow tree for its host: the selector is `:host`, `:host(<arg>)` or
 * `:host-context(<arg>)` in a compound that
 * the featureless host can match (see parseHost). Returns whether a host matches, or null.
 */
export function hostMatcher(selector: string): ((host: Element) => boolean) | null {
  let matcher = hostMatchers.get(selector);
  if (matcher === undefined) hostMatchers.set(selector, (matcher = parseHost(selector)));
  return matcher;
}

/** Host matchers by selector. */
const hostMatchers = new Map<string, ((host: Element) => boolean) | null>();

type HostTest = (host: Element) => boolean;

/**
 * The host is featureless in its shadow tree, as in Chrome: a compound of `:host`, `:host()`,
 * `:host-context()`, `:is()`/`:where()`/`:not()` of those, and `:has()` (in the shadow tree),
 * with one of the first at least. Any other simple selector (`.x`, `:hover`) or a combinator
 * makes the rule one for the shadow tree.
 */
function parseHost(selector: string): HostTest | null {
  const tests: HostTest[] = [];
  let host = false;
  for (let at = 0; at < selector.length;) {
    const m = /^:(host-context|host|is|where|not|has)(?![\w-])/.exec(selector.slice(at));
    if (!m) return null;
    at += m[0].length;
    let arg: string | undefined;
    if (selector[at] === '(') {
      const end = closing(selector, at);
      if (end < 0) return null;
      arg = selector.slice(at + 1, end).trim();
      at = end + 1;
    }
    const name = m[1];
    const own = arg;
    if (name === 'host') {
      host = true;
      if (own !== undefined) tests.push(h => h.matches(own));
    } else if (!own) return null;
    else if (name === 'host-context') {
      host = true;
      // The host or any of its ancestors, across shadow boundaries.
      tests.push(h => {
        for (let node: Element | null = h; node;) {
          if (node.matches(own)) return true;
          const parent: Node | null = node.parentNode;
          node = isShadowRoot(parent) ? parent.host : isElement(parent) ? parent : null;
        }
        return false;
      });
    } else if (name === 'has') tests.push(h => !!h.shadowRoot?.querySelector(own));
    else {
      // Only the items for the host count: the others never match it.
      const items: HostTest[] = [];
      for (let from = 0, i = 0; i <= own.length; i++) {
        if (own[i] === '(') i = closing(own, i);
        if (i < 0) return null;
        if (i === own.length || own[i] === ',') {
          const item = hostMatcher(own.slice(from, i).trim());
          if (item) items.push(item);
          from = i + 1;
        }
      }
      if (!items.length) return null;
      host = true;
      tests.push(name === 'not' ? h => !items.some(f => f(h)) : h => items.some(f => f(h)));
    }
  }
  return host ? h => tests.every(f => f(h)) : null;
}

/** The index of the `)` closing the `(` at `open` in `s`, past strings and escapes; -1 if none. */
function closing(s: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') i++;
    else if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}
