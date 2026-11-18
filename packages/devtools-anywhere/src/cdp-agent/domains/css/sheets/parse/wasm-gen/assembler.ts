/**
 * A WebAssembly binary encoder small enough to read in one sitting, for writing the CSS lexer and
 * outline's module without a compiler (lexer.ts, outline.ts). Instructions are built as arrays of
 * bytes; blocks take a label and a function that returns their body, so a branch names its target
 * instead of counting how deep it is.
 */

export type Code = number[];

/** Unsigned LEB128. */
export const uleb = (n: number): Code => {
  const out: Code = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};

/** Signed LEB128, for i32 constants. */
export const sleb = (n: number): Code => {
  const out: Code = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) return [...out, b];
    out.push(b | 0x80);
  }
};

const vec = (items: Code[]): Code => [...uleb(items.length), ...items.flat()];
const name = (s: string): Code => vec([...new TextEncoder().encode(s)].map(b => [b]));
const section = (id: number, body: Code): Code => [id, ...uleb(body.length), ...body];

export const I32 = 0x7f;
const VOID = 0x40;

// Labels of the blocks the code being built is inside, innermost last; '' for an `if`.
const labels: string[] = [];
const depth = (label: string): number => {
  const i = labels.lastIndexOf(label);
  if (i < 0) throw new Error(`no enclosing block ${label}`);
  return labels.length - 1 - i;
};
const scoped = (label: string, body: () => Code[]): Code => {
  labels.push(label);
  try {
    return body().flat();
  } finally {
    labels.pop();
  }
};

export const block = (label: string, body: () => Code[]): Code => [0x02, VOID, ...scoped(label, body), 0x0b];
export const loop = (label: string, body: () => Code[]): Code => [0x03, VOID, ...scoped(label, body), 0x0b];
export const br = (label: string): Code => [0x0c, ...uleb(depth(label))];
export const brIf = (label: string, cond: Code): Code => [...cond, 0x0d, ...uleb(depth(label))];
/** Branches to `targets[index]`, or to `fallback` for an index past them. */
export const brTable = (index: Code, targets: string[], fallback: string): Code => [
  ...index,
  0x0e,
  ...vec(targets.map(t => uleb(depth(t)))),
  ...uleb(depth(fallback)),
];
export const if_ = (cond: Code, then: () => Code[], otherwise?: () => Code[]): Code => [
  ...cond,
  0x04,
  VOID,
  ...scoped('', then),
  ...(otherwise ? [0x05, ...scoped('', otherwise)] : []),
  0x0b,
];
/** `cond ? a : b` as a value; both sides are evaluated. */
export const select = (a: Code, b: Code, cond: Code): Code => [...a, ...b, ...cond, 0x1b];
export const ret = (value?: Code): Code => [...(value ?? []), 0x0f];

export const i32 = (n: number): Code => [0x41, ...sleb(n | 0)];
const bin =
  (op: number) =>
  (a: Code, b: Code): Code => [...a, ...b, op];
export const eqz = (a: Code): Code => [...a, 0x45];
export const eq = bin(0x46);
export const ne = bin(0x47);
export const ltS = bin(0x48);
export const ltU = bin(0x49);
export const geS = bin(0x4e);
export const geU = bin(0x4f);
export const add = bin(0x6a);
export const sub = bin(0x6b);
export const and = bin(0x71);
export const or = bin(0x72);
export const shl = bin(0x74);
export const gtS = bin(0x4a);
export const gtU = bin(0x4b);
export const leU = bin(0x4d);
export const mul = bin(0x6c);
export const shrU = bin(0x76);
export const drop = (v: Code): Code => [...v, 0x1a];
export const unreachable = (): Code => [0x00];
/** memory.size and memory.grow, in pages; grow gives the old size, or -1. */
export const memSize = (): Code => [0x3f, 0];
export const memGrow = (pages: Code): Code => [...pages, 0x40, 0];

/** Loads and stores, with a constant offset added to the address. */
export const load8 = (addr: Code, offset = 0): Code => [...addr, 0x2d, 0, ...uleb(offset)];
export const load16 = (addr: Code, offset = 0): Code => [...addr, 0x2f, 1, ...uleb(offset)];
export const load32 = (addr: Code, offset = 0): Code => [...addr, 0x28, 2, ...uleb(offset)];
export const store8 = (addr: Code, v: Code, offset = 0): Code => [...addr, ...v, 0x3a, 0, ...uleb(offset)];
export const store32 = (addr: Code, v: Code, offset = 0): Code => [...addr, ...v, 0x36, 2, ...uleb(offset)];
/** memory.fill (bulk memory). */
export const fill = (dest: Code, value: Code, size: Code): Code => [...dest, ...value, ...size, 0xfc, 11, 0];
/** memory.copy (bulk memory); the ranges may overlap. */
export const copy = (dest: Code, src: Code, size: Code): Code => [...dest, ...src, ...size, 0xfc, 10, 0, 0];

export interface Func {
  name: string;
  params: number;
  results: number;
  /** Names of the parameters, then of the other locals, all i32. */
  locals: string[];
  body: Code;
  export?: boolean;
}

/**
 * Builds functions whose locals and callees are found by name. `define` is called once every
 * function has its index, so bodies can call any of them.
 */
export class Module {
  private funcs: { name: string; params: number; results: number; locals: string[]; export: boolean }[] = [];
  private bodies: Code[] = [];
  private globals: string[] = [];
  private data: { offset: number; bytes: number[] }[] = [];
  private current: string[] = [];
  start?: string;

  private pages: number;
  constructor(pages: number) {
    this.pages = pages;
  }

  global(name: string): void {
    this.globals.push(name);
  }
  segment(offset: number, bytes: number[]): void {
    this.data.push({ offset, bytes });
  }
  declare(name: string, params: string[], results: number, locals: string[] = [], exported = false): void {
    this.funcs.push({ name, params: params.length, results, locals: [...params, ...locals], export: exported });
  }
  /** Gives the body of each declared function, in the order declared. */
  define(name: string, body: () => Code[]): void {
    const i = this.funcs.findIndex(f => f.name === name);
    const f = this.funcs[i];
    if (!f) throw new Error(`undeclared ${name}`);
    this.current = f.locals;
    this.bodies[i] = body().flat();
  }

  private local(name: string): number {
    const i = this.current.indexOf(name);
    if (i < 0) throw new Error(`no local ${name}`);
    return i;
  }
  get = (name: string): Code =>
    this.globals.includes(name) ? [0x23, ...uleb(this.globals.indexOf(name))] : [0x20, ...uleb(this.local(name))];
  set = (name: string, v: Code): Code =>
    this.globals.includes(name)
      ? [...v, 0x24, ...uleb(this.globals.indexOf(name))]
      : [...v, 0x21, ...uleb(this.local(name))];
  call = (name: string, ...args: Code[]): Code => {
    const i = this.funcs.findIndex(f => f.name === name);
    if (i < 0) throw new Error(`no function ${name}`);
    return [...args.flat(), 0x10, ...uleb(i)];
  };

  encode(): Uint8Array {
    // One type per distinct (params, results): every value is an i32.
    const sigs: string[] = [];
    const sig = (f: { params: number; results: number }) => {
      const key = `${f.params}:${f.results}`;
      if (!sigs.includes(key)) sigs.push(key);
      return sigs.indexOf(key);
    };
    const typeIndex = this.funcs.map(sig);
    const types = sigs.map(key => {
      const [p, r] = key.split(':').map(Number) as [number, number];
      return [0x60, ...vec(Array.from({ length: p }, () => [I32])), ...vec(Array.from({ length: r }, () => [I32]))];
    });
    const exports = [
      [...name('m'), 0x02, 0],
      ...this.funcs.flatMap((f, i) => (f.export ? [[...name(f.name), 0x00, ...uleb(i)]] : [])),
    ];
    const startIndex = this.start === undefined ? -1 : this.funcs.findIndex(f => f.name === this.start);
    const code = this.funcs.map((f, i) => {
      const extra = f.locals.length - f.params;
      const body = [...(extra ? vec([[...uleb(extra), I32]]) : [0]), ...(this.bodies[i] ?? []), 0x0b];
      return [...uleb(body.length), ...body];
    });
    const bytes = [
      // `\0asm`, version 1
      0x00,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, vec(types)),
      ...section(3, vec(typeIndex.map(t => uleb(t)))),
      ...section(5, vec([[0, ...uleb(this.pages)]])),
      ...section(6, vec(this.globals.map(() => [I32, 1, ...i32(-1), 0x0b]))),
      ...section(7, vec(exports)),
      ...(startIndex >= 0 ? section(8, uleb(startIndex)) : []),
      ...section(10, vec(code)),
      ...section(11, vec(this.data.map(d => [0, ...i32(d.offset), 0x0b, ...vec(d.bytes.map(b => [b]))]))),
    ];
    return Uint8Array.from(bytes);
  }
}
