// Entry of cdp-server.iife.js: exposes the API as `window.DevtoolsAnywhereCdp`, and
// installs the probe right away in case probe.iife.js was not loaded earlier.
import { createCdpServer, installProbe } from './index';

installProbe();
Object.assign(window, { DevtoolsAnywhereCdp: { createCdpServer, installProbe } });
