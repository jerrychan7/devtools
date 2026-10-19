import type { Protocol } from 'devtools-protocol';
import type { CdpServer } from '../core/server';

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
  Emulation: ['setEmulatedMedia', 'setAutoDarkModeOverride', 'setEmulatedVisionDeficiency', 'setFocusEmulationEnabled'],
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
  ],
  Network: ['overrideNetworkState', 'enableReportingApi'],
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
    'untrackCacheStorageForOrigin',
    'untrackCacheStorageForStorageKey',
    'untrackIndexedDBForOrigin',
    'untrackIndexedDBForStorageKey',
  ],
  Target: ['setAutoAttach', 'setDiscoverTargets', 'setRemoteLocations'],
  WebMCP: ['enable'],
};

export function registerStubs(server: CdpServer) {
  for (const [domain, methods] of Object.entries(NOOPS)) {
    server.register(domain, Object.fromEntries(methods.map(method => [method, () => {}])));
  }
  // Throttling cannot be emulated in the page: the rules are accepted but never applied.
  server.register('Network', {
    emulateNetworkConditionsByRule: (params: Protocol.Network.EmulateNetworkConditionsByRuleRequest) => ({
      ruleIds: params.matchedNetworkConditions.map((_, i) => `rule-${i}`),
    }),
  });
  // Feature flags of the browser are not readable from the page: report them as off.
  server.register('SystemInfo', {
    getFeatureState: (): Protocol.SystemInfo.GetFeatureStateResponse => ({ featureEnabled: false }),
  });
  // COOP, COEP and CSP are response headers of the document, unknown to the page.
  server.register('Network', {
    getSecurityIsolationStatus: (): Protocol.Network.GetSecurityIsolationStatusResponse => ({ status: {} }),
  });
  // env() values are not readable from the page.
  server.register('CSS', { getEnvironmentVariables: () => ({ environmentVariables: {} }) });
}
