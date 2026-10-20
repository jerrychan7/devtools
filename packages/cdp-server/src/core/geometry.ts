/** A CDP quad: x1 y1 … x4 y4, clockwise from the top left. */
export type Quad = number[];

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const rectQuad = (r: Box): Quad => [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom];

/** The quad of `box` (in an element's local, untransformed coordinates) mapped through `m`. */
export function mapQuad(m: DOMMatrixReadOnly, box: Box): Quad {
  const corners: [number, number][] = [
    [box.left, box.top],
    [box.right, box.top],
    [box.right, box.bottom],
    [box.left, box.bottom],
  ];
  return corners.flatMap(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x, y));
    return [p.x / p.w, p.y / p.w];
  });
}

const isTransformed = (style: CSSStyleDeclaration) =>
  style.transform !== 'none' ||
  ['translate', 'rotate', 'scale'].some(p => {
    const v = style.getPropertyValue(p);
    return v !== '' && v !== 'none';
  });

/** Whether the element or an ancestor is transformed: a cheap check before following the layout. */
export function hasTransformedAncestor(el: Element): boolean {
  for (let a: Element | null = el; a; a = a.parentElement) if (isTransformed(getComputedStyle(a))) return true;
  return false;
}

/** A translate length; percentages are relative to the element's own border box, like CSS. */
const length = (v: string, size: number) => {
  // A computed calc() is a sum of lengths and percentages, e.g. calc(50% + 10px).
  const inner = v.startsWith('calc(') && v.endsWith(')') ? v.slice(5, -1) : v;
  let total = 0;
  for (const term of inner.replace(/\s+([+-])\s+/g, ' $1').split(' ')) {
    const n = parseFloat(term) || 0;
    total += term.endsWith('%') ? (n / 100) * size : n;
  }
  return total;
};

/** A computed value's parts, split at the spaces outside parentheses. */
function parts(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let part = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ' ' && !depth) {
      if (part) out.push(part);
      part = '';
    } else part += ch;
  }
  if (part) out.push(part);
  return out;
}

/** The element's own transform, about its transform origin, or null without one. */
function ownTransform(el: Element, style = getComputedStyle(el)): DOMMatrix | null {
  const hasTransform = style.transform !== 'none';
  if (!isTransformed(style)) return null;
  // Composes translate, rotate, scale and transform in the order CSS applies them.
  let m = new DOMMatrix();
  const translate = style.getPropertyValue('translate');
  if (translate && translate !== 'none') {
    const [x = '0', y = '0', z = '0'] = parts(translate);
    const w = el instanceof HTMLElement ? el.offsetWidth : 0;
    const h = el instanceof HTMLElement ? el.offsetHeight : 0;
    m = m.translate(length(x, w), length(y, h), parseFloat(z) || 0);
  }
  const rotate = style.getPropertyValue('rotate');
  if (rotate && rotate !== 'none') m = m.multiply(new DOMMatrix(`rotate(${rotate})`));
  const scale = style.getPropertyValue('scale');
  if (scale && scale !== 'none') {
    const [x = '1', y = x, z = '1'] = scale.split(' ');
    m = m.scale(parseFloat(x), parseFloat(y), parseFloat(z));
  }
  if (hasTransform) m = m.multiply(new DOMMatrix(style.transform));
  const [ox = 0, oy = 0, oz = 0] = style.transformOrigin.split(' ').map(v => parseFloat(v) || 0);
  return new DOMMatrix().translate(ox, oy, oz).multiply(m).translate(-ox, -oy, -oz);
}

/** The perspective an element gives its children, about its perspective origin. */
function perspectiveOf(style: CSSStyleDeclaration): DOMMatrix | null {
  const distance = parseFloat(style.perspective);
  if (!(distance > 0)) return null;
  const [ox = 0, oy = 0] = style.perspectiveOrigin.split(' ').map(v => parseFloat(v) || 0);
  const p = new DOMMatrix();
  p.m34 = -1 / distance;
  return new DOMMatrix().translate(ox, oy).multiply(p).translate(-ox, -oy);
}

/** Drops the z row and column, as where a 3D rendering context ends (Blink's FlattenTo2d). */
function flatten(m: DOMMatrix): DOMMatrix {
  const f = DOMMatrix.fromMatrix(m);
  f.m13 = 0;
  f.m23 = 0;
  f.m43 = 0;
  f.m31 = 0;
  f.m32 = 0;
  f.m34 = 0;
  f.m33 = 1;
  return f;
}

/**
 * Where the border box of the body or root element is in the document, before its transform
 * (their offsetLeft and offsetTop are always 0).
 */
function documentPosition(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  const own = ownTransform(el);
  if (own) {
    const q = mapQuad(own, { left: 0, top: 0, right: el.offsetWidth, bottom: el.offsetHeight });
    dx = Math.min(...q.filter((_, i) => i % 2 === 0));
    dy = Math.min(...q.filter((_, i) => i % 2 === 1));
  }
  return { x: rect.left - dx + scrollX, y: rect.top - dy + scrollY };
}

/**
 * Maps the element's border-box coordinates (origin at its top left, before transforms) to the
 * viewport, from container to container (offsetParent, which in Chrome includes transformed and
 * perspective elements): their transforms and perspectives, the scrolling in between, and 3D
 * rendering contexts flattened where they end. Null when the layout cannot be followed that way
 * (SVG, …): callers fall back to the bounding rectangle.
 */
export function localToViewport(el: Element): DOMMatrix | null {
  if (!(el instanceof HTMLElement)) return null;
  const scrolling = document.scrollingElement;
  let m = new DOMMatrix();
  // Each element's computed style is read once, as the node and then as the container.
  for (let node: HTMLElement = el, style = getComputedStyle(el); ;) {
    const own = ownTransform(node, style);
    if (own) m = own.multiply(m);
    const container = node.offsetParent;
    const position = style.position;
    let x = node.offsetLeft;
    let y = node.offsetTop;
    // Offsets ignore the scroll containers in between, which move the node unless it is positioned
    // out of them.
    if (position !== 'absolute' && position !== 'fixed')
      for (let a = node.parentElement; a && a !== container; a = a.parentElement)
        if (a !== scrolling) {
          x -= a.scrollLeft;
          y -= a.scrollTop;
        }
    if (!(container instanceof HTMLElement)) {
      // The viewport, or the document for the root elements.
      if (position === 'fixed') return flatten(new DOMMatrix().translate(x, y).multiply(m));
      if (node === document.body || node === document.documentElement) {
        const origin = documentPosition(node);
        return flatten(new DOMMatrix().translate(origin.x - scrollX, origin.y - scrollY).multiply(m));
      }
      return null;
    }
    const containerStyle = getComputedStyle(container);
    if (container === document.body || container === document.documentElement) {
      // Offsets from a static body are relative to the document, from a positioned one to its
      // border box (Chrome).
      if (containerStyle.position === 'static') {
        const origin = documentPosition(container);
        x -= origin.x;
        y -= origin.y;
      }
      if (container !== scrolling) {
        x -= container.scrollLeft;
        y -= container.scrollTop;
      }
    } else {
      // Relative to the container's padding edge.
      x += container.clientLeft - container.scrollLeft;
      y += container.clientTop - container.scrollTop;
    }
    m = new DOMMatrix().translate(x, y).multiply(m);
    const perspective = perspectiveOf(containerStyle);
    if (perspective) m = perspective.multiply(m);
    if (containerStyle.transformStyle !== 'preserve-3d') m = flatten(m);
    node = container;
    style = containerStyle;
  }
}

/** The nearest HTML ancestor of an SVG element, which the SVG layout is placed in. */
function htmlAncestor(el: Element): HTMLElement | null {
  let a: Element | null = el.parentElement;
  while (a && !(a instanceof HTMLElement)) a = a.parentElement;
  return a;
}

/**
 * Maps an SVG element's user space to the viewport. getScreenCTM is only the affine part of that
 * (Blink drops the perspective): composed with the exact mapping of the nearest HTML ancestor,
 * from which the SVG part is solved.
 */
function svgToViewport(
  el: SVGGraphicsElement,
  ancestors = new Map<Element, DOMMatrix | null>()
): { m: DOMMatrix; svg: DOMMatrix } | null {
  const ctm = el.getScreenCTM();
  if (!ctm) return null;
  const screen = DOMMatrix.fromMatrix(ctm);
  const ancestor = htmlAncestor(el);
  // The mapping of the ancestor, shared by the elements of a subtree.
  let a: DOMMatrix | null = null;
  if (ancestor) {
    const known = ancestors.get(ancestor);
    a = known !== undefined ? known : hasTransformedAncestor(ancestor) ? localToViewport(ancestor) : null;
    ancestors.set(ancestor, a);
  }
  const det = a ? a.m11 * a.m22 - a.m21 * a.m12 : 0;
  if (!a || Math.abs(det) < 1e-9) return { m: screen, svg: screen };
  // [x; y] = K [u; v], K = [m11 m21; m12 m22].
  const solve = (x: number, y: number) => [(a.m22 * x - a.m21 * y) / det, (a.m11 * y - a.m12 * x) / det];
  const [na = 0, nb = 0] = solve(screen.a, screen.b);
  const [nc = 0, nd = 0] = solve(screen.c, screen.d);
  const [ne = 0, nf = 0] = solve(screen.e - a.m41, screen.f - a.m42);
  const svg = new DOMMatrix([na, nb, nc, nd, ne, nf]);
  return { m: a.multiply(svg), svg };
}

/**
 * How far the stroke reaches out of the geometry, approximated like Chrome: half the stroke width,
 * times √2 for square caps, or the miter limit for miter joins of paths and polylines.
 */
function strokeOutset(el: SVGGraphicsElement): number {
  if (!(el instanceof SVGGeometryElement)) return 0;
  const style = getComputedStyle(el);
  const width = parseFloat(style.strokeWidth) || 0;
  if (style.stroke === 'none' || width <= 0) return 0;
  if (el instanceof SVGRectElement || el instanceof SVGCircleElement || el instanceof SVGEllipseElement)
    return width / 2;
  let factor = style.strokeLinecap === 'square' ? Math.SQRT2 : 1;
  if (!(el instanceof SVGLineElement) && style.strokeLinejoin === 'miter')
    factor = Math.max(factor, parseFloat(style.strokeMiterlimit) || 4);
  return (width / 2) * factor;
}

const isContainer = (el: Element) =>
  el instanceof SVGGElement ||
  el instanceof SVGSVGElement ||
  el instanceof SVGAElement ||
  el instanceof SVGSwitchElement;

/** The bounds of the quad. */
function boundsOf(q: Quad): Box {
  const xs = q.filter((_, i) => i % 2 === 0);
  const ys = q.filter((_, i) => i % 2 === 1);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** An SVG element's stroke bounding box in its user space: a container's covers its children's. */
function strokeBox(el: SVGGraphicsElement, svg: DOMMatrix, ancestors = new Map<Element, DOMMatrix | null>()): Box {
  if (isContainer(el)) {
    let union: Box | null = null;
    const inverse = svg.inverse();
    for (const child of Array.from(el.children)) {
      if (!(child instanceof SVGGraphicsElement) || getComputedStyle(child).display === 'none') continue;
      const mapping = svgToViewport(child, ancestors);
      if (!mapping) continue;
      const box = boundsOf(mapQuad(inverse.multiply(mapping.svg), strokeBox(child, mapping.svg, ancestors)));
      union = union
        ? {
            left: Math.min(union.left, box.left),
            top: Math.min(union.top, box.top),
            right: Math.max(union.right, box.right),
            bottom: Math.max(union.bottom, box.bottom),
          }
        : box;
    }
    if (union) return union;
  }
  const b = el.getBBox();
  const grow = strokeOutset(el);
  return { left: b.x - grow, top: b.y - grow, right: b.x + b.width + grow, bottom: b.y + b.height + grow };
}

/**
 * The box Chrome gives an element inside an <svg>: its stroke bounding box mapped to the viewport,
 * the integer bounds of that as the size (for text, the bounding box's right and bottom edges in
 * user space, rounded).
 */
export function svgLayout(el: Element): { quad: Quad; width: number; height: number } | null {
  if (!(el instanceof SVGGraphicsElement) || (el instanceof SVGSVGElement && !el.ownerSVGElement)) return null;
  const ancestors = new Map<Element, DOMMatrix | null>();
  const mapping = svgToViewport(el, ancestors);
  if (!mapping) return null;
  const q = mapQuad(mapping.m, strokeBox(el, mapping.svg, ancestors));
  if (el instanceof SVGTextElement) {
    const b = el.getBBox();
    return { quad: q, width: Math.round(b.x + b.width), height: Math.round(b.y + b.height) };
  }
  const b = boundsOf(q);
  return {
    quad: q,
    width: Math.ceil(b.right) - Math.floor(b.left),
    height: Math.ceil(b.bottom) - Math.floor(b.top),
  };
}

/** The viewBox transform of an <svg> whose content box is `width` × `height`. */
function viewBoxTransform(svg: SVGSVGElement, width: number, height: number): DOMMatrix {
  const vb = svg.viewBox.baseVal;
  if (!svg.hasAttribute('viewBox') || !vb || vb.width <= 0 || vb.height <= 0) return new DOMMatrix();
  const par = svg.preserveAspectRatio.baseVal;
  let sx = width / vb.width;
  let sy = height / vb.height;
  let tx = 0;
  let ty = 0;
  if (par.align !== SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE) {
    const scale =
      par.meetOrSlice === SVGPreserveAspectRatio.SVG_MEETORSLICE_SLICE ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = scale;
    // xMinYMin is 2, xMidYMin 3, …, xMaxYMax 10.
    const align = Math.max(par.align - 2, 0);
    tx = ((align % 3) / 2) * (width - vb.width * scale);
    ty = (Math.floor(align / 3) / 2) * (height - vb.height * scale);
  }
  return new DOMMatrix().translate(tx, ty).scale(sx, sy).translate(-vb.x, -vb.y);
}

/** The border box mapping and size of an outermost <svg>, from its user space mapping. */
export function svgRootLayout(el: Element): { m: DOMMatrix; width: number; height: number } | null {
  if (!(el instanceof SVGSVGElement) || el.ownerSVGElement) return null;
  const mapping = svgToViewport(el);
  if (!mapping) return null;
  const style = getComputedStyle(el);
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const left = px('border-left-width') + px('padding-left');
  const top = px('border-top-width') + px('padding-top');
  const contentWidth = el.clientWidth - px('padding-left') - px('padding-right');
  const contentHeight = el.clientHeight - px('padding-top') - px('padding-bottom');
  const m = mapping.m.multiply(viewBoxTransform(el, contentWidth, contentHeight).inverse()).translate(-left, -top);
  return {
    m,
    width: el.clientWidth + px('border-left-width') + px('border-right-width'),
    height: el.clientHeight + px('border-top-width') + px('border-bottom-width'),
  };
}

/**
 * An inline element's line boxes relative to its border box (the union of them), measured with
 * the transforms of it and its ancestors switched off for the moment (2D transforms that do not
 * move anything, so that containing blocks stay), by animations that are gone before anything is
 * drawn and change no attribute. Null when the page's own !important transform wins over the
 * animation, and when a scrolled ancestor (or the document) may owe its scroll position to the
 * transformed boxes, as the smaller overflow could clamp it and fire a scroll event.
 */
export function untransformedBoxes(el: Element): Box[] | null {
  const off = { transform: 'translate(0px)', translate: 'none', rotate: 'none', scale: 'none' };
  const animated: Element[] = [];
  for (let a: Element | null = el; a; a = a.parentElement) {
    // Switching the transforms off can shrink a scroller's scrollable overflow and clamp its
    // position, which queues a scroll event the page would see even if the position is put back.
    if ((a.scrollLeft || a.scrollTop) && !fillsScrollEnd(a, [el, ...animated])) return null;
    if (isTransformed(getComputedStyle(a))) animated.push(a);
  }
  const animations = animated.map(a => {
    const animation = a.animate([off, off], { duration: 1, fill: 'both' });
    animation.pause();
    return animation;
  });
  try {
    if (animated.some(a => getComputedStyle(a).transform !== 'matrix(1, 0, 0, 1, 0, 0)')) return null;
    const origin = el.getBoundingClientRect();
    return Array.from(el.getClientRects(), r => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      right: r.right - origin.left,
      bottom: r.bottom - origin.top,
    }));
  } finally {
    for (const animation of animations) animation.cancel();
  }
}

function union(a: DOMRect, b: DOMRect): DOMRect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return new DOMRect(left, top, Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
}

/**
 * Whether switching the transforms of the descendants `moved` of the scroller `a` (and with
 * them the measured element) off cannot clamp its scroll position: in each direction it is
 * scrolled to (negative positions scroll to the left or top), every one of them ends short of the end
 * of its visible area or of the end of its scrollable overflow, which other content then holds.
 * Their contents count with them (overflow that is not part of a box, such as shadows, does not).
 */
function fillsScrollEnd(a: Element, moved: Element[]): boolean {
  const viewport = a === a.ownerDocument.scrollingElement;
  const box = viewport ? new DOMRect(0, 0, 0, 0) : a.getBoundingClientRect();
  const left = box.left + (viewport ? 0 : a.clientLeft);
  const top = box.top + (viewport ? 0 : a.clientTop);
  const right = left + a.clientWidth;
  const bottom = top + a.clientHeight;
  // Chrome rounds the overflow of transformed boxes outwards, by up to 2px here and there.
  const slack = 3;
  return moved.every(t => {
    const own = t.getBoundingClientRect();
    const range = t.ownerDocument.createRange();
    range.selectNodeContents(t);
    const inner = range.getBoundingClientRect();
    const r = inner.width || inner.height ? union(own, inner) : own;
    const x =
      a.scrollLeft > 0
        ? r.right < right - slack || r.right - left + a.scrollLeft < a.scrollWidth - slack
        : a.scrollLeft >= 0 || r.left > left + slack;
    const y =
      a.scrollTop > 0
        ? r.bottom < bottom - slack || r.bottom - top + a.scrollTop < a.scrollHeight - slack
        : a.scrollTop >= 0 || r.top > top + slack;
    return x && y;
  });
}

/**
 * The local boxes of fragments (an inline element's line boxes) under the affine `m`, from their
 * client rectangles, which are the bounds of the mapped boxes. Null when `m` is not affine or the
 * bounds do not determine the boxes (45° rotations).
 */
export function unmapRects(m: DOMMatrix, rects: DOMRect[]): Box[] | null {
  if (m.m14 !== 0 || m.m24 !== 0 || m.m44 !== 1) return null;
  const a = Math.abs(m.a);
  const b = Math.abs(m.b);
  const c = Math.abs(m.c);
  const d = Math.abs(m.d);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-3) return null;
  const inverse = m.inverse();
  return rects.map(r => {
    const w = (d * r.width - c * r.height) / det;
    const h = (a * r.height - b * r.width) / det;
    const center = inverse.transformPoint(new DOMPoint(r.left + r.width / 2, r.top + r.height / 2));
    return { left: center.x - w / 2, top: center.y - h / 2, right: center.x + w / 2, bottom: center.y + h / 2 };
  });
}

const replaced = [
  HTMLImageElement,
  HTMLVideoElement,
  HTMLCanvasElement,
  HTMLIFrameElement,
  HTMLEmbedElement,
  HTMLObjectElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
];

/** Whether the element lays out as line boxes: an inline, non-replaced element. */
export const isInlineBox = (el: Element) =>
  el instanceof HTMLElement && getComputedStyle(el).display === 'inline' && !replaced.some(type => el instanceof type);

/**
 * Chrome's quads of an inline element's line boxes leave out its padding and border: above and
 * below on every line, at the start of the first line and the end of the last.
 */
export function lineContentBoxes(el: Element, boxes: Box[]): Box[] {
  const style = getComputedStyle(el);
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const edge = (side: string) => px(`padding-${side}`) + px(`border-${side}-width`);
  const top = edge('top');
  const bottom = edge('bottom');
  const rtl = style.direction === 'rtl';
  const start = edge(rtl ? 'right' : 'left');
  const end = edge(rtl ? 'left' : 'right');
  return boxes.map((box, i) => {
    let { left, right } = box;
    if (i === 0) {
      if (rtl) right -= start;
      else left += start;
    }
    if (i === boxes.length - 1) {
      if (rtl) left += end;
      else right -= end;
    }
    return { left, top: box.top + top, right, bottom: box.bottom - bottom };
  });
}
