import {
  installProbe,
  SHELL_KEY,
  SHELL_PAGE_ID,
  createCdpSession,
  isShellPage,
  isTrusted,
  markOwn,
  OWN_ATTRIBUTE,
  readShellConfig,
  refuseShell,
  SHELL_MODE_KEY,
  storeShellConfig,
  storeShellOpen,
  type CdpSession,
  type SnapdomLoader,
} from '../cdp-agent';
import { connectFrontend, relayShell } from '../connection';
import { SHELL_HANDSHAKE } from '../shell-messages';
import type { Grip } from '../grip';
import { isDockSide, isEmbedderRequest } from './request';
import {
  createPanelGrip,
  DOCK_KEY,
  GRIP_EDGE,
  readStored,
  saveFloat,
  setupCorner,
  setupMover,
  sizePanel,
  store,
} from './panel';
import { ShellLayout } from '../shell-layout';
import { STYLE } from './style';
import {
  CONTROL_EVENT,
  customElementsLoading,
  globalConfigs,
  globalElements,
  globals,
  inactiveGlobals,
  isCustom,
  isShellElement,
  ownElements,
  shellTogglers,
  STATE_EVENT,
} from './registry';
import { controlElement, installTogglers, refreshTogglers, shellElement } from './togglers';
import type { GlobalElementConfig } from '../api';
import type { DevtoolsAnywhereAttributes } from '../public-types';
import {
  HIDDEN_NOTICE,
  PROBE_SCRIPT,
  SNAPDOM_SCRIPT,
  REQUEST_KEY,
  type DockSide,
  type FrontendNotice,
  type FrontendHash,
} from '../embedder';

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

/**
 * Whether the browser has the top layer for popovers. There the toggler and the panel are above
 * everything the page draws, whatever its z-index; elsewhere they fall back to the highest z-index.
 */
const TOP_LAYER = typeof HTMLElement.prototype.showPopover === 'function';

/** Shows or hides a popover, if not already. */
function setPopoverOpen(el: HTMLElement, open: boolean) {
  if (el.matches(':popover-open') !== open) el.togglePopover(open);
}

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
  private readonly grip: Grip;

  constructor() {
    super();
    ownElements.add(this);
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
    const relayout = () => this.layout();
    setupMover(part<HTMLElement>('.bar'), this.panel, relayout);
    this.grip = createPanelGrip(this.panel, () => this.dock, relayout);
    this.panel.append(this.grip.element);
    setupCorner(part<HTMLElement>('.corner'), this.panel, relayout);
    // The undocked panel is resized by the browser (CSS resize): remember its size once it
    // settles, not on every frame of the drag.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    new ResizeObserver(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (this.dock === 'undocked' && this.isOpen && this.panel.offsetWidth) saveFloat(this.panel);
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
        [request.toolbar, ['--bar-background', '--grip-background']],
        [request.divider, ['--bar-handle', '--bar-border', '--grip-border']],
        [request.icon, ['--bar-icon', '--grip-dot']],
      ];
      const set: Record<string, string> = {};
      for (const [value, properties] of colors) {
        if (!CSS.supports('color', value)) continue;
        for (const property of properties) set[property] = value;
      }
      for (const [property, value] of Object.entries(set)) this.panel.style.setProperty(property, value);
      // The shell's grip is outside this element.
      this.shellLayout?.setGripColors(set);
    } else if (request.type === 'close') {
      this.setOpen(false);
    } else if (request.type === 'page-bounds') {
      this.shellLayout?.pageBounds(request);
    } else if (request.type === 'split') {
      this.shellLayout?.splitArea(request);
    } else if (request.type === 'toolbox') {
      // Only a page next to the frontend's: on a CDN, its origin is every package's.
      let url: string;
      let frontendDir: string;
      try {
        url = new URL(request.url, this.loadedUrl).href;
        frontendDir = new URL('.', this.loadedUrl).href;
      } catch {
        return;
      }
      if (isTrusted(url, { prefixes: [frontendDir] })) this.shellLayout?.showToolbox(url);
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
      globals.probeFrontend ||
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
      if (globals.taken) {
        if (!inactiveGlobals.has(this))
          console.warn('devtools-anywhere: the page has a global <devtools-anywhere> already');
        inactiveGlobals.add(this);
        this.style.setProperty('display', 'none', 'important');
        return;
      }
      globals.taken = this.firstGlobal = true;
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
    const dock = this.dock;
    sizePanel(this.panel, dock);
    // Docked, the grip on the panel's inner edge resizes it; in the shell, the shell's grip does.
    if (dock !== 'undocked') this.grip.place(GRIP_EDGE[dock], 'outside');
    this.grip.show(dock !== 'undocked' && !isShellElement(this) && !this.panel.hasAttribute('data-custom'));
    // The shell document is ours: the page iframe comes first, then this element.
    if (isShellElement(this)) {
      document.body.style.flexDirection = dock === 'right' ? 'row' : dock === 'left' ? 'row-reverse' : 'column';
      this.shellLayout?.update(this.isOpen, dock);
    }
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
}

/** Creates a global element with the probe's options: only the first one connected works. @internal */
export function createGlobalElement(config: GlobalElementConfig): DevtoolsAnywhereElement | null {
  try {
    const element = new DevtoolsAnywhereElement();
    globalElements.add(element);
    globalConfigs.set(element, config);
    if (config.frontend && !globals.probeFrontend) {
      globals.probeFrontend = config.frontend;
      customElementsLoading.forEach(load => load());
    }
    return element;
  } catch {
    // The page registered devtools-anywhere itself, with a class of its own.
    console.warn('devtools-anywhere: <devtools-anywhere> is registered by the page; no global element');
    return null;
  }
}

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

/**
 * Registers the element under `tag` unless something is already registered there, and makes
 * elements with `data-devtools-anywhere-toggle` open and close it. @internal
 */
export function defineDevtoolsAnywhere(tag = 'devtools-anywhere') {
  if (!customElements.get(tag)) customElements.define(tag, DevtoolsAnywhereElement);
  installTogglers(tag);
}
