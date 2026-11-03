import type { Protocol } from 'devtools-protocol';
import {
  askChild,
  type ChildLink,
  type ChildSession,
  type ChildTargets,
  childTargets,
  OWN_ID_PREFIX,
  parse,
} from '../../core/child-targets';
import type { Context } from '../../core/context';
import { isFrameOwner, sourceAttribute } from '../../core/realm';
import { CdpError } from '../../core/session';

/**
 * The Target domain: the page's cross-origin iframes as child targets of type `iframe`
 * (docs/roadmap.md, "iframes"; what Chrome does is in test-support/oopif-notes.md). Each link
 * to an iframe's agent (core/child-targets.ts) is attached as a session of its own while
 * auto-attach is on, and the client's messages are routed to it by `sessionId`, flattened as
 * Chrome does: every session, the iframe's own children's too, talks over the one connection.
 * Like Chrome's, a target and its session outlive the iframe's navigations: the next document's
 * link carries them on (see `relink`).
 *
 * As in Chrome, every client (every CDP session of the page's agent) attaches a target on its own,
 * with a session of its own in the iframe's agent (ChildLink.openSession). Unlike Chrome, an iframe is announced only once its document has loaded the
 * probe and the link is made, so it is never paused at start: `waitingForDebugger` is false, and
 * the URL and title are known, as Chrome announces iframes that exist when auto-attach is turned
 * on.
 */

/** How long the iframe's agent has to tell its URL and title, in ms, before the iframe's `src` is used. */
const INFO_TIMEOUT = 1000;

/** The attachments of each child target, by target id, the page's sessions' all: its info's `attached`. */
const attachments = new Map<string, Set<object>>();

/** Chrome's error for a command to a target whose document went away. */
const NAVIGATED_ERROR = { code: -32000, message: 'Inspected target navigated or closed' };

/**
 * Commands that set up what a session gets, besides the `enable`s: what the client sent of them is
 * sent the iframe's next document too, which starts from nothing, as Chrome's session keeps them
 * across the iframe's navigations.
 */
const KEPT = new Set([
  'Target.setAutoAttach',
  'Overlay.setInspectMode',
  'Runtime.setAsyncCallStackDepth',
  'Debugger.setAsyncCallStackDepth',
  'Debugger.setPauseOnExceptions',
  'Debugger.setBreakpointsActive',
  'Debugger.setSkipAllPauses',
  'Network.setCacheDisabled',
  'Emulation.setEmitTouchEventsForMouse',
]);
let replaySeq = 0;

/** A session id: random, unique across the page and the iframes' agents, like Chrome's. */
function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

/** The child frames of a Page.getFrameTree tree. */
function childFrames(tree: unknown): unknown[] {
  const children = field(tree, 'childFrames');
  return Array.isArray(children) ? children : [];
}

/** Asks the iframe's agent, waiting {@link INFO_TIMEOUT} ms at most: undefined if it did not answer. */
const ask = (link: ChildLink, method: string, params: object = {}) =>
  askChild(link, method, params, INFO_TIMEOUT).catch(() => undefined);

/** The URL an iframe was given, for one whose agent does not tell its own. */
function srcOf(owner: Element): string {
  const src = isFrameOwner(owner) ? owner.getAttribute(sourceAttribute(owner))?.trim() : undefined;
  try {
    return src ? new URL(src, owner.baseURI).href : '';
  } catch {
    return src ?? '';
  }
}

/** A child target attached as a session: its link's, and its next links' (the iframe's next documents'). */
interface Attached {
  readonly sessionId: string;
  /** The link now, or the last one while the iframe is between two documents. */
  link: ChildLink;
  /** The client's session with the iframe's agent, on the link; none between two documents. */
  channel: ChildSession | undefined;
  /** The link closed: the iframe is between two documents, and the target kept for the next one. */
  between: boolean;
  /**
   * What the client's messages wait for: the next document set up as the client set up the last.
   * At first, the client told of the target: nothing comes on the session before it is.
   */
  ready: Promise<void>;
  /** The client was told of the target: only then is it told of its end. */
  announced: boolean;
  /** The sessions of the iframe's own child targets (and theirs), routed to the link as they are. */
  readonly nested: Map<string, { targetId: string; off: () => void }>;
  /** The `enable`s and {@link KEPT} commands the client sent on the session, with their params. */
  readonly kept: Map<string, unknown>;
  /** The ids of the client's commands sent on to the iframe's agent, not yet answered. */
  readonly pending: Set<unknown>;
  readonly offs: (() => void)[];
  /** What ends with the link. */
  linkOffs: (() => void)[];
}

/** Registers the Target domain on `ctx.session`, for the links in `targets`. */
export function registerTarget(ctx: Pick<Context, 'session' | 'frames'>, targets: ChildTargets = childTargets) {
  const { session } = ctx;
  let autoAttach = false;
  let discover = false;
  /** By target id. */
  const attached = new Map<string, Attached>();
  /** The child targets this client has heard of by `Target.targetCreated`, by target id. */
  const announced = new Set<string>();

  /** This page's target: an iframe's too, when its agent is linked to its parent's. */
  function ownInfo(): Protocol.Target.TargetInfo {
    const { document: doc, window: win } = ctx.frames.top;
    const url = win.location.href;
    // A sandboxed iframe's agent merged into its parent's is in the parent's target, as Chrome
    // keeps such a frame: its id is the parent's, and it has no parent of its own.
    const merged = targets.parentMerged ? targets.parent : undefined;
    const parent = merged ? undefined : targets.parent;
    const info: Protocol.Target.TargetInfo = {
      targetId: parent?.frameId ?? merged?.parentTargetId ?? ctx.frames.top.id,
      type: parent ? 'iframe' : 'page',
      // Chrome reports the URL while the document has no title.
      title: doc.title || url,
      url,
      attached: true,
      canAccessOpener: false,
    };
    if (parent) {
      info.parentId = parent.parentTargetId;
      info.parentFrameId = parent.parentFrameId;
    }
    return info;
  }

  /** A child target's info: its URL and title from its agent, its place from the parent's frames. */
  async function infoOf(link: ChildLink): Promise<Protocol.Target.TargetInfo> {
    const own = field(await ask(link, 'Target.getTargetInfo'), 'targetInfo');
    const told = field(own, 'url');
    const url = typeof told === 'string' ? told : srcOf(link.owner);
    const title = field(own, 'title');
    const ownId = ownInfo().targetId;
    // The top frame's id is this target's, in an iframe's agent too.
    const holder = ctx.frames.ofNode(link.owner);
    return {
      targetId: link.frameId,
      type: 'iframe',
      title: typeof title === 'string' && title ? title : url,
      url,
      attached: (attachments.get(link.frameId)?.size ?? 0) > 0,
      parentId: ownId,
      canAccessOpener: false,
      parentFrameId: holder === ctx.frames.top ? ownId : holder.id,
    };
  }

  /** Sends the client a message on a child target's session. */
  const postOn = (entry: Attached, message: object) =>
    session.post(JSON.stringify({ ...message, sessionId: entry.sessionId }));

  /** Whether a session id is already another target's: an attached one's, or another iframe's child's. */
  const taken = (sessionId: string) =>
    [...attached.values()].some(entry => entry.sessionId === sessionId || entry.nested.has(sessionId));

  /** A message from the iframe's agent, on to the client with the link's session id unless it has one. */
  function fromChild(entry: Attached, message: string) {
    const parsed = parse(message);
    if (!parsed) return;
    const { id, method, params } = parsed;
    if (typeof id === 'string' && id.startsWith(OWN_ID_PREFIX)) return;
    if (method === undefined) entry.pending.delete(id);
    // The iframe's agent is not trusted: only its own children's sessions are its to speak on.
    const own = parsed['sessionId'];
    const onNested = typeof own === 'string' && own !== '';
    if (onNested && !entry.nested.has(own)) return;
    // The iframe's own children (and theirs): their sessions are the iframe's to route to, not one taken.
    const nested = field(params, 'sessionId');
    if (typeof nested === 'string' && method === 'Target.attachedToTarget' && !entry.nested.has(nested)) {
      if (!nested || taken(nested)) return;
      const targetId = field(field(params, 'targetInfo'), 'targetId');
      entry.nested.set(nested, {
        targetId: typeof targetId === 'string' ? targetId : '',
        off: session.route(nested, m => entry.channel?.send(JSON.stringify(m))),
      });
    } else if (typeof nested === 'string' && method === 'Target.detachedFromTarget') {
      const child = entry.nested.get(nested);
      if (!child) return;
      child.off();
      entry.nested.delete(nested);
    }
    if (onNested) return session.post(message);
    postOn(entry, parsed);
  }

  /** Keeps what the client set up on a child target's session, for the iframe's next document. */
  function keep(entry: Attached, method: string, params: unknown) {
    if (method.endsWith('.enable') || KEPT.has(method)) entry.kept.set(method, params ?? {});
    else if (method.endsWith('.disable')) entry.kept.delete(method.replace(/disable$/, 'enable'));
  }

  /** The client's message on a child target's session, to the iframe's agent as its own client's, without the session id. */
  function toChild(entry: Attached, message: Record<string, unknown>) {
    const { id, method, params } = message;
    delete message['sessionId'];
    if (entry.between) {
      // Like the relay for a page between two instances: what the next document is set up with
      // succeeds, anything else fails as in Chrome, and so leaves the next document's setup as it was.
      const enable = typeof method === 'string' && (method.endsWith('.enable') || KEPT.has(method));
      if (enable) keep(entry, method, params);
      if (id === undefined) return;
      postOn(entry, enable ? { id, result: {} } : { id, error: NAVIGATED_ERROR });
      return;
    }
    if (typeof method === 'string') keep(entry, method, params);
    if (id !== undefined) entry.pending.add(id);
    const { channel } = entry;
    void entry.ready.then(() => {
      if (channel && entry.channel === channel) return channel.send(JSON.stringify(message));
      // The document went away first: the command fails as one sent between two documents.
      if (entry.pending.delete(id) && attached.get(entry.link.frameId) === entry) {
        postOn(entry, { id, error: NAVIGATED_ERROR });
      }
    });
  }

  /** Opens the client's session on a link of an attached target, and listens to it. */
  function follow(entry: Attached, link: ChildLink) {
    const channel = link.openSession();
    entry.link = link;
    entry.channel = channel;
    entry.between = false;
    entry.linkOffs = [channel.onMessage(message => fromChild(entry, message)), link.onClose(() => leave(entry, link))];
  }

  /**
   * The iframe's document went away, its link with it: like Chrome, the target and its session
   * stay for the next document, and the document's own children go at once, on its session.
   */
  function leave(entry: Attached, link: ChildLink) {
    if (entry.link !== link || entry.between) return;
    entry.between = true;
    entry.channel = undefined;
    entry.linkOffs.forEach(off => off());
    // What the document was asked and did not answer never will be: it fails as in Chrome.
    for (const id of entry.pending) postOn(entry, { id, error: NAVIGATED_ERROR });
    entry.pending.clear();
    for (const [sessionId, { targetId, off }] of entry.nested) {
      off();
      postOn(entry, {
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId } satisfies Protocol.Target.DetachedFromTargetEvent,
      });
    }
    entry.nested.clear();
  }

  /**
   * The iframe's next document linked: it carries the target on. Like Chrome on the iframe's
   * navigation, the client hears of the new document on the target's session (the old
   * document's contexts cleared, its main frame navigated, its document updated) and of the new
   * URL and title on this one; the new document's agent gets what the client set up on the
   * session, as the relay replays a page's (packages/relay-core), and reports what it has.
   */
  function relink(entry: Attached, link: ChildLink) {
    follow(entry, link);
    const announcing = entry.ready;
    entry.ready = (async () => {
      // Linked again before the client was told of the target: it hears of the target first.
      await announcing;
      const [tree, targetInfo] = await Promise.all([ask(link, 'Page.getFrameTree'), infoOf(link)]);
      if (attached.get(link.frameId) !== entry || entry.link !== link) return;
      const { kept } = entry;
      if (kept.has('Runtime.enable')) postOn(entry, { method: 'Runtime.executionContextsCleared', params: {} });
      const frameTree = field(tree, 'frameTree');
      const frame = field(frameTree, 'frame');
      const page = kept.has('Page.enable');
      if (page && frame) postOn(entry, { method: 'Page.frameNavigated', params: { frame, type: 'Navigation' } });
      changed(targetInfo);
      if (kept.has('DOM.enable')) postOn(entry, { method: 'DOM.documentUpdated', params: {} });
      // The new document's own frames, which came before its agent was linked.
      if (page) for (const child of childFrames(frameTree)) attachFrame(entry, child);
      for (const [method, params] of kept) {
        entry.channel?.send(JSON.stringify({ id: `${OWN_ID_PREFIX}replay-${++replaySeq}`, method, params }));
      }
    })();
  }

  /** Tells the client of a frame of a child target's document, and of its own frames, as Chrome does as they load. */
  function attachFrame(entry: Attached, tree: unknown) {
    const frame = field(tree, 'frame');
    postOn(entry, {
      method: 'Page.frameAttached',
      params: { frameId: field(frame, 'id'), parentFrameId: field(frame, 'parentId') },
    });
    postOn(entry, { method: 'Page.frameNavigated', params: { frame, type: 'Navigation' } });
    for (const child of childFrames(tree)) attachFrame(entry, child);
  }

  /** A child target's URL changed. */
  function changed(targetInfo: Protocol.Target.TargetInfo) {
    if (!announced.has(targetInfo.targetId) && !attached.has(targetInfo.targetId)) return;
    session.emit('Target.targetInfoChanged', { targetInfo } satisfies Protocol.Target.TargetInfoChangedEvent);
  }

  async function attach(link: ChildLink) {
    if (attached.has(link.frameId)) return;
    const entry: Attached = {
      sessionId: newSessionId(),
      link,
      channel: undefined,
      between: false,
      ready: Promise.resolve(),
      announced: false,
      nested: new Map(),
      kept: new Map(),
      pending: new Set(),
      offs: [],
      linkOffs: [],
    };
    attached.set(link.frameId, entry);
    let holders = attachments.get(link.frameId);
    if (!holders) attachments.set(link.frameId, (holders = new Set()));
    holders.add(entry);
    follow(entry, link);
    entry.ready = (async () => {
      const targetInfo = await infoOf(link);
      // Let go meanwhile, untold: auto-attach turned off, the iframe gone, or the client.
      if (attached.get(link.frameId) !== entry) return;
      entry.offs.push(session.route(entry.sessionId, message => toChild(entry, message)));
      entry.announced = true;
      session.emit('Target.attachedToTarget', {
        sessionId: entry.sessionId,
        targetInfo,
        waitingForDebugger: false,
      } satisfies Protocol.Target.AttachedToTargetEvent);
    })();
    await entry.ready;
  }

  /** Lets a target go: with an event when the client is to hear of it, and ending its session in the iframe when it is still there. */
  function detach(entry: Attached, notify: boolean) {
    const { link } = entry;
    if (attached.get(link.frameId) !== entry) return;
    attached.delete(link.frameId);
    const holders = attachments.get(link.frameId);
    holders?.delete(entry);
    if (holders?.size === 0) attachments.delete(link.frameId);
    entry.offs.forEach(off => off());
    entry.linkOffs.forEach(off => off());
    entry.nested.forEach(({ off }) => off());
    // What the client started there ends, its own children let go too, as when a client leaves Chrome.
    entry.channel?.close();
    entry.channel = undefined;
    // The session is gone: its commands are answered no more.
    entry.pending.clear();
    if (notify && entry.announced) {
      session.emit('Target.detachedFromTarget', {
        sessionId: entry.sessionId,
        targetId: link.frameId,
      } satisfies Protocol.Target.DetachedFromTargetEvent);
    }
  }

  async function announce(link: ChildLink) {
    if (announced.has(link.frameId)) return;
    announced.add(link.frameId);
    const targetInfo = await infoOf(link);
    if (discover && announced.has(link.frameId))
      session.emit('Target.targetCreated', { targetInfo } satisfies Protocol.Target.TargetCreatedEvent);
  }

  targets.onChild((link, previous) => {
    const entry = previous && attached.get(previous.frameId);
    if (entry && entry.link === previous) return relink(entry, link);
    // A target carried on (another session's, or one this client let go) is news to it only if it
    // heard of it: one between two documents when the client turned discovery or auto-attach on is
    // new to it, as in Chrome, where the target was there all along.
    if (announced.has(link.frameId)) void infoOf(link).then(changed);
    else if (discover) void announce(link);
    if (autoAttach) void attach(link);
  });
  // Like Chrome when the iframe is removed, or comes back to this page's origin; its own children
  // went first, when its link closed.
  targets.onGone(link => {
    const entry = attached.get(link.frameId);
    if (entry?.link === link) {
      leave(entry, link);
      detach(entry, true);
    }
    if (announced.delete(link.frameId)) session.emit('Target.targetDestroyed', { targetId: link.frameId });
  });
  session.onReset(() => {
    // The client is gone: no one to tell.
    autoAttach = false;
    discover = false;
    announced.clear();
    for (const entry of attached.values()) detach(entry, false);
  });

  session.register('Target', {
    setAutoAttach(params: Protocol.Target.SetAutoAttachRequest) {
      // Only flatten sessions are supported: Chrome accepts the others too, wrapping the
      // messages in Target.receivedMessageFromTarget, which is not done here; without flatten
      // nothing could be attached, so it fails (the frontend always asks for it).
      if (params.autoAttach === true && params.flatten !== true) {
        throw new CdpError('Not supported in the page: only flatten sessions are supported');
      }
      autoAttach = params.autoAttach === true;
      if (autoAttach) for (const link of targets.children()) void attach(link);
      // Like Chrome, turning it off detaches the targets it attached.
      else for (const entry of attached.values()) detach(entry, true);
    },

    async setDiscoverTargets(params: Protocol.Target.SetDiscoverTargetsRequest) {
      const was = discover;
      discover = params.discover === true;
      if (!discover) announced.clear();
      if (!discover || was) return;
      // Like Chrome, every target there is, this page's own included.
      session.emit('Target.targetCreated', { targetInfo: ownInfo() } satisfies Protocol.Target.TargetCreatedEvent);
      for (const link of targets.children()) await announce(link);
    },

    async getTargets(): Promise<Protocol.Target.GetTargetsResponse> {
      const children = await Promise.all([...targets.children()].map(infoOf));
      return { targetInfos: [ownInfo(), ...children] };
    },

    async getTargetInfo(params: Protocol.Target.GetTargetInfoRequest): Promise<Protocol.Target.GetTargetInfoResponse> {
      const own = ownInfo();
      if (params.targetId === undefined || params.targetId === own.targetId) return { targetInfo: own };
      const link = [...targets.children()].find(child => child.frameId === params.targetId);
      if (!link) throw new CdpError('No target with given id found', -32602);
      return { targetInfo: await infoOf(link) };
    },

    detachFromTarget(params: Protocol.Target.DetachFromTargetRequest) {
      const entry = [...attached.values()].find(
        ({ sessionId, link }) => sessionId === params.sessionId || link.frameId === params.targetId
      );
      if (!entry) throw new CdpError('No session with given id', -32602);
      detach(entry, true);
    },
  });
}
