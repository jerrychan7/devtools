// The relay's own messages, between a page and the relay (shell mode's or the remote server's):
// JSON objects whose method is in the DevtoolsAnywhere namespace, which no CDP domain uses.

/** Sent by the page when it connects, and again when what the target list shows changes. */
export const HELLO_METHOD = 'DevtoolsAnywhere.hello';
/** Sent by the page on pagehide: the commands it did not answer never will be. */
export const PAGEHIDE_METHOD = 'DevtoolsAnywhere.pagehide';
/** Sent to the page when a session ends: its CDP session stops (its domains are disabled). */
export const DETACH_METHOD = 'DevtoolsAnywhere.detach';
/**
 * Sent to the page when a session starts (the remote server's): a client's attach time, which
 * orders device metrics overrides after a reload as in Chrome.
 */
export const ATTACH_METHOD = 'DevtoolsAnywhere.attach';
/** Sent by the shell on startup, in case the page started listening first: the page says hello. */
export const PING_METHOD = 'DevtoolsAnywhere.ping';
/**
 * Between a page in shell mode and the shell: a client of the page's CDP agent sets
 * (`metrics`, its Emulation.setDeviceMetricsOverride params) or clears (`metrics` null) the
 * page's size, which is the shell's (shell-layout.ts). The shell answers with the same method and
 * the request's `id` alone.
 */
export const METRICS_METHOD = 'DevtoolsAnywhere.metrics';
/** The code the remote server closes a page's connection with when another page took its id. */
export const REPLACED_CLOSE_CODE = 4001;

/** A hello's params. In shell mode the page sends only its loader id. */
export interface HelloParams {
  loaderId: string;
  frameId: string;
  url: string;
  title: string;
  favicon: string;
  userAgent: string;
  /** Whether the page is a secure context. */
  secure: boolean;
  /** The sessions the page still has CDP sessions for, for a new relay to end those it does not know. */
  sessions: string[];
}

/**
 * An attach's or a detach's params: the session that started or ended, as the relay or the page's
 * hello named it.
 */
export interface DetachParams {
  session: number | string;
}

/** A metrics request's params; its answer has the `id` alone. */
export interface MetricsParams {
  id: number;
  /** The client, unique across the page's instances. */
  client: string;
  metrics: object | null;
  /**
   * The client only attached (true: the shell notes when) or its session ended (false: the shell
   * forgets it, its override cleared before), and leaves overrides as they are.
   */
  attach?: boolean;
}
