// Shell mode: the page runs in an iframe inside a "shell" document that also hosts DevTools,
// so DevTools stays open while the page reloads or navigates.
//
// Entering shell mode stores a ShellConfig in sessionStorage and reloads. The probe, being
// the first script, then turns the top-level document into the shell in place (the URL in
// the address bar stays the same), and inside the page iframe it loads the bundle that
// connects the page's CDP server to the shell.

export const SHELL_KEY = 'devtools-anywhere:shell'
/** id of the page iframe in the shell document. */
export const SHELL_PAGE_ID = 'devtools-anywhere-page'

export interface ShellConfig {
  /** Absolute URL of the DevTools frontend entry page. */
  frontend: string
  /** Absolute URL of devtools-anywhere.iife.js. */
  bundle: string
}

export function readShellConfig(): ShellConfig | null {
  try {
    const config = JSON.parse(sessionStorage.getItem(SHELL_KEY) || 'null')
    return config && typeof config.frontend === 'string' && typeof config.bundle === 'string' ? config : null
  } catch {
    return null
  }
}

/** True when this window is the page iframe inside a shell. */
export function isShellPage(): boolean {
  if (window === top || !readShellConfig()) return false
  try {
    return window.frameElement?.id === SHELL_PAGE_ID
  } catch {
    return false
  }
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Replaces the current top-level document with the shell. */
export function writeShellDocument(config: ShellConfig) {
  // While the page is still parsing, an unclosed <plaintext> turns the rest of the page
  // into inert text, so none of its scripts run and none of its resources load. (Chrome
  // ignores document.open() after window.stop().) document.open() is also ignored while a
  // parser-inserted script runs, so the document is replaced right after this script.
  if (document.readyState === 'loading') document.write('<plaintext style="display:none">')
  setTimeout(() => replaceDocument(config))
}

function replaceDocument(config: ShellConfig) {
  document.open()
  document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column}
#${SHELL_PAGE_ID}{flex:1;min-height:0;width:100%;border:0;display:block}</style></head>
<body><iframe id="${SHELL_PAGE_ID}" src="${escapeAttr(location.href)}"></iframe>
<script src="${escapeAttr(config.bundle)}"></script>
<devtools-anywhere shell open frontend="${escapeAttr(config.frontend)}"></devtools-anywhere></body></html>`)
  document.close()
}
