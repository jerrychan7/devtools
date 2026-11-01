import { isOwn } from '../../core/nodes';

/** A rectangle in page (document) coordinates, CSS pixels. */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of snapDOM (`@zumer/snapdom`) the screencast and screenshots use. */
export type Snapdom = (
  element: Element,
  options: {
    clip: 'viewport' | PageRect;
    exclude: ((el: Element) => boolean)[];
    excludeMode: 'hide';
    backgroundColor: string;
  }
) => Promise<{ toCanvas(options: { scale: number; dpr: number }): Promise<HTMLCanvasElement> }>;

/** Loads snapDOM on demand: it is large, and only the screencast and screenshots need it. @internal */
export type SnapdomLoader = () => Promise<{ snapdom: Snapdom }>;

/**
 * Renders the page's DOM as an image, since page scripts cannot read the pixels on screen:
 * the viewport or a region of the page. DevTools' own elements are left out.
 */
export type Render = (clip: 'viewport' | PageRect, scale: number, dpr: number) => Promise<HTMLCanvasElement>;

/** The color the browser paints behind the page: the root's or body's background, or white. */
function background() {
  for (const el of [document.documentElement, document.body]) {
    const color = el && getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '#fff';
}

/**
 * A failure before drawing: loading snapDOM or reading the page. Drawing at a smaller size would
 * not help, unlike a failure to draw.
 */
export class CaptureError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** A Render on snapDOM, loaded on first use. */
export function createRender(load: SnapdomLoader): Render {
  let snapdom: Promise<Snapdom> | null = null;
  return async (clip, scale, dpr) => {
    let result;
    try {
      // A failed load is not kept, so that the next render loads snapDOM again.
      const capture = await (snapdom ??= load().then(
        m => m.snapdom,
        (e: unknown) => {
          snapdom = null;
          throw e;
        }
      ));
      result = await capture(document.documentElement, {
        clip,
        exclude: [isOwn],
        excludeMode: 'hide',
        backgroundColor: background(),
      });
    } catch (e) {
      throw new CaptureError(e);
    }
    return result.toCanvas({ scale, dpr });
  };
}

/** The canvas as base64 image data, in a CDP image format (`quality` from 0 to 100). */
export function encode(canvas: HTMLCanvasElement, format: 'png' | 'jpeg' | 'webp', quality: number | undefined) {
  const url = canvas.toDataURL(`image/${format}`, (quality ?? 80) / 100);
  return url.slice(url.indexOf(',') + 1);
}
