// A grip for dragging a divider: a small pill with three dots that takes input only where it is
// seen, so that it hides none of what is around it. It is placed against an edge of its parent
// (which must be a containing block, positioned or fixed), on the middle of that edge: across
// the edge, inside the parent or outside it. Its colors are the custom properties
// --grip-background, --grip-border and --grip-dot, inherited from where it is placed.

/** An edge of the grip's parent. */
export type Edge = 'top' | 'right' | 'bottom' | 'left';

/** Where the grip sits against the edge: across it, inside the parent, or outside it. */
export type GripSide = 'center' | 'inside' | 'outside';

/** A size in CSS pixels: across the edge, then along it. */
export type GripSize = readonly [across: number, along: number];

export interface GripOptions {
  edge: Edge;
  side?: GripSide;
  /** For a mouse, and larger for a finger on touch screens. */
  size?: { mouse: GripSize; touch: GripSize };
  /** Its tooltip. */
  title?: string;
  onStart?(down: PointerEvent): void;
  /** Each move of the pointer while the grip is dragged; `down` is where the drag started. */
  onMove(move: PointerEvent, down: PointerEvent): void;
  onEnd?(): void;
}

const DEFAULT_SIZE = { mouse: [12, 36], touch: [20, 52] } as const;
const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
/** The corners on each side, in border-radius order (top left, top right, bottom right, bottom left). */
const CORNERS: Record<Edge, readonly number[]> = { top: [0, 1], right: [1, 2], bottom: [2, 3], left: [3, 0] };
const COARSE = '(pointer: coarse)';

export class Grip {
  readonly element: HTMLDivElement;
  private edge: Edge;
  private side: GripSide;
  private readonly size: { mouse: GripSize; touch: GripSize };
  private readonly coarse = matchMedia(COARSE);
  private readonly onPointerChange = () => this.render();

  constructor(private readonly options: GripOptions) {
    this.edge = options.edge;
    this.side = options.side ?? 'center';
    this.size = options.size ?? DEFAULT_SIZE;
    const el = (this.element = document.createElement('div'));
    if (options.title) el.title = options.title;
    el.style.cssText =
      'position:absolute;z-index:1;display:none;box-sizing:border-box;touch-action:none;' +
      'align-items:center;justify-content:center;gap:3px;' +
      'background:var(--grip-background,#f1f3f4);border:1px solid var(--grip-border,#cacdd1)';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.style.cssText =
        'width:3px;height:3px;border-radius:50%;background:var(--grip-dot,#5f6368);pointer-events:none';
      el.append(dot);
    }
    this.coarse.addEventListener('change', this.onPointerChange);
    this.setupDrag();
    this.render();
  }

  /** Moves the grip to another edge of its parent, or another side of it. */
  place(edge: Edge, side: GripSide = this.side) {
    this.edge = edge;
    this.side = side;
    this.render();
  }

  show(shown: boolean) {
    this.element.style.display = shown ? 'flex' : 'none';
  }

  dispose() {
    this.coarse.removeEventListener('change', this.onPointerChange);
    this.element.remove();
  }

  private render() {
    const { edge, side } = this;
    const style = this.element.style;
    const [across, along] = this.size[this.coarse.matches ? 'touch' : 'mouse'];
    const horizontal = edge === 'top' || edge === 'bottom';
    style.cursor = horizontal ? 'row-resize' : 'col-resize';
    style.flexDirection = horizontal ? 'row' : 'column';
    style.width = `${horizontal ? along : across}px`;
    style.height = `${horizontal ? across : along}px`;
    // On the middle of the edge, and across it, inside or outside by its offset from the edge.
    style.top = style.right = style.bottom = style.left = '';
    style[horizontal ? 'left' : 'top'] = `calc(50% - ${along / 2}px)`;
    style[edge] = `${{ center: -across / 2, inside: 0, outside: -across }[side]}px`;
    // Against the edge, a side of the grip is flat and has no border; the others are rounded.
    const flat: Edge | null = side === 'inside' ? edge : side === 'outside' ? OPPOSITE[edge] : null;
    const radius = [6, 6, 6, 6];
    if (flat) for (const corner of CORNERS[flat]) radius[corner] = 0;
    style.borderRadius = radius.map(r => `${r}px`).join(' ');
    style.borderWidth = '1px';
    if (flat) style.setProperty(`border-${flat}-width`, '0');
  }

  private setupDrag() {
    const el = this.element;
    el.addEventListener('pointerdown', down => {
      down.preventDefault();
      el.setPointerCapture(down.pointerId);
      this.options.onStart?.(down);
      const move = (e: PointerEvent) => this.options.onMove(e, down);
      // Released, or the capture lost (the grip removed mid-drag): a single end either way.
      const end = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('lostpointercapture', end);
        this.options.onEnd?.();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('lostpointercapture', end);
    });
  }
}
