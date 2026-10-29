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
  'data-open'?: true;
  /** Passed on as the element's `sw` attribute (shell mode's Service Worker). */
  'data-sw'?: string | true;
  /** Connects to a remote debugging server: this URL, by default the one the probe is served from. */
  'data-remote'?: string | true;
  /** Connects to the remote server's URL itself, the target in the query. */
  'data-single-path'?: true;
};
