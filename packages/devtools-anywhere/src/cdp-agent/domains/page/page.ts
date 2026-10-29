import type { Protocol } from 'devtools-protocol';
import { readBody } from '../../core/body';
import { FRAME_ID, LOADER_ID, type Context } from '../../core/context';
import { isOwnRequest, refetch } from '../network/network';

export function registerPage({ session, probe }: Context) {
  session.register('Page', {
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
          secureContextType: !isSecureContext
            ? 'InsecureScheme'
            : /^(.+\.)?localhost$|^127(\.\d+){3}$|^\[::1\]$/.test(location.hostname)
              ? 'SecureLocalhost'
              : 'Secure',
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
            type: rec.type,
            mimeType: rec.mimeType || '',
          })),
      },
    }),

    /** Re-fetches the resource, from the HTTP cache when possible; not recorded by the probe. */
    async getResourceContent(
      params: Protocol.Page.GetResourceContentRequest
    ): Promise<Protocol.Page.GetResourceContentResponse> {
      const res = await refetch(probe, params.url);
      const { body, base64Encoded } = await readBody(res);
      return { content: body, base64Encoded };
    },

    /**
     * The manifest the page links to, as text; the frontend parses it. `manifest` holds only
     * what page scripts can tell without Chrome's parser: nothing.
     */
    async getAppManifest(): Promise<Protocol.Page.GetAppManifestResponse> {
      const link = document.querySelector<HTMLLinkElement>('link[rel~="manifest"][href]');
      if (!link) return { url: '', errors: [], data: '', manifest: {} };
      const res = await refetch(probe, link.href, {
        credentials: link.crossOrigin === 'use-credentials' ? 'include' : 'omit',
      });
      return { url: link.href, errors: [], data: await res.text(), manifest: {} };
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
    getInstallabilityErrors: (): Protocol.Page.GetInstallabilityErrorsResponse => ({ installabilityErrors: [] }),
    getManifestIcons: () => ({}),
    getAppId: () => ({}),
    bringToFront: () => {},
    setAdBlockingEnabled: () => {},
    setLifecycleEventsEnabled: () => {},
    stopLoading: () => {},
    getPermissionsPolicyState: (): Protocol.Page.GetPermissionsPolicyStateResponse => ({ states: [] }),
    getOriginTrials: (): Protocol.Page.GetOriginTrialsResponse => ({ originTrials: [] }),
    getSpellCheckCustomDictionary: (): Protocol.Page.GetSpellCheckCustomDictionaryResponse => ({ words: [] }),
  });
}
