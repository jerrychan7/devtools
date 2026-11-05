// What DevTools changes about the page's requests and what the page sees of the browser: blocked
// URLs, extra headers, the cache disabled, offline, the user agent. Requests are changed where
// the probe hooks them (fetch() and XHR, probe/network.ts); the document's own request and other
// subresources go out as the browser makes them.
import type { Protocol } from 'devtools-protocol';
import type { Intercept, Probe, RequestType } from '../../probe/types';
import { CdpError, type CdpSession } from '../../core/session';
import { frames } from '../../core/frames/frames';
import { mergedFrames } from '../../core/frames/merged-frames';

// The user agent applies to the merged sandboxed iframes as well, as Chrome's to every frame of
// the target; Network's commands go to them already (network.ts).
mergedFrames.registerRoutes('Emulation', {
  fanOut: ['Emulation.setUserAgentOverride'],
});
mergedFrames.registerRoutes('Network', {
  fanOut: [
    'Network.setUserAgentOverride',
    'Network.emulateNetworkConditions',
    'Network.emulateNetworkConditionsByRule',
    'Network.overrideNetworkState',
  ],
});

/** What one session asked for. */
interface Settings {
  patterns: Protocol.Network.BlockPattern[];
  /** setBlockedURLs' deprecated `urls`, as regular expressions. */
  wildcards: RegExp[];
  headers: Record<string, string>;
  cacheDisabled: boolean;
  /** Offline for every request (true), for those matching the rules' patterns, or not at all. */
  offline: boolean | Protocol.Network.NetworkConditions[];
  userAgent?: Protocol.Network.SetUserAgentOverrideRequest | undefined;
}

const sessions = new Map<CdpSession, Settings>();

/** Whether a URLPattern string matches `url`; one that does not parse matches nothing. */
function matches(pattern: string, url: string): boolean {
  try {
    return new URLPattern(pattern).test(url);
  } catch {
    return false;
  }
}

/** A wildcard pattern of setBlockedURLs' `urls` ('*' for anything) as a regular expression. */
const wildcard = (pattern: string) =>
  new RegExp(
    '^' +
      pattern
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  );

/** Whether the session blocks `url`: the first URL pattern matching it decides, then the wildcards. */
function blocks(s: Settings, url: string): boolean {
  for (const { urlPattern, block } of s.patterns) if (matches(urlPattern, url)) return block;
  return s.wildcards.some(re => re.test(url));
}

/** Whether the session has the page offline for `url`: the first rule matching it decides. */
function offlineFor(s: Settings, url: string): boolean {
  if (typeof s.offline === 'boolean') return s.offline;
  const rule = s.offline.find(c => !c.urlPattern || matches(c.urlPattern, url));
  return !!rule?.offline;
}

/** What every session asks of a fetch() or XHR request, merged; nothing when none changes it. */
function intercept(
  url: string,
  type: RequestType,
  setHeader: (name: string, value: string) => void
): Intercept | undefined {
  const all = [...sessions.values()];
  // Chrome fails a blocked request before it would go out, offline or not.
  if (all.some(s => blocks(s, url))) return { fail: { errorText: '', blockedReason: 'inspector' } };
  if (all.some(s => offlineFor(s, url))) return { fail: { errorText: 'net::ERR_INTERNET_DISCONNECTED' } };
  const headers: Record<string, string> = {};
  let noCache = false;
  for (const s of all) {
    Object.assign(headers, s.headers);
    if (s.userAgent) {
      headers['User-Agent'] = s.userAgent.userAgent;
      if (s.userAgent.acceptLanguage) headers['Accept-Language'] = s.userAgent.acceptLanguage;
    }
    noCache ||= s.cacheDisabled;
  }
  // XHR has no cache mode: the headers Chrome sends then make the server answer anew. Same origin
  // only, where they need no CORS preflight that Chrome's would not.
  if (noCache && type === 'XHR' && new URL(url).origin === location.origin)
    Object.assign(headers, { 'Cache-Control': 'no-cache', Pragma: 'no-cache' });
  if (!noCache && !Object.keys(headers).length) return undefined;
  // Replacing the page's, as Chrome's do.
  for (const [name, value] of Object.entries(headers)) setHeader(name, value);
  return { noCache };
}

// ---- what the page sees ----

/** The navigator properties overridden, so that clearing the override puts the page's back. */
const NAVIGATOR_KEYS = ['userAgent', 'appVersion', 'platform', 'language', 'languages', 'userAgentData', 'onLine'];

/** The page's documents: the top one and the same-origin iframes' found so far. */
function* navigators(): Generator<Navigator> {
  for (const frame of frames) {
    const nav = frame.document.defaultView?.navigator;
    if (nav) yield nav;
  }
}

/** navigator.userAgentData as Chrome makes it from the override's metadata, or empty without. */
function userAgentData(meta: Protocol.Emulation.UserAgentMetadata | undefined) {
  const low = {
    brands: (meta?.brands ?? []).map(({ brand, version }) => ({
      brand,
      version,
    })),
    mobile: meta?.mobile ?? false,
    platform: meta?.platform ?? '',
  };
  const high = {
    ...low,
    architecture: meta?.architecture ?? '',
    bitness: meta?.bitness ?? '',
    fullVersionList: (meta?.fullVersionList ?? []).map(({ brand, version }) => ({ brand, version })),
    model: meta?.model ?? '',
    platformVersion: meta?.platformVersion ?? '',
    uaFullVersion: meta?.fullVersion ?? '',
    wow64: meta?.wow64 ?? false,
  };
  return Object.defineProperties(
    { ...low },
    {
      getHighEntropyValues: {
        value: (hints: string[]) =>
          Promise.resolve({
            ...low,
            ...Object.fromEntries(Object.entries(high).filter(([key]) => hints.includes(key))),
          }),
      },
      toJSON: { value: () => low },
    }
  );
}

/** Puts the navigator properties the sessions override on the page's documents. */
function applyNavigator() {
  const all = [...sessions.values()];
  // The latest session's, as the last command wins in Chrome.
  const ua = all.reverse().find(s => s.userAgent)?.userAgent;
  const offline = all.some(s => s.offline === true);
  const values: Record<string, unknown> = {};
  if (ua) {
    const slash = ua.userAgent.indexOf('/');
    values['userAgent'] = ua.userAgent;
    // Chrome's appVersion is the user agent past its first product name.
    values['appVersion'] = slash < 0 ? ua.userAgent : ua.userAgent.slice(slash + 1);
    if (ua.platform !== undefined) values['platform'] = ua.platform;
    if (ua.acceptLanguage) {
      // Chrome's languages are the list as given, q-values included; language is the first one's tag.
      const languages = ua.acceptLanguage.split(',').map(l => l.trim());
      values['language'] = (languages[0] ?? '').split(';')[0];
      values['languages'] = Object.freeze(languages);
    }
    values['userAgentData'] = userAgentData(ua.userAgentMetadata);
  }
  if (offline) values['onLine'] = false;
  for (const nav of navigators())
    for (const key of NAVIGATOR_KEYS) {
      // Own properties shadow Navigator.prototype's getters; deleting them shows those again.
      if (key in values)
        Object.defineProperty(nav, key, {
          value: values[key],
          configurable: true,
        });
      else Reflect.deleteProperty(nav, key);
    }
}

/** Whether the page was offline for every request, to tell it when that changes. */
let wasOffline = false;

/** Applies what the sessions now ask for: the probe's hook, the navigator, online and offline events. */
function update(probe: Probe) {
  probe.intercept = sessions.size ? intercept : undefined;
  applyNavigator();
  const offline = [...sessions.values()].some(s => s.offline === true);
  if (offline !== wasOffline) {
    wasOffline = offline;
    for (const frame of frames) frame.document.defaultView?.dispatchEvent(new Event(offline ? 'offline' : 'online'));
  }
}

const NO_THROTTLING = 'Not supported in the page: requests are throttled by the browser';

/** Whether conditions slow requests down; 0 or less is no limit, as in Chrome. */
function throttles(c: Protocol.Network.NetworkConditions | Protocol.Network.EmulateNetworkConditionsRequest) {
  return [c.latency, c.downloadThroughput, c.uploadThroughput, c.packetLoss].some(v => (v ?? 0) > 0);
}

export function registerConditions(session: CdpSession, probe: Probe) {
  const settings: Settings = {
    patterns: [],
    wildcards: [],
    headers: {},
    cacheDisabled: false,
    offline: false,
  };
  /** Changes this session's settings and applies them. */
  const set = (patch: Partial<Settings>) => {
    Object.assign(settings, patch);
    sessions.set(session, settings);
    update(probe);
  };
  session.onReset(() => {
    if (!sessions.delete(session)) return;
    Object.assign(settings, {
      patterns: [],
      wildcards: [],
      headers: {},
      cacheDisabled: false,
      offline: false,
    });
    settings.userAgent = undefined;
    update(probe);
  });
  const setUserAgentOverride = (params: Protocol.Network.SetUserAgentOverrideRequest) =>
    // An empty user agent clears the override, as in Chrome.
    set({ userAgent: params.userAgent ? params : undefined });
  session.register('Emulation', { setUserAgentOverride });
  session.register('Network', {
    setUserAgentOverride,
    setBlockedURLs: (params: Protocol.Network.SetBlockedURLsRequest) =>
      set({
        patterns: params.urlPatterns ?? [],
        wildcards: (params.urls ?? []).map(wildcard),
      }),
    setExtraHTTPHeaders: ({ headers }: Protocol.Network.SetExtraHTTPHeadersRequest) =>
      set({
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
      }),
    setCacheDisabled: ({ cacheDisabled }: Protocol.Network.SetCacheDisabledRequest) => set({ cacheDisabled }),
    // Throttling cannot be done in the page: requests cannot be made slower. The frontend sends
    // these with no throttling on every connection, which succeeds.
    emulateNetworkConditions: (params: Protocol.Network.EmulateNetworkConditionsRequest) => {
      if (throttles(params)) throw new CdpError(NO_THROTTLING);
      set({ offline: params.offline });
    },
    overrideNetworkState: (params: Protocol.Network.OverrideNetworkStateRequest) => {
      if (throttles(params)) throw new CdpError(NO_THROTTLING);
      set({ offline: params.offline });
    },
    emulateNetworkConditionsByRule: (params: Protocol.Network.EmulateNetworkConditionsByRuleRequest) => {
      const rules = params.matchedNetworkConditions;
      if (rules.some(throttles)) throw new CdpError(NO_THROTTLING);
      // Rules without a pattern are for every request: offline for the page as a whole.
      set({
        offline: params.offline || (rules.every(c => !c.urlPattern) ? rules.some(c => c.offline) : rules),
      });
      return { ruleIds: rules.map((_, i) => `rule-${i}`) };
    },
  });
}
