// Vision deficiencies: Chrome filters the whole page with an SVG filter outside the DOM. We put a
// transparent mask in the top layer whose backdrop-filter is that filter, so the page's own
// `filter` on <html> stays and getComputedStyle sees nothing of ours.
import { frames } from '../../core/frames/frames';
import { OWN_ATTRIBUTE, closestOwn, isOwn, markOwn } from '../../core/nodes/nodes';
import type { ShadowRootTracker } from '../../core/nodes/shadow-roots';
import type { TopNatives } from '../../probe/types';

/** The SVG filters Chrome puts on the page for each vision deficiency. */
export const VISION: Record<string, string> = {
  blurredVision: '<feGaussianBlur stdDeviation="2"/>',
  reducedContrast:
    '<feComponentTransfer><feFuncR type="gamma" offset="0.5"/><feFuncG type="gamma" offset="0.5"/><feFuncB type="gamma" offset="0.5"/></feComponentTransfer>',
  achromatopsia: matrix('0.213 0.715 0.072 0.213 0.715 0.072 0.213 0.715 0.072'),
  deuteranopia: matrix('0.367 0.861 -0.228 0.280 0.673 0.047 -0.012 0.043 0.969'),
  protanopia: matrix('0.152 1.053 -0.205 0.115 0.786 0.099 -0.004 -0.048 1.052'),
  tritanopia: matrix('1.256 -0.077 -0.179 -0.078 0.931 0.148 0.005 0.691 0.304'),
};

/** A color matrix filter from its 3×3 RGB part, alpha kept. */
function matrix(rgb: string): string {
  const v = rgb.split(' ');
  const row = (i: number) => `${v.slice(i * 3, i * 3 + 3).join(' ')} 0 0`;
  return `<feColorMatrix values="${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0"/>`;
}

/**
 * The browser's own functions: the probe's (taken before the page's code and the probe's own
 * hooks, so that our listeners are not listed as the page's either), else those found when this
 * module loaded.
 */
let natives: TopNatives = {
  show: HTMLElement.prototype.showPopover,
  hide: HTMLElement.prototype.hidePopover,
  listen: EventTarget.prototype.addEventListener,
  unlisten: EventTarget.prototype.removeEventListener,
  MO: MutationObserver,
};

/** The shadow roots of the frames' documents, whose popovers and dialogs the page toggles too. */
let shadowRoots: ShadowRootTracker | undefined;

/** Takes the probe's natives (undefined from an older probe) and the shadow root tracker. */
export function useVisionContext(top: TopNatives | undefined, tracker: ShadowRootTracker): void {
  if (top) natives = top;
  shadowRoots = tracker;
}

const EVENTS = ['toggle', 'fullscreenchange'];
const on = (target: EventTarget, listener: (e: Event) => void) => {
  for (const t of EVENTS) Reflect.apply(natives.listen, target, [t, listener, true]);
};
const off = (target: EventTarget, listener: (e: Event) => void) => {
  for (const t of EVENTS) Reflect.apply(natives.unlisten, target, [t, listener, true]);
};

/**
 * The mask's popover style: the browser's popover style undone, over the whole viewport, letting
 * every event through. The host is laid out as nothing.
 */
const MASK_STYLE = `
:host { all: initial !important; display: contents !important; }
div {
  all: initial; position: fixed; inset: 0; width: auto; height: auto; margin: 0; padding: 0; border: 0;
  overflow: visible; background: transparent; pointer-events: none; display: block;
}`;

interface Mask {
  doc: Document;
  host: HTMLElement;
  mask: HTMLElement;
  style: HTMLStyleElement;
  onEvent: (e: Event) => void;
  observer: MutationObserver;
  /** The shadow roots listened to: their toggle events do not reach the document. */
  roots: Set<ShadowRoot>;
  stop: () => void;
}

let current: Mask | null = null;

/** Whether the mask was raised during this frame, and whether to raise it again at the next. */
let raised = false;
let pending = false;

/**
 * Puts the mask back on top of the top layer (a dialog, popover or full-screen element the page
 * opened after it is above it otherwise), then our own popovers (the panel) above it again, so
 * that, as in Chrome, DevTools is not filtered. At most once a frame, so that a page opening a
 * popover whenever another toggles cannot loop with us.
 */
function raise() {
  const m = current;
  const { show, hide } = natives;
  if (!m || !show || !hide) return;
  if (raised) {
    pending = true;
    return;
  }
  raised = true;
  requestAnimationFrame(() => {
    raised = false;
    if (pending) {
      pending = false;
      raise();
    }
  });
  try {
    if (m.mask.matches(':popover-open')) Reflect.apply(hide, m.mask, []);
    Reflect.apply(show, m.mask, []);
  } catch {
    return;
  }
  for (const el of m.doc.querySelectorAll(`[${OWN_ATTRIBUTE}]`)) {
    if (!isOwn(el) || !el.shadowRoot || el === m.host) continue;
    for (const open of el.shadowRoot.querySelectorAll<HTMLElement>(':popover-open')) {
      Reflect.apply(hide, open, []);
      Reflect.apply(show, open, []);
    }
  }
}

function create(doc: Document): Mask {
  // The mask lives in a shadow root: its own toggle events do not leave it (they are not
  // composed), so the page does not see them.
  const host = doc.createElement('div');
  markOwn(host);
  host.setAttribute(OWN_ATTRIBUTE, 'vision');
  host.inert = true;
  host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  const css = doc.createElement('style');
  css.textContent = MASK_STYLE;
  const mask = doc.createElement('div');
  mask.popover = 'manual';
  root.append(css, style, mask);
  const onEvent = (e: Event) => {
    if (e.type === 'toggle' && (e as ToggleEvent).newState !== 'open') return;
    if (e.target instanceof Node && closestOwn(e.target)) return;
    raise();
  };
  // Dialogs opened by the page with show() or showModal() before toggle events fired for them.
  const observer = new natives.MO(records => {
    if (records.some(r => r.target instanceof HTMLDialogElement && r.target.open)) raise();
  });
  return { doc, host, mask, style, onEvent, observer, roots: new Set(), stop: () => {} };
}

/** Listens to the shadow roots of `m`'s document not listened to yet. */
function listenToRoots(m: Mask) {
  for (const root of shadowRoots?.roots() ?? []) {
    if (m.roots.has(root) || root.host.ownerDocument !== m.doc || closestOwn(root.host)) continue;
    m.roots.add(root);
    on(root, m.onEvent);
  }
}

/** Filters the top document with `type`'s filter, or stops ('none' or an unknown type). */
export function setVision(type: string): void {
  const filter = VISION[type];
  if (!filter) {
    if (!current) return;
    const m = current;
    current = null;
    off(m.doc, m.onEvent);
    for (const root of m.roots) off(root, m.onEvent);
    m.stop();
    m.observer.disconnect();
    m.host.remove();
    return;
  }
  const doc = frames.top.document;
  if (current && current.doc !== doc) setVision('none');
  if (!current) {
    const m = (current = create(doc));
    on(doc, m.onEvent);
    m.observer.observe(doc, { subtree: true, attributeFilter: ['open'] });
    if (shadowRoots) {
      const release = shadowRoots.acquire();
      const unsubscribe = shadowRoots.onStale(() => current === m && listenToRoots(m));
      m.stop = () => {
        unsubscribe();
        release();
      };
      listenToRoots(m);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f">${filter}</filter></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}#f")`;
  current.style.textContent = `div { backdrop-filter: ${url}; -webkit-backdrop-filter: ${url}; }`;
  if (!current.host.isConnected) doc.documentElement.append(current.host);
  raise();
}
