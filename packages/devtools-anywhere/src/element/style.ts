/** The shadow root style of `<devtools-anywhere>`. */
export const STYLE = `
:host { all: initial; display: block; }
:host([hidden]) { display: none; }
/* Both go into the top layer as popovers (see TOP_LAYER): undo the browser's popover style. */
.toggler, .panel {
  inset: auto; width: auto; height: auto; margin: 0; padding: 0; border: 0; overflow: visible; color: inherit;
}
.toggler {
  position: fixed; z-index: 2147483647;
  right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  width: 44px; height: 44px; border: 0; border-radius: 50%;
  background: #1a73e8; color: #fff; font: 600 13px/44px system-ui, sans-serif;
  box-shadow: 0 2px 6px rgba(0, 0, 0, .3); cursor: pointer; touch-action: manipulation;
}
.toggler[hidden] { display: none; }
.panel {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  display: none; flex-direction: column; box-sizing: border-box;
  background: #fff; border-top: 1px solid var(--bar-border, #cacdd1);
  /* Clear of the screen's cutouts and rounded corners (a page with viewport-fit=cover has them):
     the home indicator below, and the notch on the sides in landscape. */
  padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}
.panel[data-open] { display: flex; }
/* The undocked window's bar, which moves it; it takes the DevTools toolbar's colors, which the
   frontend reports (theme request), as does the grip that resizes the docked panel (grip.ts). */
.bar {
  flex: none; position: relative; height: 16px; background: var(--bar-background, #f1f3f4);
  cursor: move; touch-action: none; display: none;
}
[data-dock=undocked] .bar { display: block; }
.bar::before {
  content: ''; position: absolute; left: 50%; top: 6px; width: 32px; height: 4px;
  margin-left: -16px; border-radius: 2px; background: var(--bar-handle, #bdc1c6);
}
.bar button {
  position: absolute; top: 0; width: 24px; height: 16px; padding: 0; border: 0;
  background: none; color: var(--bar-icon, #5f6368); font: 14px/16px system-ui, sans-serif; cursor: pointer;
}
/* DevTools' own toolbar has a close button, except when undocked: then the bar has one. */
.close { right: 4px; }
/* The undocked window's resize corner, for touch screens where CSS resize does not work. */
.corner {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; display: none;
  cursor: nwse-resize; touch-action: none;
}
[data-dock=undocked] .corner { display: block; }
iframe { flex: 1; min-width: 0; min-height: 0; border: 0; }
.dragging iframe { pointer-events: none; }

/* Docked to a side: full height, with the bar as a vertical strip on the inner edge. */
.panel[data-dock=right], .panel[data-dock=left] {
  top: 0; border-top: 0; padding-top: env(safe-area-inset-top, 0px);
}
/* No inset on the inner edge, which is in the middle of the screen. */
.panel[data-dock=right] {
  left: auto; flex-direction: row; border-left: 1px solid var(--bar-border, #cacdd1); padding-left: 0;
}
.panel[data-dock=left] {
  right: auto; flex-direction: row-reverse; border-right: 1px solid var(--bar-border, #cacdd1); padding-right: 0;
}

/* Undocked: a window over the page, moved by its bar and resized from its corner. */
.panel[data-dock=undocked] {
  right: auto; bottom: auto; border: 1px solid var(--bar-border, #cacdd1); border-radius: 6px; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .3); resize: both; padding: 0;
}

/* Touch screens: targets large enough for a finger. */
@media (pointer: coarse) {
  .bar { height: 28px; }
  .bar::before { top: 12px; }
  .bar button { width: 44px; height: 28px; line-height: 28px; font-size: 18px; }
  .corner { width: 32px; height: 32px; }
}

/* An element placed by the page: a box in the page's flow, sized by its CSS, always loaded. */
.panel[data-custom] {
  position: static; display: flex; width: 100%; height: 100%; border: 0; padding: 0;
}
[data-custom] .bar, .toggler[data-custom] { display: none; }

/* Shell mode: the panel takes its place next to the page iframe, unless undocked. */
:host([data-shell]) { display: flex; flex: none; }
:host([data-shell]) .panel { position: static; flex: 1 1 auto; }
:host([data-shell]) .panel[data-dock=undocked] { position: fixed; }
/* Laid out by the frontend (shell-layout.ts): it fills the shell, the page iframe on top. */
:host([data-laid-out]) { position: fixed; inset: 0; z-index: 0; }
:host([data-laid-out]) .panel {
  position: absolute; inset: 0; width: auto !important; height: auto !important; border: 0;
}
:host([data-laid-out]) .bar { display: none; }
`;
