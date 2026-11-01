// Shell mode's layout, as in Chrome: DevTools' frontend fills the shell and lays out the page and
// itself (upstream's AdvancedApp), telling where the page goes (`page-bounds`, its
// InspectedPagePlaceholder); the shell places the page iframe there, on top. In device mode the
// frontend asks for the page's size through Emulation.setDeviceMetricsOverride, which the shell
// answers by sizing and scaling the page iframe. Undocked, device mode draws into a page of the
// frontend's (`toolbox`), shown here in an iframe under the floating panel; the bounds are then in
// that iframe. Until the frontend says where the page goes, or while DevTools is hidden, the page
// fills the shell. On touch screens a handle on the edge between the page and DevTools resizes
// them, since the frontend's own resizer is a few pixels wide.

import type { DeviceMetrics } from './connection';
import { type DockSide, type FrontendNotice, type PageBounds, REQUEST_KEY, SIDEBAR_SIZE_NOTICE } from './embedder';

/** Width of the touch handle, as the panel's bar on touch screens. */
const HANDLE = 28;

/** Sets the given inline styles, and clears the others this layout sets. */
function place(
  el: HTMLElement,
  styles: Partial<Record<'left' | 'top' | 'width' | 'height' | 'transform' | 'clipPath', string>>
) {
  const style = el.style;
  const fixed = Object.keys(styles).length > 0;
  style.position = fixed ? 'fixed' : '';
  style.zIndex = fixed ? '1' : '';
  style.left = styles.left ?? '';
  style.top = styles.top ?? '';
  style.width = styles.width ?? '';
  style.height = styles.height ?? '';
  style.flex = fixed ? 'none' : '';
  style.transform = styles.transform ?? '';
  style.transformOrigin = styles.transform ? '0 0' : '';
  style.clipPath = styles.clipPath ?? '';
}

export class ShellLayout {
  private bounds: PageBounds | null = null;
  private split: number | null = null;
  private metrics: DeviceMetrics | null = null;
  private toolbox: HTMLIFrameElement | null = null;
  private open = false;
  private dock: DockSide = 'bottom';
  private readonly handle: HTMLDivElement;

  /**
   * @param host the shell's `<devtools-anywhere>`, which fills the shell while the frontend lays out
   * @param frontend the frontend's iframe
   * @param page the page's iframe
   * @param frontendOrigin where notices to the frontend go
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly frontend: HTMLIFrameElement,
    private readonly page: HTMLIFrameElement,
    private readonly frontendOrigin: () => string
  ) {
    this.handle = document.createElement('div');
    this.handle.style.cssText = 'position:fixed;z-index:2;display:none;touch-action:none';
    document.body.append(this.handle);
    this.setupHandle();
    addEventListener('resize', () => this.render());
  }

  /** DevTools was shown or hidden, or docked elsewhere. */
  update(open: boolean, dock: DockSide) {
    if (dock !== this.dock) {
      // The bounds were in the other side's layout (or in the toolbox): wait for new ones.
      this.bounds = null;
      if (dock !== 'undocked') this.removeToolbox();
    }
    this.open = open;
    this.dock = dock;
    this.render();
  }

  pageBounds(bounds: PageBounds) {
    this.bounds = bounds;
    this.render();
  }

  splitSize(size: number) {
    this.split = size;
    this.render();
  }

  /** Emulation.setDeviceMetricsOverride, or (null) clearDeviceMetricsOverride. */
  setMetrics(metrics: DeviceMetrics | null) {
    this.metrics = metrics;
    this.render();
  }

  /**
   * Shows device mode's page for the undocked panel. The frontend asks for it as it undocks,
   * before it says it did.
   */
  showToolbox(url: string) {
    this.removeToolbox();
    const frame = document.createElement('iframe');
    frame.title = 'Device mode';
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:0';
    frame.src = url;
    document.body.append(frame);
    this.toolbox = frame;
    this.render();
  }

  private removeToolbox() {
    this.toolbox?.remove();
    this.toolbox = null;
  }

  /** Where the frontend lays out the page: its own iframe, or undocked the toolbox's. */
  private get origin(): HTMLIFrameElement | null {
    return this.dock === 'undocked' ? this.toolbox : this.frontend;
  }

  private render() {
    const origin = this.origin;
    const laidOut = this.open && !!this.bounds && !!origin;
    // Docked, the frontend fills the shell from the start, so that it lays out at its full size
    // (device mode does not recover from starting small); undocked, it stays a floating panel.
    this.host.toggleAttribute('data-laid-out', this.open && this.dock !== 'undocked');
    if (this.toolbox) this.toolbox.style.display = this.open ? '' : 'none';
    this.renderHandle();
    // Until then the page fills the shell, on top.
    if (!laidOut || !this.bounds || !origin)
      return place(this.page, this.open ? { left: '0', top: '0', width: '100%', height: '100%' } : {});
    const frame = origin.getBoundingClientRect();
    const { x, y, width, height } = this.bounds;
    const scale = this.metrics?.scale || 1;
    // The page's own size; the bounds are what shows of it once scaled.
    const pageWidth = this.metrics?.width || width / scale;
    const pageHeight = this.metrics?.height || height / scale;
    // What does not fit in the bounds is clipped; a rounding error of the bounds is not.
    const hidden = (size: number) => (size >= 1 ? size : 0);
    const hiddenRight = hidden(pageWidth - width / scale);
    const hiddenBottom = hidden(pageHeight - height / scale);
    place(this.page, {
      left: `${frame.left + x}px`,
      top: `${frame.top + y}px`,
      width: `${pageWidth}px`,
      height: `${pageHeight}px`,
      transform: scale === 1 ? '' : `scale(${scale})`,
      clipPath: hiddenRight || hiddenBottom ? `inset(0 ${hiddenRight}px ${hiddenBottom}px 0)` : '',
    });
  }

  /** The touch handle straddles the edge between the page and DevTools, docked only. */
  private renderHandle() {
    const style = this.handle.style;
    const shown = this.open && this.dock !== 'undocked' && this.split !== null && !!this.bounds;
    style.display = shown && matchMedia('(pointer: coarse)').matches ? 'block' : 'none';
    if (!shown || this.split === null) return;
    const frame = this.frontend.getBoundingClientRect();
    const vertical = this.dock === 'bottom';
    style.cursor = vertical ? 'row-resize' : 'col-resize';
    style.left = `${vertical ? frame.left : this.dock === 'right' ? frame.right - this.split - HANDLE / 2 : frame.left + this.split - HANDLE / 2}px`;
    style.top = `${vertical ? frame.bottom - this.split - HANDLE / 2 : frame.top}px`;
    style.width = `${vertical ? frame.width : HANDLE}px`;
    style.height = `${vertical ? HANDLE : frame.height}px`;
  }

  private setupHandle() {
    this.handle.addEventListener('pointerdown', down => {
      down.preventDefault();
      this.handle.setPointerCapture(down.pointerId);
      const move = (e: PointerEvent) => {
        const frame = this.frontend.getBoundingClientRect();
        const size =
          this.dock === 'bottom'
            ? frame.bottom - e.clientY
            : this.dock === 'right'
              ? frame.right - e.clientX
              : e.clientX - frame.left;
        const notice: FrontendNotice = { type: SIDEBAR_SIZE_NOTICE, size: Math.round(size) };
        this.frontend.contentWindow?.postMessage({ [REQUEST_KEY]: notice }, this.frontendOrigin());
      };
      const up = () => {
        this.handle.removeEventListener('pointermove', move);
        this.handle.removeEventListener('pointerup', up);
        this.handle.removeEventListener('pointercancel', up);
      };
      this.handle.addEventListener('pointermove', move);
      this.handle.addEventListener('pointerup', up);
      this.handle.addEventListener('pointercancel', up);
    });
  }
}
