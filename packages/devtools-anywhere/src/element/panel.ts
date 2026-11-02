// The panel's size and place, the user's: docked, its size along the page; undocked, its
// position and size, dragged by the bar and the corner. Remembered in localStorage as percentages
// of the viewport, so they fit any screen and orientation.
import { Grip } from '../grip';
import { finite } from './request';
import type { DockSide } from '../embedder';

const HEIGHT_KEY = 'devtools-anywhere:height%';
const WIDTH_KEY = 'devtools-anywhere:width%';
const FLOAT_KEY = 'devtools-anywhere:float%';
/** Viewport units that follow the browser's collapsing toolbars on mobile, where supported. */
const VH = typeof CSS !== 'undefined' && CSS.supports('height', '1dvh') ? 'dvh' : 'vh';
const VW = typeof CSS !== 'undefined' && CSS.supports('width', '1dvw') ? 'dvw' : 'vw';
/** `part` as a percentage of `whole`, to one decimal. */
const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;
export const DOCK_KEY = 'devtools-anywhere:dock';
const MIN_SIZE = 80;
/** The panel's inner edge, next to the page, for each docked side. */
export const GRIP_EDGE = { bottom: 'top', right: 'left', left: 'right' } as const;

/**
 * localStorage, which throws when it is unavailable: Android WebViews without DOM storage,
 * Safari blocking all cookies, sandboxed iframes. Sizes and dock side are only preferences.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** Position and size of the undocked panel, in percent of the viewport. */
interface FloatRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Sizes the panel for its dock side, from what is remembered. */
export function sizePanel(panel: HTMLElement, dock: DockSide) {
  const style = panel.style;
  style.width = style.height = style.left = style.top = '';
  if (dock === 'bottom') {
    const stored = Number(readStored(HEIGHT_KEY));
    style.height = stored ? `${stored}${VH}` : `50${VH}`;
  } else if (dock === 'undocked') {
    const rect = floatRect();
    style.left = `${rect.left}${VW}`;
    style.top = `${rect.top}${VH}`;
    style.width = `${rect.width}${VW}`;
    style.height = `${rect.height}${VH}`;
  } else {
    const stored = Number(readStored(WIDTH_KEY));
    style.width = stored ? `${stored}${VW}` : `50${VW}`;
  }
}

/** The undocked panel's last position and size, kept inside the viewport. */
function floatRect(): FloatRect {
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

/** Remembers the undocked panel's position and size. */
export function saveFloat(panel: HTMLElement) {
  const { left, top, width, height } = panel.getBoundingClientRect();
  const rect: FloatRect = {
    left: percent(left, innerWidth),
    top: percent(top, innerHeight),
    width: percent(width, innerWidth),
    height: percent(height, innerHeight),
  };
  store(FLOAT_KEY, JSON.stringify(rect));
}

/**
 * Dragging the bar moves the undocked panel; `relayout` then goes from the pixels of the drag to
 * the remembered percentages.
 */
export function setupMover(bar: HTMLElement, panel: HTMLElement, relayout: () => void) {
  bar.addEventListener('pointerdown', down => {
    if ((down.target as HTMLElement).closest('button')) return;
    down.preventDefault();
    bar.setPointerCapture(down.pointerId);
    panel.classList.add('dragging');
    const start = panel.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const left = start.left + e.clientX - down.clientX;
      const top = start.top + e.clientY - down.clientY;
      // The whole window stays in the viewport, so its resize corner stays reachable; a
      // window larger than the viewport keeps its top left corner in view.
      panel.style.left = `${Math.max(Math.min(left, innerWidth - start.width), 0)}px`;
      panel.style.top = `${Math.max(Math.min(top, innerHeight - start.height), 0)}px`;
    };
    const up = () => {
      panel.classList.remove('dragging');
      saveFloat(panel);
      relayout();
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}

/**
 * The grip on the docked panel's inner edge, on the page's side: dragging it resizes the panel.
 * `relayout` then goes from the pixels of the drag to the remembered percentages.
 */
export function createPanelGrip(panel: HTMLElement, dock: () => DockSide, relayout: () => void) {
  const clampSize = (size: number, max: number) => Math.min(Math.max(size, MIN_SIZE), max - 16);
  return new Grip({
    edge: 'top',
    side: 'outside',
    title: 'Drag to resize',
    onStart: () => panel.classList.add('dragging'),
    onMove: e => {
      const style = panel.style;
      const side = dock();
      if (side === 'bottom') style.height = `${clampSize(innerHeight - e.clientY, innerHeight)}px`;
      else if (side === 'right') style.width = `${clampSize(innerWidth - e.clientX, innerWidth)}px`;
      else if (side === 'left') style.width = `${clampSize(e.clientX, innerWidth)}px`;
    },
    onEnd: () => {
      panel.classList.remove('dragging');
      if (dock() === 'bottom') store(HEIGHT_KEY, String(percent(panel.offsetHeight, innerHeight)));
      else store(WIDTH_KEY, String(percent(panel.offsetWidth, innerWidth)));
      relayout();
    },
  });
}

/** Dragging the corner resizes the undocked panel, within the viewport. */
export function setupCorner(corner: HTMLElement, panel: HTMLElement, relayout: () => void) {
  corner.addEventListener('pointerdown', down => {
    down.preventDefault();
    corner.setPointerCapture(down.pointerId);
    panel.classList.add('dragging');
    const start = panel.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const width = start.width + e.clientX - down.clientX;
      const height = start.height + e.clientY - down.clientY;
      panel.style.width = `${Math.min(Math.max(width, MIN_SIZE), innerWidth - start.left)}px`;
      panel.style.height = `${Math.min(Math.max(height, MIN_SIZE), innerHeight - start.top)}px`;
    };
    const up = () => {
      panel.classList.remove('dragging');
      saveFloat(panel);
      relayout();
      corner.removeEventListener('pointermove', move);
      corner.removeEventListener('pointerup', up);
      corner.removeEventListener('pointercancel', up);
    };
    corner.addEventListener('pointermove', move);
    corner.addEventListener('pointerup', up);
    corner.addEventListener('pointercancel', up);
  });
}
