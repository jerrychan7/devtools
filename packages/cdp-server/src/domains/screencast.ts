import type { Protocol } from 'devtools-protocol';
import type { Context } from '../core/context';
import { isOwn } from '../core/nodes';
import { CdpError } from '../core/server';

/** The part of snapDOM (`@zumer/snapdom`) the screencast uses. */
export type Snapdom = (
  element: Element,
  options: {
    clip: 'viewport';
    exclude: ((el: Element) => boolean)[];
    excludeMode: 'hide';
    backgroundColor: string;
  }
) => Promise<{ toCanvas(options: { scale: number; dpr: number }): Promise<HTMLCanvasElement> }>;

/** Loads snapDOM on demand: it is large, and only the screencast needs it. @internal */
export type SnapdomLoader = () => Promise<{ snapdom: Snapdom }>;

/** The color the browser paints behind the page: the root's or body's background, or white. */
function background() {
  for (const el of [document.documentElement, document.body]) {
    const color = el && getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '#fff';
}

/** Shortest time between two frames, in milliseconds. */
const MIN_INTERVAL = 500;

/**
 * Page.startScreencast: renders the viewport with snapDOM, the page's DOM redrawn as an
 * image, since page scripts cannot read the pixels on screen. A frame is sent once the
 * previous one is acknowledged and at most every MIN_INTERVAL ms, or every two rendering
 * times when rendering is slower; nothing is rendered while the page is hidden.
 * DevTools' own elements are left out.
 */
export function registerScreencast({ server }: Context, loadSnapdom: SnapdomLoader | undefined) {
  if (!loadSnapdom) {
    server.register('Page', {
      startScreencast() {
        throw new CdpError('Screencast is not available: snapDOM is not configured');
      },
      stopScreencast: () => {},
    });
    return;
  }
  const load = loadSnapdom;
  let session = 0;
  let params: Protocol.Page.StartScreencastRequest | null = null;
  let acked = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapdom: Promise<Snapdom> | null = null;

  async function frame(current: number) {
    // A failed load is not kept, so that the retry loads snapDOM again.
    const capture = await (snapdom ??= load().then(
      m => m.snapdom,
      (e: unknown) => {
        snapdom = null;
        throw e;
      }
    ));
    const start = performance.now();
    const width = innerWidth;
    const height = innerHeight;
    const scale = Math.min(1, (params?.maxWidth ?? width) / width, (params?.maxHeight ?? height) / height);
    const result = await capture(document.documentElement, {
      clip: 'viewport',
      exclude: [isOwn],
      excludeMode: 'hide',
      backgroundColor: background(),
    });
    const canvas = await result.toCanvas({ scale, dpr: 1 });
    const png = params?.format === 'png';
    const url = canvas.toDataURL(png ? 'image/png' : 'image/jpeg', (params?.quality ?? 80) / 100);
    if (current !== session) return;
    acked = false;
    server.emit('Page.screencastFrame', {
      data: url.slice(url.indexOf(',') + 1),
      sessionId: current,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: width,
        deviceHeight: height,
        scrollOffsetX: scrollX,
        scrollOffsetY: scrollY,
        timestamp: Date.now() / 1000,
      },
    } satisfies Protocol.Page.ScreencastFrameEvent);
    schedule(current, Math.max(MIN_INTERVAL, 2 * (performance.now() - start)));
  }

  function schedule(current: number, delay: number) {
    clearTimeout(timer);
    timer = setTimeout(function tick() {
      if (current !== session) return;
      // Wait for the acknowledgement and for the page to be visible.
      if (!acked || document.hidden) {
        timer = setTimeout(tick, 100);
        return;
      }
      // A failed frame is retried later. Not logged: the page's console is the one inspected.
      frame(current).catch(() => {
        if (current === session) schedule(current, MIN_INTERVAL * 4);
      });
    }, delay);
  }

  function stop() {
    session++;
    params = null;
    clearTimeout(timer);
  }

  server.register('Page', {
    startScreencast(request: Protocol.Page.StartScreencastRequest) {
      stop();
      params = request;
      acked = true;
      schedule(session, 0);
    },
    stopScreencast: () => stop(),
    screencastFrameAck(request: Protocol.Page.ScreencastFrameAckRequest) {
      if (request.sessionId === session) acked = true;
    },
  });
}
