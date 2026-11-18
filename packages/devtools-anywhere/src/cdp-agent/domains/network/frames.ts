// Requests of same-origin iframes: the probe hooks each iframe document's network APIs like the
// top page's, and tags their requests with the frame and document that made them.
import type { Frame, FrameRegistry } from '../../core/frames/frames';
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
 * The `<iframe>` or `<frame>` in `doc` (or a same-origin frame within it) that loads `url` into a
 * document the page cannot reach: a sandbox without allow-same-origin makes it opaque. The probe
 * never hooks such a frame, so its document request is only seen in its parent's Resource Timing.
 */
function opaqueOwner(doc: Document, url: string): Element | undefined {
  for (const el of doc.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>('iframe,frame')) {
    const inner = el.contentDocument;
    const found = inner ? opaqueOwner(inner, url) : el.src === url ? el : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * How the record stands as the document of a same-origin child frame (iframe, `<object>`,
 * `<embed>`), as its parent's Resource Timing reports it. One search of the page's frames.
 * - `opaque`: the owner of the opaque (sandboxed) frame whose document it is. Chrome attributes
 *   that request to the frame; it has no navigation entry of its own.
 * - `frameDocument`: the document of a frame that is not opaque. The frame's own Resource Timing
 *   reports it too, as its navigation, which Chrome attributes to the frame's own loader: that one
 *   is kept, this one dropped.
 */
// The top page's document and location are meant: opaqueOwner searches every frame from the top.
export function childDocumentOf(rec: RequestRecord): { frameDocument: boolean; opaque: Element | undefined } {
  if (!isChildDocument(rec)) return { frameDocument: false, opaque: undefined };
  const url = new URL(rec.url, location.href);
  if (url.origin !== location.origin) return { frameDocument: false, opaque: undefined };
  const opaque = opaqueOwner(document, url.href);
  return { frameDocument: !opaque, opaque };
}
