// Copyright 2026 jerrychan7. MIT license.
//
// DevTools for a page that inspects itself (devtools-anywhere): only the panels that work
// against the in-page CDP agent, connected to the embedding window through postMessage, or
// through a remote debugging server.

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

import {type DockSide, type EmbedderRequest, type FrontendHash, OWN_SCRIPTS, REQUEST_KEY} from './embedder.js';
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
// The embedder passes its origin as `#?embedded=<origin>`; messages go only there. Without it,
// only an embedder of the frontend's own origin is trusted, never any page that frames it.
const params = new URLSearchParams(location.hash.replace(/^#\??/, ''));
/** One of the embedder's hash parameters (embedder.ts). */
const param = (name: keyof FrontendHash): string|null => params.get(name);
const embedder = param('embedded') ?? location.origin;
const host = Host.InspectorFrontendHost.InspectorFrontendHostInstance;
host.isHostedMode = () => false;
host.sendMessageToBackend = (message: string) => window.parent.postMessage(message, embedder);

// Docking: the main menu's "Dock side" moves the panel in the embedding page, which owns the
// side (`#?dock=`, the side it shows the panel on now). The requests and the hash parameters are
// embedder.ts, copied in from packages/devtools-anywhere.
// Our dock sides are Chromium's dock states: this fails to compile when either changes.
const DOCK_SIDE_OF: Record<UI.DockController.DockState, DockSide>&Record<DockSide, `${UI.DockController.DockState}`> = {
  bottom: 'bottom',
  right: 'right',
  left: 'left',
  undocked: 'undocked',
};
// Remote debugging (packages/remote-server): DevTools is a page of its own, connected to the
// relay with upstream's `?ws=`/`?wss=` (its WebSocket transport), and there is no embedder.
// A frontend hosted elsewhere (a CDN) is given them as `#?ws=`/`#?wss=`, so that the socket's token
// is not sent there: upstream reads only the query, which they are copied to.
for (const name of ['ws', 'wss']) {
  const value = params.get(name);
  if (value && !Root.Runtime.Runtime.queryParam(name)) {
    Root.Runtime.Runtime.setQueryParamForTesting(name, value);
  }
}
const remote = Boolean(Root.Runtime.Runtime.queryParam('ws') || Root.Runtime.Runtime.queryParam('wss'));
const notifyEmbedder = (request: EmbedderRequest) => {
  if (!remote) {
    window.parent.postMessage({[REQUEST_KEY]: request}, embedder);
  }
};
if (!remote) {
  Root.Runtime.Runtime.setQueryParamForTesting('can_dock', 'true');
}
// The page's debugger cannot pause (Debugger.setBreakpointByUrl only hands out ids): the Sources
// panel leaves out the parts of its debugger sidebar that need a pause (pause and step buttons,
// Breakpoints with "Pause on exceptions", Call Stack, Scope, Threads) and its breakpoint gutter;
// Watch stays, evaluating in the global scope (patches/sources-without-pausing.patch).
Root.Runtime.Runtime.setQueryParamForTesting('can_pause', 'false');
const dock = param('dock');

// devtools-anywhere's own scripts (the probe, the bundle, snapDOM) are listed in Sources, since
// they hook globals the page uses, but ignore-listed like extension scripts in Chrome: their stack
// frames collapse, and "Hide ignore-listed sources" hides them. The rule is added once, so the
// user can still remove it.
const IGNORE_LIST = 'skip-stack-frames-pattern';
const IGNORE_LIST_SEEDED = 'devtools-anywhere-ignore-list-seeded';
const OWN_SCRIPTS_PATTERN = `/(${OWN_SCRIPTS.map(file => file.replaceAll('.', '\\.')).join('|')})$`;
function withOwnScriptsIgnored(prefs: Record<string, string>): Record<string, string> {
  if (prefs[IGNORE_LIST_SEEDED]) {
    return prefs;
  }
  let rules: unknown;
  try {
    rules = JSON.parse(prefs[IGNORE_LIST] ?? '');
  } catch {
    // Never set: the setting's default, as RegExpSetting stores it. models/workspace's
    // bundle is not visible to this entrypoint, so the default is spelled out here.
    rules = [{pattern: '/node_modules/|^node:'}];
  }
  const value = JSON.stringify([...(Array.isArray(rules) ? rules : []), {pattern: OWN_SCRIPTS_PATTERN, disabled: false}]);
  host.setPreference(IGNORE_LIST, value);
  host.setPreference(IGNORE_LIST_SEEDED, 'true');
  return {...prefs, [IGNORE_LIST]: value, [IGNORE_LIST_SEEDED]: 'true'};
}

const getPreferences = host.getPreferences.bind(host);
host.getPreferences = callback => getPreferences(prefs => {
  const seeded = withOwnScriptsIgnored(prefs);
  callback(dock ? {...seeded, currentDockState: JSON.stringify(dock)} : seeded);
});
host.setIsDocked = (_isDocked: boolean, callback: () => void) => {
  const side = UI.DockController.DockController.instance().dockSide();
  if (side) {
    notifyEmbedder({type: 'dock', side: DOCK_SIDE_OF[side]});
  }
  setTimeout(callback, 0);
};
host.closeWindow = () => notifyEmbedder({type: 'close'});

// Main toolbar, left of the settings button: keeping DevTools open across reloads (the
// embedder's shell mode, `#?keep=` says whether it is available and `#?shell=` whether it is
// on), and upstream's reload action. A dialog explains the mode before the page reloads into
// it (tooltips need a mouse), and an info bar says when it is on.
const canKeepOpen = param('keep') === '1';
const keptOpen = param('shell') === '1';

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
    // Escape closes the dialog without any of the callbacks above.
    dialog.setOnHideCallback(() => resolve(false));
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
  if (remote || event.source !== window.parent || typeof event.data !== 'string' ||
      (embedder !== '*' && event.origin !== embedder)) {
    return;
  }
  host.events.dispatchEventToListeners(Host.InspectorFrontendHostAPI.Events.DispatchMessage, event.data);
});

// Chrome gives DevTools its theme colors through devtools://theme/colors.css, which a page
// cannot load: the frontend then never learns which theme is on, and shows the colors of a
// dynamic theme (blue-tinted surfaces). Here the page names Chrome's default theme itself and
// the request is reported as loaded, which gives Chrome's default look: the palette's
// fallbacks are its colors.
const defaultTheme = document.createElement('style');
defaultTheme.textContent = ':root { --user-color-source: baseline-default; }';
document.head.append(defaultTheme);
// The link is added once, at startup: watching stops then, not to run on every node DevTools adds.
const themeColorsObserver = new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof HTMLLinkElement && node.href.startsWith('devtools://theme/colors.css')) {
        node.dispatchEvent(new Event('load'));
        themeColorsObserver.disconnect();
      }
    }
  }
});
themeColorsObserver.observe(document, {childList: true, subtree: true});

// The embedder's bar sits on top of the toolbar: it takes the toolbar's colors, sent whenever
// the theme is applied (which sets classes on the root element).
let reportedTheme = '';
new MutationObserver(() => {
  const style = getComputedStyle(document.documentElement);
  const theme = {
    type: 'theme' as const,
    toolbar: style.getPropertyValue('--app-color-toolbar-background').trim(),
    divider: style.getPropertyValue('--sys-color-divider').trim(),
    icon: style.getPropertyValue('--sys-color-on-surface-subtle').trim(),
  };
  if (theme.toolbar && JSON.stringify(theme) !== reportedTheme) {
    reportedTheme = JSON.stringify(theme);
    notifyEmbedder(theme);
  }
}).observe(document.documentElement, {attributes: true, attributeFilter: ['class']});

// Context menus: outside hosted mode the frontend asks the host for a native menu, which no
// embedder can show. Switch to the DOM-drawn ("soft") menus the way Chrome does, right after
// ContextMenu starts listening for the switch.
const initializeContextMenu = UI.ContextMenu.ContextMenu.initialize;
UI.ContextMenu.ContextMenu.initialize = () => {
  initializeContextMenu();
  host.events.dispatchEventToListeners(Host.InspectorFrontendHostAPI.Events.SetUseSoftMenu, true);
};

// @ts-expect-error Exposed like in devtools_app, for parity.
self.runtime = Root.Runtime.Runtime.instance({forceNew: true});
new Main.MainImpl.MainImpl();

/**
 * The modules the end-to-end tests reach into, by their path in front_end: the built frontend is
 * bundled, so they are not files of their own (each import resolves to the chunk that holds it).
 */
export const modules: Record<string, () => Promise<unknown>> = {
  'core/common/common.js': () => import('../../core/common/common.js'),
  'core/host/host.js': () => import('../../core/host/host.js'),
  'models/breakpoints/breakpoints.js': () => import('../../models/breakpoints/breakpoints.js'),
  'models/workspace/workspace.js': () => import('../../models/workspace/workspace.js'),
  'panels/console/console.js': () => import('../../panels/console/console.js'),
  'ui/legacy/legacy.js': () => import('../../ui/legacy/legacy.js'),
};
