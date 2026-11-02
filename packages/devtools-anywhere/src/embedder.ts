// The contract between the DevTools frontend (anywhere_app, in an iframe) and its embedder
// (<devtools-anywhere>, in the page): the one place it is written. The frontend's build copies
// this file into the devtools-frontend checkout (packages/devtools-frontend/scripts/build.ts),
// so it imports nothing and holds only constants and types: it must compile on its own there.

/**
 * Where the panel is: docked to a side of the viewport, or floating over the page. The same
 * values as Chromium's UI.DockController.DockState, which the frontend checks at build time.
 */
export const DOCK_SIDES = ['bottom', 'right', 'left', 'undocked'] as const;
/** One of {@link DOCK_SIDES}. */
export type DockSide = (typeof DOCK_SIDES)[number];

/**
 * Requests from the frontend to the embedder: its dock side menu, its close button, keeping
 * DevTools open across reloads (shell mode), the theme's colors for the panel's bar, and in shell
 * mode where the page goes (`page-bounds`, the frontend's InspectedPagePlaceholder, in CSS pixels
 * of the frontend's viewport, like Chrome's setInspectedPageBounds) and the page's side of the split
 * next to DevTools (`split`, in the same pixels: the whole of it, where the page bounds are only the
 * device's screen in device mode), for the shell's grip on DevTools' edge.
 * Undocked, device mode draws into a page of the frontend's (`toolbox`, its URL), which Chrome
 * opens in the tab under DevTools' window and the shell shows in an iframe under the panel, where
 * the frontend finds it among its parent's frames; the page bounds are then in CSS pixels of that
 * iframe.
 */
export type EmbedderRequest =
  | { type: 'dock'; side: DockSide }
  | { type: 'close' }
  | { type: 'keep-open'; keep: boolean }
  | { type: 'theme'; toolbar: string; divider: string; icon: string }
  | ({ type: 'page-bounds' } & PageBounds)
  | ({ type: 'split' } & PageBounds)
  | { type: 'toolbox'; url: string };

/** A rectangle in CSS pixels. */
export interface PageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tells the frontend, posted to it under {@link REQUEST_KEY} (`{ type: HIDDEN_NOTICE }`), that the
 * embedder hid the panel: like Chrome when DevTools closes, it leaves inspect mode and hides
 * highlights, which would otherwise keep taking the page over.
 */
export const HIDDEN_NOTICE = 'hidden';
/**
 * Tells the frontend, in shell mode, to give DevTools `size` CSS pixels next to the page: the
 * shell's touch handle on the edge between them was dragged.
 */
export const SIDEBAR_SIZE_NOTICE = 'sidebar-size';
/** What the embedder posts to the frontend: {@link HIDDEN_NOTICE} or {@link SIDEBAR_SIZE_NOTICE}. */
export type FrontendNotice = { type: typeof HIDDEN_NOTICE } | { type: typeof SIDEBAR_SIZE_NOTICE; size: number };

/**
 * The key a request is posted under (`{ [REQUEST_KEY]: request }`): requests are objects, so
 * they never mix with CDP messages, which are strings.
 */
export const REQUEST_KEY = 'devtoolsAnywhere';

/**
 * devtools-anywhere's own scripts, as built (build.ts) and loaded next to each other: the
 * frontend ignore-lists them in Sources, like extension scripts in Chrome.
 */
export const PROBE_SCRIPT = 'probe.iife.js';
export const BUNDLE_SCRIPT = 'devtools-anywhere.iife.js';
/** snapDOM, the screencast's renderer, loaded on demand. */
export const SNAPDOM_SCRIPT = 'snapdom.js';
export const OWN_SCRIPTS: readonly string[] = [PROBE_SCRIPT, BUNDLE_SCRIPT, SNAPDOM_SCRIPT];

/** What the embedder passes the frontend in its URL's hash (`#?embedded=…&dock=…`). */
export interface FrontendHash {
  /** The embedder's origin: the only one the frontend posts to. */
  embedded: string;
  /** The side the embedder shows the panel on now. */
  dock: DockSide;
  /** Whether keeping DevTools open across reloads is available. */
  keep: '0' | '1';
  /** Whether it is on. */
  shell: '0' | '1';
}

/**
 * What remote-server passes a frontend it does not serve itself (a CDN build) in its URL's hash
 * (`#?ws=…`): the relay's socket, without the scheme, under the parameter naming the scheme. The
 * frontend copies it to its query, which upstream reads, so that the socket's token stays out of
 * requests to that host.
 *
 * @internal
 */
export interface RemoteFrontendHash {
  /** The relay's socket over plain `ws:`. */
  ws: string;
  /** The relay's socket over `wss:`. */
  wss: string;
}
