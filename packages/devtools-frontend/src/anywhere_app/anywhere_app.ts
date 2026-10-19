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
// Registers the throttling settings the Network panel's toolbar needs.
import '../../panels/mobile_throttling/mobile_throttling-meta.js';
import '../../panels/application/application-meta.js';
// The page as an image, with input forwarded to it: for when the page is not in view.
import '../../panels/screencast/screencast-meta.js';
import '../../panels/settings/settings-meta.js';
import '../../ui/legacy/components/perf_ui/perf_ui-meta.js';
import '../../ui/legacy/components/quick_open/quick_open-meta.js';
import '../../ui/legacy/components/source_frame/source_frame-meta.js';

import * as Common from '../../core/common/common.js';
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Root from '../../core/root/root.js';
import type * as Sources from '../../panels/sources/sources.js';
import * as UI from '../../ui/legacy/legacy.js';
import * as Main from '../main/main.js';

// The Sources panel's Page tab lists the page's resources. Upstream registers it in
// browser_debugger-meta, together with breakpoint panes that cannot work in the page, so it
// is registered here instead (like node_app does), reusing upstream's translated strings.
const UIStrings = {
  /**
   * @description Title of the Page tab in the Sources panel.
   */
  page: 'Page',
  /**
   * @description Command for showing the Page tab in the Sources panel.
   */
  showPage: 'Show Page',
} as const;
const str_ = i18n.i18n.registerUIStrings('panels/browser_debugger/browser_debugger-meta.ts', UIStrings);
const i18nLazyString = i18n.i18n.getLazilyComputedLocalizedString.bind(undefined, str_);

UI.ViewManager.registerViewExtension({
  location: UI.ViewManager.ViewLocationValues.NAVIGATOR_VIEW,
  id: 'navigator-network',
  title: i18nLazyString(UIStrings.page),
  commandPrompt: i18nLazyString(UIStrings.showPage),
  order: 2,
  persistence: UI.ViewManager.ViewPersistence.PERMANENT,
  async loadView(universe) {
    const SourcesModule: typeof Sources = await import('../../panels/sources/sources.js');
    return SourcesModule.SourcesNavigator.NetworkNavigatorView.instance(
        {forceNew: null, networkProjectManager: universe.networkProjectManager});
  },
});

// The page is usually in view next to DevTools, and every frame is rendered in the page:
// the screencast starts turned off (the toolbar's device button turns it on).
Common.Settings.registerSettingExtension({
  settingName: 'screencast-enabled',
  settingType: Common.Settings.SettingType.BOOLEAN,
  defaultValue: false,
});

// The embedder is the parent window: CDP messages travel as strings through postMessage,
// in place of Chrome's native DevToolsHost bindings. Every other host method keeps the
// hosted-mode stub implementation (preferences in localStorage, no file system, …).
// The embedder passes its origin as `#?embedded=<origin>`; messages go only there.
const params = new URLSearchParams(location.hash.replace(/^#\??/, ''));
const embedder = params.get('embedded') ?? '*';
const host = Host.InspectorFrontendHost.InspectorFrontendHostInstance;
host.isHostedMode = () => false;
host.sendMessageToBackend = (message: string) => window.parent.postMessage(message, embedder);

// Docking: the main menu's "Dock side" moves the panel in the embedding page, which owns the
// side (`#?dock=`, the side it shows the panel on now). Requests to the embedder are objects,
// so they never mix with CDP messages, which are strings.
const notifyEmbedder = (request: {type: 'dock', side: string}|{type: 'close'}) =>
    window.parent.postMessage({devtoolsAnywhere: request}, embedder);
Root.Runtime.Runtime.setQueryParamForTesting('can_dock', 'true');
const dock = params.get('dock');
if (dock) {
  const getPreferences = host.getPreferences.bind(host);
  host.getPreferences = callback => getPreferences(prefs => callback({...prefs, currentDockState: JSON.stringify(dock)}));
}
host.setIsDocked = (_isDocked: boolean, callback: () => void) => {
  const side = UI.DockController.DockController.instance().dockSide();
  if (side) {
    notifyEmbedder({type: 'dock', side});
  }
  setTimeout(callback, 0);
};
host.closeWindow = () => notifyEmbedder({type: 'close'});
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
