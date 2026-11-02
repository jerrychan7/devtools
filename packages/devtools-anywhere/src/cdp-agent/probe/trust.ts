// What a shell config may point to, from the URL of the script that reads it (the probe, or the
// bundle). sessionStorage can be written by any script of the page, so a config is trusted only
// where that script says. On a public npm CDN (jsDelivr, unpkg), where anyone can publish, its
// origin is everyone's: only this package and the frontend's, at the script's version, are
// trusted, and the frontend is found there by default. Elsewhere, the script's origin is.

/** The CDNs whose paths are npm packages: `<prefix><name>@<version>/<file>`. */
const NPM_CDNS = ['https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/'];
const PACKAGE = 'devtools-anywhere';
const FRONTEND_PACKAGE = '@devtools-anywhere/devtools-frontend';
/** The frontend's entry page in its package. */
const FRONTEND_ENTRY = 'dist/anywhere_app.html';
/** A version or dist-tag, as in a CDN path: no `/`, nothing escaped. */
const VERSION = /^[0-9A-Za-z.+-]+$/;

/** Where URLs are trusted: an origin, or (on an npm CDN) URL prefixes, maybe none. */
export type Trust = { origin: string } | { prefixes: string[] };

/** The package directories at the version of `script`, a URL of this package on an npm CDN. */
function cdnPackages(script: URL): { own: string; frontend: string } | null {
  const cdn = NPM_CDNS.find(prefix => script.href.startsWith(prefix));
  if (!cdn) return null;
  const [name, rest] = splitOnce(script.href.slice(cdn.length), '/');
  const [pkg, version] = splitOnce(name, '@');
  if (pkg !== PACKAGE || !VERSION.test(version) || !rest) return null;
  return { own: `${cdn}${PACKAGE}@${version}/`, frontend: `${cdn}${FRONTEND_PACKAGE}@${version}/` };
}

function splitOnce(s: string, separator: string): [string, string] {
  const at = s.indexOf(separator);
  return at < 0 ? [s, ''] : [s.slice(0, at), s.slice(at + 1)];
}

/** What a script at `scriptUrl` trusts; `null` when it is no URL. @internal */
export function trustOf(scriptUrl: string): Trust | null {
  let script: URL;
  try {
    script = new URL(scriptUrl);
  } catch {
    return null;
  }
  const packages = cdnPackages(script);
  if (packages) return { prefixes: [packages.own, packages.frontend] };
  // Another package on the CDN, or no version: nothing there is ours.
  if (NPM_CDNS.some(prefix => script.href.startsWith(prefix))) return { prefixes: [] };
  return { origin: script.origin };
}

/** Whether `url` is an http(s) URL that `trust` trusts. @internal */
export function isTrusted(url: string, trust: Trust): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if ('origin' in trust) return parsed.origin === trust.origin;
  // Parsed, `.` and `..` segments are resolved, `%2e` ones included; an escaped `/` or `\` is not,
  // and a CDN may still take it for one.
  if (/%2f|%5c/i.test(parsed.pathname)) return false;
  return trust.prefixes.some(prefix => parsed.href.startsWith(prefix));
}

/**
 * The frontend's entry page at the version of `scriptUrl`, when it is this package on an npm CDN:
 * the frontend to use by default. @internal
 */
export function cdnFrontendUrl(scriptUrl: string): string | null {
  try {
    const packages = cdnPackages(new URL(scriptUrl));
    return packages && packages.frontend + FRONTEND_ENTRY;
  } catch {
    return null;
  }
}
