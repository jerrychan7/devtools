// Globals the tests read and write inside test pages (through page.evaluate).
// Types come from the built packages (`pnpm build`), like the code the pages load. Their entry
// points export only what the other packages use, not what the tests would like: types they do
// not export are derived from those they do.
import type { CdpServer, createCdpServer, installProbe } from '@devtools-anywhere/cdp-server';
import type { DevtoolsAnywhereApi } from '../packages/devtools-anywhere/src/api.ts';

type Probe = ReturnType<typeof installProbe>;

declare global {
  /** A CDP message as the fake frontends receive it (parsed JSON). */
  interface ReceivedMessage {
    id?: number;
    result?: unknown;
    method?: string;
    params?: unknown;
  }

  /** The <devtools-anywhere> element (the parts the tests use). */
  interface DevtoolsAnywhereElement extends HTMLElement {
    open: boolean;
    enterShell(): void;
    exitShell(): Promise<void>;
  }

  interface HTMLElementTagNameMap {
    'devtools-anywhere': DevtoolsAnywhereElement;
  }

  interface Window {
    /** cdp-server.iife.js */
    DevtoolsAnywhereCdp: { createCdpServer: typeof createCdpServer };
    /** devtools-anywhere.iife.js */
    DevtoolsAnywhere: DevtoolsAnywhereApi;
    __devtoolsAnywhereProbe__?: Probe;
    /** The harness's CDP server in the page, and the events it emitted. */
    __server: CdpServer;
    __ours: { method: string; params: unknown }[];
    /** A CDP server with a stand-in snapDOM, the frames it sent and the scales it rendered at. */
    __screencast?: {
      server: CdpServer;
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
    resourceLoaded?: boolean;
  }
}
