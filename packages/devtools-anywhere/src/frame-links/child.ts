// The iframe's side of the handshake (protocol.ts): links this page's agent to its parent's, when
// the parent's origin is one data-parent-origins names.
import { type CdpSession, type ParentLink, childTargets, frames } from '../cdp-agent';
import { endSession } from '../connection';
import { type OriginPattern, matchOrigin } from './origins';
import { openPort } from './port';
import { FRAME_HELLO, FRAME_PING, type FrameWelcome, isMessage, postToTrusted, readWelcome } from './protocol';

/** A new id for this page's hellos. */
const newId = () => Math.random().toString(36).slice(2);

/**
 * Says hello to the parent window if its origin may be one of `patterns`, and again when pinged,
 * until welcomed from one of them. The link's CDP messages go to a session of this page's agent,
 * made by `createSession` and reset when the link closes; the parent's agent speaks for it.
 * Returns a function that stops and closes the link.
 */
export function linkParent(patterns: readonly OriginPattern[], createSession: () => CdpSession): () => void {
  if (window.parent === window) return () => {};
  let id = newId();
  let link: ParentLink | undefined;
  let session: CdpSession | undefined;

  const hello = () => {
    if (!link) postToTrusted(window.parent, { type: FRAME_HELLO, id }, patterns);
  };

  const connect = (port: MessagePort, { frameId, parentFrameId, parentTargetId }: FrameWelcome) => {
    const end = openPort(port);
    const linked: ParentLink = {
      frameId,
      parentFrameId,
      parentTargetId,
      send: end.send,
      onMessage: end.onMessage,
      onEndSession: end.onEndSession,
      onClose: end.onClose,
      close: end.close,
    };
    link = linked;
    // The page's frames are the iframe target's from now on: its top frame has the parent's id
    // for it, before the agent reports anything over the link.
    frames.link({ frameId, parentFrameId });
    const own = (session ??= createSession());
    /** The end of the parent's client's last session: the next one's messages wait for it. */
    let ended = Promise.resolve();
    const offSession = own.onMessage(message => linked.send(message));
    linked.onMessage(message => {
      void ended.then(() =>
        own.dispatch(message).catch(() => {
          // Malformed message: there is no id to answer to.
        })
      );
    });
    // Like a new Chrome session for the next client: the domains disabled, ids forgotten.
    linked.onEndSession(() => {
      ended = ended.then(() => endSession(own)).then(() => own.reset());
    });
    linked.onClose(() => {
      offSession();
      if (link === linked) {
        link = undefined;
        frames.link(undefined);
      }
      // Nothing the parent's DevTools asked for outlives the link, as on a frontend's disconnect.
      void ended.then(() => endSession(own)).then(() => own.reset());
    });
    childTargets.setParent(linked);
  };

  const onMessage = (event: MessageEvent) => {
    if (!event.isTrusted || event.source !== window.parent || !matchOrigin(patterns, event.origin)) return;
    if (isMessage(event.data, FRAME_PING)) return hello();
    const welcome = readWelcome(event.data);
    const port = event.ports[0];
    // Only the welcome for this document's hello, once.
    if (!welcome || welcome.id !== id || !port || link) return;
    connect(port, welcome);
  };

  // Leaving, the page ends its link: a port has no close event. Back from the back/forward cache,
  // it is another document to the parent, which links it again.
  const onPagehide = () => link?.close();
  const onPageshow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    id = newId();
    hello();
  };
  addEventListener('message', onMessage);
  addEventListener('pagehide', onPagehide);
  addEventListener('pageshow', onPageshow);
  hello();
  return () => {
    removeEventListener('message', onMessage);
    removeEventListener('pagehide', onPagehide);
    removeEventListener('pageshow', onPageshow);
    link?.close();
  };
}
