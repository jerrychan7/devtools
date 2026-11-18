import type { Protocol } from 'devtools-protocol';
import type { ChildLink } from '../../core/frames/child-targets';
import type { FrameRegistry, OpaqueFrameChange } from '../../core/frames/frames';
import { mergedFrames } from '../../core/frames/merged-frames';
import type { CdpSession } from '../../core/session';

/**
 * The Page domain with sandboxed iframes merged into the page's agent (core/frames/merged-frames.ts).
 * Their frames stay the page's opaque ones (core/frames/frames.ts, OpaqueFrame): attached, navigated and
 * detached by the page's agent, which knows the iframe; the iframe's agent reports only what
 * happens within its document, Page.navigatedWithinDocument, as Chrome reports it for the frame
 * on the page's target. Chrome sends no lifecycleEvent, domContentEventFired or loadEventFired of
 * ours for any frame, so none of the iframe's either.
 */
mergedFrames.registerRoutes('Page', { fanOut: ['Page.enable', 'Page.disable'] });

/** How long, in ms, the page waits for a merged frame's agent to tell its URL. */
const URL_TIMEOUT = 1000;

/** The URL a merged frame's agent shows, as its own frame tree gives it; undefined if not told. */
async function hrefIn(session: CdpSession, ns: number): Promise<string | undefined> {
  try {
    const reply = await mergedFrames.forSession(session).ask(ns, 'Page.getFrameTree', {}, URL_TIMEOUT);
    const { frame } = (reply as Protocol.Page.GetFrameTreeResponse).frameTree;
    return frame.url + (frame.urlFragment ?? '');
  } catch {
    return undefined;
  }
}

/** The elements whose frames were merged: a frame's next document links again, after its load. */
const wasMerged = new WeakSet<Element>();
mergedFrames.onLinked((_ns, link) => wasMerged.add(link.owner));

/**
 * The link of the document a merged frame shows after `previous`'s: the current one if newer, else
 * the next one, if it comes within {@link URL_TIMEOUT} ms.
 */
function nextLink(
  owner: Element,
  previous: ChildLink | undefined
): Promise<{ link: ChildLink; ns: number } | undefined> {
  const now = mergedFrames.linkOf(owner);
  if (now && now.link !== previous) return Promise.resolve(now);
  return new Promise(resolve => {
    const done = (value: { link: ChildLink; ns: number } | undefined) => {
      stop();
      clearTimeout(timer);
      resolve(value);
    };
    const stop = mergedFrames.onLinked((ns, link) => {
      if (link.owner === owner) done({ link, ns });
    });
    const timer = setTimeout(() => done(undefined), URL_TIMEOUT);
  });
}

/**
 * Wraps the listener of opaque frame changes: a merged frame navigated is reported with the URL of
 * the document its agent shows (`location.href`, not the iframe's `src`, which a navigation within
 * it leaves), once told. The changes are passed on in order, till `stop` is called: those still
 * waiting for a URL then are dropped, as Chrome reports nothing once Page is disabled.
 */
export function withMergedUrls(
  session: CdpSession,
  listener: (change: OpaqueFrameChange) => void
): { onChange: (change: OpaqueFrameChange) => void; stop: () => void } {
  let queue = Promise.resolve();
  let stopped = false;
  /** The link each merged frame's URL was last told by: its document's, till it navigates. */
  const told = new WeakMap<Element, ChildLink>();
  // Those linked now show the documents the frames are reported at.
  for (const [, link] of mergedFrames.frames()) told.set(link.owner, link);
  const onChange = (change: OpaqueFrameChange) => {
    const { owner } = change.frame;
    const url = change.type === 'navigated' && wasMerged.has(owner) ? nextLink(owner, told.get(owner)) : undefined;
    queue = queue.then(async () => {
      const href = await url?.then(merged => {
        if (!merged) return undefined;
        told.set(owner, merged.link);
        return hrefIn(session, merged.ns);
      });
      if (stopped) return;
      if (href !== undefined) change.frame.url = href;
      listener(change);
    });
  };
  return {
    onChange,
    stop: () => {
      stopped = true;
    },
  };
}

/** Updates the URLs of the merged frames among `frames` to their documents', as their agents tell. */
export async function updateMergedUrls(session: CdpSession, frames: FrameRegistry): Promise<void> {
  await Promise.all(
    [...mergedFrames.frames()].map(async ([ns, link]) => {
      const frame = frames.opaqueOf(link.owner);
      const href = frame && (await hrefIn(session, ns));
      if (frame && href) frame.url = href;
    })
  );
}

/**
 * The resources of each merged frame's document, by frame id, as its agent lists its own frame's
 * (Chrome lists them under the frame, on the page's target); a frame whose agent does not answer
 * has none.
 */
export async function mergedResources(session: CdpSession): Promise<Map<string, Protocol.Page.FrameResource[]>> {
  const client = mergedFrames.forSession(session);
  const byFrame = new Map<string, Protocol.Page.FrameResource[]>();
  await Promise.all(
    [...mergedFrames.frames()].map(async ([ns, link]) => {
      try {
        const reply = await client.ask(ns, 'Page.getResourceTree', {}, URL_TIMEOUT);
        byFrame.set(link.frameId, (reply as Protocol.Page.GetResourceTreeResponse).frameTree.resources);
      } catch {
        // Gone, or not answering: none known.
      }
    })
  );
  return byFrame;
}
