// Shell mode's layout, as in Chrome: DevTools' frontend fills the shell and lays out the page and
// itself (upstream's AdvancedApp), telling where the page goes (`page-bounds`, its
// InspectedPagePlaceholder); the shell places the page iframe there, on top. In device mode the
// frontend asks for the page's size through Emulation.setDeviceMetricsOverride, which the shell
// answers by sizing and scaling the page iframe. Undocked, device mode draws into a page of the
// frontend's (`toolbox`), shown here in an iframe under the floating panel; the bounds are then in
// that iframe. Until the frontend says where the page goes, or while DevTools is hidden, the page
// fills the shell. Docked, a grip on the page's side of the middle of the edge between the page
// and DevTools resizes them, since the frontend's own resizer is a few pixels wide and shows
// nothing; it covers none of DevTools, and only as much of the page as it shows.

import type { DeviceMetrics } from './connection';
import { Grip } from './grip';
import { type DockSide, type FrontendNotice, type PageBounds, REQUEST_KEY, SIDEBAR_SIZE_NOTICE } from './embedder';

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
  /** The page's side of the split next to DevTools (`split`), where the grip goes. */
  private split: PageBounds | null = null;
  private metrics: DeviceMetrics | null = null;
  private toolbox: HTMLIFrameElement | null = null;
  private open = false;
  private dock: DockSide = 'bottom';
  /** The page's side of the split next to DevTools, for the grip on DevTools' edge (grip.ts). */
  private readonly pageArea: HTMLDivElement;
  private readonly grip: Grip;

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
    this.pageArea = document.createElement('div');
    this.pageArea.style.cssText = 'position:fixed;z-index:2;display:none;pointer-events:none';
    this.grip = new Grip({
      edge: 'bottom',
      side: 'inside',
      title: 'Drag to resize',
      onMove: e => this.resizeTo(e),
    });
    this.grip.element.style.pointerEvents = 'auto';
    this.grip.show(true);
    this.pageArea.append(this.grip.element);
    document.body.append(this.pageArea);
    addEventListener('resize', this.onResize);
  }

  private readonly onResize = () => this.render();

  /** The element left the shell: stops listening and removes what this layout added. */
  dispose() {
    removeEventListener('resize', this.onResize);
    this.grip.dispose();
    this.pageArea.remove();
    this.removeToolbox();
    // Not left at the device's size, or scaled: the page fills the document again.
    place(this.page, {});
  }

  /** DevTools was shown or hidden, or docked elsewhere. */
  update(open: boolean, dock: DockSide) {
    if (dock !== this.dock) {
      // The bounds were in the other side's layout (or in the toolbox): wait for new ones.
      this.bounds = null;
      this.split = null;
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

  splitArea(area: PageBounds) {
    this.split = area;
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
    this.renderGrip();
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

  /**
   * The grip sits against the middle of the page's edge next to DevTools, on the page's side, as
   * a tab of DevTools' panel; docked only.
   */
  private renderGrip() {
    // Not the page bounds: in device mode they are only the device's screen, in the middle.
    const area = this.split;
    const shown = this.open && this.dock !== 'undocked' && !!area && !!this.bounds;
    this.pageArea.style.display = shown ? 'block' : 'none';
    if (!shown || !area || this.dock === 'undocked') return;
    const frame = this.frontend.getBoundingClientRect();
    Object.assign(this.pageArea.style, {
      left: `${frame.left + area.x}px`,
      top: `${frame.top + area.y}px`,
      width: `${area.width}px`,
      height: `${area.height}px`,
    });
    this.grip.place(this.dock);
  }

  /** The grip's colors (its custom properties, grip.ts), DevTools' toolbar's. */
  setGripColors(colors: Record<string, string>) {
    for (const [property, value] of Object.entries(colors)) this.pageArea.style.setProperty(property, value);
  }

  /** Dragging the grip: DevTools takes the room from the pointer to its far edge. */
  private resizeTo(e: PointerEvent) {
    const frame = this.frontend.getBoundingClientRect();
    const size =
      this.dock === 'bottom'
        ? frame.bottom - e.clientY
        : this.dock === 'right'
          ? frame.right - e.clientX
          : e.clientX - frame.left;
    const notice: FrontendNotice = { type: SIDEBAR_SIZE_NOTICE, size: Math.round(size) };
    this.frontend.contentWindow?.postMessage({ [REQUEST_KEY]: notice }, this.frontendOrigin());
  }
}
