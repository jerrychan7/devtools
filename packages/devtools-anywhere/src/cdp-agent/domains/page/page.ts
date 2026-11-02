import type { Protocol } from 'devtools-protocol';
import { readBody } from '../../core/body';
import type { Context } from '../../core/context';
import { isOwnRequest, refetch } from '../network/network';
import { frameEvents, frameTree } from './frame-tree';

/** Resource Timing initiators of documents: a frame's own, not resources of the page. */
const DOCUMENT_INITIATORS = new Set(['navigation', 'iframe', 'frame']);

export function registerPage({ session, probe, frames }: Context) {
  let stopFrames: (() => void) | null = null;
  const disable = () => {
    stopFrames?.();
    stopFrames = null;
  };
  session.onReset(disable);

  session.register('Page', {
    /** Like Chrome, frames attached, navigated and detached are reported from now on. */
    enable() {
      stopFrames ??= frames.onChange(frameEvents(session, frames));
    },

    disable,

    getFrameTree(): Protocol.Page.GetFrameTreeResponse {
      frames.sync();
      return { frameTree: frameTree(frames, frames.top) };
    },

    getResourceTree(): Protocol.Page.GetResourceTreeResponse {
      frames.sync();
      // The top page's own resources, as far as Resource Timing knows them (Sources panel).
      // Those of iframes are not known: the probe watches the top page's requests only.
      const resources = probe.requests
        .filter(
          rec =>
            rec.initiatorType &&
            !DOCUMENT_INITIATORS.has(rec.initiatorType) &&
            rec.type !== 'Ping' &&
            !isOwnRequest(probe, rec)
        )
        .map(rec => ({
          url: rec.url,
          type: rec.type,
          mimeType: rec.mimeType || '',
        }));
      const withResources = (
        tree: Protocol.Page.FrameTree,
        own: Protocol.Page.FrameResource[]
      ): Protocol.Page.FrameResourceTree => ({
        frame: tree.frame,
        ...(tree.childFrames ? { childFrames: tree.childFrames.map(child => withResources(child, [])) } : {}),
        resources: own,
      });
      return { frameTree: withResources(frameTree(frames, frames.top), resources) };
    },

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
      const link = frames.top.document.querySelector<HTMLLinkElement>('link[rel~="manifest"][href]');
      if (!link) return { url: '', errors: [], data: '', manifest: {} };
      const res = await refetch(probe, link.href, {
        credentials: link.crossOrigin === 'use-credentials' ? 'include' : 'omit',
      });
      return { url: link.href, errors: [], data: await res.text(), manifest: {} };
    },

    /**
     * The css* fields are in CSS pixels; the deprecated ones are mostly in device pixels, as
     * Chrome reports them: times the screen's scale factor, devicePixelRatio as page scripts
     * see it.
     */
    getLayoutMetrics(): Protocol.Page.GetLayoutMetricsResponse {
      const root = frames.top.document.documentElement;
      const layout = { pageX: scrollX, pageY: scrollY, clientWidth: root.clientWidth, clientHeight: root.clientHeight };
      const vv = visualViewport;
      const visual = {
        offsetX: vv?.offsetLeft ?? 0,
        offsetY: vv?.offsetTop ?? 0,
        pageX: vv?.pageLeft ?? scrollX,
        pageY: vv?.pageTop ?? scrollY,
        clientWidth: vv?.width ?? root.clientWidth,
        clientHeight: vv?.height ?? root.clientHeight,
        scale: vv?.scale ?? 1,
        zoom: 1,
      };
      const content = { x: 0, y: 0, width: root.scrollWidth, height: root.scrollHeight };
      const dpr = devicePixelRatio;
      return {
        layoutViewport: {
          pageX: layout.pageX * dpr,
          pageY: layout.pageY * dpr,
          clientWidth: layout.clientWidth * dpr,
          clientHeight: layout.clientHeight * dpr,
        },
        // Chrome leaves the visual viewport's position in CSS pixels.
        visualViewport: { ...visual, clientWidth: visual.clientWidth * dpr, clientHeight: visual.clientHeight * dpr },
        contentSize: { ...content, width: content.width * dpr, height: content.height * dpr },
        cssLayoutViewport: layout,
        cssVisualViewport: visual,
        cssContentSize: content,
      };
    },

    getNavigationHistory: (): Protocol.Page.GetNavigationHistoryResponse => ({
      currentIndex: 0,
      entries: [
        {
          id: 0,
          url: location.href,
          userTypedURL: location.href,
          title: frames.top.document.title,
          transitionType: 'link',
        },
      ],
    }),

    reload: () => location.reload(),

    navigate(params: Protocol.Page.NavigateRequest): Protocol.Page.NavigateResponse {
      location.href = params.url;
      return { frameId: frames.top.id, loaderId: frames.top.loaderId };
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
