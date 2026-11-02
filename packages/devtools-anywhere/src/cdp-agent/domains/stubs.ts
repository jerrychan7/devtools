import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping';
import { CdpError, type CdpSession } from '../core/session';

type Command = keyof ProtocolMapping.Commands;
type DomainOf<C> = C extends `${infer D}.${string}` ? D : never;
type MethodOf<C, D extends string> = C extends `${D}.${infer M}` ? M : never;
/** Commands of each domain, so a misspelt name fails to compile. */
type CommandsByDomain = { [D in DomainOf<Command>]?: MethodOf<Command, D>[] };

/**
 * Commands the frontend sends at startup that have no in-page equivalent (or are not
 * implemented yet). Answering them with an empty result keeps the frontend happy.
 */
const NOOPS = {
  Accessibility: ['enable'],
  Animation: ['enable'],
  Audits: ['enable'],
  Autofill: ['enable', 'setAddresses'],
  BackgroundService: ['startObserving'],
  CSS: ['trackComputedStyleUpdatesForNode'],
  // Device mode's size is the shell's (shell-layout.ts); the rest a page cannot change: the user
  // agent, safe areas, a hinge or cutout, the pinch zoom.
  Emulation: [
    'setEmulatedMedia',
    'setAutoDarkModeOverride',
    'setEmulatedVisionDeficiency',
    'setFocusEmulationEnabled',
    'setSafeAreaInsetsOverride',
    'resetPageScaleFactor',
    'setUserAgentOverride',
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
    'setShowHinge',
    'setShowDisplayCutout',
  ],
  Network: [
    'overrideNetworkState',
    'enableReportingApi',
    'setCacheDisabled',
    'setAttachDebugStack',
    'emulateNetworkConditions',
    'setBypassServiceWorker',
    'setExtraHTTPHeaders',
    'setBlockedURLs',
    'setUserAgentOverride',
  ],
  Preload: ['enable'],
  Profiler: ['enable'],
  ServiceWorker: ['enable'],
  Storage: [
    'trackCacheStorageForOrigin',
    'trackIndexedDBForOrigin',
    'trackIndexedDBForStorageKey',
    'setStorageBucketTracking',
    'untrackCacheStorageForOrigin',
    'untrackCacheStorageForStorageKey',
    'untrackIndexedDBForOrigin',
    'untrackIndexedDBForStorageKey',
  ],
  Target: ['setAutoAttach', 'setDiscoverTargets', 'setRemoteLocations'],
} satisfies CommandsByDomain;

/** No-ops the frontend sends that this devtools-protocol version does not declare. */
const UNDECLARED_NOOPS: Record<string, string[]> = {
  Database: ['enable'],
  Network: ['clearAcceptedEncodingsOverride'],
  Storage: ['setInterestGroupTracking', 'setSharedStorageTracking'],
};

export function registerStubs(session: CdpSession) {
  for (const [domain, methods] of [...Object.entries(NOOPS), ...Object.entries(UNDECLARED_NOOPS)]) {
    session.register(domain, Object.fromEntries(methods.map(method => [method, () => {}])));
  }
  session.register('Network', {
    // Throttling cannot be emulated in the page: the rules are accepted but never applied.
    emulateNetworkConditionsByRule: (params: Protocol.Network.EmulateNetworkConditionsByRuleRequest) => ({
      ruleIds: params.matchedNetworkConditions.map((_, i) => `rule-${i}`),
    }),
    // COOP, COEP and CSP are response headers of the document, unknown to the page.
    getSecurityIsolationStatus: (): Protocol.Network.GetSecurityIsolationStatusResponse => ({ status: {} }),
  });
  // Feature flags of the browser are not readable from the page: report them as off.
  session.register('SystemInfo', {
    getFeatureState: (): Protocol.SystemInfo.GetFeatureStateResponse => ({ featureEnabled: false }),
  });
  // The page cannot read its shared storage's metadata: an error rather than made-up numbers.
  session.register('Storage', {
    getSharedStorageMetadata() {
      throw new CdpError('Shared storage metadata is not available to the page');
    },
  });
  // env() values are not readable from the page.
  session.register('CSS', { getEnvironmentVariables: () => ({ environmentVariables: {} }) });
}
