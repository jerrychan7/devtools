// Entry of devtools-anywhere.iife.js: installs the probe (if probe.iife.js did not run
// earlier), registers <devtools-anywhere>, and exposes the API as `window.DevtoolsAnywhere`.
// Inside the page iframe of shell mode, it connects the page's CDP server to the shell.
import { createCdpServer, installProbe, isShellPage } from '@devtools-anywhere/cdp-server';
import {
  DevtoolsAnywhereElement,
  connectFrontend,
  connectToShell,
  defineDevtoolsAnywhere,
  setBundleUrl,
} from './index';

const w = window as any;
// The probe loads this bundle inside the shell's page iframe, and the page may load it
// again itself: only the first copy runs.
if (!w.DevtoolsAnywhere) {
  const probe = installProbe();
  const script = document.currentScript as HTMLScriptElement | null;
  if (script?.src) {
    setBundleUrl(script.src);
    // DevTools' own code is not one of the page's requests.
    probe.ownUrls.add(script.src);
  }
  defineDevtoolsAnywhere();
  if (isShellPage()) connectToShell(createCdpServer());
  w.DevtoolsAnywhere = { DevtoolsAnywhereElement, connectFrontend, createCdpServer, defineDevtoolsAnywhere };
}
