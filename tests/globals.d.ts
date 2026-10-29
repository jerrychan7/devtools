// Globals the tests read and write inside test pages (through page.evaluate).
// Types come straight from the devtools-anywhere sources (api.ts, cdp-agent/probe/types.ts), so
// no build is needed. Those modules export only what the other code uses, not what the tests would like:
// types they do not export are derived from those they do.
import type { DevtoolsAnywhereApi } from '../packages/devtools-anywhere/src/api.ts';
import type { Probe } from '../packages/devtools-anywhere/src/cdp-agent/probe/types.ts';

type CdpSession = ReturnType<DevtoolsAnywhereApi['createCdpSession']>;

declare global {
  /** A CDP message as the fake frontends receive it (parsed JSON). */
  interface ReceivedMessage {
    id?: number;
    result?: unknown;
    method?: string;
    params?: unknown;
  }

  /** The <devtools-anywhere> element: it has no API of its own. */
  type DevtoolsAnywhereElement = HTMLElement;

  interface HTMLElementTagNameMap {
    'devtools-anywhere': DevtoolsAnywhereElement;
  }

  interface Window {
    /** devtools-anywhere.iife.js */
    DevtoolsAnywhere: DevtoolsAnywhereApi;
    __devtoolsAnywhereProbe__?: Probe;
    /** The harness's CDP session in the page, and the events it emitted. */
    __session: CdpSession;
    __ours: { method: string; params: unknown }[];
    /** More CDP sessions in the page (multi-session.test.ts). */
    __sessions?: CdpSession[];
    /** A CDP session with a stand-in snapDOM, the frames it sent and the scales it rendered at. */
    __screencast?: {
      session: CdpSession;
      frames: { sessionId: number; data: string; deviceWidth: number }[];
      scales: number[];
    };
    /** Page.screencastFrame messages the real frontend received. */
    __screencastFrames?: number;
    /** Input events the input conformance page saw, as `type:targetId`. */
    __inputEvents?: string[];
    /** Messages the fake frontend received. */
    received?: ReceivedMessage[];
    /** The real frontend's postMessage targets, the page's original postMessage, and the messages the frontend dispatched. */
    __targets?: string[];
    __postMessage?: typeof window.postMessage;
    __received?: unknown[];
    /** Markers set by test pages and fixtures. */
    __pageScriptRan?: boolean;
    __frame?: HTMLIFrameElement;
    __hacked?: number;
    __fireOnce?: () => boolean;
    /** The aria-expanded values a toggler took, and the shell element's state listeners (toggler.test.ts). */
    __toggles?: string[];
    __toggleListeners?: Set<unknown>;
    /** Clicks the page's button got, and the removed <devtools-anywhere> (disconnect.test.ts). */
    __clicks?: number;
    __devtools?: DevtoolsAnywhereElement;
    resourceLoaded?: boolean;
  }
}
