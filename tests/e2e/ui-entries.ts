// Where the DevTools frontend shows each CDP domain the in-page agent carries out, and what a view
// opened there shows for tests/e2e/pages/ui-entries.html. Read by tests/e2e/ui-entries.test.ts:
// every domain with a handler that does something must be here, and every entry must open and show
// its content, so a domain cannot be implemented with no way to see it in the frontend.

export interface UiEntry {
  /** A view id of the frontend's ViewManager: a panel, a drawer view or an Elements sidebar pane. */
  view: string;
  /** What in the fixture page the view shows. */
  trigger: string;
  /** Text the opened view then shows, in one of its text nodes (shadow DOM included). */
  text: string;
  /** An element the opened view then has, checked instead of `text`. */
  selector?: string;
  /** A tab of the view's tabbed pane to click first, by its id (`#tab-<id>`). */
  tab?: string;
  /** Runs in the page once the view is open, for what the view shows only from then on. */
  start?: string;
  /** Selects the first element of this tag in the Elements panel first: the view shows the selected node. */
  select?: string;
  /** Expands the view's collapsed tree items first: their children are made on expanding. */
  expand?: boolean;
}

export const UI_ENTRIES: Record<string, UiEntry | null> = {
  Accessibility: { view: 'accessibility.view', trigger: 'the button', select: 'button', text: '"ui entries button"' },
  Animation: {
    view: 'animations',
    trigger: 'the infinite ui-entries-spin animation, started once the panel is open',
    // Like Chrome's, the panel lists the animations that start while it is open.
    start: "document.getElementById('ui-entries-spinner').className = 'spin'",
    text: 'ui-entries-spin',
    // An animation group's preview in the timeline.
    selector: '.animation-buffer-preview',
  },
  Audits: { view: 'issues-pane', trigger: 'an input without id or name', text: 'id or name attribute' },
  CacheStorage: { view: 'resources', trigger: 'caches.open', text: 'ui-entries-cache', expand: true },
  CSS: {
    view: 'elements',
    trigger: "body's --ui-entries-css",
    select: 'body',
    tab: 'styles',
    text: '--ui-entries-css',
  },
  Debugger: { view: 'navigator-network', trigger: 'assets/ui-entries.js', text: 'ui-entries.js', expand: true },
  DOM: { view: 'elements', trigger: 'the h1 marker', text: 'ui-entries-marker' },
  DOMDebugger: {
    view: 'elements.event-listeners',
    trigger: "document's uientriesevent listener",
    select: 'body',
    text: 'uientriesevent',
  },
  DOMStorage: { view: 'resources', trigger: 'localStorage.setItem', text: 'Local storage', expand: true },
  // The Rendering drawer view's media and vision deficiency emulation; device mode is a toolbar toggle.
  Emulation: { view: 'rendering', trigger: 'none: its controls', text: 'Emulate CSS media type' },
  IndexedDB: { view: 'resources', trigger: 'indexedDB.open', text: 'ui-entries-db', expand: true },
  // Input.* forwards mouse and keys from device mode's screencast; it has no view of its own.
  Input: null,
  // Log.startViolationsReport is set from Console settings; the domain has no view of its own.
  Log: null,
  Network: { view: 'network', trigger: 'the ?ui-entries-fetch request', text: 'ui-entries-fetch' },
  // Grid and flex overlays: the Layout pane lists the page's grids.
  Overlay: { view: 'elements.layout', trigger: '#ui-entries-grid', text: 'ui-entries-grid' },
  Page: { view: 'resources', trigger: 'the top frame', text: 'top', expand: true },
  Runtime: { view: 'console', trigger: "console.log('ui-entries-console')", text: 'ui-entries-console' },
  ServiceWorker: { view: 'resources', trigger: 'none: its tree item', text: 'Service workers' },
  Storage: { view: 'resources', trigger: 'none: its tree item', text: 'Storage' },
  // Target discovery and auto-attach: what other panels' models build on, with no view of its own.
  Target: null,
  WebMCP: { view: 'resources', trigger: 'none: its tree item', text: 'WebMCP' },
};
