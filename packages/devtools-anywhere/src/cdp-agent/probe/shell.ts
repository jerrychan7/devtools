// Shell mode: the page runs in an iframe inside a "shell" document that also hosts DevTools,
// so DevTools stays open while the page reloads or navigates.
//
// Entering shell mode stores a ShellConfig in sessionStorage and reloads. The probe, being
// the first script, then turns the top-level document into the shell in place (the URL in
// the address bar stays the same), and inside the page iframe it loads the bundle that
// connects the page's CDP session to the shell. The zero-config probe enters it by default,
// storing the config itself on the first load, unless shell mode is turned off (see
// SHELL_MODE_KEY, SHELL_REFUSED_KEY).

/** @internal */
export const SHELL_KEY = 'devtools-anywhere:shell';
/**
 * localStorage: `off` once the user turned shell mode off in DevTools, `on` once they turned it
 * on; either wins over the page's `data-shell`. @internal
 */
export const SHELL_MODE_KEY = 'devtools-anywhere:shell-mode';
/**
 * sessionStorage: set when the page cannot be shown in the shell (it refuses to be framed, or
 * keeps navigating the shell away), so that shell mode is not entered again in this tab. @internal
 */
export const SHELL_REFUSED_KEY = 'devtools-anywhere:shell-refused';
/** sessionStorage: when the shell was last written, to catch a page that navigates it away in a loop. */
const SHELL_ENTRIES_KEY = 'devtools-anywhere:shell-entries';
/** id of the page iframe in the shell document. @internal */
export const SHELL_PAGE_ID = 'devtools-anywhere-page';

/** @internal */
export interface ShellConfig {
  /** Absolute URL of the DevTools frontend entry page. */
  frontend: string;
  /** Absolute URL of devtools-anywhere.iife.js. */
  bundle: string;
  /** Absolute URL of devtools-anywhere-sw.js, to inject the probe into iframe pages. */
  sw?: string;
  /** False to start with DevTools hidden (shell mode entered by default); shown otherwise. */
  open?: boolean;
}

let trustedOrigin = '';

/**
 * Sets the origin shell configs must come from: that of the script that read them (the probe,
 * or the bundle). Its URL is taken while the script runs synchronously. Unset, the page's own
 * origin is used.
 *
 * @internal
 */
export function setShellScriptUrl(url: string) {
  try {
    trustedOrigin = new URL(url).origin;
  } catch {
    // Keep the previous origin.
  }
}

/**
 * True when every URL of the config is http(s) on the trusted origin. sessionStorage can be
 * written by any script of the page, so a config pointing elsewhere is not trusted. Only the
 * origin is checked: the frontend, bundle and probe may sit in different directories (e.g. the
 * Vite plugin's base vs. a zero-config `data-frontend`).
 *
 * @internal
 */
export function isTrustedShellConfig(config: ShellConfig): boolean {
  const origin = trustedOrigin || location.origin;
  return [config.frontend, config.bundle, config.sw].every(url => {
    if (url === undefined) return true;
    try {
      const parsed = new URL(url);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin;
    } catch {
      return false;
    }
  });
}

/**
 * Stores the shell config for the next load of the top-level page: DevTools' `frontend`, the
 * bundle, and `sw` as the element's attribute (`''`: next to the bundle). False when the URLs
 * are not all on the trusted origin, which the probe would refuse, or storage throws.
 *
 * @internal
 */
export function storeShellConfig(frontend: string, bundle: string, sw: string | null, open?: boolean): boolean {
  const config: ShellConfig = { frontend: new URL(frontend, location.href).href, bundle };
  if (sw !== null) config.sw = new URL(sw || 'devtools-anywhere-sw.js', sw ? location.href : bundle).href;
  if (open !== undefined) config.open = open;
  if (!isTrustedShellConfig(config)) return false;
  try {
    sessionStorage.setItem(SHELL_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

/** The stored shell config; an invalid or untrusted one is removed and ignored. @internal */
export function readShellConfig(): ShellConfig | null {
  try {
    const raw = sessionStorage.getItem(SHELL_KEY);
    if (raw === null) return null;
    const config: unknown = JSON.parse(raw);
    if (isShellConfig(config) && isTrustedShellConfig(config)) return config;
    sessionStorage.removeItem(SHELL_KEY);
    return null;
  } catch {
    return null;
  }
}

function isShellConfig(value: unknown): value is ShellConfig {
  if (typeof value !== 'object' || value === null) return false;
  const { frontend, bundle, sw, open } = value as Record<string, unknown>;
  return (
    typeof frontend === 'string' &&
    typeof bundle === 'string' &&
    (sw === undefined || typeof sw === 'string') &&
    (open === undefined || typeof open === 'boolean')
  );
}

/** True when this window is the page iframe inside a shell. @internal */
export function isShellPage(): boolean {
  if (window === top || !readShellConfig()) return false;
  try {
    return window.frameElement?.id === SHELL_PAGE_ID;
  } catch {
    return false;
  }
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Leaves shell mode for the rest of the session: the page cannot be shown in the shell. Its
 * config is removed, so the page loads on its own from now on. @internal
 */
export function refuseShell() {
  try {
    sessionStorage.removeItem(SHELL_KEY);
    sessionStorage.setItem(SHELL_REFUSED_KEY, '1');
  } catch {
    // Without sessionStorage there is no shell mode either.
  }
}

/**
 * Replaces the current top-level document with the shell. A page that navigates the shell
 * away (`top.location = …`) brings the probe back here at once: the fifth time within two
 * seconds, shell mode is refused instead, and false returned.
 */
export function writeShellDocument(config: ShellConfig): boolean {
  const now = Date.now();
  let entries: number[] = [];
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(SHELL_ENTRIES_KEY) || '[]');
    if (Array.isArray(stored)) entries = stored.filter((t): t is number => typeof t === 'number' && now - t < 2000);
    entries.push(now);
    sessionStorage.setItem(SHELL_ENTRIES_KEY, JSON.stringify(entries));
  } catch {
    // Checked when the config was read.
  }
  if (entries.length >= 5) {
    refuseShell();
    return false;
  }
  // While the page is still parsing, an unclosed <plaintext> turns the rest of the page
  // into inert text, so none of its scripts run and none of its resources load. (Chrome
  // ignores document.open() after window.stop().) document.open() is also ignored while a
  // parser-inserted script runs, so the document is replaced right after this script.
  if (document.readyState === 'loading') document.write('<plaintext style="display:none">');
  setTimeout(() => replaceDocument(config));
  return true;
}

function replaceDocument(config: ShellConfig) {
  document.open();
  document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column}
#${SHELL_PAGE_ID}{flex:1;min-height:0;width:100%;border:0;display:block}</style></head>
<body><iframe id="${SHELL_PAGE_ID}" src="${escapeAttr(location.href)}"></iframe>
<script src="${escapeAttr(config.bundle)}"></script>
<devtools-anywhere shell${config.open === false ? '' : ' open'} frontend="${escapeAttr(config.frontend)}"></devtools-anywhere></body></html>`);
  document.close();
}
