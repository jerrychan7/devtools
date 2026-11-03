import type { Protocol } from 'devtools-protocol';
import { readBody } from '../../core/body';
import type { Context } from '../../core/context';
import { CdpError } from '../../core/session';
import { isChildDocument } from '../network/frames';
import { isOwnRequest, refetch } from '../network/network';
import { frameEvents, frameTree } from './frame-tree';
import { sameDocumentNavigations } from './history-navigations';

export function registerPage({ session, probe, frames }: Context) {
  let stopFrames: (() => void) | null = null;
  let stopSameDocument: (() => void) | null = null;
  const disable = () => {
    stopFrames?.();
    stopFrames = null;
    stopSameDocument?.();
    stopSameDocument = null;
  };
  session.onReset(disable);

  session.register('Page', {
    /**
     * Like Chrome, frames attached, navigated and detached are reported from now on, and the
     * navigations within their documents.
     */
    enable() {
      stopFrames ??= frames.onChange(frameEvents(session, frames));
      stopSameDocument ??= sameDocumentNavigations(session, frames);
    },

    disable,

    getFrameTree(): Protocol.Page.GetFrameTreeResponse {
      frames.sync();
      return { frameTree: frameTree(frames, frames.top) };
    },

    getResourceTree(): Protocol.Page.GetResourceTreeResponse {
      frames.sync();
      // Each frame's own resources, as far as Resource Timing knows them (Sources panel): like
      // Chrome, those of the document the frame shows now, not its parent's or its children's.
      const byFrame = new Map<string, Protocol.Page.FrameResource[]>();
      for (const rec of probe.requests) {
        if (
          !rec.initiatorType ||
          // Documents are a frame's own, not resources of the page.
          rec.initiatorType === 'navigation' ||
          isChildDocument(rec) ||
          rec.type === 'Ping' ||
          isOwnRequest(probe, rec)
        )
          continue;
        const frame = rec.frame ? frames.byId(rec.frame.frameId) : frames.top;
        if (!frame || (rec.frame && rec.frame.loaderId !== frame.loaderId)) continue;
        const own = byFrame.get(frame.id) ?? [];
        byFrame.set(frame.id, own);
        own.push({ url: rec.url, type: rec.type, mimeType: rec.mimeType || '' });
      }
      const withResources = (tree: Protocol.Page.FrameTree): Protocol.Page.FrameResourceTree => ({
        frame: tree.frame,
        ...(tree.childFrames ? { childFrames: tree.childFrames.map(withResources) } : {}),
        resources: byFrame.get(tree.frame.id) ?? [],
      });
      return { frameTree: withResources(frameTree(frames, frames.top)) };
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

    getNavigationHistory(): Protocol.Page.GetNavigationHistoryResponse {
      // Like Chrome's iframe targets: the history is the top page's.
      if (frames.parent) throw new CdpError('Command can only be executed on top-level targets');
      return {
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
      };
    },

    reload: () => location.reload(),

    /** The frame given, as in Chrome; the loader returned is that of the document it leaves. */
    navigate(params: Protocol.Page.NavigateRequest): Protocol.Page.NavigateResponse {
      // The URL first, as in Chrome: it must be absolute.
      if (!URL.canParse(params.url)) throw new CdpError('Cannot navigate to invalid URL');
      frames.sync();
      const frame = params.frameId === undefined ? frames.top : frames.byId(params.frameId);
      if (!frame) throw new CdpError('No frame with given id found');
      const win = frame.document.defaultView;
      if (!win) throw new CdpError('No frame with given id found');
      win.location.href = params.url;
      return { frameId: frame.id, loaderId: frame.loaderId };
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
