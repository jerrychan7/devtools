import type { Protocol } from 'devtools-protocol'
import { FRAME_ID, LOADER_ID, type Context } from '../core/context'

export function registerPage({ server }: Context) {
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
        resources: [],
      },
    }),

    getNavigationHistory: (): Protocol.Page.GetNavigationHistoryResponse => ({
      currentIndex: 0,
      entries: [{ id: 0, url: location.href, userTypedURL: location.href, title: document.title, transitionType: 'link' }],
    }),

    reload: () => location.reload(),

    navigate(params: Protocol.Page.NavigateRequest): Protocol.Page.NavigateResponse {
      location.href = params.url
      return { frameId: FRAME_ID, loaderId: LOADER_ID }
    },

    addScriptToEvaluateOnNewDocument: (): Protocol.Page.AddScriptToEvaluateOnNewDocumentResponse => ({ identifier: '0' }),
    getAppManifest: () => ({ url: '', errors: [] }),
    getInstallabilityErrors: (): Protocol.Page.GetInstallabilityErrorsResponse => ({ installabilityErrors: [] }),
    getManifestIcons: () => ({}),
    getAppId: () => ({}),
    bringToFront: () => {},
    setAdBlockingEnabled: () => {},
    setLifecycleEventsEnabled: () => {},
    stopLoading: () => {},
  })
}
