// Entry of probe.iife.js: installs the probe as soon as the script runs.
import { installProbe } from './index';

const probe = installProbe();
// The probe's own request is DevTools', not the page's: left out of the Network panel.
const script = document.currentScript;
if (script instanceof HTMLScriptElement && script.src) probe.ownUrls.add(script.src);
