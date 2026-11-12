// Pixel comparison of screenshots, for the conformance tests that compare what Chrome paints with what
// we paint. Decodes the 8-bit, non-interlaced PNGs Chrome's screenshots are (RGB or RGBA) and nothing else.
// The comparison looks at the colour channels only: a page's screenshot is opaque, so alpha is not compared.
import { inflateSync } from 'node:zlib';

/** An image: its size, and its pixels as RGBA, four bytes each, row by row. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A rectangle of pixels: its top-left corner and its size. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The paeth or other filter of a scanline, reversed in place (PNG's filter types 0 to 4). */
function unfilter(type: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  for (let x = 0; x < line.length; x++) {
    const a = x >= bpp ? (line[x - bpp] ?? 0) : 0;
    const b = prev[x] ?? 0;
    const c = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
    let predictor = 0;
    if (type === 1) predictor = a;
    else if (type === 2) predictor = b;
    else if (type === 3) predictor = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    line[x] = ((line[x] ?? 0) + predictor) & 0xff;
  }
}

/** Decodes a PNG (see the module comment), as its RGBA pixels. */
export function decodePng(bytes: Uint8Array): Pixels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let channels = 0;
  for (let pos = 8; pos + 8 <= bytes.length;) {
    const length = view.getUint32(pos);
    if (pos + 12 + length > bytes.length) throw new Error('truncated PNG: a chunk runs past the end');
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = bytes[pos + 16];
      const colour = bytes[pos + 17];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || bytes[pos + 20] !== 0) {
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colour}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!channels) throw new Error('PNG without an IHDR chunk');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG: the image data is short');
  const data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const line = raw.subarray(start + 1, start + 1 + stride);
    const current = new Uint8Array(line);
    const filter = raw[start] ?? 0;
    if (filter > 4) throw new Error(`bad PNG filter type ${filter}`);
    unfilter(filter, current, prev, channels);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = current[x * channels] ?? 0;
      data[o + 1] = current[x * channels + 1] ?? 0;
      data[o + 2] = current[x * channels + 2] ?? 0;
      data[o + 3] = channels === 4 ? (current[x * channels + 3] ?? 0) : 255;
    }
    prev = current;
  }
  return { width, height, data };
}

/** Whether the pixel at index `i` of `a` and `b` differs by more than `tolerance` in some colour channel. */
function differs(a: Pixels, b: Pixels, i: number, tolerance: number): boolean {
  const o = i * 4;
  for (let k = 0; k < 3; k++) {
    if (Math.abs((a.data[o + k] ?? 0) - (b.data[o + k] ?? 0)) > tolerance) return true;
  }
  return false;
}

/**
 * The number of pixels of `box` that differ between `a` and `b`. The box must be inside both images and not empty:
 * a part of it outside them would go uncompared, and a box fully outside would compare nothing, so either throws
 * rather than count only the pixels that happen to be there.
 */
export function mismatches(a: Pixels, b: Pixels, box: Box, tolerance = 0): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`the screenshots differ in size: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  const { x, y, width, height } = box;
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > a.width || y + height > a.height) {
    throw new Error(
      `the box ${x},${y} ${width}x${height} is empty or not inside the ${a.width}x${a.height} screenshot`
    );
  }
  let count = 0;
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      if (differs(a, b, row * a.width + col, tolerance)) count++;
    }
  }
  return count;
}

/** The share of the pixels of `a` that `b` matches (within `tolerance`), over the whole image. */
export function agreement(a: Pixels, b: Pixels, tolerance = 0): number {
  const total = a.width * a.height;
  return 1 - mismatches(a, b, { x: 0, y: 0, width: a.width, height: a.height }, tolerance) / total;
}
