import type { Protocol } from 'devtools-protocol';
import {
  type Frame,
  type FrameChange,
  type FrameRegistry,
  type OpaqueFrame,
  type OpaqueFrameChange,
  awaitsFirstDocument,
} from '../../core/frames';
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
 * name, else its `<iframe>`'s id. The top frame of a page linked to its parent (in a cross-origin
 * iframe) is described as the main frame of Chrome's iframe target: with the parent's frame as
 * `parentId`, and an empty `name` (the parent's view has the iframe's name).
 */
export function describeFrame(frames: FrameRegistry, frame: Frame | OpaqueFrame): Protocol.Page.Frame {
  if (!('document' in frame)) return describeOpaqueFrame(frame);
  const win = frame.window;
  const linked = frame === frames.top ? frames.parent : undefined;
  const href = frame.document.URL;
  const hash = href.indexOf('#');
  const url = hash < 0 ? href : href.slice(0, hash);
  return {
    id: frame.id,
    ...(frame.parent ? { parentId: frame.parent.id } : linked ? { parentId: linked.parentFrameId } : {}),
    loaderId: frame.loaderId,
    ...(frame.owner ? { name: win.name || frame.owner.id } : linked ? { name: '' } : {}),
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

/**
 * A sandboxed iframe's opaque frame as Chrome describes it: the security origin of its URL (not
 * the opaque one), a secure context and NotIsolatedFeatureDisabled. Its document is out of reach:
 * the URL is the iframe's, the name the iframe's `name` (else its id), the MIME type text/html.
 */
function describeOpaqueFrame(frame: OpaqueFrame): Protocol.Page.Frame {
  const { url: href, owner } = frame;
  const hash = href.indexOf('#');
  const url = hash < 0 ? href : href.slice(0, hash);
  const parent = frame.parent.window;
  return {
    id: frame.id,
    parentId: frame.parent.id,
    loaderId: frame.loaderId,
    name: owner.getAttribute('name') || owner.id,
    url,
    ...(hash < 0 || hash === href.length - 1 ? {} : { urlFragment: href.slice(hash) }),
    domainAndRegistry: '',
    securityOrigin: url.startsWith('about:') ? '://' : new URL(url).origin,
    mimeType: 'text/html',
    secureContextType: parent.isSecureContext ? 'Secure' : 'InsecureScheme',
    crossOriginIsolatedContextType: 'NotIsolatedFeatureDisabled',
    gatedAPIFeatures: [],
  };
}

/** The frame tree under `frame`, the children in the order they were registered. */
export function frameTree(frames: FrameRegistry, frame: Frame | OpaqueFrame): Protocol.Page.FrameTree {
  const children = 'document' in frame ? frames.treeChildrenOf(frame) : [];
  return {
    frame: describeFrame(frames, frame),
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
export function frameEvents(
  session: CdpSession,
  frames: FrameRegistry
): (change: FrameChange | OpaqueFrameChange) => void {
  /** Frames that started loading their first document, reported when attached. */
  const loading = new WeakSet<Frame | OpaqueFrame>();
  const navigated = (frame: Frame | OpaqueFrame) => {
    session.emit('Page.frameNavigated', {
      frame: describeFrame(frames, frame),
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
      // An opaque frame's document is not known until its iframe's load.
      if (!('document' in frame) || awaitsFirstDocument(frame)) {
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
