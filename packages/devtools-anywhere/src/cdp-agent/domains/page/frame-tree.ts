import type { Protocol } from 'devtools-protocol';
import { type Frame, type FrameChange, type FrameRegistry, awaitsFirstDocument } from '../../core/frames';
import type { CdpSession } from '../../core/session';

const LOCALHOST = /^(.+\.)?localhost$|^127(\.\d+){3}$|^\[::1\]$/;

/** The hostname of a serialized origin, empty for an opaque one ("null"). */
function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * A frame as Chrome describes it. Like Chrome, the URL is given without its fragment, an
 * `about:` document (`about:blank`, `about:srcdoc`) has the security origin `://` while its
 * execution context has the origin it inherited, and a child frame is named by its window's
 * name, else its `<iframe>`'s id.
 */
export function describeFrame(frame: Frame): Protocol.Page.Frame {
  const win = frame.window;
  const href = frame.document.URL;
  const hash = href.indexOf('#');
  const url = hash < 0 ? href : href.slice(0, hash);
  return {
    id: frame.id,
    ...(frame.parent ? { parentId: frame.parent.id } : {}),
    loaderId: frame.loaderId,
    ...(frame.owner ? { name: win.name || frame.owner.id } : {}),
    url,
    ...(hash < 0 || hash === href.length - 1 ? {} : { urlFragment: href.slice(hash) }),
    domainAndRegistry: '',
    securityOrigin: url.startsWith('about:') ? '://' : win.origin,
    mimeType: frame.document.contentType,
    secureContextType: !win.isSecureContext
      ? 'InsecureScheme'
      : LOCALHOST.test(hostnameOf(win.origin))
        ? 'SecureLocalhost'
        : 'Secure',
    crossOriginIsolatedContextType: win.crossOriginIsolated ? 'Isolated' : 'NotIsolated',
    gatedAPIFeatures: [],
  };
}

/** The frame tree under `frame`, the children in document order of their `<iframe>`s. */
export function frameTree(frames: FrameRegistry, frame: Frame): Protocol.Page.FrameTree {
  const children = frames.childrenOf(frame);
  return {
    frame: describeFrame(frame),
    ...(children.length ? { childFrames: children.map(child => frameTree(frames, child)) } : {}),
  };
}

/**
 * Sends the Page events of frames attached, navigated and detached, in Chrome's order:
 * frameAttached, then frameStartedLoading, frameNavigated and frameStoppedLoading once the frame
 * shows a document; frameDetached for each frame removed, its descendants first. Chrome reports a
 * navigation as it commits, before the document runs; the registry notices it only on `load`, so
 * the three come together. Chrome's experimental frameRequestedNavigation, frameStartedNavigating
 * and frameSubtreeWillBeDetached are not sent: their loader id and timing are not known here.
 */
export function frameEvents(session: CdpSession, frames: FrameRegistry): (change: FrameChange) => void {
  /** Frames that started loading their first document, reported when attached. */
  const loading = new WeakSet<Frame>();
  const navigated = (frame: Frame) => {
    session.emit('Page.frameNavigated', {
      frame: describeFrame(frame),
      type: 'Navigation',
    } satisfies Protocol.Page.FrameNavigatedEvent);
  };
  return ({ type, frame }) => {
    const frameId = frame.id;
    if (type === 'attached') {
      session.emit('Page.frameAttached', {
        frameId,
        parentFrameId: frame.parent?.id ?? frames.top.id,
      } satisfies Protocol.Page.FrameAttachedEvent);
      if (awaitsFirstDocument(frame)) {
        loading.add(frame);
        session.emit('Page.frameStartedLoading', { frameId });
        return;
      }
      // An empty iframe: Chrome navigates it to about:blank before it starts loading.
      navigated(frame);
      session.emit('Page.frameStartedLoading', { frameId });
      session.emit('Page.frameStoppedLoading', { frameId });
    } else if (type === 'navigated') {
      if (!loading.has(frame)) session.emit('Page.frameStartedLoading', { frameId });
      loading.delete(frame);
      navigated(frame);
      session.emit('Page.frameStoppedLoading', { frameId });
    } else {
      session.emit('Page.frameDetached', { frameId, reason: 'remove' } satisfies Protocol.Page.FrameDetachedEvent);
    }
  };
}
