// The API devtools-anywhere.iife.js exposes as `window.DevtoolsAnywhere`: the one definition the
// bundle (which must satisfy it), the probe (probe.iife.js, built separately, which calls it) and
// the tests share. Types only, and no source module imported, so that any of them can take it in.
import type { CdpServer, createCdpServer } from './cdp-agent';

/** How a page reaches a remote debugging server. */
export interface RemoteOptions {
  /**
   * Connect to the server's URL itself, the target in the query (`?target=<id>`), instead of to
   * `target/<id>` under it: for a server whose host routes upgrades by exact path.
   */
  singlePath?: boolean;
}

export interface DevtoolsAnywhereApi {
  DevtoolsAnywhereElement: CustomElementConstructor;
  connectFrontend(server: CdpServer, frame: HTMLIFrameElement, frontendOrigin: string): () => void;
  connectRemote(serverUrl: string, options?: RemoteOptions): () => void;
  createCdpServer: typeof createCdpServer;
  defineDevtoolsAnywhere(tag?: string): void;
}
