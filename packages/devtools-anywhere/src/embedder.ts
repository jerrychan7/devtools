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
 * DevTools open across reloads (shell mode), and the theme's colors for the panel's bar.
 */
export type EmbedderRequest =
  | { type: 'dock'; side: DockSide }
  | { type: 'close' }
  | { type: 'keep-open'; keep: boolean }
  | { type: 'theme'; toolbar: string; divider: string; icon: string };

/**
 * Tells the frontend, posted to it under {@link REQUEST_KEY} (`{ type: HIDDEN_NOTICE }`), that the
 * embedder hid the panel: like Chrome when DevTools closes, it leaves inspect mode and hides
 * highlights, which would otherwise keep taking the page over.
 */
export const HIDDEN_NOTICE = 'hidden';
/** What the embedder posts to the frontend: {@link HIDDEN_NOTICE}. */
export interface FrontendNotice {
  type: typeof HIDDEN_NOTICE;
}

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
