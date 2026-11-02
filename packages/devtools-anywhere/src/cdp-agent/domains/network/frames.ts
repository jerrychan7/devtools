// Requests of same-origin iframes: the probe hooks each iframe document's network APIs like the
// top page's, and tags their requests with the frame and document that made them.
import type { Context } from '../../core/context';
import type { Frame, FrameRegistry } from '../../core/frames';
import type { FrameTag, RequestRecord } from '../../probe/types';

/**
 * The frame of a request when it starts. Scripts of a document an iframe has just loaded run
 * before the registry hears of it (on load): the registry is brought up to date first, so that
 * the request gets the new document's loader, as in Chrome.
 */
function tagOf(frames: FrameRegistry, frame: Frame, win: Window): FrameTag {
  if (frame.document !== win.document) frames.sync();
  return { frameId: frame.id, loaderId: frame.loaderId, documentURL: win.document.URL };
}

/**
 * Hooks the network APIs of every same-origin iframe document, those there now and those to
 * come; returns a function that stops following the frames (the hooks stay, like the top
 * page's). Nothing with a probe from before 0.3.0, which cannot hook other windows.
 */
export function hookFrames({ probe, frames }: Context): () => void {
  const hook = probe.hookNetwork;
  if (!hook) return () => {};
  const install = (frame: Frame) => {
    const win = frame.document.defaultView;
    if (frame.owner && win) hook(win, () => tagOf(frames, frame, win));
  };
  // Each new document of a frame has a new global object, without the hooks.
  const stop = frames.onChange(change => {
    if (change.type !== 'detached') install(change.frame);
  });
  for (const frame of frames) install(frame);
  return stop;
}

/**
 * Whether the record is a same-origin iframe's document as its parent's Resource Timing reports
 * it. The iframe's own Resource Timing reports it too, as its navigation, which Chrome attributes
 * to the iframe's frame and new loader: that one is kept. Not when the probe cannot hook iframes.
 */
export function isFrameDocument(probe: Context['probe'], rec: RequestRecord): boolean {
  return (
    !!probe.hookNetwork &&
    (rec.initiatorType === 'iframe' || rec.initiatorType === 'frame') &&
    new URL(rec.url, location.href).origin === location.origin
  );
}
