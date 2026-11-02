// The origins a page trusts across an iframe boundary: the probe's `data-frame-origins` (the
// iframes its DevTools may debug) and `data-parent-origins` (the pages that may debug it). Both
// are space-separated lists, empty by default: nothing is trusted unless named.

/**
 * One entry of a list: an exact origin, or every subdomain of a host, at any depth
 * (`https://*.example.com`, not `https://example.com` itself), with the same scheme and port.
 */
export type OriginPattern = { origin: string } | { protocol: string; suffix: string; port: string };

/** Entries already warned about: once each, whichever list they are in. */
const warned = new Set<string>();

/** The origin `entry` names, normalized, or null when it is not one (with a path, opaque, …). */
function originOf(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  return bare && url.origin !== 'null' && !/[?#]/.test(entry) ? url.origin : null;
}

/** One entry, or null when it is not one: `*` alone, or anywhere but before a host's first dot. */
function parseEntry(entry: string): OriginPattern | null {
  const wildcard = /^([a-z][a-z\d+.-]*:\/\/)\*\.([^*]+)$/i.exec(entry);
  if (!wildcard) {
    const origin = entry.includes('*') ? null : originOf(entry);
    return origin ? { origin } : null;
  }
  // The host behind the `*.`, checked as the origin of one of its subdomains.
  const [, scheme = '', rest = ''] = wildcard;
  const sample = originOf(`${scheme}x.${rest}`);
  if (!sample) return null;
  const url = new URL(sample);
  return { protocol: url.protocol, suffix: `.${url.hostname.slice(2)}`, port: url.port };
}

/**
 * Reads a space-separated list of origins. Invalid entries are left out, with a warning in the
 * console, once.
 */
export function parseOrigins(list: string | null | undefined): OriginPattern[] {
  const patterns: OriginPattern[] = [];
  for (const entry of (list ?? '').split(/\s+/)) {
    if (!entry) continue;
    const pattern = parseEntry(entry);
    if (pattern) patterns.push(pattern);
    else if (!warned.has(entry)) {
      warned.add(entry);
      console.warn(
        `devtools-anywhere: "${entry}" is not an origin, nor one with a subdomain wildcard such as https://*.example.com; ignored`
      );
    }
  }
  return patterns;
}

/** Whether `origin` (as in MessageEvent.origin) is one of `patterns`. */
export function matchOrigin(patterns: readonly OriginPattern[], origin: string): boolean {
  if (origin === 'null') return false;
  let url: URL | null = null;
  for (const pattern of patterns) {
    if ('origin' in pattern) {
      if (pattern.origin === origin) return true;
      continue;
    }
    try {
      url ??= new URL(origin);
    } catch {
      return false;
    }
    if (
      url.protocol === pattern.protocol &&
      url.port === pattern.port &&
      url.hostname.length > pattern.suffix.length &&
      url.hostname.endsWith(pattern.suffix)
    )
      return true;
  }
  return false;
}
