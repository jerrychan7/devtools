import type { Protocol } from 'devtools-protocol';
import type { Context } from '../core/context';
import { OWN_ATTRIBUTE } from '../core/nodes';
import { boxModel, resolveNode } from './dom';

/** Bounds of a CDP quad (x1 y1 … x4 y4, clockwise from the top left). */
function bounds(quad: number[]) {
  const [left = 0, top = 0, , , right = 0, bottom = 0] = quad;
  return { left, top, right, bottom };
}

type RGBA = Protocol.DOM.RGBA;

const color = (c: RGBA | undefined, fallback: string) => (c ? `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})` : fallback);

/** Draws highlights in a fixed, click-through layer that the DOM domain hides from the page tree. */
class Highlighter {
  private layer: HTMLDivElement | null = null;

  private ensureLayer(): HTMLDivElement {
    if (this.layer?.isConnected) return this.layer;
    const layer = document.createElement('div');
    layer.setAttribute(OWN_ATTRIBUTE, 'overlay');
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    document.documentElement.appendChild(layer);
    return (this.layer = layer);
  }

  hide() {
    this.layer?.remove();
    this.layer = null;
  }

  /** Highlights an element's margin, border, padding and content boxes, with a size label. */
  element(el: Element, config: Protocol.Overlay.HighlightConfig = {}) {
    const model = boxModel(el);
    const layer = this.ensureLayer();
    layer.replaceChildren();
    const boxes: [number[], string][] = [
      [model.margin, color(config.marginColor, 'rgba(246,178,107,.66)')],
      [model.border, color(config.borderColor, 'rgba(255,229,153,.66)')],
      [model.padding, color(config.paddingColor, 'rgba(147,196,125,.55)')],
      [model.content, color(config.contentColor, 'rgba(111,168,220,.66)')],
    ];
    for (const [q, fill] of boxes) {
      const { left, top, right, bottom } = bounds(q);
      layer.appendChild(this.rect(left, top, right - left, bottom - top, fill));
    }

    if (config.showInfo !== false) {
      const label = document.createElement('div');
      const id = el.id ? `#${el.id}` : '';
      const cls = el.classList.length ? '.' + Array.from(el.classList).join('.') : '';
      label.textContent = `${el.localName}${id}${cls}  ${model.width} × ${model.height}`;
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

  area(x: number, y: number, width: number, height: number, fill: string, outline?: string) {
    const layer = this.ensureLayer();
    layer.replaceChildren(this.rect(x, y, width, height, fill, outline));
  }
}

export function registerOverlay(ctx: Context) {
  const { server, nodes } = ctx;
  const highlighter = new Highlighter();
  let stopInspect: (() => void) | null = null;

  /** Element under a pointer event, ignoring devtools-anywhere's own UI. */
  function targetOf(event: Event): Element | null {
    const el = event.target instanceof Element ? event.target : null;
    return el && !el.closest(`[${OWN_ATTRIBUTE}]`) ? el : null;
  }

  function startInspect(config: Protocol.Overlay.HighlightConfig) {
    stopInspect?.();
    const onMove = (event: Event) => {
      const el = targetOf(event);
      if (el) highlighter.element(el, config);
    };
    const swallow = (event: Event) => {
      if (!targetOf(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event: Event) => {
      const el = targetOf(event);
      if (!el) return;
      swallow(event);
      highlighter.hide();
      server.emit('Overlay.inspectNodeRequested', { backendNodeId: nodes.backendIdOf(el) });
    };
    const options = { capture: true };
    window.addEventListener('pointermove', onMove, options);
    window.addEventListener('pointerdown', swallow, options);
    window.addEventListener('mousedown', swallow, options);
    window.addEventListener('pointerup', swallow, options);
    window.addEventListener('mouseup', swallow, options);
    window.addEventListener('click', onClick, options);
    stopInspect = () => {
      window.removeEventListener('pointermove', onMove, options);
      window.removeEventListener('pointerdown', swallow, options);
      window.removeEventListener('mousedown', swallow, options);
      window.removeEventListener('pointerup', swallow, options);
      window.removeEventListener('mouseup', swallow, options);
      window.removeEventListener('click', onClick, options);
      highlighter.hide();
      stopInspect = null;
    };
  }

  server.register('Overlay', {
    enable: () => {},
    disable() {
      stopInspect?.();
      highlighter.hide();
    },

    highlightNode(params: Protocol.Overlay.HighlightNodeRequest) {
      const node = resolveNode(ctx, params);
      const el = node instanceof Element ? node : node.parentElement;
      if (el) highlighter.element(el, params.highlightConfig);
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
      const { left, top, right, bottom } = bounds(params.quad);
      highlighter.area(
        left,
        top,
        right - left,
        bottom - top,
        color(params.color, 'transparent'),
        color(params.outlineColor, '')
      );
    },

    hideHighlight: () => highlighter.hide(),

    setInspectMode(params: Protocol.Overlay.SetInspectModeRequest) {
      if (params.mode === 'none') stopInspect?.();
      else startInspect(params.highlightConfig ?? {});
    },
  });
}
