import {
  installProbe,
  SHELL_KEY,
  SHELL_PAGE_ID,
  createCdpSession,
  isShellDocument,
  isShellPage,
  markOwn,
  OWN_ATTRIBUTE,
  readShellConfig,
  refuseShell,
  SHELL_MODE_KEY,
  storeShellConfig,
  storeShellOpen,
  type CdpSession,
  type SnapdomLoader,
} from './cdp-agent';
import { connectFrontend, relayShell } from './connection';
import { SHELL_HANDSHAKE } from './shell-messages';
import { ShellLayout } from './shell-layout';
import type { GlobalElementConfig } from './api';
import type { DevtoolsAnywhereAttributes, TogglerAttributes } from './public-types';
import {
  DOCK_SIDES,
  HIDDEN_NOTICE,
  PROBE_SCRIPT,
  SNAPDOM_SCRIPT,
  REQUEST_KEY,
  type DockSide,
  type EmbedderRequest,
  type FrontendNotice,
  type FrontendHash,
} from './embedder';

let bundleUrl = '';

/**
 * Tells the element where devtools-anywhere.iife.js lives, which shell mode needs to load
 * it inside the page iframe. The IIFE build sets this itself.
 */
export function setBundleUrl(url: string) {
  bundleUrl = url;
  loadSnapdom = () => import(/* @vite-ignore */ new URL(SNAPDOM_SCRIPT, url).href);
}

/**
 * snapDOM, which renders the screencast, is loaded only when the screencast starts: the copy
 * next to the bundle (snapdom.js), once setBundleUrl has said where that is.
 */
let loadSnapdom: SnapdomLoader = () => Promise.reject(new Error('snapDOM: the bundle URL is not known'));

/** The CDP session of a page, with the screencast's renderer. */
export const createPageSession = () => createCdpSession({ loadSnapdom: () => loadSnapdom() });

// Sizes are remembered as percentages of the viewport, so they fit any screen and orientation.
const HEIGHT_KEY = 'devtools-anywhere:height%';
const WIDTH_KEY = 'devtools-anywhere:width%';
const FLOAT_KEY = 'devtools-anywhere:float%';
/** Viewport units that follow the browser's collapsing toolbars on mobile, where supported. */
const VH = typeof CSS !== 'undefined' && CSS.supports('height', '1dvh') ? 'dvh' : 'vh';
const VW = typeof CSS !== 'undefined' && CSS.supports('width', '1dvw') ? 'dvw' : 'vw';
/** `part` as a percentage of `whole`, to one decimal. */
const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;
const DOCK_KEY = 'devtools-anywhere:dock';
const MIN_SIZE = 80;

/**
 * localStorage, which throws when it is unavailable: Android WebViews without DOM storage,
 * Safari blocking all cookies, sandboxed iframes. Sizes and dock side are only preferences.
 */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
/** A finite number from a stored value, else undefined. */
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const isDockSide = (value: unknown): value is DockSide => DOCK_SIDES.some(side => side === value);

/**
 * Checks the fields of each type of request from the frontend, which is built separately: a type
 * added to EmbedderRequest (embedder.ts) does not compile here until it is checked.
 */
const REQUEST_CHECKS: { [T in EmbedderRequest['type']]: (request: object) => boolean } = {
  dock: request => 'side' in request && isDockSide(request.side),
  close: () => true,
  'keep-open': request => 'keep' in request && typeof request.keep === 'boolean',
  theme: request => ['toolbar', 'divider', 'icon'].every(key => typeof Reflect.get(request, key) === 'string'),
  'page-bounds': request => ['x', 'y', 'width', 'height'].every(key => finite(Reflect.get(request, key)) !== undefined),
  split: request => 'size' in request && finite(request.size) !== undefined,
  toolbox: request => 'url' in request && typeof request.url === 'string',
};
const isRequestType = (type: unknown): type is EmbedderRequest['type'] =>
  typeof type === 'string' && Object.hasOwn(REQUEST_CHECKS, type);
const isEmbedderRequest = (value: unknown): value is EmbedderRequest =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  isRequestType(value.type) &&
  REQUEST_CHECKS[value.type](value);

/** Position and size of the undocked panel, in percent of the viewport. */
interface FloatRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Whether the browser has the top layer for popovers. There the toggler and the panel are above
 * everything the page draws, whatever its z-index; elsewhere they fall back to the highest z-index.
 */
const TOP_LAYER = typeof HTMLElement.prototype.showPopover === 'function';

/** Shows or hides a popover, if not already. */
function setPopoverOpen(el: HTMLElement, open: boolean) {
  if (el.matches(':popover-open') !== open) el.togglePopover(open);
}

const STYLE = `
:host { all: initial; display: block; }
:host([hidden]) { display: none; }
/* Both go into the top layer as popovers (see TOP_LAYER): undo the browser's popover style. */
.toggler, .panel {
  inset: auto; width: auto; height: auto; margin: 0; padding: 0; border: 0; overflow: visible; color: inherit;
}
.toggler {
  position: fixed; z-index: 2147483647;
  right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  width: 44px; height: 44px; border: 0; border-radius: 50%;
  background: #1a73e8; color: #fff; font: 600 13px/44px system-ui, sans-serif;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .3); cursor: pointer; touch-action: manipulation;
}
.toggler[hidden] { display: none; }
.panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  display: none; flex-direction: column; box-sizing: border-box;
  background: #fff; border-top: 1px solid var(--bar-border, #cacdd1);
  /* Clear of the screen's cutouts and rounded corners (a page with viewport-fit=cover has them):
     the home indicator below, and the notch on the sides in landscape. */
  padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}
.panel[data-open] { display: flex; }
/* The bar takes the DevTools toolbar's colors, which the frontend reports (theme request). */
.bar {
  flex: none; position: relative; height: 16px; background: var(--bar-background, #f1f3f4);
  cursor: row-resize; touch-action: none;
}
.bar::before {
  content: ''; position: absolute; left: 50%; top: 6px; width: 32px; height: 4px;
  margin-left: -16px; border-radius: 2px; background: var(--bar-handle, #bdc1c6);
}
.bar button {
  position: absolute; top: 0; width: 24px; height: 16px; padding: 0; border: 0;
  background: none; color: var(--bar-icon, #5f6368); font: 14px/16px system-ui, sans-serif; cursor: pointer;
}
/* DevTools' own toolbar has a close button, except when undocked: then the bar has one. */
.close { right: 4px; display: none; }
[data-dock=undocked] .close { display: block; }
/* The undocked window's resize corner, for touch screens where CSS resize does not work. */
.corner {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; display: none;
  cursor: nwse-resize; touch-action: none;
}
[data-dock=undocked] .corner { display: block; }
iframe { flex: 1; min-width: 0; min-height: 0; border: 0; }
.dragging iframe { pointer-events: none; }

/* Docked to a side: full height, with the bar as a vertical strip on the inner edge. */
.panel[data-dock=right], .panel[data-dock=left] {
  top: 0; border-top: 0; padding-top: env(safe-area-inset-top, 0px);
}
/* No inset on the inner edge, which is in the middle of the screen. */
.panel[data-dock=right] {
  left: auto; flex-direction: row; border-left: 1px solid var(--bar-border, #cacdd1); padding-left: 0;
}
.panel[data-dock=left] {
  right: auto; flex-direction: row-reverse; border-right: 1px solid var(--bar-border, #cacdd1); padding-right: 0;
}
[data-dock=right] .bar, [data-dock=left] .bar { width: 16px; height: auto; cursor: col-resize; }
[data-dock=right] .bar::before, [data-dock=left] .bar::before {
  left: 6px; top: 50%; width: 4px; height: 32px; margin: -16px 0 0;
}
[data-dock=right] .bar button, [data-dock=left] .bar button { left: 0; right: auto; width: 16px; }

/* Undocked: a window over the page, moved by its bar and resized from its corner. */
.panel[data-dock=undocked] {
  right: auto; bottom: auto; border: 1px solid var(--bar-border, #cacdd1); border-radius: 6px; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .3); resize: both; padding: 0;
}
[data-dock=undocked] .bar { cursor: move; }

/* Touch screens: targets large enough for a finger. */
@media (pointer: coarse) {
  .bar { height: 28px; }
  .bar::before { top: 12px; }
  .bar button { width: 44px; height: 28px; line-height: 28px; font-size: 18px; }
  [data-dock=right] .bar, [data-dock=left] .bar { width: 28px; }
  [data-dock=right] .bar::before, [data-dock=left] .bar::before { left: 12px; }
  [data-dock=right] .bar button, [data-dock=left] .bar button { width: 28px; height: 44px; }
  .corner { width: 32px; height: 32px; }
}

/* An element placed by the page: a box in the page's flow, sized by its CSS, always loaded. */
.panel[data-custom] {
  position: static; display: flex; width: 100%; height: 100%; border: 0; padding: 0;
}
[data-custom] .bar, .toggler[data-custom] { display: none; }

/* Shell mode: the panel takes its place next to the page iframe, unless undocked. */
:host([data-shell]) { display: flex; flex: none; }
:host([data-shell]) .panel { position: static; flex: 1 1 auto; }
:host([data-shell]) .panel[data-dock=undocked] { position: fixed; }
/* Laid out by the frontend (shell-layout.ts): it fills the shell, the page iframe on top. */
:host([data-laid-out]) { position: fixed; inset: 0; z-index: 0; }
:host([data-laid-out]) .panel {
  position: absolute; inset: 0; width: auto !important; height: auto !important; border: 0;
}
:host([data-laid-out]) .bar { display: none; }
`;

/**
 * `<devtools-anywhere devtools-frontend-url="…/anywhere_app.html">`
 *
 * Attribute: `devtools-frontend-url`, the URL of the DevTools frontend entry page, loaded on
 * first open; without it, the probe's. The rest of its state is the library's: the probe gives
 * the global element its options (createGlobalElement), and the user opens and closes it.
 *
 * Whether it is open shows in its togglers' `aria-expanded`. Elements with `data-devtools-anywhere-toggle` open and close it when clicked: the
 * attribute is empty for the probe's element. An element the page placed itself is a box in its
 * flow with DevTools always loaded, no open state and no shell mode: a toggler set to its id only
 * fires `devtools-toggle-request` on it.
 *
 * The togglers work once the element is registered with defineDevtoolsAnywhere(); in the shell's
 * page iframe, those without a value control the shell's `<devtools-anywhere>`.
 *
 * The dock side (DevTools' main menu, "Dock side") and the sizes (dragging the bar) are the
 * user's: remembered in localStorage, sizes as percentages of the viewport (`dvh`/`dvw`).
 *
 * Keep the element attached in one place: moving it in the DOM reloads the iframe.
 *
 * @internal
 */
export class DevtoolsAnywhereElement extends HTMLElement {
  /** The attributes whose changes update the element. */
  static observedAttributes: (keyof DevtoolsAnywhereAttributes)[] = ['devtools-frontend-url'];

  /** The CDP session for this page. Created when the element is first connected. */
  private session: CdpSession | null = null;

  private panel: HTMLDivElement;
  private toggler: HTMLButtonElement;
  private frame: HTMLIFrameElement;
  private loadedUrl = '';
  private disconnect: (() => void) | null = null;
  private frontendOrigin = '';
  /** Whether DevTools is shown. */
  private isOpen = false;
  /** The options the probe gave, or the shell config's in the shell. */
  private config: GlobalElementConfig = {};
  /** `isOpen` as last seen by syncOpen, or null before. */
  private openState: boolean | null = null;
  /** The first global element connected: the only one that works. */
  private firstGlobal = false;
  /** In the shell: whether the page in the page iframe shows the F12 button (see mountShellToggler). */
  private pageToggler = false;
  /** For the F12 button in the shell's page (mountShellToggler): the shell's element, once found. */
  private shell: Element | null = null;
  /**
   * For the F12 button in the shell's page: shows it to the shell's element (attach) or stops
   * (detach), as the page shows or hides it, or removes it (document.open, replaceChildren).
   */
  private shellLink: { attach(): void; detach(): void } | null = null;
  /** In the shell: places the page where the frontend lays it out (shell-layout.ts). */
  private shellLayout: ShellLayout | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
<button class="toggler" part="toggler" popover="manual" aria-label="Open DevTools">F12</button>
<div class="panel" popover="manual">
  <div class="bar">
    <button class="close" aria-label="Close DevTools" title="Close DevTools">×</button>
  </div>
  <iframe title="DevTools"></iframe>
  <div class="corner"></div>
</div>`;
    /** An element of the template above. */
    const part = <T extends Element>(selector: string) => {
      const el = root.querySelector<T>(selector);
      if (!el) throw new Error(`devtools-anywhere: missing ${selector}`);
      return el;
    };
    this.panel = part<HTMLDivElement>('.panel');
    this.frame = part<HTMLIFrameElement>('iframe');
    this.toggler = part<HTMLButtonElement>('.toggler');
    this.toggler.addEventListener('click', () => {
      // The F12 button in the shell's page toggles the shell's element.
      if (!shellTogglers.has(this)) this.setOpen(!this.isOpen);
      else if (this.shell) controlElement(this.shell, true);
    });
    part('.close').addEventListener('click', () => this.setOpen(false));
    this.addEventListener(CONTROL_EVENT, this.onControl);
    this.setupResizer(part<HTMLElement>('.bar'));
    this.setupCorner(part<HTMLElement>('.corner'));
    // The undocked panel is resized by the browser (CSS resize): remember its size once it
    // settles, not on every frame of the drag.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    new ResizeObserver(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (this.dock === 'undocked' && this.isOpen && this.panel.offsetWidth) this.saveFloat();
      }, 300);
    }).observe(this.panel);
  }

  /** Where the panel is: shown to the style sheet as the panel's data-dock. */
  private get dock(): DockSide {
    const value = this.panel.dataset['dock'];
    return isDockSide(value) ? value : 'bottom';
  }
  private set dock(side: DockSide) {
    this.panel.dataset['dock'] = side;
  }

  /** Requests from the frontend (embedder.ts): its dock side menu, its close button, … */
  private onFrontendRequest = (event: MessageEvent) => {
    if (event.source !== this.frame.contentWindow || event.origin !== this.frontendOrigin) return;
    const request: unknown = event.data?.[REQUEST_KEY];
    if (!isEmbedderRequest(request)) return;
    // An element placed by the page only takes the frontend's colors: it has no dock side,
    // shell mode or open state.
    if (this.custom && request.type !== 'theme') return;
    if (request.type === 'dock') {
      store(DOCK_KEY, request.side);
      this.dock = request.side;
      this.update();
    } else if (request.type === 'keep-open') {
      // The page decides, not the user.
      if (this.config.locked) return;
      // The user's choice: the probe enters shell mode by default, unless they turned it off.
      store(SHELL_MODE_KEY, request.keep ? 'on' : 'off');
      if (request.keep) this.enterShell();
      else void this.exitShell();
    } else if (request.type === 'theme') {
      const colors: [string, string[]][] = [
        [request.toolbar, ['--bar-background']],
        [request.divider, ['--bar-handle', '--bar-border']],
        [request.icon, ['--bar-icon']],
      ];
      for (const [value, properties] of colors) {
        if (!CSS.supports('color', value)) continue;
        for (const property of properties) this.panel.style.setProperty(property, value);
      }
    } else if (request.type === 'close') {
      this.setOpen(false);
    } else if (request.type === 'page-bounds') {
      this.shellLayout?.pageBounds(request);
    } else if (request.type === 'split') {
      this.shellLayout?.splitSize(request.size);
    } else if (request.type === 'toolbox') {
      // Only a page of the frontend's own origin.
      let url: URL;
      try {
        url = new URL(request.url, this.loadedUrl);
      } catch {
        return;
      }
      if (url.origin === this.frontendOrigin) this.shellLayout?.showToolbox(url.href);
    }
  };

  /** Whether the page placed this element itself: neither the probe's nor the shell's. */
  private get custom() {
    return isCustom(this);
  }

  /**
   * The F12 button in the shell's page (mountShellToggler): shown, in the page's top layer, while
   * the shell's element is closed; it toggles that element. The shell hides its own button meanwhile.
   */
  private connectShellToggler() {
    if (!this.shellLink) {
      this.openState = false;
      const shellDocument = window.frameElement?.ownerDocument;
      const sync = () => {
        const open = this.shell ? controlElement(this.shell, false) : undefined;
        this.toggler.hidden = open !== false;
        if (TOP_LAYER) setPopoverOpen(this.toggler, !this.toggler.hidden);
      };
      const announce = (shown: boolean) =>
        this.shell?.dispatchEvent(new CustomEvent(CONTROL_EVENT, { detail: { toggler: shown } }));
      const listen = () => {
        this.shell = shellElement();
        this.shell?.addEventListener(STATE_EVENT, sync);
        announce(true);
        sync();
      };
      let linked = false;
      const link = {
        attach: () => {
          if (linked) return;
          linked = true;
          // The shell parses its element after its bundle, which may load after this page has run.
          if (shellDocument?.readyState === 'loading') shellDocument.addEventListener('DOMContentLoaded', listen);
          else listen();
        },
        detach: () => {
          if (!linked) return;
          linked = false;
          shellDocument?.removeEventListener('DOMContentLoaded', listen);
          this.shell?.removeEventListener(STATE_EVENT, sync);
          announce(false);
        },
      };
      this.shellLink = link;
      // Leaving, the shell shows its own button again until the next page shows one.
      window.addEventListener('pagehide', link.detach);
      window.addEventListener('pageshow', event => event.persisted && this.isConnected && link.attach());
    }
    this.shellLink.attach();
  }

  /**
   * An element placed by the page: a box in its flow, with DevTools loaded at once, as long as it
   * is connected. Its CSS shows and hides it; it never enters shell mode.
   */
  private connectCustom() {
    this.panel.toggleAttribute('data-custom', true);
    this.toggler.toggleAttribute('data-custom', true);
    window.addEventListener('message', this.onFrontendRequest);
    // Inside the shell's page iframe too: it inspects that page.
    this.session ??= createPageSession();
    // Loaded again once the probe gives its frontend URL.
    customElementsLoading.set(this, () => this.loadFrontend());
    this.loadFrontend();
  }

  /**
   * A toggler's request (see togglerTarget), maybe from another window: toggles when asked, and
   * answers whether DevTools is shown.
   */
  private onControl = (event: Event) => {
    // From another window, the event is not of this window's CustomEvent.
    const detail: unknown = Reflect.get(event, 'detail');
    if (typeof detail !== 'object' || !detail || inactiveGlobals.has(this)) return;
    // The page in the page iframe shows the F12 button, or no longer does.
    const toggler: unknown = Reflect.get(detail, 'toggler');
    if (typeof toggler === 'boolean' && isShellElement(this)) {
      this.pageToggler = toggler;
      if (this.isConnected) this.update();
      return;
    }
    if (Reflect.get(detail, 'toggle') === true) this.setOpen(!this.isOpen);
    Reflect.set(detail, 'open', this.isOpen);
  };

  /** Shows or hides DevTools; the frontend loads the first time and stays loaded. */
  private setOpen(open: boolean) {
    if (open === this.isOpen) return;
    this.isOpen = open;
    // In the shell, DevTools stays shown (or hidden) across reloads of the top-level page.
    if (isShellElement(this)) storeShellOpen(open);
    // Hidden, the frontend stays loaded: it leaves inspect mode, as Chrome's does when closed.
    if (!open && !this.custom && this.frontendOrigin) {
      const notice: FrontendNotice = { type: HIDDEN_NOTICE };
      this.frame.contentWindow?.postMessage({ [REQUEST_KEY]: notice }, this.frontendOrigin);
    }
    this.syncOpen();
    if (this.isConnected && !inactiveGlobals.has(this)) this.update();
  }

  /** The frontend's URL: the attribute, else the probe's, else in the shell's page iframe the shell's. */
  private get frontendUrl() {
    return (
      this.getAttribute('devtools-frontend-url') ||
      this.config.frontend ||
      probeFrontend ||
      (isShellPage() && readShellConfig()?.frontend) ||
      ''
    );
  }

  /**
   * Switches to shell mode: the page reloads inside an iframe next to DevTools, which then
   * stays open across reloads and navigations of the page. Needs the bundle URL.
   */
  private enterShell() {
    const frontend = this.frontendUrl;
    if (!bundleUrl || !frontend) return;
    // The probe ignores (and removes) a config whose URLs are not on its own origin.
    const flags = { locked: !!this.config.locked, noToggler: !!this.config.noToggler };
    if (!storeShellConfig(frontend, bundleUrl, this.config.serviceWorker ?? null, flags)) {
      console.warn('devtools-anywhere: shell mode needs the frontend, bundle and Service Worker on one origin');
      return;
    }
    location.reload();
  }

  /** Leaves shell mode and reloads the page on its own. */
  private async exitShell() {
    const config = readShellConfig();
    sessionStorage.removeItem(SHELL_KEY);
    try {
      if (config?.serviceWorker) {
        const registration = await navigator.serviceWorker
          ?.getRegistration(config.serviceWorker)
          .catch(() => undefined);
        await registration?.unregister();
      }
    } finally {
      // Reload even if the worker could not be unregistered: shell mode is already off.
      location.reload();
    }
  }

  /**
   * Back from the back/forward cache: the worker did not see this shell while it was there and
   * forgot it, and connectedCallback does not run again, so the handshake is made again.
   */
  private onShellPageshow = (event: PageTransitionEvent) => {
    if (event.persisted) navigator.serviceWorker?.controller?.postMessage({ type: SHELL_HANDSHAKE });
  };

  /**
   * In the shell: watches the page iframe. When its first page is out of reach, it refused to
   * be framed (X-Frame-Options, CSP frame-ancestors) and an error page is shown instead: shell
   * mode is refused for the session and the page reloads on its own. Otherwise the address bar
   * and the tab's title follow the page shown, through loads, history traversals and same-document navigations, so
   * that a reload (or a copied link) opens that page rather than the first one. Later pages out
   * of reach are another origin's: the address bar stays at the last one of ours.
   */
  private watchShellPage() {
    const page = document.getElementById(SHELL_PAGE_ID);
    if (!(page instanceof HTMLIFrameElement)) return;
    let first = true;
    const follow = () => {
      let href = '';
      try {
        href = page.contentWindow?.location.href ?? '';
      } catch {
        // Another origin, or an error page.
      }
      if (first && (!href || href === 'about:blank')) {
        refuseShell();
        location.reload();
        return;
      }
      first = false;
      if (!href || href === 'about:blank') return;
      if (href !== location.href) history.replaceState(history.state, '', href);
      // The tab shows the page's title too.
      const title = page.contentDocument?.title;
      if (title !== undefined) document.title = title;
    };
    const watch = () => {
      follow();
      const win = page.contentWindow;
      if (!win) return;
      try {
        win.addEventListener('popstate', follow);
        win.addEventListener('hashchange', follow);
        // pushState and replaceState fire no event but this one, where the Navigation API exists.
        if ('navigation' in win) win.navigation.addEventListener('currententrychange', follow);
      } catch {
        // Another origin.
      }
    };
    page.addEventListener('load', watch);
    // Loaded before this element ran: an error page is out of reach already.
    if (page.contentDocument?.readyState === 'complete' && page.contentWindow?.location.href !== 'about:blank') watch();
    else if (!page.contentDocument) follow();
  }

  /** In the shell: registers the Service Worker that injects the probe into iframe pages. */
  private async registerShellWorker() {
    const config = readShellConfig();
    if (!config?.serviceWorker || !navigator.serviceWorker) return;
    window.addEventListener('pageshow', this.onShellPageshow);
    // A worker already active controls this shell: tell it right away, before the page frame
    // navigates, instead of after register() and ready.
    navigator.serviceWorker.controller?.postMessage({ type: SHELL_HANDSHAKE });
    const url = new URL(config.serviceWorker);
    url.searchParams.set('probe', new URL(PROBE_SCRIPT, config.bundle).href);
    // Marks the worker as the shell's (see probe.ts), which unregisters a leftover one.
    url.searchParams.set('shell', '');
    try {
      await navigator.serviceWorker.register(url.href, { scope: '/' });
      // Tells the worker this window is a shell: it only touches requests while one is open.
      const registration = await navigator.serviceWorker.ready;
      registration.active?.postMessage({ type: SHELL_HANDSHAKE });
    } catch (e) {
      // Not a secure context, or the scope is not allowed: shell mode works without it.
      console.warn('[devtools-anywhere] Service Worker not registered:', e);
    }
  }

  /** Connects the page's CDP session (or, with `shell`, registers the Service Worker) and lays out the panel. */
  connectedCallback() {
    // Registers the element so the CDP domains hide it from the Elements panel; the
    // attribute only isolates its styles, as the page can set it too. A page that writes
    // <devtools-anywhere> itself (a supported way to mount it) gets it hidden too, with
    // whatever it puts inside.
    markOwn(this);
    this.setAttribute(OWN_ATTRIBUTE, '');
    // Only an element the page placed lets it style DevTools' iframe; known once connected, as a
    // global element is marked after it is created.
    this.frame.part.toggle('iframe', isCustom(this));
    if (shellTogglers.has(this)) return this.connectShellToggler();
    if (this.custom) return this.connectCustom();
    // Only the first global element connected works, even once it is gone.
    if (globalElements.has(this) && !this.firstGlobal) {
      if (globalTaken) {
        if (!inactiveGlobals.has(this))
          console.warn('devtools-anywhere: the page has a global <devtools-anywhere> already');
        inactiveGlobals.add(this);
        this.style.setProperty('display', 'none', 'important');
        return;
      }
      globalTaken = this.firstGlobal = true;
    }
    // The options, once: the probe's, or in the shell the shell config's, kept for its reloads.
    if (this.openState === null) {
      const shell = isShellElement(this) ? readShellConfig() : null;
      const given = shell
        ? {
            open: shell.open !== false,
            locked: !!shell.locked,
            noToggler: !!shell.noToggler,
            serviceWorker: shell.serviceWorker ?? null,
          }
        : globalConfigs.get(this);
      if (given) {
        this.config = given;
        this.isOpen = !!given.open;
      }
    }
    this.toggler.hidden = this.isOpen || !!this.config.noToggler || this.pageToggler;
    // Changed while detached, or now the first element for the togglers without a value.
    this.syncOpen();
    refreshTogglers(this.ownerDocument);
    const stored = readStored(DOCK_KEY);
    if (isDockSide(stored)) this.dock = stored;
    window.addEventListener('message', this.onFrontendRequest);
    if (isShellElement(this)) {
      // Only for its styles: what makes it the shell's is its document.
      this.setAttribute('data-shell', '');
      const page = document.getElementById(SHELL_PAGE_ID);
      if (page instanceof HTMLIFrameElement && !this.shellLayout) {
        this.shellLayout = new ShellLayout(this, this.frame, page, () => this.frontendOrigin);
      }
      this.watchShellPage();
      this.registerShellWorker();
    } else {
      this.session ??= createPageSession();
    }
    this.update();
  }

  /** Disconnects the frontend and stops listening to it. */
  disconnectedCallback() {
    // Removed by the page: the shell shows its own button again until it is back.
    if (shellTogglers.has(this)) this.shellLink?.detach();
    customElementsLoading.delete(this);
    // A detached iframe is unloaded; it reconnects and reloads when attached again.
    this.disconnect?.();
    this.disconnect = null;
    this.loadedUrl = '';
    this.shellLayout?.dispose();
    this.shellLayout = null;
    window.removeEventListener('message', this.onFrontendRequest);
    window.removeEventListener('pageshow', this.onShellPageshow);
    // The togglers without a value may point to another element now.
    refreshTogglers(this.ownerDocument);
  }

  /** Loads the new frontend if DevTools is open. */
  attributeChangedCallback() {
    if (shellTogglers.has(this)) return;
    if (this.custom) {
      if (this.isConnected) this.loadFrontend();
      return;
    }
    if (this.isConnected && !inactiveGlobals.has(this)) this.update();
  }

  /**
   * Tells STATE_EVENT's listeners when it opens or closes (not when first seen), and updates the
   * togglers' aria-expanded while connected (connectedCallback does when it connects).
   */
  private syncOpen() {
    if (inactiveGlobals.has(this)) return;
    const open = this.isOpen;
    const old = this.openState;
    this.openState = open;
    if (old === open || old === null) return;
    this.dispatchEvent(new Event(STATE_EVENT));
    if (this.isConnected) refreshTogglers(this.ownerDocument);
  }

  private update() {
    this.toggler.hidden = this.isOpen || !!this.config.noToggler || this.pageToggler;
    this.panel.toggleAttribute('data-open', this.isOpen);
    this.layout();
    // The toggler is a popover: shown as one, in the shell too. The shell document is ours:
    // nothing there covers the panel, which takes its place in the layout.
    if (TOP_LAYER) {
      if (!isShellElement(this)) setPopoverOpen(this.panel, this.isOpen);
      setPopoverOpen(this.toggler, !this.isOpen && !this.toggler.hidden);
    }
    // Load the frontend only once DevTools is opened; the probe keeps capturing meanwhile.
    if (this.isOpen) this.loadFrontend();
  }

  /** Sizes the panel for its dock side; in shell mode, also lays out the shell around it. */
  private layout() {
    const style = this.panel.style;
    style.width = style.height = style.left = style.top = '';
    const dock = this.dock;
    if (dock === 'bottom') {
      const stored = Number(readStored(HEIGHT_KEY));
      style.height = stored ? `${stored}${VH}` : `50${VH}`;
    } else if (dock === 'undocked') {
      const rect = this.floatRect();
      style.left = `${rect.left}${VW}`;
      style.top = `${rect.top}${VH}`;
      style.width = `${rect.width}${VW}`;
      style.height = `${rect.height}${VH}`;
    } else {
      const stored = Number(readStored(WIDTH_KEY));
      style.width = stored ? `${stored}${VW}` : `50${VW}`;
    }
    // The shell document is ours: the page iframe comes first, then this element.
    if (isShellElement(this)) {
      document.body.style.flexDirection = dock === 'right' ? 'row' : dock === 'left' ? 'row-reverse' : 'column';
      this.shellLayout?.update(this.isOpen, dock);
    }
  }

  /** The undocked panel's last position and size, kept inside the viewport. */
  private floatRect(): FloatRect {
    let stored: unknown = null;
    try {
      stored = JSON.parse(readStored(FLOAT_KEY) || 'null');
    } catch {}
    // Written by an older version or by the page itself: only finite numbers are used.
    const field = (key: keyof FloatRect) =>
      typeof stored === 'object' && stored ? finite(Reflect.get(stored, key)) : undefined;
    const width = Math.min(field('width') || 80, 100);
    const height = Math.min(field('height') || 60, 100);
    const clamp = (value: number | undefined, fallback: number, max: number) =>
      Math.min(Math.max(value ?? fallback, 0), max);
    return {
      left: clamp(field('left'), (100 - width) / 2, 100 - width),
      top: clamp(field('top'), (100 - height) / 2, 100 - height),
      width,
      height,
    };
  }

  private saveFloat() {
    const { left, top, width, height } = this.panel.getBoundingClientRect();
    const rect: FloatRect = {
      left: percent(left, innerWidth),
      top: percent(top, innerHeight),
      width: percent(width, innerWidth),
      height: percent(height, innerHeight),
    };
    store(FLOAT_KEY, JSON.stringify(rect));
  }

  private loadFrontend() {
    const frontend = this.frontendUrl;
    const pageElement = document.getElementById(SHELL_PAGE_ID);
    const page = pageElement instanceof HTMLIFrameElement ? pageElement : null;
    if (!frontend || (!this.session && !(isShellElement(this) && page))) return;
    const url = new URL(frontend, location.href);
    // The frontend's own switch for shell mode is hidden.
    if (this.config.locked || this.custom) url.searchParams.set('shellModeLocked', '');
    if (url.href === this.loadedUrl) return;
    this.loadedUrl = url.href;
    // The frontend's document is not one of the page's requests.
    installProbe().ownUrls.add(url.href);
    this.disconnect?.();
    this.frontendOrigin = url.origin;
    if (this.session) this.disconnect = connectFrontend(this.session, this.frame, url.origin);
    else if (page) {
      // Device mode was the previous frontend's: Chrome clears it with the frontend.
      this.shellLayout?.setMetrics(null);
      this.disconnect = relayShell(page, this.frame, url.origin, metrics => this.shellLayout?.setMetrics(metrics));
    }
    // Whether shell mode is available (it needs the bundle URL) and whether it is on.
    const shell = isShellElement(this);
    const hash = new URLSearchParams({
      embedded: location.origin,
      dock: this.dock,
      keep: !shell && !this.custom && bundleUrl ? '1' : '0',
      shell: shell ? '1' : '0',
    } satisfies FrontendHash);
    this.frame.src = `${url.href.split('#')[0]}#?${hash}`;
  }

  /** Dragging the bar resizes the docked panel, or moves the undocked one. */
  private setupResizer(resizer: HTMLElement) {
    resizer.addEventListener('pointerdown', down => {
      if ((down.target as HTMLElement).closest('button')) return;
      down.preventDefault();
      resizer.setPointerCapture(down.pointerId);
      this.panel.classList.add('dragging');
      const dock = this.dock;
      const start = this.panel.getBoundingClientRect();
      const clampSize = (size: number, max: number) => Math.min(Math.max(size, MIN_SIZE), max - 16);
      const move = (e: PointerEvent) => {
        const style = this.panel.style;
        if (dock === 'bottom') style.height = `${clampSize(innerHeight - e.clientY, innerHeight)}px`;
        else if (dock === 'right') style.width = `${clampSize(innerWidth - e.clientX, innerWidth)}px`;
        else if (dock === 'left') style.width = `${clampSize(e.clientX, innerWidth)}px`;
        else {
          const left = start.left + e.clientX - down.clientX;
          const top = start.top + e.clientY - down.clientY;
          // The whole window stays in the viewport, so its resize corner stays reachable; a
          // window larger than the viewport keeps its top left corner in view.
          style.left = `${Math.max(Math.min(left, innerWidth - start.width), 0)}px`;
          style.top = `${Math.max(Math.min(top, innerHeight - start.height), 0)}px`;
        }
      };
      const up = () => {
        this.panel.classList.remove('dragging');
        if (dock === 'bottom') store(HEIGHT_KEY, String(percent(this.panel.offsetHeight, innerHeight)));
        else if (dock === 'undocked') this.saveFloat();
        else store(WIDTH_KEY, String(percent(this.panel.offsetWidth, innerWidth)));
        // From the pixels of the drag to the remembered percentages.
        this.layout();
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        resizer.removeEventListener('pointercancel', up);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
      resizer.addEventListener('pointercancel', up);
    });
  }

  /** Dragging the corner resizes the undocked panel, within the viewport. */
  private setupCorner(corner: HTMLElement) {
    corner.addEventListener('pointerdown', down => {
      down.preventDefault();
      corner.setPointerCapture(down.pointerId);
      this.panel.classList.add('dragging');
      const start = this.panel.getBoundingClientRect();
      const move = (e: PointerEvent) => {
        const width = start.width + e.clientX - down.clientX;
        const height = start.height + e.clientY - down.clientY;
        this.panel.style.width = `${Math.min(Math.max(width, MIN_SIZE), innerWidth - start.left)}px`;
        this.panel.style.height = `${Math.min(Math.max(height, MIN_SIZE), innerHeight - start.top)}px`;
      };
      const up = () => {
        this.panel.classList.remove('dragging');
        this.saveFloat();
        this.layout();
        corner.removeEventListener('pointermove', move);
        corner.removeEventListener('pointerup', up);
        corner.removeEventListener('pointercancel', up);
      };
      corner.addEventListener('pointermove', move);
      corner.addEventListener('pointerup', up);
      corner.addEventListener('pointercancel', up);
    });
  }
}

/**
 * The global elements, created for the probe (createGlobalElement), whether one has connected, and
 * those connected after it, which do nothing.
 */
const globalElements = new WeakSet<Element>();
let globalTaken = false;
const inactiveGlobals = new WeakSet<Element>();
/** The probe's frontend URL, for the elements placed by the page without one. */
let probeFrontend = '';
/** The connected elements placed by the page, each with what loads its frontend. */
const customElementsLoading = new Map<Element, () => void>();
/** The probe's options for each global element, taken when it first connects. */
const globalConfigs = new WeakMap<Element, GlobalElementConfig>();

/** Creates a global element with the probe's options: only the first one connected works. @internal */
export function createGlobalElement(config: GlobalElementConfig): DevtoolsAnywhereElement | null {
  try {
    const element = new DevtoolsAnywhereElement();
    globalElements.add(element);
    globalConfigs.set(element, config);
    if (config.frontend && !probeFrontend) {
      probeFrontend = config.frontend;
      customElementsLoading.forEach(load => load());
    }
    return element;
  } catch {
    // The page registered devtools-anywhere itself, with a class of its own.
    console.warn('devtools-anywhere: <devtools-anywhere> is registered by the page; no global element');
    return null;
  }
}

/** The F12 buttons of the shell's element, in the shell's page (mountShellToggler). */
const shellTogglers = new WeakSet<Element>();

/**
 * In the shell's page iframe: mounts the shell element's F12 button in the page, under <html> like
 * the global element, so that the page's `::part(toggler)` styles reach it. The shell config
 * decides, not the page's probe: none with `noToggler`. @internal
 */
export function mountShellToggler() {
  if (readShellConfig()?.noToggler) return;
  let element: DevtoolsAnywhereElement;
  try {
    element = new DevtoolsAnywhereElement();
  } catch {
    // The page registered devtools-anywhere itself: the shell keeps its own button.
    return;
  }
  shellTogglers.add(element);
  const mount = () => document.documentElement.appendChild(element);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

/** What a toggler fires on an element placed by the page, which has no open state. */
const TOGGLE_REQUEST_EVENT = 'devtools-toggle-request';
/** Whether `el` is an element placed by the page (of this window). */
const isCustom = (el: Element) =>
  el instanceof DevtoolsAnywhereElement && !globalElements.has(el) && !shellTogglers.has(el) && !isShellElement(el);
/**
 * Whether `el` is the shell's element: one in the shell document the probe wrote (not created
 * for the probe), maybe of another window. Its document is marked as the shell's when the probe writes the
 * shell; a `shell` attribute no longer makes an element the shell's.
 */
const isShellElement = (el: Element) => !globalElements.has(el) && isShellDocument(el.ownerDocument);

/**
 * Fired on the global element when it opens or closes, for the togglers of the shell's page: an
 * internal convention, not part of the API, which has only their aria-expanded. A page of the
 * same origin can fire it too: it is not meant to be trusted.
 */
const STATE_EVENT = 'devtools-anywhere-state';

/**
 * The event a toggler controls its element with (see controlElement): an internal convention, not
 * part of the API. A page of the same origin can fire it too: it is not meant to be trusted.
 */
const CONTROL_EVENT = 'devtools-anywhere-control';

/** Elements with this attribute open and close DevTools when clicked (see togglerTarget). */
const TOGGLE_ATTRIBUTE: keyof TogglerAttributes = 'data-devtools-anywhere-toggle';
/** The tag the togglers look for, once they are installed. */
let togglerTag = '';
/** Toggler values already warned about. */
const warned = new Set<string>();

/**
 * The element a toggler controls: the element whose id is the attribute's value, or without one
 * the first global element, or in the shell's page iframe the shell's element.
 */
function togglerTarget(toggler: Element, warn: boolean): Element | null {
  const id = toggler.getAttribute(TOGGLE_ATTRIBUTE) ?? '';
  const doc = toggler.ownerDocument;
  let target: Element | null | undefined = null;
  if (isShellPage()) {
    // An element the page placed in the shell's page: the toggler names it. Without a value, the
    // shell's element, of the shell window's class: it is toggled through an event.
    const named = id ? doc.getElementById(id) : null;
    if (named && customElementsLoading.has(named)) return named;
    if (!id) return shellElement();
  } else {
    // Without a value, the global element (or the shell's); global elements after the first do
    // nothing: they are not targets.
    target = id
      ? doc.getElementById(id)
      : [...doc.querySelectorAll(togglerTag)].find(
          el => (globalElements.has(el) || isShellElement(el)) && !inactiveGlobals.has(el)
        );
  }
  if (target instanceof DevtoolsAnywhereElement && !inactiveGlobals.has(target)) return target;
  if (warn && !warned.has(id)) {
    warned.add(id);
    console.warn(`devtools-anywhere: no <${togglerTag}>${id ? ` with id "${id}"` : ''} for ${TOGGLE_ATTRIBUTE}`);
  }
  return null;
}

/** In the shell's page iframe: the shell's element, of the shell window's class. */
function shellElement(): Element | null {
  const shellDocument = window.frameElement?.ownerDocument;
  return (shellDocument && [...shellDocument.querySelectorAll(togglerTag)].find(isShellElement)) ?? null;
}

/**
 * Asks a toggler's element, maybe of another window, whether it is open, toggling it first when
 * `toggle`. Undefined when it does not answer.
 */
function controlElement(target: Element, toggle: boolean): boolean | undefined {
  const detail: { toggle: boolean; open?: boolean } = { toggle };
  target.dispatchEvent(new CustomEvent(CONTROL_EVENT, { detail }));
  return detail.open;
}

/** Sets aria-expanded on a toggler from the state of its element. */
function refreshToggler(toggler: Element, warn = false) {
  const target = togglerTarget(toggler, warn);
  // An element placed by the page has no open state.
  if (target && isCustom(target)) return target;
  const open = target && controlElement(target, false);
  if (open !== undefined && open !== null) toggler.setAttribute('aria-expanded', String(open));
  return target;
}

function refreshTogglers(doc: Document) {
  if (!togglerTag) return;
  for (const toggler of doc.querySelectorAll(`[${TOGGLE_ATTRIBUTE}]`)) refreshToggler(toggler);
}

/** Makes any element with TOGGLE_ATTRIBUTE, including those added later, a toggler. */
function installTogglers(tag: string) {
  if (togglerTag) return;
  togglerTag = tag;
  document.addEventListener(
    'click',
    event => {
      const clicked = event.target instanceof Element ? event.target : null;
      const toggler = clicked?.closest(`[${TOGGLE_ATTRIBUTE}]`);
      // A label's click is followed by one on its control: that one toggles, once.
      const control = clicked?.closest('label')?.control;
      if (!toggler || (control && control !== clicked && toggler.contains(control))) return;
      const target = toggler && refreshToggler(toggler, true);
      if (!target) return;
      // An element placed by the page only tells its listeners, which decide.
      if (isCustom(target)) target.dispatchEvent(new Event(TOGGLE_REQUEST_EVENT));
      else controlElement(target, true);
      refreshToggler(toggler);
    },
    true
  );
  const refresh = () => refreshTogglers(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
  // In the shell's page iframe, the togglers follow the shell's element while this page is shown.
  if (!isShellPage()) return;
  const shellDocument = window.frameElement?.ownerDocument;
  let shell: Element | null = null;
  const listen = () => {
    shell = togglerTarget(document.documentElement, false);
    shell?.addEventListener(STATE_EVENT, refresh);
    refresh();
  };
  // The shell parses its element after its bundle, which may load after this page has run.
  if (shellDocument?.readyState === 'loading') shellDocument.addEventListener('DOMContentLoaded', listen);
  else listen();
  window.addEventListener('pagehide', () => {
    shellDocument?.removeEventListener('DOMContentLoaded', listen);
    shell?.removeEventListener(STATE_EVENT, refresh);
  });
  window.addEventListener('pageshow', event => event.persisted && listen());
}

/**
 * Registers the element under `tag` unless something is already registered there, and makes
 * elements with `data-devtools-anywhere-toggle` open and close it. @internal
 */
export function defineDevtoolsAnywhere(tag = 'devtools-anywhere') {
  if (!customElements.get(tag)) customElements.define(tag, DevtoolsAnywhereElement);
  installTogglers(tag);
}
