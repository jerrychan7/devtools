import {
  installProbe,
  SHELL_KEY,
  SHELL_PAGE_ID,
  createCdpServer,
  isShellPage,
  readShellConfig,
  type CdpServer,
  type ShellConfig,
  type SnapdomLoader,
} from '@devtools-anywhere/cdp-server';
import { connectFrontend, relayShell } from './connection';

let bundleUrl = '';

/**
 * Tells the element where devtools-anywhere.iife.js lives, which shell mode needs to load
 * it inside the page iframe. The IIFE build sets this itself.
 */
export function setBundleUrl(url: string) {
  bundleUrl = url;
  loadSnapdom = () => import(/* @vite-ignore */ new URL('snapdom.js', url).href);
}

/**
 * snapDOM, which renders the screencast, is loaded only when the screencast starts. The ESM
 * build leaves `import('@zumer/snapdom')` to the bundler; the IIFE build loads the copy
 * next to itself (snapdom.js).
 */
let loadSnapdom: SnapdomLoader = () => import('@zumer/snapdom');

/** The CDP server of a page, with the screencast's renderer. */
export const createPageServer = () => createCdpServer({ loadSnapdom: () => loadSnapdom() });

const HEIGHT_KEY = 'devtools-anywhere:height';
const WIDTH_KEY = 'devtools-anywhere:width';
const FLOAT_KEY = 'devtools-anywhere:float';
const DOCK_KEY = 'devtools-anywhere:dock';
const MIN_SIZE = 80;

/** Where the panel is: docked to a side of the viewport, or floating over the page. */
export type DockSide = 'bottom' | 'right' | 'left' | 'undocked';
const DOCK_SIDES: readonly string[] = ['bottom', 'right', 'left', 'undocked'];
const isDockSide = (value: unknown): value is DockSide => typeof value === 'string' && DOCK_SIDES.includes(value);

/** Position and size of the undocked panel, in CSS pixels. */
interface FloatRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const STYLE = `
:host { all: initial; }
.launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 44px; height: 44px; border: 0; border-radius: 50%;
  background: #1a73e8; color: #fff; font: 600 13px/44px system-ui, sans-serif;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .3); cursor: pointer; touch-action: manipulation;
}
:host([open]) .launcher, :host([no-launcher]) .launcher { display: none; }
.panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  display: none; flex-direction: column;
  background: #fff; border-top: 1px solid #cacdd1;
}
:host([open]) .panel { display: flex; }
.bar {
  flex: none; position: relative; height: 16px; background: #f1f3f4;
  cursor: row-resize; touch-action: none;
}
.bar::before {
  content: ''; position: absolute; left: 50%; top: 6px; width: 32px; height: 4px;
  margin-left: -16px; border-radius: 2px; background: #bdc1c6;
}
.bar button {
  position: absolute; top: 0; width: 24px; height: 16px; padding: 0; border: 0;
  background: none; color: #5f6368; font: 14px/16px system-ui, sans-serif; cursor: pointer;
}
/* DevTools' own toolbar has a close button, except when undocked: then the bar has one. */
.close { right: 4px; display: none; }
.keep { right: 4px; }
:host([dock=undocked]) .close { display: block; }
:host([dock=undocked]) .keep { right: 32px; }
:host(:not([data-can-keep])) .keep { display: none; }
iframe { flex: 1; min-width: 0; min-height: 0; border: 0; }
.dragging iframe { pointer-events: none; }

/* Docked to a side: full height, with the bar as a vertical strip on the inner edge. */
:host([dock=right]) .panel, :host([dock=left]) .panel { top: 0; border-top: 0; }
:host([dock=right]) .panel { left: auto; flex-direction: row; border-left: 1px solid #cacdd1; }
:host([dock=left]) .panel { right: auto; flex-direction: row-reverse; border-right: 1px solid #cacdd1; }
:host([dock=right]) .bar, :host([dock=left]) .bar { width: 16px; height: auto; cursor: col-resize; }
:host([dock=right]) .bar::before, :host([dock=left]) .bar::before {
  left: 6px; top: 50%; width: 4px; height: 32px; margin: -16px 0 0;
}
:host([dock=right]) .bar button, :host([dock=left]) .bar button { left: 0; right: auto; width: 16px; }

/* Undocked: a window over the page, moved by its bar and resized from its corner. */
:host([dock=undocked]) .panel {
  right: auto; bottom: auto; border: 1px solid #cacdd1; border-radius: 6px; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .3); resize: both;
}
:host([dock=undocked]) .bar { cursor: move; }

/* Shell mode: the panel takes its place next to the page iframe, unless undocked. */
:host([shell]) { display: flex; flex: none; }
:host([shell]) .panel { position: static; display: flex; flex: 1 1 auto; }
:host([shell][dock=undocked]) .panel { position: fixed; }
:host([data-shell-page]) { display: none !important; }
`;

/**
 * `<devtools-anywhere frontend="…/chii_app.html" open>`
 *
 * Attributes:
 * - `frontend`: URL of the DevTools frontend entry page. Loaded on first open.
 * - `open`: shows the panel; otherwise a small launcher button is shown.
 * - `dock`: `bottom` (default), `right`, `left` or `undocked` (a window over the page). The
 *   main menu's "Dock side" in DevTools changes it; the choice is remembered in localStorage.
 * - `height`: panel height when docked to the bottom, as a CSS length (default `50vh`).
 * - `width`: panel width when docked to a side, as a CSS length (default `50vw`).
 *   Dragging the bar overrides either size, and the size is remembered in localStorage.
 * - `no-launcher`: hides the launcher button.
 * - `sw`: in shell mode, also register devtools-anywhere-sw.js from this URL (or next to the
 *   bundle when the value is empty), which injects the probe into iframe pages that do not
 *   include it. Needs a secure context and a scope covering the pages.
 * - `shell`: set by shell mode on the element inside the shell document.
 *
 * Keep the element attached in one place: moving it in the DOM reloads the iframe.
 */
export class DevtoolsAnywhereElement extends HTMLElement {
  static observedAttributes = ['open', 'frontend', 'height', 'width', 'dock'];

  /** The CDP server for this page. Created when the element is first connected. */
  server: CdpServer | null = null;

  private panel: HTMLDivElement;
  private frame: HTMLIFrameElement;
  private loadedUrl = '';
  private disconnect: (() => void) | null = null;
  private frontendOrigin = '';

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>
<button class="launcher" part="launcher" aria-label="Open DevTools">F12</button>
<div class="panel" part="panel">
  <div class="bar">
    <button class="keep" aria-label="Keep DevTools open across reloads" title="Keep DevTools open across reloads">⟳</button>
    <button class="close" aria-label="Close DevTools" title="Close DevTools">×</button>
  </div>
  <iframe title="DevTools"></iframe>
</div>`;
    /** An element of the template above. */
    const part = <T extends Element>(selector: string) => {
      const el = root.querySelector<T>(selector);
      if (!el) throw new Error(`devtools-anywhere: missing ${selector}`);
      return el;
    };
    this.panel = part<HTMLDivElement>('.panel');
    this.frame = part<HTMLIFrameElement>('iframe');
    part('.launcher').addEventListener('click', () => this.show());
    part('.close').addEventListener('click', () => (this.hasAttribute('shell') ? this.exitShell() : this.hide()));
    part('.keep').addEventListener('click', () => this.enterShell());
    this.setupResizer(part<HTMLElement>('.bar'));
    // The undocked panel is resized by the browser (CSS resize): remember its size.
    new ResizeObserver(() => {
      if (this.dock === 'undocked' && this.open && this.panel.offsetWidth) this.saveFloat();
    }).observe(this.panel);
  }

  /** Where the panel is. */
  get dock(): DockSide {
    const value = this.getAttribute('dock');
    return isDockSide(value) ? value : 'bottom';
  }
  set dock(side: DockSide) {
    this.setAttribute('dock', side);
  }

  /** Requests from the frontend (objects, unlike CDP messages): its dock side menu, its close button. */
  private onFrontendRequest = (event: MessageEvent) => {
    if (event.source !== this.frame.contentWindow || event.origin !== this.frontendOrigin) return;
    const request: unknown = event.data?.devtoolsAnywhere;
    if (typeof request !== 'object' || !request || !('type' in request)) return;
    if (request.type === 'dock' && 'side' in request && isDockSide(request.side)) {
      localStorage.setItem(DOCK_KEY, request.side);
      this.dock = request.side;
    } else if (request.type === 'close') {
      if (this.hasAttribute('shell')) this.exitShell();
      else this.hide();
    }
  };

  get open() {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  show() {
    this.open = true;
  }
  hide() {
    this.open = false;
  }
  toggle() {
    this.open = !this.open;
  }

  /**
   * Switches to shell mode: the page reloads inside an iframe next to DevTools, which then
   * stays open across reloads and navigations of the page. Needs the bundle URL.
   */
  enterShell() {
    const frontend = this.getAttribute('frontend');
    if (!bundleUrl || !frontend) return;
    const config: ShellConfig = { frontend: new URL(frontend, location.href).href, bundle: bundleUrl };
    const sw = this.getAttribute('sw');
    if (sw !== null) config.sw = new URL(sw || 'devtools-anywhere-sw.js', sw ? location.href : bundleUrl).href;
    sessionStorage.setItem(SHELL_KEY, JSON.stringify(config));
    location.reload();
  }

  /** Leaves shell mode and reloads the page on its own. */
  async exitShell() {
    const config = readShellConfig();
    sessionStorage.removeItem(SHELL_KEY);
    if (config?.sw) {
      const registration = await navigator.serviceWorker?.getRegistration(config.sw).catch(() => undefined);
      await registration?.unregister();
    }
    location.reload();
  }

  /** In the shell: registers the Service Worker that injects the probe into iframe pages. */
  private async registerShellWorker() {
    const config = readShellConfig();
    if (!config?.sw || !navigator.serviceWorker) return;
    const url = new URL(config.sw);
    url.searchParams.set('probe', new URL('probe.iife.js', config.bundle).href);
    try {
      await navigator.serviceWorker.register(url.href, { scope: '/' });
    } catch (e) {
      // Not a secure context, or the scope is not allowed: shell mode works without it.
      console.warn('[devtools-anywhere] Service Worker not registered:', e);
    }
  }

  connectedCallback() {
    // Marks the element so the DOM domain can hide it from the Elements panel.
    this.setAttribute('data-devtools-anywhere', '');
    const stored = localStorage.getItem(DOCK_KEY);
    if (isDockSide(stored)) this.dock = stored;
    window.addEventListener('message', this.onFrontendRequest);
    if (isShellPage()) {
      // Inside the shell's page iframe the shell shows DevTools; the IIFE connects the page.
      this.setAttribute('data-shell-page', '');
      return;
    }
    if (this.hasAttribute('shell')) {
      this.registerShellWorker();
    } else {
      this.server ??= createPageServer();
      this.toggleAttribute('data-can-keep', !!bundleUrl);
    }
    this.update();
  }

  disconnectedCallback() {
    // A detached iframe is unloaded; it reconnects and reloads when attached again.
    this.disconnect?.();
    this.disconnect = null;
    this.loadedUrl = '';
    window.removeEventListener('message', this.onFrontendRequest);
  }

  attributeChangedCallback() {
    if (this.isConnected && !this.hasAttribute('data-shell-page')) this.update();
  }

  private update() {
    this.layout();
    // Load the frontend only once DevTools is opened; the probe keeps capturing meanwhile.
    if (this.open) this.loadFrontend();
  }

  /** Sizes the panel for its dock side; in shell mode, also lays out the shell around it. */
  private layout() {
    const style = this.panel.style;
    style.width = style.height = style.left = style.top = '';
    const dock = this.dock;
    if (dock === 'bottom') {
      const stored = Number(localStorage.getItem(HEIGHT_KEY));
      style.height = stored ? `${stored}px` : this.getAttribute('height') || '50vh';
    } else if (dock === 'undocked') {
      const rect = this.floatRect();
      style.left = `${rect.left}px`;
      style.top = `${rect.top}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
    } else {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      style.width = stored ? `${stored}px` : this.getAttribute('width') || '50vw';
    }
    // The shell document is ours: the page iframe comes first, then this element.
    if (this.hasAttribute('shell')) {
      document.body.style.flexDirection = dock === 'right' ? 'row' : dock === 'left' ? 'row-reverse' : 'column';
    }
  }

  /** The undocked panel's last position and size, kept inside the viewport. */
  private floatRect(): FloatRect {
    let rect: Partial<FloatRect> = {};
    try {
      rect = JSON.parse(localStorage.getItem(FLOAT_KEY) || '{}');
    } catch {}
    const width = Math.min(rect.width || innerWidth * 0.8, innerWidth);
    const height = Math.min(rect.height || innerHeight * 0.6, innerHeight);
    const clamp = (value: number | undefined, fallback: number, max: number) =>
      Math.min(Math.max(value ?? fallback, 0), Math.max(max, 0));
    return {
      left: clamp(rect.left, (innerWidth - width) / 2, innerWidth - width),
      top: clamp(rect.top, (innerHeight - height) / 2, innerHeight - height),
      width,
      height,
    };
  }

  private saveFloat() {
    const { left, top, width, height } = this.panel.getBoundingClientRect();
    localStorage.setItem(FLOAT_KEY, JSON.stringify({ left, top, width, height }));
  }

  private loadFrontend() {
    const frontend = this.getAttribute('frontend');
    const page = document.getElementById(SHELL_PAGE_ID) as HTMLIFrameElement | null;
    if (!frontend || (!this.server && !(this.hasAttribute('shell') && page))) return;
    const url = new URL(frontend, location.href);
    if (url.href === this.loadedUrl) return;
    this.loadedUrl = url.href;
    // The frontend's document is not one of the page's requests.
    installProbe().ownUrls.add(url.href);
    this.disconnect?.();
    this.frontendOrigin = url.origin;
    if (this.server) this.disconnect = connectFrontend(this.server, this.frame, url.origin);
    else if (page) this.disconnect = relayShell(page, this.frame, url.origin);
    const hash = new URLSearchParams({ embedded: location.origin, dock: this.dock });
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
        if (dock === 'bottom') localStorage.setItem(HEIGHT_KEY, String(this.panel.offsetHeight));
        else if (dock === 'undocked') this.saveFloat();
        else localStorage.setItem(WIDTH_KEY, String(this.panel.offsetWidth));
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        resizer.removeEventListener('pointercancel', up);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
      resizer.addEventListener('pointercancel', up);
    });
  }
}

/** Registers the element under `tag` unless something is already registered there. */
export function defineDevtoolsAnywhere(tag = 'devtools-anywhere') {
  if (!customElements.get(tag)) customElements.define(tag, DevtoolsAnywhereElement);
}
