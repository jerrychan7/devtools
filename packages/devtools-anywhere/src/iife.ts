// Entry of devtools-anywhere.iife.js: installs the probe (if probe.iife.js did not run
// earlier), registers <devtools-anywhere>, and exposes the API as `window.DevtoolsAnywhere`.
// Inside the page iframe of shell mode, it connects the page's CDP session to the shell and shows
// the shell element's F12 button in the page.
import { createCdpSession, installProbe, isShellPage, setShellScriptUrl } from './cdp-agent';
import { connectFrontend, connectToShell } from './connection';
import {
  createGlobalElement,
  createPageSession,
  defineDevtoolsAnywhere,
  mountShellToggler,
  setBundleUrl,
} from './element';
import type { DevtoolsAnywhereApi } from './api';
import { SNAPDOM_SCRIPT } from './embedder';
import { connectRemote } from './remote';

// The probe loads this bundle inside the shell's page iframe, and the page may load it
// again itself: only the first copy runs.
if (!('DevtoolsAnywhere' in window)) {
  const script = document.currentScript as HTMLScriptElement | null;
  // Shell configs must come from this script's origin.
  if (script?.src) setShellScriptUrl(script.src);
  const probe = installProbe();
  if (script?.src) {
    setBundleUrl(script.src);
    // DevTools' own code is not one of the page's requests.
    probe.ownUrls.add(script.src);
    probe.ownUrls.add(new URL(SNAPDOM_SCRIPT, script.src).href);
  }
  defineDevtoolsAnywhere();
  if (isShellPage()) {
    connectToShell(createPageSession());
    // The shell element's F12 button, where the page's styles reach it.
    mountShellToggler();
  }
  const api: DevtoolsAnywhereApi = {
    connectFrontend,
    connectRemote: (serverUrl, options) => connectRemote(createPageSession, serverUrl, options),
    createCdpSession,
    createGlobalElement,
  };
  Object.assign(window, { DevtoolsAnywhere: api });
}
