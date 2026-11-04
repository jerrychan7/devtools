/**
 * The attributes of the probe's script tag (probe.iife.js), which the probe reads and the Vite
 * plugin and the remote server write. Those set to `true` are written without a value.
 *
 * @public
 */
export type ProbeScriptAttributes = {
  /**
   * The frontend to mount <devtools-anywhere> with, after the page has loaded. By default, with the
   * probe from jsDelivr or unpkg, the frontend package of the same version there; otherwise none,
   * and no element.
   */
  'data-devtools-frontend-url'?: string;
  /** No element (and no shell mode), whatever the frontend: for a page only debugged remotely. */
  'data-no-panel'?: true;
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
  'data-service-worker'?: string | true;
  /** Connects to a remote debugging server: this URL, by default the one the probe is served from. */
  'data-remote'?: string | true;
  /** Connects to the remote server's URL itself, the target in the query. */
  'data-id-in-query'?: true;
  /**
   * The origins of the cross-origin iframes this page's DevTools may debug, space-separated: an
   * iframe whose page has the probe too, and trusts this page (`data-parent-origins`), is
   * debugged from here, as Chrome debugs an out-of-process iframe. Each entry is an origin
   * (`https://app.example.com`) or every subdomain of a host, at any depth
   * (`https://*.example.com`, not `https://example.com` itself), with the scheme and port exact;
   * `*` alone, or elsewhere, is ignored with a warning. None by default.
   */
  'data-frame-origins'?: string;
  /**
   * The origins of the pages that may debug this page when it is in their iframe, space-separated,
   * in the same form as `data-frame-origins`, which they must set too. While linked, this page's
   * own F12 button and panel are hidden. None by default.
   */
  'data-parent-origins'?: string;
};
