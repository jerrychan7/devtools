// Shell mode: the page runs in an iframe inside a "shell" document that also hosts DevTools,
// so DevTools stays open while the page reloads or navigates.
//
// Entering shell mode stores a ShellConfig in sessionStorage and reloads. The probe, being
// the first script, then turns the top-level document into the shell in place (the URL in
// the address bar stays the same), and inside the page iframe it loads the bundle that
// connects the page's CDP server to the shell.

export const SHELL_KEY = 'devtools-anywhere:shell';
/** id of the page iframe in the shell document. */
export const SHELL_PAGE_ID = 'devtools-anywhere-page';

export interface ShellConfig {
  /** Absolute URL of the DevTools frontend entry page. */
  frontend: string;
  /** Absolute URL of devtools-anywhere.iife.js. */
  bundle: string;
  /** Absolute URL of devtools-anywhere-sw.js, to inject the probe into iframe pages. */
  sw?: string;
}

let trustedOrigin = '';

/**
 * Sets the origin shell configs must come from: that of the script that read them (the probe,
 * or the bundle). Its URL is taken while the script runs synchronously. Unset, the page's own
 * origin is used.
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

/** The stored shell config; an invalid or untrusted one is removed and ignored. */
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
  const { frontend, bundle, sw } = value as Record<string, unknown>;
  return typeof frontend === 'string' && typeof bundle === 'string' && (sw === undefined || typeof sw === 'string');
}

/** True when this window is the page iframe inside a shell. */
export function isShellPage(): boolean {
  if (window === top || !readShellConfig()) return false;
  try {
    return window.frameElement?.id === SHELL_PAGE_ID;
  } catch {
    return false;
  }
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Replaces the current top-level document with the shell. */
export function writeShellDocument(config: ShellConfig) {
  // While the page is still parsing, an unclosed <plaintext> turns the rest of the page
  // into inert text, so none of its scripts run and none of its resources load. (Chrome
  // ignores document.open() after window.stop().) document.open() is also ignored while a
  // parser-inserted script runs, so the document is replaced right after this script.
  if (document.readyState === 'loading') document.write('<plaintext style="display:none">');
  setTimeout(() => replaceDocument(config));
}

function replaceDocument(config: ShellConfig) {
  document.open();
  document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column}
#${SHELL_PAGE_ID}{flex:1;min-height:0;width:100%;border:0;display:block}</style></head>
<body><iframe id="${SHELL_PAGE_ID}" src="${escapeAttr(location.href)}"></iframe>
<script src="${escapeAttr(config.bundle)}"></script>
<devtools-anywhere shell open frontend="${escapeAttr(config.frontend)}"></devtools-anywhere></body></html>`);
  document.close();
}
