import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping';
import { CdpError, type CdpSession } from '../core/session';

type Command = keyof ProtocolMapping.Commands;
type DomainOf<C> = C extends `${infer D}.${string}` ? D : never;
type MethodOf<C, D extends string> = C extends `${D}.${infer M}` ? M : never;
/** Commands of each domain, so a misspelt name fails to compile. */
type CommandsByDomain = { [D in DomainOf<Command>]?: MethodOf<Command, D>[] };

/**
 * Commands that succeed without effect: they can be done in the page but are not yet
 * (docs/roadmap.md), so the frontend and scripts are not told they cannot. A domain is enabled
 * here when the page can give its events later; one whose events only the browser has fails below.
 * `Inspector` is about the connection itself, whose events come from it.
 */
const NOOPS = {
  Accessibility: ['enable'],
  // Some issues are the page's to find (docs/roadmap.md, the Issues panel).
  Audits: ['enable'],
  Animation: ['enable'],
  CSS: ['trackComputedStyleUpdatesForNode'],
  // Device mode's size is the shell's (shell-layout.ts).
  Emulation: ['setEmulatedMedia', 'setEmulatedVisionDeficiency', 'setSafeAreaInsetsOverride', 'setUserAgentOverride'],
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
    'setExtraHTTPHeaders',
    'setBlockedURLs',
    'setUserAgentOverride',
  ],
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
  // No encodings override can be set, so clearing one is done.
  Network: ['clearAcceptedEncodingsOverride'],
};

/**
 * Commands a page cannot carry out, with why. They fail rather than succeed without effect; the
 * frontend does not log a server error (-32000), and the few callers that check for one adjust what
 * they show, as noted below.
 */
const UNSUPPORTED: Record<string, Record<string, string>> = {
  Autofill: { enable: 'the browser fills forms', setAddresses: 'the browser fills forms' },
  BackgroundService: { startObserving: 'the browser records background service events' },
  // WebSQL is gone from browsers; the frontend still enables it.
  Database: { enable: 'WebSQL databases are not available' },
  Emulation: {
    setAutoDarkModeOverride: 'auto dark mode is applied by the browser',
    resetPageScaleFactor: 'the pinch zoom cannot be changed',
  },
  HeapProfiler: { enable: 'the heap is seen by the browser only' },
  Network: {
    // The frontend reads a failure as no status: the Frames view leaves the isolation section out.
    getSecurityIsolationStatus: 'COOP, COEP and CSP response headers are unknown to the page',
    setBypassServiceWorker: "the page's requests go through its service worker",
  },
  Preload: { enable: 'speculative loads are made by the browser' },
  Profiler: { enable: 'scripts are sampled by the browser' },
  Storage: {
    getSharedStorageMetadata: 'shared storage metadata is not readable',
    setInterestGroupTracking: 'interest groups are kept by the browser',
    setSharedStorageTracking: 'shared storage access is seen by the browser only',
  },
  // The bounce tracking view reads a failure as the feature being off, as it did the made-up answer.
  SystemInfo: { getFeatureState: 'feature flags of the browser are not readable' },
  Target: { setRemoteLocations: 'the browser discovers remote targets' },
};

const NO_THROTTLING = 'Not supported in the page: requests are throttled by the browser';

/** Whether conditions slow requests down; 0 or less is no limit, as in Chrome. */
function throttles(c: Protocol.Network.NetworkConditions | Protocol.Network.EmulateNetworkConditionsRequest) {
  return [c.latency, c.downloadThroughput, c.uploadThroughput, c.packetLoss].some(v => (v ?? 0) > 0);
}

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
    // Throttling cannot be done in the page; going offline can, though not yet (docs/roadmap.md).
    // The frontend sends these with no throttling on every connection, which succeeds.
    emulateNetworkConditions: (params: Protocol.Network.EmulateNetworkConditionsRequest) => {
      if (throttles(params)) throw new CdpError(NO_THROTTLING);
    },
    emulateNetworkConditionsByRule: (params: Protocol.Network.EmulateNetworkConditionsByRuleRequest) => {
      if (params.matchedNetworkConditions.some(throttles)) throw new CdpError(NO_THROTTLING);
      return { ruleIds: params.matchedNetworkConditions.map((_, i) => `rule-${i}`) };
    },
  });
}
