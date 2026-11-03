// The parent's side of the handshake (protocol.ts): links the cross-origin iframes whose origin
// data-frame-origins names, as child targets of this page's agent.
import { type ChildLink, childTargets, frameOwners, frames, ownerOfWindow, watchOwner } from '../cdp-agent';
import { type OriginPattern, matchOrigin } from './origins';
import { type PortEnd, openPort } from './port';
import { FRAME_PING, FRAME_WELCOME, type FrameWelcome, postToTrusted, readHello } from './protocol';

/** A linked iframe: its link's port, and the hello's id it answered. */
interface Linked {
  id: string;
  end: PortEnd;
}

/**
 * Answers the hellos of iframes of `patterns`' origins with a link, and pings the iframes there
 * already, which may have said hello before this page listened. Returns a function that stops
 * listening and closes the links.
 */
export function linkChildren(patterns: readonly OriginPattern[]): () => void {
  const linked = new Map<Element, Linked>();
  /** The elements of the targets there are, watched for removal, with what stops watching. */
  const watched = new Map<Element, () => void>();
  const offGone = childTargets.onGone(({ owner }) => {
    watched.get(owner)?.();
    watched.delete(owner);
  });

  const onMessage = (event: MessageEvent) => {
    const hello = event.isTrusted ? readHello(event.data) : null;
    if (!hello || !matchOrigin(patterns, event.origin)) return;
    // Only one of this page's frames, in its document, a shadow tree or a same-origin frame.
    const found = ownerOfWindow(event.source);
    if (!found) return;
    const { owner, frame, window: target } = found;
    const known = linked.get(owner);
    // A hello again (pinged meanwhile) from the document linked already.
    if (known?.id === hello.id && !known.end.closed) return;
    // Another document in the iframe, whose bye was lost.
    known?.end.close();

    const channel = new MessageChannel();
    const frameId = childTargets.frameIdOf(owner);
    const welcome: FrameWelcome = {
      type: FRAME_WELCOME,
      id: hello.id,
      frameId,
      parentFrameId: frame.id,
      parentTargetId: frames.top.id,
    };
    // To the origin the hello came from, which the list has: the port goes nowhere else.
    target?.postMessage(welcome, event.origin, [channel.port2]);
    const end = openPort(channel.port1);
    const link: ChildLink = {
      owner,
      frameId,
      send: end.send,
      onMessage: end.onMessage,
      openSession: end.openSession,
      onClose: end.onClose,
      close: end.close,
    };
    linked.set(owner, { id: hello.id, end });
    // The iframe's page says bye when it goes, but not when its element does, which is watched
    // till its target ends, between two documents too; removed or moved, the element's next
    // frame is a new one.
    if (!watched.has(owner)) {
      const unwatch = watchOwner(owner, () => {
        watched.delete(owner);
        linked.get(owner)?.end.close();
        childTargets.end(owner);
        childTargets.forget(owner);
      });
      watched.set(owner, unwatch);
    }
    end.onClose(() => {
      if (linked.get(owner)?.end === end) linked.delete(owner);
    });
    childTargets.addChild(link);
  };

  const ping = () => {
    for (const { window: target } of frameOwners()) if (target) postToTrusted(target, { type: FRAME_PING }, patterns);
  };

  // Their targets end with them: this page leaves, or the iframes link again at once.
  const closeAll = () => {
    for (const [owner, { end }] of linked) {
      end.close();
      childTargets.end(owner);
    }
  };
  // Leaving, this page ends its links; back from the back/forward cache, its iframes link again.
  const onPageshow = (event: PageTransitionEvent) => event.persisted && ping();
  // Linked to its own parent, this page's top frame takes another id (FrameRegistry.link): its
  // iframes link again, for their welcome to carry it.
  const offParent = childTargets.onParent(() => {
    closeAll();
    ping();
  });
  addEventListener('message', onMessage);
  addEventListener('pagehide', closeAll);
  addEventListener('pageshow', onPageshow);
  ping();
  return () => {
    removeEventListener('message', onMessage);
    removeEventListener('pagehide', closeAll);
    removeEventListener('pageshow', onPageshow);
    offParent();
    closeAll();
    // And those kept for their iframe's next document, which no link can carry on now.
    for (const owner of watched.keys()) childTargets.end(owner);
    offGone();
  };
}
