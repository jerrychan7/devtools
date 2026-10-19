// Entry of devtools-anywhere.iife.js: installs the probe (if probe.iife.js did not run
// earlier), registers <devtools-anywhere>, and exposes the API as `window.DevtoolsAnywhere`.
import { createCdpServer, installProbe } from '@devtools-anywhere/cdp-server'
import { DevtoolsAnywhereElement, connectFrontend, defineDevtoolsAnywhere } from './index'

installProbe()
defineDevtoolsAnywhere()
;(window as any).DevtoolsAnywhere = { DevtoolsAnywhereElement, connectFrontend, createCdpServer, defineDevtoolsAnywhere }
