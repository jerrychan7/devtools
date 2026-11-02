import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';
import { encode, type Render } from './render';

/** Shortest time between two frames, in milliseconds. */
const MIN_INTERVAL = 500;

/**
 * Page.startScreencast: renders the viewport with snapDOM (render.ts). A frame is sent once the
 * previous one is acknowledged and at most every MIN_INTERVAL ms, or every two rendering
 * times when rendering is slower; nothing is rendered while the page is hidden.
 */
export function registerScreencast({ session: cdpSession }: Context, render: Render | undefined) {
  if (!render) {
    cdpSession.register('Page', {
      startScreencast() {
        throw new CdpError('Screencast is not available: snapDOM is not configured');
      },
      stopScreencast: () => {},
    });
    return;
  }
  const draw = render;
  let frameSession = 0;
  let params: Protocol.Page.StartScreencastRequest | null = null;
  let acked = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function frame(current: number) {
    const start = performance.now();
    const width = innerWidth;
    const height = innerHeight;
    const scale = Math.min(1, (params?.maxWidth ?? width) / width, (params?.maxHeight ?? height) / height);
    const canvas = await draw('viewport', scale, 1);
    const data = encode(canvas, params?.format === 'png' ? 'png' : 'jpeg', params?.quality);
    if (current !== frameSession) return;
    acked = false;
    cdpSession.emit('Page.screencastFrame', {
      data,
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
      if (current !== frameSession) return;
      // Wait for the acknowledgement and for the page to be visible.
      if (!acked || document.hidden) {
        timer = setTimeout(tick, 100);
        return;
      }
      // A failed frame is retried later. Not logged: the page's console is the one inspected.
      frame(current).catch(() => {
        if (current === frameSession) schedule(current, MIN_INTERVAL * 4);
      });
    }, delay);
  }

  function stop() {
    frameSession++;
    params = null;
    clearTimeout(timer);
  }

  cdpSession.register('Page', {
    startScreencast(request: Protocol.Page.StartScreencastRequest) {
      stop();
      params = request;
      acked = true;
      schedule(frameSession, 0);
    },
    stopScreencast: () => stop(),
    screencastFrameAck(request: Protocol.Page.ScreencastFrameAckRequest) {
      if (request.sessionId === frameSession) acked = true;
    },
  });
}
