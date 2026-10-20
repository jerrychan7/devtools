// Entry of probe.iife.js: installs the probe as soon as the script runs.
import { installProbe } from './index';
import { setShellScriptUrl } from './shell';

// Read while this script runs synchronously; shell configs must come from its origin.
const script = document.currentScript;
const src = script instanceof HTMLScriptElement ? script.src : '';
if (src) setShellScriptUrl(src);
const probe = installProbe();
// The probe's own request is DevTools', not the page's: left out of the Network panel.
if (src) probe.ownUrls.add(src);
