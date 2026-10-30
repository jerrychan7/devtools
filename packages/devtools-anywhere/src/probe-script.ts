/**
 * The attributes of the probe's script tag (probe.iife.js), which the probe reads and the Vite
 * plugin and the remote server write. Those set to `true` are written without a value.
 *
 * @public
 */
export type ProbeScriptAttributes = {
  /** The frontend to mount <devtools-anywhere> with, after the page has loaded. */
  'data-devtools-frontend-url'?: string;
  /** Where devtools-anywhere.iife.js is, by default next to the probe. */
  'data-bundle'?: string;
  /** Opens DevTools right away. */
  'data-open-immediately'?: true;
  /**
   * `off` to stay out of shell mode, which the top-level page enters by default (the page runs in
   * an iframe next to DevTools, which stays open across reloads). The user's choice in DevTools
   * wins over it, unless `data-shell-mode-locked` is set.
   */
  'data-default-shell-mode'?: 'on' | 'off';
  /** Keeps shell mode as `data-default-shell-mode` says: DevTools offers no choice. */
  'data-shell-mode-locked'?: true;
  /** Hides the element's toggler button. */
  'data-no-toggler'?: true;
  /**
   * In shell mode, registers its Service Worker from this URL (or next to the bundle when empty).
   * It injects the probe into same-origin pages loaded in the page iframe that do not include it,
   * and adds the request and response headers of same-origin requests (documents, stylesheets,
   * scripts, images and so on). It needs a secure context (HTTPS or localhost) and a scope covering
   * those pages: `Service-Worker-Allowed: /` on the script, or the script at the site root. Off by
   * default, and only for a site without a Service Worker of its own.
   */
  'data-sw'?: string | true;
  /** Connects to a remote debugging server: this URL, by default the one the probe is served from. */
  'data-remote'?: string | true;
  /** Connects to the remote server's URL itself, the target in the query. */
  'data-id-in-query'?: true;
};
