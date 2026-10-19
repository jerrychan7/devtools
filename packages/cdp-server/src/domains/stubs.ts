import type { CdpServer } from '../core/server'

/**
 * Commands the frontend sends at startup that have no in-page equivalent (or are not
 * implemented yet). Answering them with an empty result keeps the frontend happy.
 */
const NOOPS: Record<string, string[]> = {
  Audits: ['enable'],
  Autofill: ['enable', 'setAddresses'],
  BackgroundService: ['startObserving'],
  Database: ['enable'],
  Emulation: [
    'setEmulatedMedia',
    'setAutoDarkModeOverride',
    'setEmulatedVisionDeficiency',
    'setFocusEmulationEnabled',
    'setTouchEmulationEnabled',
    'setEmitTouchEventsForMouse',
  ],
  HeapProfiler: ['enable'],
  Inspector: ['enable'],
  Log: ['enable', 'clear', 'startViolationsReport'],
  Overlay: [
    'highlightFrame',
    'setPausedInDebuggerMessage',
    'setShowGridOverlays',
    'setShowFlexOverlays',
    'setShowScrollSnapOverlays',
    'setShowContainerQueryOverlays',
    'setShowIsolatedElements',
    'setShowViewportSizeOnResize',
  ],
  Profiler: ['enable'],
  ServiceWorker: ['enable'],
  Storage: ['trackCacheStorageForOrigin', 'trackIndexedDBForOrigin', 'trackIndexedDBForStorageKey'],
  Target: ['setAutoAttach', 'setDiscoverTargets', 'setRemoteLocations'],
}

export function registerStubs(server: CdpServer) {
  for (const [domain, methods] of Object.entries(NOOPS)) {
    server.register(domain, Object.fromEntries(methods.map(method => [method, () => {}])))
  }
  server.register('Debugger', {
    enable: () => ({ debuggerId: 'devtools-anywhere' }),
    disable: () => {},
    setAsyncCallStackDepth: () => {},
    setBlackboxPatterns: () => {},
    setPauseOnExceptions: () => {},
    setBreakpointsActive: () => {},
  })
}
