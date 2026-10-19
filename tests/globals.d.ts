// Globals the tests read and write inside test pages (through page.evaluate).
// Types come from the built packages (`pnpm build`), like the code the pages load.
import type { CdpServer, Probe, createCdpServer } from '@devtools-anywhere/cdp-server';

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
    /** devtools-anywhere.iife.js (the parts the tests use) */
    DevtoolsAnywhere: {
      createCdpServer: typeof createCdpServer;
      connectFrontend(server: CdpServer, frame: HTMLIFrameElement, frontendOrigin: string): () => void;
    };
    __devtoolsAnywhereProbe__?: Probe;
    /** The harness's CDP server in the page, and the events it emitted. */
    __server: CdpServer;
    __ours: { method: string; params: unknown }[];
    /** Messages the fake frontend received. */
    received?: ReceivedMessage[];
    /** Markers set by test pages and fixtures. */
    __pageScriptRan?: boolean;
    __frame?: HTMLIFrameElement;
    __hacked?: number;
    __fireOnce?: () => boolean;
    resourceLoaded?: boolean;
  }
}
