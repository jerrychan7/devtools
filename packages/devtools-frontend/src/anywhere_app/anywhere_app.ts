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
const PageStrings = {
  page: 'Page',
  showPage: 'Show Page',
} as const;
const pageStr_ = i18n.i18n.registerUIStrings('panels/browser_debugger/browser_debugger-meta.ts', PageStrings);
const i18nLazyString = i18n.i18n.getLazilyComputedLocalizedString.bind(undefined, pageStr_);

// anywhere_app's own strings. Upstream has no translations for them: the build adds ours
// (anywhere_app.<locale>.json), and other languages show English.
const UIStrings = {
  /**
   * @description Title of the toolbar button and dialog that keep DevTools open when the page reloads.
   */
  keepOpen: 'Keep DevTools open across reloads',
  /**
   * @description Title of the toolbar button that stops keeping DevTools open when the page reloads.
   */
  stopKeepingOpen: 'Stop keeping DevTools open across reloads',
  /**
   * @description Explanation in the dialog shown before keeping DevTools open across reloads.
   */
  keepOpenExplanation:
      'The page reloads and runs inside a frame. Then DevTools stays open, with its logs, when the page reloads or navigates. Some things may behave differently than when the page is opened directly, such as 100vh, position: fixed and window.top.',
  /**
   * @description Checkbox in the dialog shown before keeping DevTools open across reloads.
   */
  dontAskAgain: 'Don\'t ask again',
  /**
   * @description Button in the dialog shown before keeping DevTools open across reloads.
   */
  reloadAndKeepOpen: 'Reload and keep open',
  /**
   * @description Button that closes the dialog shown before keeping DevTools open across reloads.
   */
  cancel: 'Cancel',
  /**
   * @description Info bar shown while DevTools is kept open across reloads.
   */
  keptOpen: 'DevTools stays open across reloads. The page runs inside a frame.',
  /**
   * @description Button of the info bar shown while DevTools is kept open across reloads.
   */
  stopKeeping: 'Stop keeping open',
} as const;
const str_ = i18n.i18n.registerUIStrings('entrypoints/anywhere_app/anywhere_app.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

UI.ViewManager.registerViewExtension({
  location: UI.ViewManager.ViewLocationValues.NAVIGATOR_VIEW,
  id: 'navigator-network',
  title: i18nLazyString(PageStrings.page),
  commandPrompt: i18nLazyString(PageStrings.showPage),
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
const notifyEmbedder = (request: {type: 'dock', side: string}|{type: 'close'}|{type: 'keep-open', keep: boolean}) =>
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

// Main toolbar, left of the settings button: keeping DevTools open across reloads (the
// embedder's shell mode, `#?keep=` says whether it is available and `#?shell=` whether it is
// on), and upstream's reload action. A dialog explains the mode before the page reloads into
// it (tooltips need a mouse), and an info bar says when it is on.
const canKeepOpen = params.get('keep') === '1';
const keptOpen = params.get('shell') === '1';

async function confirmKeepOpen(): Promise<boolean> {
  const confirmed = Common.Settings.Settings.instance().createSetting('anywhere-keep-open-confirmed', false);
  if (confirmed.get()) {
    return true;
  }
  const dialog = new UI.Dialog.Dialog('keep-open');
  dialog.setSizeBehavior(UI.GlassPane.SizeBehavior.MEASURE_CONTENT);
  dialog.setDimmed(true);
  const content = dialog.contentElement.createChild('div');
  content.style.cssText = 'display: flex; flex-direction: column; gap: 12px; padding: 16px; max-width: 420px;';
  const header = content.createChild('div');
  header.style.cssText = 'font-size: 14px; font-weight: 500;';
  header.textContent = i18nString(UIStrings.keepOpen);
  content.createChild('div').textContent = i18nString(UIStrings.keepOpenExplanation);
  const dontAsk = UI.UIUtils.CheckboxLabel.create(i18nString(UIStrings.dontAskAgain), false);
  content.appendChild(dontAsk);
  const buttons = content.createChild('div');
  buttons.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px;';
  const result = await new Promise<boolean>(resolve => {
    buttons.appendChild(UI.UIUtils.createTextButton(i18nString(UIStrings.cancel), () => resolve(false)));
    const ok = UI.UIUtils.createTextButton(
        i18nString(UIStrings.reloadAndKeepOpen), () => resolve(true), {jslogContext: 'confirm'});
    buttons.appendChild(ok);
    dialog.setOutsideClickCallback(event => {
      event.consume();
      resolve(false);
    });
    dialog.show();
    ok.focus();
  });
  dialog.hide();
  if (result && dontAsk.checked) {
    confirmed.set(true);
  }
  return result;
}

function showKeptOpenInfobar(): void {
  const inspectorView = UI.InspectorView.InspectorView.maybeGetInspectorViewInstance();
  if (!inspectorView) {
    return;
  }
  const infobar = new UI.Infobar.Infobar(
      UI.Infobar.Type.INFO, i18nString(UIStrings.keptOpen), [{
        text: i18nString(UIStrings.stopKeeping),
        delegate: () => notifyEmbedder({type: 'keep-open', keep: false}),
        dismiss: true,
        jslogContext: 'stop-keeping-open',
      }],
      undefined, 'kept-open');
  const container = document.createElement('div');
  container.classList.add('flex-none');
  container.appendChild(infobar.element);
  inspectorView.contentElement.prepend(container);
}

UI.Toolbar.registerToolbarItem({
  async loadItem() {
    return {
      item() {
        if (!canKeepOpen && !keptOpen) {
          return null;
        }
        const button = new UI.Toolbar.ToolbarToggle(
            i18nString(keptOpen ? UIStrings.stopKeepingOpen : UIStrings.keepOpen), 'lock', undefined, 'keep-open');
        button.setToggled(keptOpen);
        button.addEventListener(UI.Toolbar.ToolbarButton.Events.CLICK, async () => {
          if (keptOpen || await confirmKeepOpen()) {
            notifyEmbedder({type: 'keep-open', keep: !keptOpen});
          }
        });
        if (keptOpen) {
          // The toolbar is built with the inspector view, which the info bar goes into.
          setTimeout(showKeptOpenInfobar, 0);
        }
        return button;
      },
    };
  },
  order: 97,
  location: UI.Toolbar.ToolbarItemLocation.MAIN_TOOLBAR_RIGHT,
});
UI.Toolbar.registerToolbarItem({
  actionId: 'inspector-main.reload',
  order: 97.5,
  location: UI.Toolbar.ToolbarItemLocation.MAIN_TOOLBAR_RIGHT,
});
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
