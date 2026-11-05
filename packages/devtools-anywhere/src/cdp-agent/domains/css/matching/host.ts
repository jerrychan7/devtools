import { isElement, isShadowRoot } from '../../../core/realm';

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
const hostMatchers = new Map<string, ((host: Element) => boolean) | null>();

function parseHost(selector: string): ((host: Element) => boolean) | null {
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
      node = isShadowRoot(parent) ? parent.host : isElement(parent) ? parent : null;
    }
    return false;
  };
}
