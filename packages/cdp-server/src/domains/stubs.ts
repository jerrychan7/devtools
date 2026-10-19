import type { Protocol } from 'devtools-protocol'
import type { CdpServer } from '../core/server'

/**
 * Commands the frontend sends at startup that have no in-page equivalent (or are not
 * implemented yet). Answering them with an empty result keeps the frontend happy.
 */
const NOOPS: Record<string, string[]> = {
  Accessibility: ['enable'],
  Animation: ['enable'],
  Audits: ['enable'],
  Autofill: ['enable', 'setAddresses'],
  BackgroundService: ['startObserving'],
  CSS: ['trackComputedStyleUpdatesForNode'],
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
  Network: ['overrideNetworkState'],
  Preload: ['enable'],
  Profiler: ['enable'],
  ServiceWorker: ['enable'],
  Storage: [
    'trackCacheStorageForOrigin',
    'trackIndexedDBForOrigin',
    'trackIndexedDBForStorageKey',
    'setInterestGroupTracking',
    'setSharedStorageTracking',
    'setStorageBucketTracking',
  ],
  Target: ['setAutoAttach', 'setDiscoverTargets', 'setRemoteLocations'],
}

export function registerStubs(server: CdpServer) {
  for (const [domain, methods] of Object.entries(NOOPS)) {
    server.register(domain, Object.fromEntries(methods.map(method => [method, () => {}])))
  }
  // Throttling cannot be emulated in the page: the rules are accepted but never applied.
  server.register('Network', {
    emulateNetworkConditionsByRule: (params: Protocol.Network.EmulateNetworkConditionsByRuleRequest) => ({
      ruleIds: params.matchedNetworkConditions.map((_, i) => `rule-${i}`),
    }),
  })
  // env() values are not readable from the page.
  server.register('CSS', { getEnvironmentVariables: () => ({ environmentVariables: {} }) })
  server.register('Debugger', {
    enable: () => ({ debuggerId: 'devtools-anywhere' }),
    disable: () => {},
    setAsyncCallStackDepth: () => {},
    setBlackboxPatterns: () => {},
    setPauseOnExceptions: () => {},
    setBreakpointsActive: () => {},
  })
}
