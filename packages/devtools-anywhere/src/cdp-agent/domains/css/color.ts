import { parentOf } from '../../core/container-query';
import { splitTopLevel } from '../../core/selectors';

/** Channels of a computed `rgb()` / `rgba()` color, or null for other notations. */
export function rgba(value: string): [number, number, number, number] | null {
  const match = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

export type RGBA = [number, number, number, number];
/** A color: its channels, or for one in another color space (`oklch()`, `color()`...) its text, which Chrome reports as is. */
export type Color = RGBA | string;

/** Computed colors: rgb() and the notations Chrome keeps for other color spaces. */
export const COLOR = /\b(?:rgba?|color|lab|lch|oklab|oklch)\([^()]*\)/g;

/** A computed color, or null for a translucent one outside sRGB, which we cannot blend. */
export function parseColor(value: string): Color | null {
  const channels = rgba(value);
  if (channels) return channels;
  const alpha = /\/\s*([\d.]+)(%?)\s*\)$/.exec(value);
  if (alpha && Number(alpha[1]) / (alpha[2] ? 100 : 1) < 1) return null;
  return value;
}

export const isOpaque = (c: Color) => typeof c === 'string' || c[3] >= 1;

/**
 * The colors of one element's background, topmost last: its color, then the stops of its
 * topmost gradient (like Chrome, the layers below it are not looked at). null when an image
 * makes the background unknown.
 */
export function backgroundLayers(style: CSSStyleDeclaration): Color[][] | null {
  const layers: Color[][] = [];
  const color = parseColor(style.backgroundColor);
  if (!color) return null;
  if (typeof color === 'string' || color[3] > 0) layers.push([color]);
  const image = style.backgroundImage;
  if (image !== 'none') {
    const top = splitTopLevel(image, ',')[0]?.trim() ?? '';
    if (!/^(?:repeating-)?(?:linear|radial|conic)-gradient\(.*\)$/.test(top)) return null;
    const stops: Color[] = [];
    for (const [stop] of top.matchAll(COLOR)) {
      const c = parseColor(stop);
      if (!c) return null;
      stops.push(c);
    }
    if (!stops.length) return null;
    layers.push(stops);
  }
  return layers;
}

/**
 * The colors text is drawn on, as Chrome reports them: translucent backgrounds are blended over
 * those of the ancestors (down to the white page), each stop of a gradient giving a color of its
 * own; null when an image makes them unknown.
 */
export function backgroundsBehind(el: Element, style: CSSStyleDeclaration): string[] | null {
  const layers: Color[][] = [];
  for (let node: Element | null = el, s = style; node;) {
    const own = backgroundLayers(s);
    if (!own) return null;
    layers.unshift(...own);
    // The topmost opaque layer hides what is below it.
    if (own.some(layer => layer.every(isOpaque))) break;
    node = parentOf(node);
    if (node) s = getComputedStyle(node);
  }
  let opaque = 0;
  layers.forEach((layer, i) => {
    if (layer.every(isOpaque)) opaque = i;
  });
  let colors: ([number, number, number] | string)[] = [[255, 255, 255]];
  for (const layer of layers.slice(opaque)) {
    const next: ([number, number, number] | string)[] = [];
    for (const below of colors)
      for (const c of layer) {
        if (typeof c === 'string' || c[3] >= 1) {
          next.push(typeof c === 'string' ? c : [c[0], c[1], c[2]]);
          continue;
        }
        // A translucent stop over a color outside sRGB: not blended, like an opaque one would hide it.
        if (typeof below === 'string') return null;
        const [lr, lg, lb, la] = c;
        const [r, g, b] = below;
        next.push([lr * la + r * (1 - la), lg * la + g * (1 - la), lb * la + b * (1 - la)]);
      }
    colors = next;
  }
  // Chrome truncates the blended channels. (It rounds them for a stop written in the modern
  // `rgb(0 0 0 / 0.5)` syntax, which the computed style does not tell from `rgba(0, 0, 0, 0.5)`.)
  const result = colors.map(c =>
    typeof c === 'string' ? c : `rgb(${Math.floor(c[0])}, ${Math.floor(c[1])}, ${Math.floor(c[2])})`
  );
  return Array.from(new Set(result));
}
