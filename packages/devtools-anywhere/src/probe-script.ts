/**
 * The attributes of the probe's script tag (probe.iife.js), which the probe reads and the Vite
 * plugin and the remote server write. Those set to `true` are written without a value.
 *
 * @public
 */
export type ProbeScriptAttributes = {
  /** The frontend to mount <devtools-anywhere> with, after the page has loaded. */
  'data-frontend'?: string;
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
  /** Passed on as the element's `sw` attribute (shell mode's Service Worker). */
  'data-sw'?: string | true;
  /** Connects to a remote debugging server: this URL, by default the one the probe is served from. */
  'data-remote'?: string | true;
  /** Connects to the remote server's URL itself, the target in the query. */
  'data-single-path'?: true;
};
