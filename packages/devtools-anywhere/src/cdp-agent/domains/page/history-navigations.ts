import type { Protocol } from 'devtools-protocol';
import type { Frame, FrameRegistry } from '../../core/frames';
import { realmOf } from '../../core/realm';
import type { CdpSession } from '../../core/session';

type Navigation = Protocol.Page.NavigatedWithinDocumentEvent['navigationType'];
type HistoryMethod = 'pushState' | 'replaceState';

/**
 * Sends Page.navigatedWithinDocument for the same-document navigations of every frame, the top one
 * included, as Chrome does: `historyApi` for each history.pushState and replaceState call, even to
 * the same URL; `fragment` for the others, a fragment navigation (`location.hash`, a link to
 * `#…`) or a traversal (back, forward) within the document. The frame's URL in the frame tree is
 * its document's, so it follows. Returns a function that stops.
 *
 * The history methods are patched in each frame document's realm, as long as this runs; the
 * others are seen through popstate, and hashchange where no popstate came for the same URL.
 */
export function sameDocumentNavigations(session: CdpSession, frames: FrameRegistry): () => void {
  /** The URL each frame was last reported at, so that hashchange after popstate is not reported twice. */
  const reported = new WeakMap<Frame, string>();
  const report = (frame: Frame, navigationType: Navigation) => {
    const url = frame.document.URL;
    reported.set(frame, url);
    session.emit('Page.navigatedWithinDocument', {
      frameId: frame.id,
      url,
      navigationType,
    } satisfies Protocol.Page.NavigatedWithinDocumentEvent);
  };
  let on = true;

  /** Each realm's History prototype, with the methods it had and our wrappers of them. */
  const patched = new Map<
    History,
    Map<HistoryMethod, { native: History[HistoryMethod]; wrapper: History[HistoryMethod] }>
  >();
  const patch = (frame: Frame) => {
    const proto = realmOf(frame.document).History.prototype;
    if (patched.has(proto)) return;
    const methods = new Map<HistoryMethod, { native: History[HistoryMethod]; wrapper: History[HistoryMethod] }>();
    for (const name of ['pushState', 'replaceState'] as const) {
      const native = proto[name];
      const wrapper = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
        native.call(this, data, unused, url);
        const target = on ? Array.from(frames).find(f => f.window.history === this) : undefined;
        if (target) report(target, 'historyApi');
      };
      methods.set(name, { native, wrapper });
      proto[name] = wrapper;
    }
    patched.set(proto, methods);
  };

  /** The listeners added to each frame document's window. */
  const listening = new Map<Frame, { win: Window; onPopState: () => void; onHashChange: () => void }>();
  const listen = (frame: Frame) => {
    const win = frame.document.defaultView;
    if (!win || listening.get(frame)?.win === win) return;
    unlisten(frame);
    const onPopState = () => report(frame, 'fragment');
    const onHashChange = () => {
      if (reported.get(frame) !== frame.document.URL) report(frame, 'fragment');
    };
    win.addEventListener('popstate', onPopState);
    win.addEventListener('hashchange', onHashChange);
    listening.set(frame, { win, onPopState, onHashChange });
  };
  const unlisten = (frame: Frame) => {
    const entry = listening.get(frame);
    if (!entry) return;
    entry.win.removeEventListener('popstate', entry.onPopState);
    entry.win.removeEventListener('hashchange', entry.onHashChange);
    listening.delete(frame);
  };

  // Each document a frame loads has its own realm and window object.
  const follow = (frame: Frame) => {
    patch(frame);
    listen(frame);
    reported.set(frame, frame.document.URL);
  };
  const stopFrames = frames.onChange(({ type, frame }) => (type === 'detached' ? unlisten(frame) : follow(frame)));
  for (const frame of frames) follow(frame);

  return () => {
    on = false;
    stopFrames();
    for (const frame of Array.from(listening.keys())) unlisten(frame);
    // A wrapper installed on top of ours stays, and ours, silent, with it.
    for (const [proto, methods] of patched) {
      for (const [name, { native, wrapper }] of methods) if (proto[name] === wrapper) proto[name] = native;
      patched.delete(proto);
    }
  };
}
