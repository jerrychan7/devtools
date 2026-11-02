// The handshake between a page and a cross-origin iframe's page that link their CDP agents (see
// cdp-agent/core/child-targets.ts), both with the bundle loaded, each trusting the other's origin
// (probe-script.ts, data-frame-origins and data-parent-origins):
//
//   iframe → parent window   { type: FRAME_HELLO, id }       when its agent is ready, or pinged
//   parent → iframe window   { type: FRAME_PING }            when the parent's agent is ready
//   parent → iframe window   { type: FRAME_WELCOME, id, frameId, parentFrameId } + a MessagePort
//   either end → port        CDP messages, as strings; { type: FRAME_BYE } as the last
//
// `id` names the iframe's document: a hello the parent has answered already (it hears one per
// ping) is not answered again, and a welcome for an earlier document is ignored. Neither hello
// nor ping carries anything of the page, so that they may go to every origin (`*`) when a list
// has a wildcard, which postMessage cannot address; the welcome, with the port, goes to the
// iframe's exact origin, as read from its hello, and the iframe checks the welcome's origin.
import type { OriginPattern } from './origins';

/** Posted by an iframe's page to its parent window: it asks for a link. */
export const FRAME_HELLO = 'devtools-anywhere:frame-hello';
/** Posted by the parent to its iframes when its agent is ready: they say hello (again). */
export const FRAME_PING = 'devtools-anywhere:frame-ping';
/** Posted by the parent to an iframe it trusts, with its end of the link's port. */
export const FRAME_WELCOME = 'devtools-anywhere:frame-welcome';
/** Posted on the port by the end that closes the link: a port has no close event. */
export const FRAME_BYE = 'devtools-anywhere:frame-bye';

export interface FrameHello {
  type: typeof FRAME_HELLO;
  id: string;
}

export interface FrameWelcome {
  type: typeof FRAME_WELCOME;
  /** The hello's id. */
  id: string;
  frameId: string;
  parentFrameId: string;
}

/** A property of a message, which may be anything. */
const field = (data: unknown, name: string): unknown =>
  typeof data === 'object' && data !== null ? Reflect.get(data, name) : undefined;

/** Whether `data` is a message of `type`. */
export const isMessage = (data: unknown, type: string): boolean => field(data, 'type') === type;

export function readHello(data: unknown): FrameHello | null {
  const id = field(data, 'id');
  return isMessage(data, FRAME_HELLO) && typeof id === 'string' ? { type: FRAME_HELLO, id } : null;
}

export function readWelcome(data: unknown): FrameWelcome | null {
  const [id, frameId, parentFrameId] = ['id', 'frameId', 'parentFrameId'].map(name => field(data, name));
  if (!isMessage(data, FRAME_WELCOME) || typeof id !== 'string') return null;
  if (typeof frameId !== 'string' || typeof parentFrameId !== 'string') return null;
  return { type: FRAME_WELCOME, id, frameId, parentFrameId };
}

/**
 * Posts a hello or a ping, which carry nothing of the page, to `target` if its origin is one of
 * `patterns`: to each exact origin, or to any (`*`) when there is a wildcard, which postMessage
 * cannot address. The answer's origin is what is checked.
 */
export function postToTrusted(target: Window, message: object, patterns: readonly OriginPattern[]): void {
  if (patterns.some(pattern => !('origin' in pattern))) return target.postMessage(message, '*');
  for (const pattern of patterns) if ('origin' in pattern) target.postMessage(message, pattern.origin);
}
