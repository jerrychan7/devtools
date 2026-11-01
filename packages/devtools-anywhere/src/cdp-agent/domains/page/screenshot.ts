import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';
import { encode, type Render } from './render';

/**
 * The most pixels a screenshot has: Safari's limit on a canvas's area (4096 × 4096). A larger
 * screenshot, of a long page in full, is scaled down to it.
 */
const MAX_PIXELS = 4096 * 4096;

/**
 * Page.captureScreenshot's response, with `approximate`: the image is the page's DOM redrawn
 * by snapDOM, not the pixels Chrome painted (README, "Limitations").
 */
export type CaptureScreenshotResponse = Protocol.Page.CaptureScreenshotResponse & { approximate: true };

/**
 * Page.captureScreenshot, as Chrome does it: `clip` is in page coordinates whether or not
 * `captureBeyondViewport` is set, and the image has device pixels, the CSS size times
 * devicePixelRatio times `clip.scale`. Without a clip it is the viewport, or with
 * `captureBeyondViewport` the whole page.
 */
export function registerScreenshot({ session }: Context, render: Render | undefined) {
  session.register('Page', {
    async captureScreenshot(params: Protocol.Page.CaptureScreenshotRequest): Promise<CaptureScreenshotResponse> {
      if (!render) throw new CdpError('Screenshots are not available: snapDOM is not configured');
      const root = document.documentElement;
      const { clip } = params;
      const area = clip
        ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height }
        : params.captureBeyondViewport
          ? { x: 0, y: 0, width: root.scrollWidth, height: root.scrollHeight }
          : null;
      const width = area?.width ?? innerWidth;
      const height = area?.height ?? innerHeight;
      if (!(width > 0 && height > 0)) throw new CdpError('Cannot take screenshot with 0 width or height');
      const dpr = devicePixelRatio;
      const scale = Math.min(clip?.scale ?? 1, Math.sqrt(MAX_PIXELS / (width * height)) / dpr);
      const canvas = await render(area ?? 'viewport', scale, dpr);
      return { data: encode(canvas, params.format ?? 'png', params.quality), approximate: true };
    },
  });
}
