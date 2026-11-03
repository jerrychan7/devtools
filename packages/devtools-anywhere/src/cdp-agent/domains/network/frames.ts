// Requests of same-origin iframes: the probe hooks each iframe document's network APIs like the
// top page's, and tags their requests with the frame and document that made them.
import type { Frame, FrameRegistry } from '../../core/frames';
import type { FrameTag, Probe, RequestRecord } from '../../probe/types';

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
 * Hooks the network APIs of a same-origin iframe's document, tagging its requests with the frame
 * and document that made them. Called for each document a frame loads (each has its own globals);
 * the hooks stay, like the top page's.
 */
export function hookFrameNetwork(probe: Pick<Probe, 'hookNetwork'>, frames: FrameRegistry, frame: Frame): void {
  const win = frame.document.defaultView;
  if (frame.owner && win) probe.hookNetwork(win, () => tagOf(frames, frame, win));
}

/**
 * Whether the record is the document of a frame owner (`<iframe>`, `<frame>`, `<object>`,
 * `<embed>`) as the Resource Timing of the document embedding it reports it.
 */
export function isChildDocument(rec: Pick<RequestRecord, 'initiatorType' | 'type'>): boolean {
  return (
    rec.initiatorType === 'iframe' ||
    rec.initiatorType === 'frame' ||
    // Not when they show an image or the like: then it is a request of the page, as in Chrome.
    ((rec.initiatorType === 'object' || rec.initiatorType === 'embed') && rec.type === 'Document')
  );
}

/**
 * Whether the record is the document of a same-origin iframe (or `<object>`, `<embed>`) as its
 * parent's Resource Timing reports it. The iframe's own Resource Timing reports it too, as its
 * navigation, which Chrome attributes to the iframe's frame and new loader: that one is kept.
 */
export function isFrameDocument(rec: RequestRecord): boolean {
  return isChildDocument(rec) && new URL(rec.url, location.href).origin === location.origin;
}
