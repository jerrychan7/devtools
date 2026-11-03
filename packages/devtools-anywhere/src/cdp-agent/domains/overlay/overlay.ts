import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { OWN_ATTRIBUTE, closestOwn, markOwn } from '../../core/nodes';
import type { Frame } from '../../core/frames';
import { mapPoints, ownerContentToTop, parentFrameDocument } from '../../core/geometry';
import { childTargets } from '../../core/child-targets';
import { mergedFrames, ownerOfId } from '../../core/merged-frames';
import { documentOf, isElement, isNode, realmOf } from '../../core/realm';
import { boxModel, resolveNode } from '../dom/dom';
import { CdpError } from '../../core/session';

/**
 * The overlay's z-index: the highest there is. Where popovers are missing, <devtools-anywhere>
 * cannot put its panel and toggler in the top layer, and gives them that z-index instead: the
 * overlay goes one below them then, so as not to cover them.
 */
const Z_INDEX = typeof HTMLElement.prototype.showPopover === 'function' ? 2147483647 : 2147483646;

/** Axis-aligned bounds of a CDP quad (x1 y1 … x4 y4, clockwise from the top left). */
function bounds(quad: number[]) {
  const xs = quad.filter((_, i) => i % 2 === 0);
  const ys = quad.filter((_, i) => i % 2 === 1);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** Whether a quad is an axis-aligned rectangle. */
function isRect(quad: number[]) {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
  return x1 === x4 && x2 === x3 && y1 === y2 && y3 === y4;
}

type RGBA = Protocol.DOM.RGBA;

const color = (c: RGBA | undefined, fallback: string) => (c ? `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})` : fallback);

/** Draws highlights in a fixed, click-through layer that the DOM domain hides from the page tree. */
class Highlighter {
  private layer: HTMLDivElement | null = null;
  /** The highlighted element, redrawn when the page scrolls or the viewport changes, like Chrome. */
  private current: { el: Element; config: Protocol.Overlay.HighlightConfig } | null = null;
  private tracking: AbortController | null = null;
  private frame = 0;

  private ensureLayer(): HTMLDivElement {
    if (this.layer?.isConnected) return this.layer;
    const layer = document.createElement('div');
    layer.setAttribute(OWN_ATTRIBUTE, 'overlay');
    markOwn(layer);
    layer.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z_INDEX}`;
    document.documentElement.appendChild(layer);
    return (this.layer = layer);
  }

  hide() {
    this.untrack();
    this.layer?.remove();
    this.layer = null;
  }

  /** Whether `el` is highlighted right now. */
  showing(el: Element): boolean {
    return this.current?.el === el && !!this.layer?.isConnected;
  }

  /** Highlights an element's margin, border, padding and content boxes, with a size label. */
  element(el: Element, config: Protocol.Overlay.HighlightConfig = {}) {
    if (this.current?.el !== el || !this.tracking) this.track(el);
    this.current = { el, config };
    this.draw(el, config);
  }

  /** Redraws at most once per frame. */
  private redraw = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.current?.el.isConnected) this.draw(this.current.el, this.current.config);
    });
  };

  private track(el: Element) {
    if (this.tracking) this.tracking.abort();
    this.tracking = new AbortController();
    const options = { capture: true, passive: true, signal: this.tracking.signal };
    // Scrolling in the iframes holding the element moves it too, and does not reach the top window.
    for (
      let doc = documentOf(el), parent = parentFrameDocument(doc);
      parent;
      doc = parent, parent = parentFrameDocument(doc)
    )
      realmOf(doc).addEventListener('scroll', this.redraw, options);
    addEventListener('scroll', this.redraw, options);
    addEventListener('resize', this.redraw, options);
    // Pinch zoom and the on-screen keyboard move the visual viewport only.
    visualViewport?.addEventListener('scroll', this.redraw, options);
    visualViewport?.addEventListener('resize', this.redraw, options);
  }

  private untrack() {
    this.tracking?.abort();
    this.tracking = null;
    this.current = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private draw(el: Element, config: Protocol.Overlay.HighlightConfig) {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? '.' + Array.from(el.classList).join('.') : '';
    this.paint(boxModel(el), config, `${el.localName}${id}${cls}`);
  }

  /**
   * Highlights an element out of reach, a merged sandboxed iframe's, by its box model as its
   * agent reports it, mapped into the top viewport (`m`); `name` is its label's selector.
   */
  remote(model: Protocol.DOM.BoxModel, m: DOMMatrixReadOnly, config: Protocol.Overlay.HighlightConfig, name: string) {
    this.untrack();
    const map = (q: number[]) => mapPoints(m, q);
    this.paint(
      {
        ...model,
        margin: map(model.margin),
        border: map(model.border),
        padding: map(model.padding),
        content: map(model.content),
      },
      config,
      name
    );
  }

  private paint(model: Protocol.DOM.BoxModel, config: Protocol.Overlay.HighlightConfig, name: string) {
    const layer = this.ensureLayer();
    layer.replaceChildren();
    const boxes: [number[], string][] = [
      [model.margin, color(config.marginColor, 'rgba(246,178,107,.66)')],
      [model.border, color(config.borderColor, 'rgba(255,229,153,.66)')],
      [model.padding, color(config.paddingColor, 'rgba(147,196,125,.55)')],
      [model.content, color(config.contentColor, 'rgba(111,168,220,.66)')],
    ];
    for (const [q, fill] of boxes) layer.appendChild(this.quad(q, fill));

    if (config.showInfo === true) {
      const label = document.createElement('div');
      label.textContent = `${name}  ${model.width} × ${model.height}`;
      const border = bounds(model.border);
      const top = border.top > 24 ? border.top - 22 : border.bottom + 2;
      label.style.cssText = `position:absolute;left:${Math.max(border.left, 0)}px;top:${top}px;padding:2px 6px;
        background:#fff;color:#222;font:11px/16px system-ui,sans-serif;border-radius:2px;
        box-shadow:0 1px 4px rgba(0,0,0,.3);white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis`;
      layer.appendChild(label);
    }
  }

  rect(x: number, y: number, width: number, height: number, fill: string, outline?: string) {
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${Math.max(width, 0)}px;height:${Math.max(height, 0)}px;background:${fill}`;
    if (outline) div.style.outline = `1px solid ${outline}`;
    return div;
  }

  /** Fills any quad: a rectangle, or else a polygon over its bounding rectangle, outlined like Chrome. */
  quad(q: number[], fill: string, outline?: string) {
    const { left, top, right, bottom } = bounds(q);
    if (isRect(q)) return this.rect(left, top, right - left, bottom - top, fill, outline);
    const div = this.rect(left, top, right - left, bottom - top, 'transparent');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(right - left));
    svg.setAttribute('height', String(bottom - top));
    // Inline, so that the page's own rules for svg and polygon do not apply.
    svg.style.cssText = `position:absolute;left:0;top:0;display:block;overflow:visible;margin:0;padding:0;border:0;
      width:${right - left}px;height:${bottom - top}px;max-width:none;max-height:none;transform:none;opacity:1;visibility:visible`;
    const polygon = document.createElementNS(ns, 'polygon');
    const points: string[] = [];
    for (let i = 0; i + 1 < q.length; i += 2) points.push(`${(q[i] ?? 0) - left},${(q[i + 1] ?? 0) - top}`);
    polygon.setAttribute('points', points.join(' '));
    polygon.style.cssText = `display:inline;transform:none;opacity:1;visibility:visible;stroke-dasharray:none;fill:${fill};
      stroke:${outline || 'none'};stroke-width:1px`;
    svg.appendChild(polygon);
    div.appendChild(svg);
    return div;
  }

  area(x: number, y: number, width: number, height: number, fill: string, outline?: string) {
    this.untrack();
    const layer = this.ensureLayer();
    layer.replaceChildren(this.rect(x, y, width, height, fill, outline));
  }

  areaQuad(q: number[], fill: string, outline?: string) {
    this.untrack();
    const layer = this.ensureLayer();
    layer.replaceChildren(this.quad(q, fill, outline));
  }
}

const isQuad = (q: unknown): q is number[] => Array.isArray(q) && q.every(n => typeof n === 'number');

function isBoxModel(value: unknown): value is Protocol.DOM.BoxModel {
  if (typeof value !== 'object' || value === null) return false;
  return ['margin', 'border', 'padding', 'content'].every(key => isQuad(Reflect.get(value, key)));
}

/** A described node's label selector (`p#id.a.b`), as Chrome's from the element itself. */
function labelOf(described: unknown): string {
  const node = typeof described === 'object' && described !== null ? Reflect.get(described, 'node') : undefined;
  const name = typeof node === 'object' && node !== null ? Reflect.get(node, 'localName') : undefined;
  const list = typeof node === 'object' && node !== null ? Reflect.get(node, 'attributes') : undefined;
  const attributes: unknown[] = Array.isArray(list) ? list : [];
  let id = '';
  let cls = '';
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const value = attributes[i + 1];
    if (typeof value !== 'string') continue;
    if (attributes[i] === 'id' && value) id = `#${value}`;
    if (attributes[i] === 'class')
      cls = value
        .split(/\s+/)
        .filter(Boolean)
        .map(c => `.${c}`)
        .join('');
  }
  return `${typeof name === 'string' ? name : ''}${id}${cls}`;
}

/** Shows the viewport size in the top right corner for a moment after each resize, like Chrome. */
function viewportSizeOnResize() {
  let label: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    if (!label) {
      label = document.createElement('div');
      label.setAttribute(OWN_ATTRIBUTE, 'viewport-size');
      markOwn(label);
      label.style.cssText = `position:fixed;top:0;right:0;z-index:${Z_INDEX};pointer-events:none;padding:2px 6px;
        background:rgba(255,255,255,.85);color:#222;font:11px/16px system-ui,sans-serif;border-radius:0 0 0 2px`;
    }
    label.textContent = `${innerWidth}px × ${innerHeight}px`;
    if (!label.isConnected) document.documentElement.appendChild(label);
    clearTimeout(timer);
    timer = setTimeout(() => label?.remove(), 1000);
  };
  return (show: boolean) => {
    if (show) addEventListener('resize', onResize);
    else {
      removeEventListener('resize', onResize);
      clearTimeout(timer);
      label?.remove();
    }
  };
}

/**
 * A merged sandboxed iframe's agent inspects its own document, which this page's input does not
 * reach, and hides what it highlighted; its nodes' highlights are drawn here (`highlightMerged`).
 */
mergedFrames.registerRoutes('Overlay', {
  fanOut: ['Overlay.enable', 'Overlay.disable', 'Overlay.setInspectMode', 'Overlay.hideHighlight'],
});

export function registerOverlay(ctx: Context) {
  const { session, nodes } = ctx;
  const highlighter = new Highlighter();
  let stopInspect: (() => void) | null = null;
  const showViewportSize = viewportSizeOnResize();

  /** Element under a pointer event, of any frame, ignoring devtools-anywhere's own UI. */
  function targetOf(event: Event): Element | null {
    const el = isNode(event.target) && isElement(event.target) ? event.target : null;
    return el && !closestOwn(el) ? el : null;
  }

  function startInspect(config: Protocol.Overlay.HighlightConfig) {
    stopInspect?.();
    let hovered: Element | null = null;
    let next: Element | null = null;
    let frame = 0;
    // Pointer events can come faster than frames: handle the latest one once per frame.
    const onFrame = () => {
      frame = 0;
      const el = next;
      if (!el || (el === hovered && highlighter.showing(el))) return;
      // Over a merged sandboxed iframe's content (its border at most reaches this page): its agent,
      // in inspect mode too (fanned out), highlights and requests its own node there.
      if (childTargets.linkOf(el)?.merged) {
        highlighter.hide();
        hovered = el;
        return;
      }
      highlighter.element(el, config);
      if (el === hovered) return;
      hovered = el;
      // Like Chrome, so that the Elements panel reveals the hovered node.
      const nodeId = nodes.pushToClient?.(el);
      if (nodeId !== undefined) session.emit('Overlay.nodeHighlightRequested', { nodeId });
    };
    const swallow = (event: Event) => {
      if (!targetOf(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Like Chrome, a move over a node is the inspecting session's: neither the page nor another
    // session in inspect mode (started later) sees it. A cross-origin iframe's content sends this
    // window nothing, so Chrome's exception for out-of-process frames has nothing to apply to.
    const onMove = (event: Event) => {
      const el = targetOf(event);
      if (!el) return;
      swallow(event);
      next = el;
      if (!frame) frame = requestAnimationFrame(onFrame);
    };
    const onClick = (event: Event) => {
      const el = targetOf(event);
      if (!el) return;
      swallow(event);
      cancelAnimationFrame(frame);
      frame = 0;
      highlighter.hide();
      session.emit('Overlay.inspectNodeRequested', { backendNodeId: nodes.backendIdOf(el) });
    };
    const listening = new AbortController();
    const options = { capture: true, signal: listening.signal };
    // Like Chrome, the nodes of same-origin iframes are inspected too: their input goes to their
    // own windows, each listened to (again once it loads another document).
    const listen = ({ window: win }: Frame) => {
      win.addEventListener('pointermove', onMove, options);
      // Chrome consumes the whole input event, so the page sees nothing derived from it either:
      // no enter/leave/over/out, nor dblclick, contextmenu or auxclick from the eaten presses.
      for (const type of 'mousemove mouseover mouseout mouseenter mouseleave pointerover pointerout pointerenter pointerleave pointerdown mousedown pointerup mouseup dblclick contextmenu auxclick'.split(
        ' '
      ))
        win.addEventListener(type, swallow, options);
      win.addEventListener('click', onClick, options);
      // The page gets no touch input either, like in Chrome's inspect mode.
      const touchOptions = { ...options, passive: false };
      win.addEventListener('touchstart', swallow, touchOptions);
      win.addEventListener('touchmove', swallow, touchOptions);
      win.addEventListener('touchend', swallow, touchOptions);
    };
    // A merged sandboxed iframe's agent hears nothing once the pointer leaves the iframe for the
    // page, whose agent highlights from then on: this one's highlight goes.
    if (childTargets.parentMerged)
      ctx.frames.top.window.addEventListener(
        'mouseout',
        event => {
          if (event.relatedTarget !== null) return;
          cancelAnimationFrame(frame);
          frame = 0;
          next = hovered = null;
          highlighter.hide();
        },
        options
      );
    const unwatch = ctx.frames.onChange(({ type, frame }) => {
      if (type !== 'detached') listen(frame);
    });
    for (const frame of ctx.frames) listen(frame);
    stopInspect = () => {
      unwatch();
      listening.abort();
      cancelAnimationFrame(frame);
      highlighter.hide();
      stopInspect = null;
    };
  }

  /**
   * Highlights a node of a merged sandboxed iframe: like Chrome, on the page, over the iframe and
   * beyond its edges, by the box model the iframe's agent reports, placed by the iframe's content box.
   */
  async function highlightMerged(ns: number, params: Protocol.Overlay.HighlightNodeRequest) {
    const link = [...mergedFrames.frames()].find(([n]) => n === ns)?.[1];
    // Gone: the page's own handler answers as for any unknown id.
    if (!link) throw new CdpError('No node with given id found');
    const ids = { nodeId: params.nodeId, backendNodeId: params.backendNodeId, objectId: params.objectId };
    const client = mergedFrames.forSession(session);
    const [box, described] = await Promise.all([
      client.ask(ns, 'DOM.getBoxModel', ids),
      client.ask(ns, 'DOM.describeNode', ids),
    ]);
    const model = typeof box === 'object' && box !== null ? Reflect.get(box, 'model') : undefined;
    if (!isBoxModel(model)) throw new CdpError('Could not compute box model.');
    highlighter.remote(model, ownerContentToTop(link.owner), params.highlightConfig, labelOf(described));
  }

  session.register('Overlay', {
    enable: () => {},
    disable() {
      stopInspect?.();
      highlighter.hide();
      showViewportSize(false);
    },

    setShowViewportSizeOnResize: (params: Protocol.Overlay.SetShowViewportSizeOnResizeRequest) =>
      showViewportSize(params.show),

    highlightNode(params: Protocol.Overlay.HighlightNodeRequest) {
      const ns = ownerOfId(params.nodeId) ?? ownerOfId(params.backendNodeId) ?? ownerOfId(params.objectId);
      if (ns !== undefined) return highlightMerged(ns, params);
      const node = resolveNode(ctx, params);
      const el = isElement(node) ? node : node.parentElement;
      if (el) highlighter.element(el, params.highlightConfig);
      return undefined;
    },

    highlightRect(params: Protocol.Overlay.HighlightRectRequest) {
      highlighter.area(
        params.x,
        params.y,
        params.width,
        params.height,
        color(params.color, 'transparent'),
        color(params.outlineColor, '')
      );
    },

    highlightQuad(params: Protocol.Overlay.HighlightQuadRequest) {
      highlighter.areaQuad(params.quad, color(params.color, 'transparent'), color(params.outlineColor, ''));
    },

    hideHighlight: () => highlighter.hide(),

    setInspectMode(params: Protocol.Overlay.SetInspectModeRequest) {
      if (params.mode === 'none') stopInspect?.();
      else startInspect(params.highlightConfig ?? {});
    },
  });
}
