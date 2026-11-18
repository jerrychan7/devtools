// The handshake between a page and a cross-origin iframe's page that link their CDP agents (see
// cdp-agent/core/frames/child-targets.ts), both with the bundle loaded, each trusting the other's origin
// (probe-script.ts, data-frame-origins and data-parent-origins):
//
//   iframe → parent window   { type: FRAME_HELLO, id, ns? }  when its agent is ready, or pinged
//   parent → iframe window   { type: FRAME_PING }            when the parent's agent is ready, or has let its links go
//   parent → iframe window   { type: FRAME_WELCOME, id, frameId, parentFrameId, parentTargetId } + a MessagePort
//   either end → port        CDP messages, as strings; { type: FRAME_BYE } as the last
//   parent → port            { type: FRAME_OPEN_SESSION } + a MessagePort, for each of its clients
//                            that attaches the iframe's target: a CDP session of its own, over
//                            that port, with the same bye; it ends with the link too
//
// `id` names the iframe's document: a hello the parent has answered already (it hears one per
// ping) is not answered again, and a welcome for an earlier document is ignored. Neither hello
// nor ping carries anything of the page, so that they may go to every origin (`*`) when a list
// has a wildcard, which postMessage cannot address; the welcome, with the port, goes to the
// iframe's exact origin, as read from its hello, and the iframe checks the welcome's origin.
//
// A sandboxed iframe's (opaque origin, `null`, when data-frame-origins names `sandboxed`) welcome
// can only go to `*`, which no origin check backs: it goes to that iframe's window alone, once its
// element is known to show an opaque frame of this page (core/frames/frames.ts, OpaqueFrame) whose
// document has not changed since the hello (its loader id), and carries the hello's id, the only
// one the iframe accepts; the iframe takes a `merge` welcome only when its own origin is opaque.
import type { OriginPattern } from './origins';

/** Posted by an iframe's page to its parent window: it asks for a link. */
export const FRAME_HELLO = 'devtools-anywhere:frame-hello';
/**
 * Posted by the parent to its iframes when its agent is ready, back from the back/forward cache,
 * or linked to its own parent, its links let go each time: they end a link still open (its bye
 * may come later) and say hello again.
 */
export const FRAME_PING = 'devtools-anywhere:frame-ping';
/** Posted by the parent to an iframe it trusts, with its end of the link's port. */
export const FRAME_WELCOME = 'devtools-anywhere:frame-welcome';
/** Posted on the port by the end that closes the link: a port has no close event. */
export const FRAME_BYE = 'devtools-anywhere:frame-bye';
/**
 * Posted on the port by the parent, with a port of its own, when one of its clients attaches the
 * iframe's target: the iframe's agent makes a session for it, as Chrome does for each client, and
 * ends it (what it enabled disabled) on that port's bye.
 */
export const FRAME_OPEN_SESSION = 'devtools-anywhere:frame-open-session';

export interface FrameHello {
  type: typeof FRAME_HELLO;
  id: string;
  /**
   * A merged iframe's document linked before (pinged, back from the back/forward cache): the
   * namespace its ids are in, which the parent gives it again if it gave it to that element last
   * (cdp-agent/core/frames/merged-frames.ts, nsFor).
   */
  ns?: number;
}

export interface FrameWelcome {
  type: typeof FRAME_WELCOME;
  /** The hello's id. */
  id: string;
  frameId: string;
  parentFrameId: string;
  /** The parent page's target id. */
  parentTargetId: string;
  /**
   * `target`: the iframe is a child target of the parent's. `merge`: an opaque-origin (sandboxed)
   * iframe, which Chrome keeps in the parent's target: its agent is merged into the parent's
   * (cdp-agent/core/frames/merged-frames.ts), its ids in namespace `ns`.
   */
  mode: 'target' | 'merge';
  /** The namespace of the merged iframe's ids (1 or more); 0 for a child target. */
  ns: number;
  /**
   * A merged iframe's: the loader id the parent gives its document, which Chrome gives the
   * document's requests too (cdp-agent/core/frames/frames.ts, opaqueLoaderId).
   */
  loaderId?: string;
}

/** The highest namespace: `ns * 2^32` plus an agent's own ids stays a safe integer. */
export const MAX_NS = 2 ** 20;

/** A property of a message, which may be anything. */
const field = (data: unknown, name: string): unknown =>
  typeof data === 'object' && data !== null ? Reflect.get(data, name) : undefined;

/** Whether `data` is a message of `type`. */
export const isMessage = (data: unknown, type: string): boolean => field(data, 'type') === type;

export function readHello(data: unknown): FrameHello | null {
  const id = field(data, 'id');
  if (!isMessage(data, FRAME_HELLO) || typeof id !== 'string') return null;
  const ns = field(data, 'ns');
  return typeof ns === 'number' && Number.isInteger(ns) && ns >= 1 && ns <= MAX_NS
    ? { type: FRAME_HELLO, id, ns }
    : { type: FRAME_HELLO, id };
}

export function readWelcome(data: unknown): FrameWelcome | null {
  const [id, frameId, parentFrameId, parentTargetId] = ['id', 'frameId', 'parentFrameId', 'parentTargetId'].map(name =>
    field(data, name)
  );
  if (!isMessage(data, FRAME_WELCOME) || typeof id !== 'string') return null;
  if (typeof frameId !== 'string' || typeof parentFrameId !== 'string' || typeof parentTargetId !== 'string')
    return null;
  const mode = field(data, 'mode');
  const ns = field(data, 'ns');
  if (typeof ns !== 'number' || !Number.isInteger(ns)) return null;
  if (mode === 'target' && ns === 0)
    return { type: FRAME_WELCOME, id, frameId, parentFrameId, parentTargetId, mode, ns };
  const loaderId = field(data, 'loaderId');
  if (mode === 'merge' && ns >= 1 && ns <= MAX_NS)
    return {
      type: FRAME_WELCOME,
      id,
      frameId,
      parentFrameId,
      parentTargetId,
      mode,
      ns,
      ...(typeof loaderId === 'string' ? { loaderId } : {}),
    };
  return null;
}

/**
 * Posts a hello or a ping, which carry nothing of the page, to `target` if its origin is one of
 * `patterns`: to each exact origin, or to any (`*`) when there is a wildcard, which postMessage
 * cannot address. The answer's origin is what is checked.
 */
export function postToTrusted(target: Window, message: object, patterns: readonly OriginPattern[]): void {
  if (patterns.some(pattern => 'suffix' in pattern)) return target.postMessage(message, '*');
  for (const pattern of patterns) if ('origin' in pattern) target.postMessage(message, pattern.origin);
}

/** What a sandboxed (opaque-origin) iframe's hello is checked against before it is welcomed. */
export interface OpaqueHello {
  /** The hello event's. */
  isTrusted: boolean;
  origin: string;
  source: unknown;
  /** The window of the element `source` was found to be a frame of (ownerOfWindow), if any. */
  ownerWindow: unknown;
  /** Whether the element shows an opaque frame of this page (FrameRegistry.opaqueOf). */
  opaque: boolean;
  /** The opaque frame's loader id when the hello came, and once the frames were synced since. */
  loaderIdAtHello: string | undefined;
  loaderIdNow: string | undefined;
}

/**
 * Why a sandboxed iframe's hello is not welcomed, or undefined when it is: the list names
 * `sandboxed`, the event is the browser's, from the very window of one of this page's elements
 * that shows an opaque frame, whose document is the one that said hello.
 */
export function refuseOpaqueHello(patterns: readonly OriginPattern[], hello: OpaqueHello): string | undefined {
  if (!hello.isTrusted || hello.origin !== 'null') return 'not an opaque origin';
  if (!patterns.some(pattern => 'opaque' in pattern)) return 'sandboxed iframes are not trusted';
  if (hello.ownerWindow === undefined || hello.ownerWindow !== hello.source) return 'not a frame of this page';
  if (!hello.opaque) return 'not a sandboxed frame of this page';
  if (hello.loaderIdAtHello === undefined || hello.loaderIdAtHello !== hello.loaderIdNow) return 'another document';
  return undefined;
}
