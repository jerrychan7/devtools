import type { Protocol } from 'devtools-protocol';
import { FRAME_ID, LOADER_ID, type Context } from '../core/context';
import { isOwnRequest } from './network';

export function registerPage({ server, probe }: Context) {
  server.register('Page', {
    enable: () => {},

    getResourceTree: (): Protocol.Page.GetResourceTreeResponse => ({
      frameTree: {
        frame: {
          id: FRAME_ID,
          loaderId: LOADER_ID,
          url: location.href,
          domainAndRegistry: '',
          securityOrigin: location.origin,
          mimeType: 'text/html',
          secureContextType: isSecureContext ? 'Secure' : 'InsecureScheme',
          crossOriginIsolatedContextType: 'NotIsolated',
          gatedAPIFeatures: [],
        },
        // The page's own resources, as far as Resource Timing knows them (Sources panel).
        resources: probe.requests
          .filter(
            rec =>
              rec.initiatorType &&
              rec.initiatorType !== 'navigation' &&
              rec.type !== 'Ping' &&
              !isOwnRequest(probe, rec)
          )
          .map(rec => ({
            url: rec.url,
            type: rec.type as Protocol.Network.ResourceType,
            mimeType: rec.mimeType || '',
          })),
      },
    }),

    /** Re-fetches the resource, from the HTTP cache when possible; not recorded by the probe. */
    async getResourceContent(
      params: Protocol.Page.GetResourceContentRequest
    ): Promise<Protocol.Page.GetResourceContentResponse> {
      const res = await probe.fetch(params.url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`Failed to load ${params.url}: ${res.status}`);
      return { content: await res.text(), base64Encoded: false };
    },

    getNavigationHistory: (): Protocol.Page.GetNavigationHistoryResponse => ({
      currentIndex: 0,
      entries: [
        { id: 0, url: location.href, userTypedURL: location.href, title: document.title, transitionType: 'link' },
      ],
    }),

    reload: () => location.reload(),

    navigate(params: Protocol.Page.NavigateRequest): Protocol.Page.NavigateResponse {
      location.href = params.url;
      return { frameId: FRAME_ID, loaderId: LOADER_ID };
    },

    addScriptToEvaluateOnNewDocument: (): Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse => ({
      identifier: '0',
    }),
    getAppManifest: () => ({ url: '', errors: [] }),
    getInstallabilityErrors: (): Protocol.Page.GetInstallabilityErrorsResponse => ({ installabilityErrors: [] }),
    getManifestIcons: () => ({}),
    getAppId: () => ({}),
    bringToFront: () => {},
    setAdBlockingEnabled: () => {},
    setLifecycleEventsEnabled: () => {},
    stopLoading: () => {},
  });
}
