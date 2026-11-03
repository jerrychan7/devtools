import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping';
import { CdpError, type CdpSession } from '../core/session';

type Command = keyof ProtocolMapping.Commands;
type DomainOf<C> = C extends `${infer D}.${string}` ? D : never;
type MethodOf<C, D extends string> = C extends `${D}.${infer M}` ? M : never;
/** Commands of each domain, so a misspelt name fails to compile. */
type CommandsByDomain = { [D in DomainOf<Command>]?: MethodOf<Command, D>[] };

/**
 * Commands that succeed without effect. Enabling a domain whose events never come is what Chrome
 * answers too, so every `enable` here is kept. The rest can be done in the page but are not yet
 * (docs/roadmap.md), so the frontend and scripts are not told they cannot.
 */
const NOOPS = {
  Accessibility: ['enable'],
  Animation: ['enable'],
  Audits: ['enable'],
  Autofill: ['enable'],
  CSS: ['trackComputedStyleUpdatesForNode'],
  // Device mode's size is the shell's (shell-layout.ts).
  Emulation: ['setEmulatedMedia', 'setEmulatedVisionDeficiency', 'setSafeAreaInsetsOverride', 'setUserAgentOverride'],
  HeapProfiler: ['enable'],
  Inspector: ['enable'],
  // The page has no browser log entries, so clearing them is done.
  Log: ['enable', 'clear', 'startViolationsReport'],
  Overlay: [
    'highlightFrame',
    // The page never pauses in a debugger, so there is no message to show.
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
} satisfies CommandsByDomain;

/** No-ops the frontend sends that this devtools-protocol version does not declare. */
const UNDECLARED_NOOPS: Record<string, string[]> = {
  Database: ['enable'],
  // No encodings override can be set, so clearing one is done.
  Network: ['clearAcceptedEncodingsOverride'],
};

/**
 * Commands a page cannot carry out, with why. They fail rather than succeed without effect; the
 * frontend does not log a server error (-32000) and none of these callers checks it.
 */
const UNSUPPORTED: Record<string, Record<string, string>> = {
  Autofill: { setAddresses: 'the browser fills forms' },
  BackgroundService: { startObserving: 'the browser records background service events' },
  Emulation: {
    setAutoDarkModeOverride: 'auto dark mode is applied by the browser',
    resetPageScaleFactor: 'the pinch zoom cannot be changed',
  },
  Network: { setBypassServiceWorker: "the page's requests go through its service worker" },
  Storage: {
    getSharedStorageMetadata: 'shared storage metadata is not readable',
    setInterestGroupTracking: 'interest groups are kept by the browser',
    setSharedStorageTracking: 'shared storage access is seen by the browser only',
  },
  Target: { setRemoteLocations: 'the browser discovers remote targets' },
};

export function registerStubs(session: CdpSession) {
  for (const [domain, methods] of [...Object.entries(NOOPS), ...Object.entries(UNDECLARED_NOOPS)]) {
    session.register(domain, Object.fromEntries(methods.map(method => [method, () => {}])));
  }
  for (const [domain, methods] of Object.entries(UNSUPPORTED)) {
    session.register(
      domain,
      Object.fromEntries(
        Object.entries(methods).map(([method, why]) => [
          method,
          () => {
            throw new CdpError(`Not supported in the page: ${why}`);
          },
        ])
      )
    );
  }
  session.register('Emulation', {
    // Not emulating is what the page does already; a page using DevTools in it loses focus to it,
    // and its :focus styles go, which nothing in the page can undo.
    setFocusEmulationEnabled: ({ enabled }: Protocol.Emulation.SetFocusEmulationEnabledRequest) => {
      if (enabled) throw new CdpError('Not supported in the page: focus is given by the browser');
    },
  });
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
  // env() values are not readable from the page.
  session.register('CSS', { getEnvironmentVariables: () => ({ environmentVariables: {} }) });
}
