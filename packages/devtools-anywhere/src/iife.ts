// Entry of devtools-anywhere.iife.js: installs the probe (if probe.iife.js did not run
// earlier), registers <devtools-anywhere>, and exposes the API as `window.DevtoolsAnywhere`.
// Inside the page iframe of shell mode, it connects the page's CDP server to the shell.
import { createCdpServer, installProbe, isShellPage, setShellScriptUrl } from '@devtools-anywhere/cdp-server';
import { connectFrontend, connectToShell } from './connection';
import { DevtoolsAnywhereElement, createPageServer, defineDevtoolsAnywhere, setBundleUrl } from './element';
import type { DevtoolsAnywhereApi } from './api';
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
    probe.ownUrls.add(new URL('snapdom.js', script.src).href);
  }
  defineDevtoolsAnywhere();
  if (isShellPage()) connectToShell(createPageServer());
  const api: DevtoolsAnywhereApi = {
    DevtoolsAnywhereElement,
    connectFrontend,
    connectRemote: (serverUrl, options) => connectRemote(createPageServer, serverUrl, options),
    createCdpServer,
    defineDevtoolsAnywhere,
  };
  Object.assign(window, { DevtoolsAnywhere: api });
}
