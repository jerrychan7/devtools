// The API devtools-anywhere.iife.js exposes as `window.DevtoolsAnywhere`: the one definition the
// bundle (which must satisfy it), the probe (probe.iife.js, built separately, which calls it) and
// the tests share. Types only, and no source module imported, so that any of them can take it in.
import type { CdpSession, ChildTargets, createCdpSession } from './cdp-agent';

/** How a page reaches a remote debugging server. */
export interface RemoteOptions {
  /**
   * Connect to the server's URL itself, the target in the query (`?target=<id>`), instead of to
   * `target/<id>` under it: for a server whose host routes upgrades by exact path.
   */
  idInQuery?: boolean;
}

export interface DevtoolsAnywhereApi {
  connectFrontend(server: CdpSession, frame: HTMLIFrameElement, frontendOrigin: string): () => void;
  connectRemote(serverUrl: string, options?: RemoteOptions): () => void;
  createCdpSession: typeof createCdpSession;
  /**
   * Creates the page's global <devtools-anywhere>, which the probe mounts. Only the first one
   * connected works; later ones warn and stay hidden. Null, with a warning, when the page has
   * registered `devtools-anywhere` itself.
   */
  createGlobalElement(config: GlobalElementConfig): HTMLElement | null;
  /**
   * Links the page's agent with those of the cross-origin iframes it trusts, and of its parent
   * when it is in one that it trusts (the probe's data-frame-origins and data-parent-origins).
   * Returns a function that stops and closes the links.
   */
  linkFrames(options: FrameLinkOptions): () => void;
  /** The page's links to cross-origin iframes, and to its parent. */
  childTargets: ChildTargets;
}

/** The origins the page trusts across iframes: space-separated lists, as in the probe's attributes. */
export interface FrameLinkOptions {
  /** The iframes this page's DevTools may debug (`data-frame-origins`). */
  frameOrigins?: string | null;
  /** The pages that may debug this one in their iframe (`data-parent-origins`). */
  parentOrigins?: string | null;
}

/** The probe's options for the global element (its `data-*` attributes). */
export interface GlobalElementConfig {
  /** The frontend's URL. */
  frontend?: string;
  /** Opens DevTools once mounted. */
  open?: boolean;
  /** DevTools offers no way in or out of shell mode, and ignores requests to. */
  locked?: boolean;
  /** Hides the toggler button. */
  noToggler?: boolean;
  /**
   * In shell mode, also register devtools-anywhere-service-worker.js from this URL (or next to the bundle
   * when empty), which injects the probe into iframe pages that do not include it.
   */
  serviceWorker?: string | null;
}
