/**
 * Offsets in a text to lines and columns and back, both counted from 0, columns in UTF-16 code
 * units. A line ends at LF, CR LF, CR or FF, the newlines of CSS Syntax §3.3.
 */

/** The offset each line starts at: the first is 0. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let p = 0; p < text.length; p++) {
    const c = text.charCodeAt(p);
    if (c === 13 && text.charCodeAt(p + 1) === 10) p++;
    if (c === 10 || c === 13 || c === 12) starts.push(p + 1);
  }
  return starts;
}

export interface TextPosition {
  line: number;
  column: number;
}

/** The line and column of `offset`, from `lineStarts`. */
export function positionAt(starts: readonly number[], offset: number): TextPosition {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - (starts[lo] ?? 0) };
}

/** The offset of a line and column, from `lineStarts`; a line past the last one is the last. */
export function offsetAt(starts: readonly number[], line: number, column: number): number {
  return (starts[Math.min(Math.max(line, 0), starts.length - 1)] ?? 0) + column;
}
