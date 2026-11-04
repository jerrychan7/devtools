import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping';
import { mergedFrames } from '../core/merged-frames';
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
  Inspector: ['enable'],
  // The page has no browser log entries, so clearing them is done.
  Log: ['enable', 'clear', 'startViolationsReport'],
  Overlay: [
    // The page never pauses in a debugger, so there is no message to show.
    'setPausedInDebuggerMessage',
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

// What emulation applies to the page's documents applies to its merged sandboxed iframes' too, as
// in Chrome, where they are in the page's target: their agents get it as well. The device metrics
// are the page's alone (its viewport), as the shell's size is.
mergedFrames.registerRoutes('Emulation', {
  fanOut: ['Emulation.setEmulatedMedia', 'Emulation.setTouchEmulationEnabled', 'Emulation.setEmitTouchEventsForMouse'],
});

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
}
