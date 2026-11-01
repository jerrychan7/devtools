import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';
import { encode, type Render } from './render';

/**
 * A canvas area small enough for any browser, older iOS Safari's limit (4096 × 4096).
 * snapDOM already scales an image past the usual canvas limits down to fit (32767 pixels a
 * side, 16384 on Safari, 16384 × 16384 in area); should drawing still fail, the screenshot is
 * halved and tried again, and once it is no larger than this the failure is reported.
 */
const SAFE_PIXELS = 4096 * 4096;

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
      for (let scale = clip?.scale ?? 1; ; scale /= 2) {
        const safe = width * height * (scale * dpr) ** 2 <= SAFE_PIXELS;
        try {
          // A canvas too large to draw encodes as an empty data URL (Chrome) or throws.
          const data = encode(await render(area ?? 'viewport', scale, dpr), params.format ?? 'png', params.quality);
          if (data) return { data, approximate: true };
          if (safe) throw new CdpError('Unable to capture screenshot');
        } catch (e) {
          if (safe) throw e;
        }
      }
    },
  });
}
