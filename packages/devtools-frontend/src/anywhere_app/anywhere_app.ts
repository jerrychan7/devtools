// Copyright 2026 jerrychan7. MIT license.
//
// DevTools for a page that inspects itself (devtools-anywhere): only the panels that work
// against the in-page CDP server, connected to the embedding window through postMessage.

import '../../Images/Images.js';
import '../../ui/dom_extension/dom_extension.js';
import '../main/main-meta.js';
import '../inspector_main/inspector_main-meta.js';
import '../../panels/common/common-meta.js';
import '../../panels/console/console-meta.js';
import '../../panels/console_counters/console_counters-meta.js';
import '../../panels/elements/elements-meta.js';
import '../../panels/sources/sources-meta.js';
import '../../panels/network/network-meta.js';
import '../../panels/application/application-meta.js';
import '../../panels/settings/settings-meta.js';
import '../../ui/legacy/components/perf_ui/perf_ui-meta.js';
import '../../ui/legacy/components/quick_open/quick_open-meta.js';
import '../../ui/legacy/components/source_frame/source_frame-meta.js';

import * as Host from '../../core/host/host.js';
import * as Root from '../../core/root/root.js';
import * as Main from '../main/main.js';

// The embedder is the parent window: CDP messages travel as strings through postMessage,
// in place of Chrome's native DevToolsHost bindings. Every other host method keeps the
// hosted-mode stub implementation (preferences in localStorage, no file system, …).
// The embedder passes its origin as `#?embedded=<origin>`; messages go only there.
const embedder = new URLSearchParams(location.hash.replace(/^#\??/, '')).get('embedded') ?? '*';
const host = Host.InspectorFrontendHost.InspectorFrontendHostInstance;
host.isHostedMode = () => false;
host.sendMessageToBackend = (message: string) => window.parent.postMessage(message, embedder);
window.addEventListener('message', event => {
  if (event.source !== window.parent || typeof event.data !== 'string' ||
      (embedder !== '*' && event.origin !== embedder)) {
    return;
  }
  host.events.dispatchEventToListeners(Host.InspectorFrontendHostAPI.Events.DispatchMessage, event.data);
});

// @ts-expect-error Exposed like in devtools_app, for parity.
self.runtime = Root.Runtime.Runtime.instance({forceNew: true});
new Main.MainImpl.MainImpl();
