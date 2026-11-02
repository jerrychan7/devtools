import type { Protocol } from 'devtools-protocol';
import { type ChildLink, type ChildTargets, childTargets } from '../../core/child-targets';
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

/** Prefix of the ids of the domain's own commands to the iframe's agent: their responses are not the client's. */
const OWN_ID_PREFIX = 'target-own-';
/** How long the iframe's agent has to tell its URL and title, in ms, before the iframe's `src` is used. */
const INFO_TIMEOUT = 1000;

/** The CDP session each link is attached to: a link carries one session. */
const claims = new WeakMap<ChildLink, object>();
/** Listeners to links let go, which another CDP session may then attach. */
const releases = new Set<(link: ChildLink) => void>();

let ownSeq = 0;

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

/**
 * Sends the iframe's agent a command of the domain's own, the response to which no client
 * sees; resolves with its result, or undefined on an error or after `timeout` ms.
 */
function ask(link: ChildLink, method: string, params: object = {}, timeout = INFO_TIMEOUT): Promise<unknown> {
  const id = `${OWN_ID_PREFIX}${++ownSeq}`;
  return new Promise(resolve => {
    const done = (result: unknown) => {
      off();
      offClose();
      clearTimeout(timer);
      resolve(result);
    };
    const off = link.onMessage(message => {
      if (!message.includes(id)) return;
      const parsed = parse(message);
      if (parsed?.['id'] === id) done(parsed['result']);
    });
    const offClose = link.onClose(() => done(undefined));
    const timer = setTimeout(() => done(undefined), timeout);
    link.send(JSON.stringify({ id, method, params }));
  });
}

/** The URL an iframe was given, for one whose agent does not tell its own. */
function srcOf(owner: Element): string {
  const src = owner.getAttribute(owner.localName === 'object' ? 'data' : 'src');
  try {
    return src ? new URL(src, owner.baseURI).href : '';
  } catch {
    return src ?? '';
  }
}

/** A link attached as a session. */
interface Attached {
  readonly sessionId: string;
  /** The sessions of the iframe's own child targets (and theirs), routed to the link as they are. */
  readonly nested: Map<string, () => void>;
  readonly offs: (() => void)[];
}

/** Registers the Target domain on `ctx.session`, for the links in `targets`. */
export function registerTarget(ctx: Pick<Context, 'session' | 'frames'>, targets: ChildTargets = childTargets) {
  const { session } = ctx;
  const claim = {};
  let autoAttach = false;
  let discover = false;
  const attached = new Map<ChildLink, Attached>();

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
      attached: claims.has(link),
      parentId: ownId,
      canAccessOpener: false,
      parentFrameId: holder === ctx.frames.top ? ownId : holder.id,
    };
  }

  /** A message from the iframe's agent, on to the client with the link's session id unless it has one. */
  function fromChild(link: ChildLink, entry: Attached, message: string) {
    const parsed = parse(message);
    if (!parsed) return;
    const { id, method, params } = parsed;
    if (typeof id === 'string' && id.startsWith(OWN_ID_PREFIX)) return;
    // The iframe's own children: their sessions are the iframe's to route to.
    const nested = field(params, 'sessionId');
    if (typeof nested === 'string') {
      if (method === 'Target.attachedToTarget' && !entry.nested.has(nested)) {
        entry.nested.set(
          nested,
          session.route(nested, m => link.send(JSON.stringify(m)))
        );
      } else if (method === 'Target.detachedFromTarget') {
        entry.nested.get(nested)?.();
        entry.nested.delete(nested);
      }
    }
    const own = parsed['sessionId'];
    session.post(typeof own === 'string' && own ? message : JSON.stringify({ ...parsed, sessionId: entry.sessionId }));
  }

  async function attach(link: ChildLink) {
    if (attached.has(link) || claims.has(link)) return;
    claims.set(link, claim);
    const entry: Attached = { sessionId: newSessionId(), nested: new Map(), offs: [] };
    attached.set(link, entry);
    // Like Chrome when the iframe is removed (or goes back to the parent's origin).
    entry.offs.push(link.onClose(() => detach(link, true, false)));
    const targetInfo = await infoOf(link);
    // Let go meanwhile: auto-attach turned off, the iframe gone, or the client.
    if (attached.get(link) !== entry) return;
    entry.offs.push(
      // To the iframe's agent as its own client's, without the session id.
      session.route(entry.sessionId, message => {
        delete message['sessionId'];
        link.send(JSON.stringify(message));
      }),
      link.onMessage(message => fromChild(link, entry, message))
    );
    session.emit('Target.attachedToTarget', {
      sessionId: entry.sessionId,
      targetInfo,
      waitingForDebugger: false,
    } satisfies Protocol.Target.AttachedToTargetEvent);
  }

  /** Lets a link go: with an event when the client is to hear of it, and ending its session in the iframe when it is still there. */
  function detach(link: ChildLink, notify: boolean, open = true) {
    const entry = attached.get(link);
    if (!entry) return;
    attached.delete(link);
    claims.delete(link);
    entry.offs.forEach(off => off());
    entry.nested.forEach(off => off());
    // What the client started there ends, its own children let go too, as a new Chrome session starts clean.
    if (open) link.endSession();
    if (notify) {
      session.emit('Target.detachedFromTarget', {
        sessionId: entry.sessionId,
        targetId: link.frameId,
      } satisfies Protocol.Target.DetachedFromTargetEvent);
    }
    releases.forEach(listener => listener(link));
  }

  async function announce(link: ChildLink) {
    const targetInfo = await infoOf(link);
    if (discover) session.emit('Target.targetCreated', { targetInfo } satisfies Protocol.Target.TargetCreatedEvent);
  }

  targets.onChild(link => {
    if (discover) void announce(link);
    link.onClose(() => {
      if (discover) session.emit('Target.targetDestroyed', { targetId: link.frameId });
    });
    if (autoAttach) void attach(link);
  });
  // A link another CDP session let go, still there: this one's if it auto-attaches.
  releases.add(link => {
    if (autoAttach && [...targets.children()].includes(link)) void attach(link);
  });
  session.onReset(() => {
    // The client is gone: no one to tell.
    autoAttach = false;
    discover = false;
    for (const link of attached.keys()) detach(link, false);
  });

  session.register('Target', {
    setAutoAttach(params: Protocol.Target.SetAutoAttachRequest) {
      // Only flatten sessions are supported: Chrome accepts the others too, wrapping the
      // messages in Target.receivedMessageFromTarget, which is not done here, so nothing is
      // attached without flatten (the frontend always asks for it).
      autoAttach = params.autoAttach === true && params.flatten === true;
      if (autoAttach) for (const link of targets.children()) void attach(link);
      // Like Chrome, turning it off detaches the targets it attached.
      else for (const link of attached.keys()) detach(link, true);
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
      const link = [...attached].find(
        ([child, entry]) => entry.sessionId === params.sessionId || child.frameId === params.targetId
      )?.[0];
      if (!link) throw new CdpError('No session with given id', -32602);
      detach(link, true);
    },
  });
}
