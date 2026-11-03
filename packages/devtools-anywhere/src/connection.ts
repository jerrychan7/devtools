import { END_SESSION_CALLS, FRAME_ID, LOADER_ID, isShellPage, type CdpSession } from './cdp-agent';
import {
  DETACH_METHOD,
  HELLO_METHOD,
  METRICS_METHOD,
  PING_METHOD,
  RelayCore,
  parse,
  type DetachParams,
  type Frame,
  type HelloParams,
  type MetricsParams,
  type Session,
} from '@devtools-anywhere/relay-core';

/**
 * Sent by a page in shell mode when its CDP session starts listening, or when pinged. Carries
 * the page's loader id, which the shell needs for the `Page.frameNavigated` it reports.
 */
const HELLO = JSON.stringify({ method: HELLO_METHOD, params: { loaderId: LOADER_ID } satisfies Partial<HelloParams> });
/** Sent by the shell on startup, in case the page started listening first. */
const PING = JSON.stringify({ method: PING_METHOD });
/** The start of the shell's detach (the relay's own message): its frontend reloaded. */
const DETACH_PREFIX = `{"method":"${DETACH_METHOD}"`;
/** The start of a metrics request or answer (the relay's own message), between the page and the shell. */
const METRICS_PREFIX = `{"method":"${METRICS_METHOD}"`;

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
 * Incoming messages wait for `after`, if given. `onNewInstance`, if given, is called before the
 * first message of a new instance of the peer, told by its command ids starting again.
 */
function link(
  session: CdpSession,
  peer: () => Window | null | undefined,
  origin: string,
  after?: Promise<void>,
  onDetach?: () => void,
  onNewInstance?: () => void
): Link {
  let ready = false;
  /** The highest command id the peer sent: a new instance numbers its commands from 1 again. */
  let lastId = 0;
  const queue: string[] = [];
  const post = (message: string) => peer()?.postMessage(message, origin);

  const offServer = session.onMessage(message => {
    if (ready) post(message);
    else queue.push(message);
  });
  const onMessage = (event: MessageEvent) => {
    if (event.source !== peer() || event.origin !== origin || typeof event.data !== 'string') return;
    if (event.data === PING) return post(HELLO);
    if (onDetach && event.data.startsWith(DETACH_PREFIX)) return onDetach();
    if (event.data.startsWith(METRICS_PREFIX)) return;
    if (onNewInstance) {
      const id = Number(/^\{"id":(\d+)/.exec(event.data)?.[1] ?? Number.NaN);
      if (id <= lastId) onNewInstance();
      if (id > 0) lastId = id;
    }
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
  await Promise.all(END_SESSION_CALLS.map(method => session.call(method).catch(() => {})));
}

/** For each session, the end of its last frontend's session: the next frontend's messages wait for it. */
const ending = new WeakMap<CdpSession, Promise<void>>();

/**
 * Connects a CDP session to a DevTools frontend running in `frame`. When the frame reloads
 * (a new frontend instance), the domains are disabled so that the new instance's `enable`
 * calls replay everything captured so far. The new instance is told by its command ids starting
 * again, as in shell mode: the frame's load event comes after its first commands. Returns a function that disconnects, and undoes what
 * the frontend did to the page.
 */
export function connectFrontend(session: CdpSession, frame: HTMLIFrameElement, frontendOrigin: string): () => void {
  // The previous frontend's session ends (and resets) before this one's first message.
  const connection: Link = link(
    session,
    () => frame.contentWindow,
    frontendOrigin,
    ending.get(session),
    undefined,
    () => {
      // A new session, as on disconnect: the new instance's messages wait for its end.
      const ended = endSession(session).then(() => session.reset());
      ending.set(session, ended);
      connection.reset(ended);
    }
  );
  return () => {
    connection.disconnect();
    // Nothing the frontend asked for outlives it: inspect mode, highlights, forced states, the
    // screencast. What the probe captured stays, for the next frontend.
    ending.set(
      session,
      endSession(session).then(() => session.reset())
    );
  };
}

/**
 * Connects the CDP session of a page in shell mode to the shell (its parent window). When the
 * shell's frontend reloads (a new frontend instance), the shell says so and the session ends, as
 * for an embedded frontend: the new instance's messages wait for its end.
 */
export function connectToShell(session: CdpSession): () => void {
  const connection = link(
    session,
    () => window.parent,
    location.origin,
    undefined,
    () => connection.reset(endSession(session).then(() => session.reset()))
  );
  window.parent.postMessage(HELLO, location.origin);
  return () => connection.disconnect();
}

/** How long a client waits for the shell to answer a metrics request. */
const METRICS_TIMEOUT = 2000;
/** CDP sessions given the shell's device metrics so far, and metrics requests sent. */
let metricsClients = 0;
let metricsCalls = 0;
/** The answers awaited from the shell, by request id. */
const metricsAnswers = new Map<number, () => void>();

function onMetricsAnswer(event: MessageEvent) {
  if (event.source !== window.parent || event.origin !== location.origin || typeof event.data !== 'string') return;
  if (!event.data.startsWith(METRICS_PREFIX)) return;
  const params: unknown = parse(event.data)?.params;
  const id: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, 'id') : undefined;
  if (typeof id === 'number') metricsAnswers.get(id)?.();
}

/**
 * In shell mode, has `session` answer Emulation.setDeviceMetricsOverride and
 * clearDeviceMetricsOverride by asking the shell, whose page size it is (shell-layout.ts), as
 * Chrome's browser does for every client of the page; its override ends with its session.
 * Elsewhere the page cannot resize itself: the methods stay unknown. Returns `session`.
 */
export function emulateInShell(session: CdpSession): CdpSession {
  if (!isShellPage()) return session;
  if (!metricsClients) window.addEventListener('message', onMetricsAnswer);
  const client = `${LOADER_ID}:${++metricsClients}`;
  const ask = (metrics: object | null) =>
    new Promise<void>((resolve, reject) => {
      const id = ++metricsCalls;
      const timer = setTimeout(() => {
        metricsAnswers.delete(id);
        reject(new Error('The shell did not answer'));
      }, METRICS_TIMEOUT);
      metricsAnswers.set(id, () => {
        clearTimeout(timer);
        metricsAnswers.delete(id);
        resolve();
      });
      const params: MetricsParams = { id, client, metrics };
      window.parent.postMessage(JSON.stringify({ method: METRICS_METHOD, params }), location.origin);
    });
  session.register('Emulation', {
    setDeviceMetricsOverride: (params: object) => ask(params),
    clearDeviceMetricsOverride: () => ask(null),
  });
  session.onReset(() => void ask(null).catch(() => {}));
  return session;
}

/** The page's size in device mode, in CSS pixels (0 for "as laid out"), and its scale. */
export interface DeviceMetrics {
  width: number;
  height: number;
  scale: number;
}

/** The shell frontend's key among the clients overriding the device metrics. */
const FRONTEND = 'frontend';

/** The shell's side of the relay core: one frontend, in an iframe; the page in another. */
class ShellRelay extends RelayCore {
  /**
   * The clients whose device metrics override is on: the frontend (FRONTEND), and the page's
   * other clients (emulateInShell). As in Chrome, the page has one override, the last set; a
   * client's clear, or its session's end, clears it if that client's own is on, whoever set it last.
   */
  private readonly overriding = new Set<string>();
  /** The page instance whose clients are in `overriding`. */
  private metricsLoader = '';
  private frontendReady = false;
  /** Hellos without a loader id so far. */
  private unknownLoaders = 0;
  private readonly toFrontend: string[] = [];
  private session: Session;
  /** The highest command id the frontend sent: a new frontend instance numbers its commands from 1 again. */
  private lastId = 0;
  private readonly page: HTMLIFrameElement;
  private readonly devtools: HTMLIFrameElement;
  private readonly frontendOrigin: string;
  private readonly onMetrics: (metrics: DeviceMetrics | null) => void;

  constructor(
    page: HTMLIFrameElement,
    devtools: HTMLIFrameElement,
    frontendOrigin: string,
    onMetrics: (metrics: DeviceMetrics | null) => void
  ) {
    super();
    this.page = page;
    this.devtools = devtools;
    this.frontendOrigin = frontendOrigin;
    this.onMetrics = onMetrics;
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
    // The page of shell mode is the shell's same-origin iframe, never linked to a parent of
    // another origin (frame-links/): its top frame keeps the first id.
    return { id: FRAME_ID, url, secure };
  }

  private onPagehide = () => this.pagehide();

  /**
   * A new frontend instance (the frontend frame reloaded) is a new session, as in Chrome: the page
   * ends the last one's (what it enabled, its objects and node ids, its child targets), so that
   * the new one's enables report everything again and its auto-attach announces the cross-origin
   * iframes again.
   */
  private newFrontend() {
    this.closeSession(this.session);
    this.setMetrics(FRONTEND, null);
    this.sendOwn(
      JSON.stringify({ method: DETACH_METHOD, params: { session: this.session.id } satisfies DetachParams })
    );
    this.session = this.openSession({ send: message => this.postFrontend(message) });
  }

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
    this.setMetrics(FRONTEND, method === 'Emulation.clearDeviceMetricsOverride' ? null : (params ?? {}));
    this.postFrontend(JSON.stringify({ id: message?.id, result: {} }));
    return true;
  }

  /** Sets `client`'s override to `params` (Emulation.setDeviceMetricsOverride's), or clears it (null). */
  private setMetrics(client: string, params: unknown) {
    if (params === null) {
      if (this.overriding.delete(client)) this.onMetrics(null);
      return;
    }
    const number = (name: string) => {
      const value: unknown = typeof params === 'object' ? Reflect.get(params, name) : undefined;
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };
    this.overriding.add(client);
    this.onMetrics({ width: number('width'), height: number('height'), scale: number('scale') || 1 });
  }

  readonly onMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    if (event.source === this.devtools.contentWindow && event.origin === this.frontendOrigin) {
      if (!this.frontendReady) {
        this.frontendReady = true;
        this.toFrontend.splice(0).forEach(message => this.postFrontend(message));
      }
      // The frame's load comes after the new instance's first commands, so it is told by these:
      // its numbers start again.
      const id = Number(/^\{"id":(\d+)/.exec(event.data)?.[1] ?? Number.NaN);
      if (id <= this.lastId) this.newFrontend();
      if (id > 0) this.lastId = id;
      if (!this.emulate(event.data)) this.clientMessage(this.session, event.data);
    } else if (event.source === this.page.contentWindow && event.origin === location.origin) {
      if (event.data.startsWith(`{"method":"${HELLO_METHOD}"`)) {
        const params = parse(event.data)?.params;
        const field = (name: keyof HelloParams): unknown =>
          typeof params === 'object' && params !== null ? Reflect.get(params, name) : undefined;
        const sent = field('loaderId');
        // A page without one (an older probe) is a new instance every time, as it always was.
        const loaderId = typeof sent === 'string' ? sent : `unknown-${++this.unknownLoaders}`;
        // A new page instance: its CDP sessions, and their overrides, are new.
        if (loaderId !== this.metricsLoader) {
          this.metricsLoader = loaderId;
          for (const client of this.overriding) if (client !== FRONTEND) this.setMetrics(client, null);
        }
        this.page.contentWindow?.addEventListener('pagehide', this.onPagehide);
        return this.hello(loaderId);
      }
      if (event.data.startsWith(METRICS_PREFIX)) {
        const params: unknown = parse(event.data)?.params;
        const field = (name: keyof MetricsParams): unknown =>
          typeof params === 'object' && params !== null ? Reflect.get(params, name) : undefined;
        const id = field('id');
        const metrics = field('metrics');
        this.setMetrics(String(field('client')), typeof metrics === 'object' ? metrics : null);
        const answer = { method: METRICS_METHOD, params: { id } };
        return this.page.contentWindow?.postMessage(JSON.stringify(answer), location.origin);
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
