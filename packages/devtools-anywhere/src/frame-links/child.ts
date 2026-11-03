// The iframe's side of the handshake (protocol.ts): links this page's agent to its parent's, when
// the parent's origin is one data-parent-origins names.
import { type CdpSession, type ParentLink, childTargets, frames, setIdNamespace } from '../cdp-agent';
import { endSession } from '../connection';
import { type OriginPattern, matchOrigin } from './origins';
import { type Channel, openPort } from './port';
import { FRAME_HELLO, FRAME_PING, type FrameWelcome, isMessage, postToTrusted, readWelcome } from './protocol';

/** A new id for this page's hellos. */
const newId = () => Math.random().toString(36).slice(2);

/**
 * Carries `session`'s messages over `channel` and the channel's to the session, each after
 * `before` (the end of the session's last use). Returns a function that stops sending the session's.
 */
function pipe(
  session: CdpSession,
  channel: Pick<Channel, 'send' | 'onMessage'>,
  before?: () => Promise<void>
): () => void {
  const dispatch = (message: string) =>
    session.dispatch(message).catch(() => {
      // Malformed message: there is no id to answer to.
    });
  channel.onMessage(message => void (before ? before().then(() => dispatch(message)) : dispatch(message)));
  return session.onMessage(message => channel.send(message));
}

/**
 * Says hello to the parent window if its origin may be one of `patterns`, and again when pinged,
 * until welcomed from one of them. The link's CDP messages go to a session of this page's agent,
 * made by `createSession` and reset when the link closes; the parent's agent speaks for it, and
 * opens one more for each of its clients that attaches this page's target.
 * Returns a function that stops and closes the link.
 */
export function linkParent(patterns: readonly OriginPattern[], createSession: () => CdpSession): () => void {
  if (window.parent === window) return () => {};
  let id = newId();
  let link: ParentLink | undefined;
  let session: CdpSession | undefined;
  /**
   * The end of the last link's use of that session: its domains disabled and ids forgotten. The
   * next link's messages wait for it, or what they enable would be undone, as connectFrontend's
   * next frontend waits for the last one's.
   */
  let ending: Promise<void> = Promise.resolve();
  /**
   * Clients' sessions that ended, reset, for the next client: a session's domains listen to the
   * page for good, so they are not made anew for each attach.
   */
  const idle: CdpSession[] = [];

  const hello = () => {
    if (!link) postToTrusted(window.parent, { type: FRAME_HELLO, id }, patterns);
  };

  const connect = (port: MessagePort, { frameId, parentFrameId, parentTargetId, mode, ns, loaderId }: FrameWelcome) => {
    const merged = mode === 'merge';
    // Merged into the parent's agent, this page's ids are in the namespace it gave, before any
    // session makes one for the link.
    if (merged) setIdNamespace(ns);
    const end = openPort(port);
    const linked: ParentLink = {
      frameId,
      parentFrameId,
      parentTargetId,
      send: end.send,
      onMessage: end.onMessage,
      onSession: end.onSession,
      onClose: end.onClose,
      close: end.close,
    };
    link = linked;
    // The page's frames are the iframe target's from now on: its top frame has the parent's id
    // for it, before the agent reports anything over the link.
    frames.link({ frameId, parentFrameId, ...(loaderId === undefined ? {} : { loaderId }) });
    // The parent agent's own commands, on a session kept across links.
    const own = (session ??= createSession());
    const offSession = pipe(own, linked, () => ending);
    // Each of the parent's clients that attaches this target gets a session of its own, as in
    // Chrome; it ends as on a frontend's disconnect, the domains disabled and ids forgotten.
    linked.onSession(channel => {
      const client = idle.pop() ?? createSession();
      const off = pipe(client, channel);
      channel.onClose(() => {
        off();
        void endSession(client)
          .then(() => client.reset())
          .then(() => idle.push(client));
      });
    });
    linked.onClose(() => {
      offSession();
      if (link === linked) {
        link = undefined;
        frames.link(undefined);
      }
      // Nothing the parent's agent asked for outlives the link.
      ending = endSession(own).then(() => own.reset());
    });
    childTargets.setParent(linked, { merged });
  };

  const onMessage = (event: MessageEvent) => {
    if (!event.isTrusted || event.source !== window.parent || !matchOrigin(patterns, event.origin)) return;
    if (isMessage(event.data, FRAME_PING)) {
      // The parent pings once it has let its links go (a new agent, back from the back/forward
      // cache, linked to its own parent): its bye on the link's port may come after the ping,
      // which a link still open would ignore, never to link again. The link is done with.
      link?.close();
      id = newId();
      return hello();
    }
    const welcome = readWelcome(event.data);
    const port = event.ports[0];
    // Only the welcome for this document's hello, once; merged into the parent's agent only in a
    // sandboxed iframe (an opaque origin), which Chrome keeps in its parent's target.
    if (!welcome || welcome.id !== id || !port || link) return;
    if ((welcome.mode === 'merge') !== (self.origin === 'null')) return;
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
