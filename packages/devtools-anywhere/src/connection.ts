import { FRAME_ID, LOADER_ID, type CdpSession } from './cdp-agent';
import {
  HELLO_METHOD,
  PING_METHOD,
  RelayCore,
  parse,
  type Frame,
  type HelloParams,
  type Session,
} from '@devtools-anywhere/relay-core';

/**
 * Sent by a page in shell mode when its CDP session starts listening, or when pinged. Carries
 * the page's loader id, which the shell needs for the `Page.frameNavigated` it reports.
 */
const HELLO = JSON.stringify({ method: HELLO_METHOD, params: { loaderId: LOADER_ID } satisfies Partial<HelloParams> });
/** Sent by the shell on startup, in case the page started listening first. */
const PING = JSON.stringify({ method: PING_METHOD });
/** Domains that keep state while enabled; a new frontend instance must start from disabled. */
const STATEFUL_DOMAINS = ['Runtime', 'Network', 'Debugger', 'CSS', 'DOM', 'DOMStorage', 'Overlay', 'WebMCP'];

interface Link {
  /**
   * Forgets that the peer has spoken; outgoing messages are queued again, and incoming ones wait
   * for `after`, if given.
   */
  reset(after?: Promise<void>): void;
  disconnect(): void;
}

/**
 * Connects a CDP session to a peer window over postMessage.
 *
 * Only messages whose source is the peer window and whose origin is `origin` are accepted,
 * and outgoing messages are addressed to that origin only. Outgoing messages are queued
 * until the peer sends its first message: before that, its window may still be loading.
 * Incoming messages wait for `after`, if given.
 */
function link(session: CdpSession, peer: () => Window | null | undefined, origin: string, after?: Promise<void>): Link {
  let ready = false;
  const queue: string[] = [];
  const post = (message: string) => peer()?.postMessage(message, origin);

  const offServer = session.onMessage(message => {
    if (ready) post(message);
    else queue.push(message);
  });
  const onMessage = (event: MessageEvent) => {
    if (event.source !== peer() || event.origin !== origin || typeof event.data !== 'string') return;
    if (event.data === PING) return post(HELLO);
    if (!ready) {
      ready = true;
      queue.splice(0).forEach(post);
    }
    const dispatch = (message: string) =>
      session.dispatch(message).catch(() => {
        // Malformed message: there is no id to answer to.
      });
    // In order, after the previous frontend's session has ended.
    const message: string = event.data;
    if (after) void after.then(() => dispatch(message));
    else void dispatch(message);
  };
  window.addEventListener('message', onMessage);
  return {
    reset(next) {
      ready = false;
      queue.length = 0;
      after = next;
    },
    disconnect() {
      offServer();
      window.removeEventListener('message', onMessage);
    },
  };
}

/**
 * Ends what a frontend started in the page, like a new Chrome session: e.g. Debugger.enable and
 * CSS.enable only report scripts and style sheets again after a disable.
 */
export async function endSession(session: CdpSession): Promise<void> {
  const calls = [...STATEFUL_DOMAINS.map(domain => `${domain}.disable`), 'Page.stopScreencast'];
  await Promise.all(calls.map(method => session.call(method).catch(() => {})));
}

/** For each session, the end of its last frontend's session: the next frontend's messages wait for it. */
const ending = new WeakMap<CdpSession, Promise<void>>();

/**
 * Connects a CDP session to a DevTools frontend running in `frame`. When the frame reloads
 * (a new frontend instance), the domains are disabled so that the new instance's `enable`
 * calls replay everything captured so far. Returns a function that disconnects, and undoes what
 * the frontend did to the page.
 */
export function connectFrontend(session: CdpSession, frame: HTMLIFrameElement, frontendOrigin: string): () => void {
  // The previous frontend's session ends (and resets) before this one's first message.
  const connection = link(session, () => frame.contentWindow, frontendOrigin, ending.get(session));
  let loads = 0;
  const onLoad = () => {
    if (loads++ === 0) return;
    // A new session, as on disconnect: the new instance's messages wait for its end.
    const ended = endSession(session).then(() => session.reset());
    ending.set(session, ended);
    connection.reset(ended);
  };
  frame.addEventListener('load', onLoad);
  return () => {
    connection.disconnect();
    frame.removeEventListener('load', onLoad);
    // Nothing the frontend asked for outlives it: inspect mode, highlights, forced states, the
    // screencast. What the probe captured stays, for the next frontend.
    ending.set(
      session,
      endSession(session).then(() => session.reset())
    );
  };
}

/** Connects the CDP session of a page in shell mode to the shell (its parent window). */
export function connectToShell(session: CdpSession): () => void {
  const connection = link(session, () => window.parent, location.origin);
  window.parent.postMessage(HELLO, location.origin);
  return () => connection.disconnect();
}

/** The page's size in device mode, in CSS pixels (0 for "as laid out"), and its scale. */
export interface DeviceMetrics {
  width: number;
  height: number;
  scale: number;
}

/** The shell's side of the relay core: one frontend, in an iframe; the page in another. */
class ShellRelay extends RelayCore {
  private frontendReady = false;
  /** Hellos without a loader id so far. */
  private unknownLoaders = 0;
  private readonly toFrontend: string[] = [];
  private readonly session: Session;

  constructor(
    private readonly page: HTMLIFrameElement,
    private readonly devtools: HTMLIFrameElement,
    private readonly frontendOrigin: string,
    private readonly onMetrics: (metrics: DeviceMetrics | null) => void
  ) {
    super();
    this.session = this.openSession({ send: message => this.postFrontend(message) });
  }

  private postFrontend(message: string) {
    if (this.frontendReady) this.devtools.contentWindow?.postMessage(message, this.frontendOrigin);
    else this.toFrontend.push(message);
  }

  protected override canDeliver() {
    return true;
  }

  protected override deliver(_session: Session | undefined, data: string) {
    this.page.contentWindow?.postMessage(data, location.origin);
  }

  protected override frame(): Frame {
    let url = this.page.src;
    let secure = isSecureContext;
    try {
      url = this.page.contentWindow?.location.href ?? url;
      secure = this.page.contentWindow?.isSecureContext ?? secure;
    } catch {
      // Cross-origin page: assume it is like the shell.
    }
    return { id: FRAME_ID, url, secure };
  }

  private onPagehide = () => this.pagehide();

  /**
   * Device mode's page size is the shell's to set (shell-layout.ts): it answers
   * Emulation.setDeviceMetricsOverride and clearDeviceMetricsOverride itself, as Chrome's browser
   * does, rather than the page.
   */
  private emulate(data: string): boolean {
    if (!data.includes('DeviceMetricsOverride')) return false;
    const message = parse(data);
    const method = message?.method;
    if (method !== 'Emulation.setDeviceMetricsOverride' && method !== 'Emulation.clearDeviceMetricsOverride')
      return false;
    const params: unknown = message?.params;
    const number = (name: string) => {
      const value: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, name) : undefined;
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    this.onMetrics(
      method === 'Emulation.clearDeviceMetricsOverride'
        ? null
        : { width: number('width'), height: number('height'), scale: number('scale') || 1 }
    );
    this.postFrontend(JSON.stringify({ id: message?.id, result: {} }));
    return true;
  }

  readonly onMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    if (event.source === this.devtools.contentWindow && event.origin === this.frontendOrigin) {
      if (!this.frontendReady) {
        this.frontendReady = true;
        this.toFrontend.splice(0).forEach(message => this.postFrontend(message));
      }
      if (!this.emulate(event.data)) this.clientMessage(this.session, event.data);
    } else if (event.source === this.page.contentWindow && event.origin === location.origin) {
      if (event.data.startsWith(`{"method":"${HELLO_METHOD}"`)) {
        const params = parse(event.data)?.params;
        const field = (name: keyof HelloParams): unknown =>
          typeof params === 'object' && params !== null ? Reflect.get(params, name) : undefined;
        const sent = field('loaderId');
        // A page without one (an older probe) is a new instance every time, as it always was.
        const loaderId = typeof sent === 'string' ? sent : `unknown-${++this.unknownLoaders}`;
        this.page.contentWindow?.addEventListener('pagehide', this.onPagehide);
        return this.hello(loaderId);
      }
      this.pageMessage(this.session, event.data);
    }
  };
}

/**
 * Runs in the shell document: relays CDP messages between the DevTools frontend in
 * `devtools` and the page's CDP session in `page`, and keeps DevTools working across page
 * reloads (the relay core's work, shared with the remote server). Returns a function that
 * disconnects.
 */
export function relayShell(
  page: HTMLIFrameElement,
  devtools: HTMLIFrameElement,
  frontendOrigin: string,
  onMetrics: (metrics: DeviceMetrics | null) => void
): () => void {
  const relay = new ShellRelay(page, devtools, frontendOrigin, onMetrics);
  window.addEventListener('message', relay.onMessage);
  page.contentWindow?.postMessage(PING, location.origin);
  return () => window.removeEventListener('message', relay.onMessage);
}
