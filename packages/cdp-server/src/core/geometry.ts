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
const length = (v: string, size: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);

/** The element's own transform, about its transform origin, or null without one. */
function ownTransform(el: Element): DOMMatrix | null {
  const style = getComputedStyle(el);
  const hasTransform = style.transform !== 'none';
  if (!isTransformed(style)) return null;
  // Composes translate, rotate, scale and transform in the order CSS applies them.
  let m = new DOMMatrix();
  const translate = style.getPropertyValue('translate');
  if (translate && translate !== 'none') {
    const [x = '0', y = '0', z = '0'] = translate.split(' ');
    const w = el instanceof HTMLElement ? el.offsetWidth : 0;
    const h = el instanceof HTMLElement ? el.offsetHeight : 0;
    // calc() mixes are not parsed here: the caller's bounding-box check falls back then.
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

/**
 * Maps the element's border-box coordinates (origin at its top left, before transforms) to the
 * viewport, following the offsetParent chain. Null when the layout cannot be followed that way
 * (SVG, fixed position, …): callers fall back to the bounding rectangle.
 */
export function localToViewport(el: Element): DOMMatrix | null {
  if (!(el instanceof HTMLElement)) return null;
  if (getComputedStyle(el).position === 'fixed') return null;
  const parent = el.offsetParent;
  const own = ownTransform(el);
  let base: DOMMatrix;
  let x = el.offsetLeft;
  let y = el.offsetTop;
  if (parent === null || parent === document.body || parent === document.documentElement) {
    // Offsets are relative to the document then (unless body itself is transformed or positioned).
    if (parent && getComputedStyle(parent).position !== 'static') return null;
    if (parent && ownTransform(parent)) return null;
    if (parent === null && el !== document.body && el !== document.documentElement) return null;
    base = new DOMMatrix().translate(-scrollX, -scrollY);
  } else {
    const outer = localToViewport(parent);
    if (!outer) return null;
    base = outer;
    // offsetLeft/Top are relative to the parent's padding edge.
    x += parent.clientLeft - parent.scrollLeft;
    y += parent.clientTop - parent.scrollTop;
  }
  // Scrolled or transformed ancestors in between are not accounted for by the offsets.
  for (let a = el.parentElement; a && a !== parent; a = a.parentElement) {
    if (a.scrollLeft || a.scrollTop || ownTransform(a)) return null;
  }
  const m = base.translate(x, y);
  return own ? m.multiply(own) : m;
}
