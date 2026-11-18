import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { OWN_ATTRIBUTE, markOwn } from '../../core/nodes/nodes';
import { ownerOfId } from '../../core/frames/merged-frames';
import { isElement, isHtmlElement, isSvgElement, realmOf } from '../../core/realm';
import { CdpError } from '../../core/session';
import { boxModel, resolveNode } from '../dom/dom';

type RGBA = Protocol.DOM.RGBA;
type LineStyle = Protocol.Overlay.LineStyle;
type Box = { left: number; top: number; right: number; bottom: number };

/** A color as CSS; none, the part is not drawn, as in Chrome, which paints only what is given a color. */
const css = (c: RGBA | undefined) => (c ? `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})` : '');

/** Axis-aligned bounds of a CDP quad. */
function bounds(quad: number[]): Box {
  const xs = quad.filter((_, i) => i % 2 === 0);
  const ys = quad.filter((_, i) => i % 2 === 1);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** An element's computed style, in its own realm. */
const styleOf = (el: Element) => realmOf(el).getComputedStyle(el);

/** A CSS length in px, 0 for `normal`, `auto` and the like. */
const px = (value: string) => parseFloat(value) || 0;

/** The px sizes of a resolved `grid-template-*` value (`[a] 50px [b] 240px`), line names left out. */
function tracks(value: string): number[] {
  return value
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter(v => v.endsWith('px'))
    .map(px);
}

/**
 * What the tools draw, as SVG markup in viewport coordinates: each shape says what it is
 * (`data-kind`), so that its geometry can be checked.
 */
class Shapes {
  readonly parts: string[] = [];

  rect(kind: string, b: Box, fill: string, stroke = '', dash = false) {
    if (!fill && !stroke) return;
    this.parts.push(
      `<rect data-kind="${kind}" x="${b.left}" y="${b.top}" width="${Math.max(b.right - b.left, 0)}" height="${Math.max(b.bottom - b.top, 0)}" fill="${fill || 'none'}" stroke="${stroke || 'none'}"${dash ? ' stroke-dasharray="3 3"' : ''}/>`
    );
  }

  line(kind: string, x1: number, y1: number, x2: number, y2: number, stroke: string, dash = false) {
    if (!stroke) return;
    this.parts.push(
      `<line data-kind="${kind}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"${dash ? ' stroke-dasharray="3 3"' : ''}/>`
    );
  }

  path(kind: string, d: string, fill: string) {
    if (fill) this.parts.push(`<path data-kind="${kind}" d="${d}" fill="${fill}"/>`);
  }

  /** A box outlined in a line style, dashed when its pattern is. */
  outline(kind: string, b: Box, style: LineStyle | undefined) {
    this.rect(kind, b, '', css(style?.color), style?.pattern === 'dashed' || style?.pattern === 'dotted');
  }
}

/**
 * A box in the top viewport scaled from the element's own px: a same-origin iframe's content may
 * be zoomed or scaled, as its box model maps it.
 */
function scaleOf(el: Element, model: Protocol.DOM.BoxModel) {
  const border = bounds(model.border);
  const { width, height } = el.getBoundingClientRect();
  return { x: width ? (border.right - border.left) / width : 1, y: height ? (border.bottom - border.top) / height : 1 };
}

/**
 * Grid lines, gaps and border, from the tracks the computed style resolves (in px). The tracks
 * start at the content box's start: a grid aligned otherwise (`justify-content`, `align-content`)
 * or written right to left is drawn from that corner still.
 */
function drawGrid(s: Shapes, el: Element, config: Protocol.Overlay.GridHighlightConfig) {
  const style = styleOf(el);
  if (!/grid/.test(style.display)) return;
  const model = boxModel(el);
  const c = bounds(model.content);
  const k = scaleOf(el, model);
  const cols = tracks(style.gridTemplateColumns).map(n => n * k.x);
  const rows = tracks(style.gridTemplateRows).map(n => n * k.y);
  const colGap = px(style.columnGap) * k.x;
  const rowGap = px(style.rowGap) * k.y;
  const right = c.left + cols.reduce((a, n) => a + n, 0) + colGap * Math.max(cols.length - 1, 0);
  const bottom = c.top + rows.reduce((a, n) => a + n, 0) + rowGap * Math.max(rows.length - 1, 0);
  const grid = { left: c.left, top: c.top, right, bottom };
  s.rect('grid-background', grid, css(config.gridBackgroundColor));
  const rowColor = css(config.rowLineColor ?? config.cellBorderColor);
  const colColor = css(config.columnLineColor ?? config.cellBorderColor);
  const rowDash = config.rowLineDash ?? config.cellBorderDash ?? false;
  const colDash = config.columnLineDash ?? config.cellBorderDash ?? false;
  const ext = config.showGridExtensionLines === true;
  // Each track's two edges; a gap between two tracks is filled.
  for (let i = 0, x = c.left; i < cols.length; i++) {
    const end = x + (cols[i] ?? 0);
    for (const at of [x, end]) {
      s.line('column', at, c.top, at, bottom, colColor, colDash);
      if (ext) s.line('column-extension', at, 0, at, innerHeight, colColor, true);
    }
    if (i < cols.length - 1)
      s.rect('column-gap', { left: end, top: c.top, right: end + colGap, bottom }, css(config.columnGapColor));
    x = end + colGap;
  }
  for (let i = 0, y = c.top; i < rows.length; i++) {
    const end = y + (rows[i] ?? 0);
    for (const at of [y, end]) {
      s.line('row', c.left, at, right, at, rowColor, rowDash);
      if (ext) s.line('row-extension', 0, at, innerWidth, at, rowColor, true);
    }
    if (i < rows.length - 1)
      s.rect('row-gap', { left: c.left, top: end, right, bottom: end + rowGap }, css(config.rowGapColor));
    y = end + rowGap;
  }
  s.rect('grid-border', grid, '', css(config.gridBorderColor), config.gridBorderDash === true);
}

/** The flex container's content box and its in-flow items' margin boxes. */
function drawFlex(s: Shapes, el: Element, config: Protocol.Overlay.FlexContainerHighlightConfig) {
  if (!/flex/.test(styleOf(el).display)) return;
  s.outline('flex-container', bounds(boxModel(el).content), config.containerBorder);
  for (const item of Array.from(el.children)) {
    const position = styleOf(item).position;
    if (position === 'absolute' || position === 'fixed' || !item.getClientRects().length) continue;
    s.outline('flex-item', bounds(boxModel(item).margin), config.itemSeparator);
  }
}

/** The container's border box; its descendants that query it are not found, so not drawn. */
function drawContainer(s: Shapes, el: Element, config: Protocol.Overlay.ContainerQueryContainerHighlightConfig) {
  const type = styleOf(el).containerType;
  if (!type || type === 'normal') return;
  s.outline('container', bounds(boxModel(el).border), config.containerBorder);
}

/** The snapport (padding box less `scroll-padding`) and the snap areas (border boxes plus `scroll-margin`). */
function drawScrollSnap(s: Shapes, el: Element, config: Protocol.Overlay.ScrollSnapContainerHighlightConfig) {
  const style = styleOf(el);
  if (!style.scrollSnapType || style.scrollSnapType === 'none') return;
  const model = boxModel(el);
  const k = scaleOf(el, model);
  const pad = bounds(model.padding);
  const port = {
    left: pad.left + px(style.scrollPaddingLeft) * k.x,
    top: pad.top + px(style.scrollPaddingTop) * k.y,
    right: pad.right - px(style.scrollPaddingRight) * k.x,
    bottom: pad.bottom - px(style.scrollPaddingBottom) * k.y,
  };
  const paddingColor = css(config.scrollPaddingColor);
  if (paddingColor)
    s.path(
      'scroll-padding',
      `M${pad.left} ${pad.top}H${pad.right}V${pad.bottom}H${pad.left}Z M${port.left} ${port.top}V${port.bottom}H${port.right}V${port.top}Z`,
      paddingColor
    );
  s.outline('snapport', port, config.snapportBorder);
  for (const area of Array.from(el.querySelectorAll('*'))) {
    const a = styleOf(area);
    if (!a.scrollSnapAlign || a.scrollSnapAlign === 'none') continue;
    const border = bounds(boxModel(area).border);
    const margin = {
      left: border.left - px(a.scrollMarginLeft) * k.x,
      top: border.top - px(a.scrollMarginTop) * k.y,
      right: border.right + px(a.scrollMarginRight) * k.x,
      bottom: border.bottom + px(a.scrollMarginBottom) * k.y,
    };
    s.rect('scroll-margin', margin, css(config.scrollMarginColor));
    s.outline('snap-area', border, config.snapAreaBorder);
  }
}

/** Draws a display cutout, in viewport coordinates, as `Overlay.setShowDisplayCutout` gives it. */
function drawCutout(s: Shapes, config: Protocol.Overlay.DisplayCutoutConfig) {
  const { x, y, width: w, height: h } = config.rect;
  const fill = config.contentColor ? css(config.contentColor) : 'rgba(0,0,0,1)';
  const box = { left: x, top: y, right: x + w, bottom: y + h };
  if (config.shape === 'rectangle') s.rect('cutout', box, fill);
  else if (config.shape === 'pill') {
    const r = Math.min(config.borderRadius ?? 0, w / 2, h / 2);
    s.path(
      'cutout',
      `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`,
      fill
    );
  } else if (config.shape === 'circle') {
    const r = config.radius ?? 0;
    const cx = config.cx ?? 0;
    const cy = config.cy ?? 0;
    s.path('cutout', `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`, fill);
  } else {
    // A notch: shoulders curving out of the top edge, rounded lower corners.
    const u = Math.min(config.upperRadius ?? 0, w / 4);
    const l = Math.min(config.lowerRadius ?? 0, w / 4, h);
    s.path(
      'cutout',
      `M${x - u} ${y}H${x + w + u}A${u} ${u} 0 0 0 ${x + w} ${y + u}V${y + h - l}A${l} ${l} 0 0 1 ${x + w - l} ${y + h}H${x + l}A${l} ${l} 0 0 1 ${x} ${y + h - l}V${y + u}A${u} ${u} 0 0 0 ${x - u} ${y}Z`,
      fill
    );
  }
}

/** Checks a cutout's config as Chrome does, in the same order. */
function checkCutout(config: Protocol.Overlay.DisplayCutoutConfig) {
  const { rect } = config;
  const numbers = [rect.x, rect.y, rect.width, rect.height, config.borderRadius, config.upperRadius];
  numbers.push(config.lowerRadius, config.cx, config.cy, config.radius);
  if (numbers.some(n => n !== undefined && n < 0)) throw new CdpError('Invalid display cutout geometry.');
  const shapes: string[] = ['pill', 'notch', 'circle', 'rectangle'];
  if (!shapes.includes(config.shape)) throw new CdpError('Unsupported display cutout shape.');
  if (config.shape === 'pill' && config.borderRadius === undefined)
    throw new CdpError('Pill display cutout requires borderRadius.');
  if (config.shape === 'notch' && (config.upperRadius === undefined || config.lowerRadius === undefined))
    throw new CdpError('Notch display cutout requires upperRadius and lowerRadius.');
  if (config.shape === 'circle' && (config.cx === undefined || config.cy === undefined || config.radius === undefined))
    throw new CdpError('Circle display cutout requires cx, cy, and radius.');
}

const HANDLE = 16;

/**
 * Isolation mode: the page masked around the element, with handles on its right, bottom and
 * corner that resize it by its inline `width` and `height`, as Chrome's do.
 */
function isolate(
  layer: HTMLElement,
  s: Shapes,
  el: Element,
  config: Protocol.Overlay.IsolationModeHighlightConfig,
  onDrag: () => void
) {
  const b = bounds(boxModel(el).border);
  const mask = css(config.maskColor);
  s.rect('mask', { left: 0, top: 0, right: innerWidth, bottom: b.top }, mask);
  s.rect('mask', { left: 0, top: b.bottom, right: innerWidth, bottom: innerHeight }, mask);
  s.rect('mask', { left: 0, top: b.top, right: b.left, bottom: b.bottom }, mask);
  s.rect('mask', { left: b.right, top: b.top, right: innerWidth, bottom: b.bottom }, mask);
  const handles: [string, Box, boolean, boolean][] = [
    ['ew-resize', { left: b.right, top: b.top, right: b.right + HANDLE, bottom: b.bottom }, true, false],
    ['ns-resize', { left: b.left, top: b.bottom, right: b.right, bottom: b.bottom + HANDLE }, false, true],
    ['nwse-resize', { left: b.right, top: b.bottom, right: b.right + HANDLE, bottom: b.bottom + HANDLE }, true, true],
  ];
  for (const [cursor, box, dx, dy] of handles) {
    s.rect('resizer', box, css(config.resizerColor));
    const handle = document.createElement('div');
    handle.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.right - box.left}px;
      height:${box.bottom - box.top}px;pointer-events:auto;cursor:${cursor};touch-action:none`;
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const target = isHtmlElement(el) || isSvgElement(el) ? el : null;
      if (!target) return;
      const { width, height } = target.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY, width, height };
      const stop = new AbortController();
      addEventListener(
        'pointermove',
        move => {
          if (dx) target.style.width = `${Math.max(start.width + move.clientX - start.x, 0)}px`;
          if (dy) target.style.height = `${Math.max(start.height + move.clientY - start.y, 0)}px`;
          onDrag();
        },
        { capture: true, signal: stop.signal }
      );
      addEventListener('pointerup', () => stop.abort(), { capture: true, signal: stop.signal });
    });
    layer.appendChild(handle);
  }
}

interface Tools {
  grid: Map<Element, Protocol.Overlay.GridHighlightConfig>;
  flex: Map<Element, Protocol.Overlay.FlexContainerHighlightConfig>;
  container: Map<Element, Protocol.Overlay.ContainerQueryContainerHighlightConfig>;
  snap: Map<Element, Protocol.Overlay.ScrollSnapContainerHighlightConfig>;
  isolated: Map<Element, Protocol.Overlay.IsolationModeHighlightConfig>;
  hinge?: Protocol.Overlay.HingeConfig | undefined;
  cutout?: Protocol.Overlay.DisplayCutoutConfig | undefined;
}

/**
 * The persistent overlays (grid, flex, container query, scroll snap, isolation mode, hinge,
 * display cutout): drawn in a click-through layer under highlightNode's, redrawn every frame
 * while any is shown, since Chrome's follow layout, scrolling and resizing alike.
 */
export function registerOverlayTools(ctx: Context, zIndex: number) {
  const tools: Tools = { grid: new Map(), flex: new Map(), container: new Map(), snap: new Map(), isolated: new Map() };
  let layer: HTMLDivElement | null = null;
  let frame = 0;
  let drawn = '';

  const active = () =>
    tools.grid.size + tools.flex.size + tools.container.size + tools.snap.size + tools.isolated.size > 0 ||
    !!tools.hinge ||
    !!tools.cutout;

  function draw() {
    frame = 0;
    if (!active()) {
      layer?.remove();
      layer = null;
      drawn = '';
      return;
    }
    if (!layer?.isConnected) {
      layer = document.createElement('div');
      layer.setAttribute(OWN_ATTRIBUTE, 'overlay-tools');
      markOwn(layer);
      layer.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${zIndex}`;
      // In the top page, before the highlight's layer, which goes above it.
      document.documentElement.prepend(layer);
      drawn = '';
    }
    const s = new Shapes();
    const live = <T>(map: Map<Element, T>) => Array.from(map).filter(([el]) => el.isConnected);
    for (const [el, config] of live(tools.grid)) drawGrid(s, el, config);
    for (const [el, config] of live(tools.flex)) drawFlex(s, el, config);
    for (const [el, config] of live(tools.container)) drawContainer(s, el, config);
    for (const [el, config] of live(tools.snap)) drawScrollSnap(s, el, config);
    const isolated = live(tools.isolated);
    const { hinge, cutout } = tools;
    if (hinge) {
      const { x, y, width, height } = hinge.rect;
      s.rect(
        'hinge',
        { left: x, top: y, right: x + width, bottom: y + height },
        css(hinge.contentColor),
        css(hinge.outlineColor)
      );
    }
    if (cutout) drawCutout(s, cutout);
    // Rebuilt only when something moved: the isolation handles are rebuilt with the rest.
    const key = s.parts.join('') + JSON.stringify(isolated.map(([el, c]) => [bounds(boxModel(el).border), c]));
    if (key !== drawn) {
      drawn = key;
      layer.replaceChildren();
      const shapes = new Shapes();
      shapes.parts.push(...s.parts);
      for (const [el, config] of isolated) isolate(layer, shapes, el, config, schedule);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      // Inline, so that the page's own rules for svg do not apply.
      svg.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;display:block;overflow:visible;
        margin:0;padding:0;border:0;max-width:none;max-height:none;transform:none;opacity:1;visibility:visible`;
      svg.innerHTML = shapes.parts.join('');
      layer.prepend(svg);
    }
    schedule();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  /** Resolves the nodes of a set* command up front, so that one missing one changes nothing, as in Chrome. */
  function elements<C extends { nodeId: number }>(list: C[]): [Element, C][] {
    const out: [Element, C][] = [];
    for (const config of list) {
      // A merged sandboxed iframe's node: its agent's own document, not drawn here (yet).
      if (ownerOfId(config.nodeId) !== undefined) continue;
      const node = resolveNode(ctx, { nodeId: config.nodeId });
      // A text node or the like is no container: it is left out, as Chrome does.
      if (isElement(node)) out.push([node, config]);
    }
    return out;
  }

  function set<T>(map: Map<Element, T>, entries: [Element, T][]) {
    map.clear();
    for (const [el, config] of entries) map.set(el, config);
    schedule();
  }

  function clear() {
    for (const map of [tools.grid, tools.flex, tools.container, tools.snap, tools.isolated]) map.clear();
    tools.hinge = tools.cutout = undefined;
    cancelAnimationFrame(frame);
    draw();
  }
  ctx.session.onReset(clear);

  return {
    clear,
    commands: {
      setShowGridOverlays: (p: Protocol.Overlay.SetShowGridOverlaysRequest) =>
        set(
          tools.grid,
          elements(p.gridNodeHighlightConfigs).map(([el, c]) => [el, c.gridHighlightConfig])
        ),
      setShowFlexOverlays: (p: Protocol.Overlay.SetShowFlexOverlaysRequest) =>
        set(
          tools.flex,
          elements(p.flexNodeHighlightConfigs).map(([el, c]) => [el, c.flexContainerHighlightConfig])
        ),
      setShowContainerQueryOverlays: (p: Protocol.Overlay.SetShowContainerQueryOverlaysRequest) =>
        set(
          tools.container,
          elements(p.containerQueryHighlightConfigs).map(([el, c]) => [el, c.containerQueryContainerHighlightConfig])
        ),
      setShowScrollSnapOverlays: (p: Protocol.Overlay.SetShowScrollSnapOverlaysRequest) =>
        set(
          tools.snap,
          elements(p.scrollSnapHighlightConfigs).map(([el, c]) => [el, c.scrollSnapContainerHighlightConfig])
        ),
      setShowIsolatedElements: (p: Protocol.Overlay.SetShowIsolatedElementsRequest) =>
        set(
          tools.isolated,
          elements(p.isolatedElementHighlightConfigs).map(([el, c]) => [el, c.isolationModeHighlightConfig])
        ),
      setShowHinge(p: Protocol.Overlay.SetShowHingeRequest) {
        const rect = p.hingeConfig?.rect;
        if (rect && [rect.x, rect.y, rect.width, rect.height].some(n => n < 0))
          throw new CdpError('Invalid hinge rectangle.');
        tools.hinge = p.hingeConfig;
        schedule();
      },
      setShowDisplayCutout(p: Protocol.Overlay.SetShowDisplayCutoutRequest) {
        if (p.displayCutoutConfig) checkCutout(p.displayCutoutConfig);
        tools.cutout = p.displayCutoutConfig;
        schedule();
      },
    },
  };
}
