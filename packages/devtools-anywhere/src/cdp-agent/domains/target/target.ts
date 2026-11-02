import type { Protocol } from 'devtools-protocol';
import { askChild, type ChildLink, type ChildTargets, childTargets, OWN_ID_PREFIX } from '../../core/child-targets';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';

/**
 * The Target domain: the page's cross-origin iframes as child targets of type `iframe`
 * (docs/roadmap.md, "iframes"; what Chrome does is in test-support/oopif-notes.md). Each link
 * to an iframe's agent (core/child-targets.ts) is attached as a session of its own while
 * auto-attach is on, and the client's messages are routed to it by `sessionId`, flattened as
 * Chrome does: every session, the iframe's own children's too, talks over the one connection.
 *
 * Unlike Chrome, where every client gets a session of its own with each target, a link carries
 * one session: it is attached to one CDP session at a time, and the others get it once that one
 * lets it go. Unlike Chrome too, an iframe is announced only once its document has loaded the
 * probe and the link is made, so it is never paused at start: `waitingForDebugger` is false, and
 * the URL and title are known, as Chrome announces iframes that exist when auto-attach is turned
 * on.
 */

/** How long the iframe's agent has to tell its URL and title, in ms, before the iframe's `src` is used. */
const INFO_TIMEOUT = 1000;

/** The CDP session each child target is attached to, by target id: a link carries one session. */
const claims = new Map<string, object>();
/** Listeners to links let go, which another CDP session may then attach. */
const releases = new Set<(link: ChildLink) => void>();

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

function parse(message: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(message);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : undefined;
  } catch {
    return undefined;
  }
}

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

/** The child frames of a Page.getFrameTree tree. */
function childFrames(tree: unknown): unknown[] {
  const children = field(tree, 'childFrames');
  return Array.isArray(children) ? children : [];
}

/** Asks the iframe's agent, waiting {@link INFO_TIMEOUT} ms at most. */
const ask = (link: ChildLink, method: string, params: object = {}) => askChild(link, method, params, INFO_TIMEOUT);

/** The URL an iframe was given, for one whose agent does not tell its own. */
function srcOf(owner: Element): string {
  const src = owner.getAttribute(owner.localName === 'object' ? 'data' : 'src');
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
  /** The link closed: the iframe is between two documents, and the target kept for the next one. */
  between: boolean;
  /** What the client's messages wait for: the next document set up as the client set up the last. */
  ready: Promise<void>;
  /** The sessions of the iframe's own child targets (and theirs), routed to the link as they are. */
  readonly nested: Map<string, { targetId: string; off: () => void }>;
  /** The `enable`s and {@link KEPT} commands the client sent on the session, with their params. */
  readonly kept: Map<string, unknown>;
  readonly offs: (() => void)[];
  /** What ends with the link. */
  linkOffs: (() => void)[];
}

/** Registers the Target domain on `ctx.session`, for the links in `targets`. */
export function registerTarget(ctx: Pick<Context, 'session' | 'frames'>, targets: ChildTargets = childTargets) {
  const { session } = ctx;
  const claim = {};
  let autoAttach = false;
  let discover = false;
  /** By target id. */
  const attached = new Map<string, Attached>();

  /** This page's target: an iframe's too, when its agent is linked to its parent's. */
  function ownInfo(): Protocol.Target.TargetInfo {
    const { document: doc, window: win } = ctx.frames.top;
    const url = win.location.href;
    const parent = targets.parent;
    const info: Protocol.Target.TargetInfo = {
      targetId: parent?.frameId ?? ctx.frames.top.id,
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
      attached: claims.has(link.frameId),
      parentId: ownId,
      canAccessOpener: false,
      parentFrameId: holder === ctx.frames.top ? ownId : holder.id,
    };
  }

  /** Sends the client a message on a child target's session. */
  const postOn = (entry: Attached, message: object) =>
    session.post(JSON.stringify({ ...message, sessionId: entry.sessionId }));

  /** A message from the iframe's agent, on to the client with the link's session id unless it has one. */
  function fromChild(entry: Attached, message: string) {
    const parsed = parse(message);
    if (!parsed) return;
    const { id, method, params } = parsed;
    if (typeof id === 'string' && id.startsWith(OWN_ID_PREFIX)) return;
    const own = parsed['sessionId'];
    if (typeof own === 'string' && own) return session.post(message);
    // The iframe's own children: their sessions are the iframe's to route to.
    const nested = field(params, 'sessionId');
    if (typeof nested === 'string' && method === 'Target.attachedToTarget' && !entry.nested.has(nested)) {
      const targetId = field(field(params, 'targetInfo'), 'targetId');
      entry.nested.set(nested, {
        targetId: typeof targetId === 'string' ? targetId : '',
        off: session.route(nested, m => entry.link.send(JSON.stringify(m))),
      });
    } else if (typeof nested === 'string' && method === 'Target.detachedFromTarget') {
      entry.nested.get(nested)?.off();
      entry.nested.delete(nested);
    }
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
    if (typeof method === 'string') keep(entry, method, params);
    delete message['sessionId'];
    if (entry.between) {
      // Like the relay for a page between two instances: what the next document is set up with
      // succeeds, anything else fails as in Chrome.
      if (id === undefined) return;
      const enable = typeof method === 'string' && (method.endsWith('.enable') || KEPT.has(method));
      postOn(entry, enable ? { id, result: {} } : { id, error: NAVIGATED_ERROR });
      return;
    }
    void entry.ready.then(() => entry.link.send(JSON.stringify(message)));
  }

  /** Starts listening to a link of an attached target. */
  function follow(entry: Attached, link: ChildLink) {
    entry.link = link;
    entry.between = false;
    entry.linkOffs = [link.onMessage(message => fromChild(entry, message)), link.onClose(() => leave(entry, link))];
  }

  /**
   * The iframe's document went away, its link with it: like Chrome, the target and its session
   * stay for the next document, and the document's own children go at once, on its session.
   */
  function leave(entry: Attached, link: ChildLink) {
    if (entry.link !== link || entry.between) return;
    entry.between = true;
    entry.linkOffs.forEach(off => off());
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
    entry.ready = (async () => {
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
        link.send(JSON.stringify({ id: `${OWN_ID_PREFIX}replay-${++replaySeq}`, method, params }));
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
    if (!discover && !attached.has(targetInfo.targetId)) return;
    session.emit('Target.targetInfoChanged', { targetInfo } satisfies Protocol.Target.TargetInfoChangedEvent);
  }

  async function attach(link: ChildLink) {
    if (attached.has(link.frameId) || claims.has(link.frameId)) return;
    claims.set(link.frameId, claim);
    const entry: Attached = {
      sessionId: newSessionId(),
      link,
      between: false,
      ready: Promise.resolve(),
      nested: new Map(),
      kept: new Map(),
      offs: [],
      linkOffs: [],
    };
    attached.set(link.frameId, entry);
    follow(entry, link);
    const targetInfo = await infoOf(link);
    // Let go meanwhile: auto-attach turned off, the iframe gone, or the client.
    if (attached.get(link.frameId) !== entry) return;
    entry.offs.push(session.route(entry.sessionId, message => toChild(entry, message)));
    session.emit('Target.attachedToTarget', {
      sessionId: entry.sessionId,
      targetInfo,
      waitingForDebugger: false,
    } satisfies Protocol.Target.AttachedToTargetEvent);
  }

  /** Lets a target go: with an event when the client is to hear of it, and ending its session in the iframe when it is still there. */
  function detach(entry: Attached, notify: boolean) {
    const { link } = entry;
    if (attached.get(link.frameId) !== entry) return;
    attached.delete(link.frameId);
    if (claims.get(link.frameId) === claim) claims.delete(link.frameId);
    entry.offs.forEach(off => off());
    entry.linkOffs.forEach(off => off());
    entry.nested.forEach(({ off }) => off());
    // What the client started there ends, its own children let go too, as a new Chrome session starts clean.
    if (!entry.between) link.endSession();
    if (notify) {
      session.emit('Target.detachedFromTarget', {
        sessionId: entry.sessionId,
        targetId: link.frameId,
      } satisfies Protocol.Target.DetachedFromTargetEvent);
    }
    if (!entry.between) releases.forEach(listener => listener(link));
  }

  async function announce(link: ChildLink) {
    const targetInfo = await infoOf(link);
    if (discover) session.emit('Target.targetCreated', { targetInfo } satisfies Protocol.Target.TargetCreatedEvent);
  }

  targets.onChild((link, previous) => {
    const entry = previous && attached.get(previous.frameId);
    if (entry && entry.link === previous) return relink(entry, link);
    // Another session's target carried on: news to this one only if it discovers targets.
    if (previous) {
      if (discover) void infoOf(link).then(changed);
      return;
    }
    if (discover) void announce(link);
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
    if (discover) session.emit('Target.targetDestroyed', { targetId: link.frameId });
  });
  // A link another CDP session let go, still there: this one's if it auto-attaches.
  releases.add(link => {
    if (autoAttach && [...targets.children()].includes(link)) void attach(link);
  });
  session.onReset(() => {
    // The client is gone: no one to tell.
    autoAttach = false;
    discover = false;
    for (const entry of attached.values()) detach(entry, false);
  });

  session.register('Target', {
    setAutoAttach(params: Protocol.Target.SetAutoAttachRequest) {
      // Only flatten sessions are supported: Chrome accepts the others too, wrapping the
      // messages in Target.receivedMessageFromTarget, which is not done here, so nothing is
      // attached without flatten (the frontend always asks for it).
      autoAttach = params.autoAttach === true && params.flatten === true;
      if (autoAttach) for (const link of targets.children()) void attach(link);
      // Like Chrome, turning it off detaches the targets it attached.
      else for (const entry of attached.values()) detach(entry, true);
    },

    async setDiscoverTargets(params: Protocol.Target.SetDiscoverTargetsRequest) {
      const was = discover;
      discover = params.discover === true;
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
