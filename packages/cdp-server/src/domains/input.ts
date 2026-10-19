import type { Protocol } from 'devtools-protocol';
import type { Context } from '../core/context';
import { OWN_ATTRIBUTE } from '../core/nodes';

type MouseEventRequest = Protocol.Input.DispatchMouseEventRequest | Protocol.Input.EmulateTouchFromMouseEventRequest;

const BUTTON = { none: 0, left: 0, middle: 1, right: 2, back: 3, forward: 4 } as const;
/** `MouseEvent.buttons` bit of each button. */
const BUTTONS = { none: 0, left: 1, middle: 4, right: 2, back: 8, forward: 16 } as const;

/** CDP modifier bits: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
const modifierKeys = (modifiers = 0) => ({
  altKey: (modifiers & 1) !== 0,
  ctrlKey: (modifiers & 2) !== 0,
  metaKey: (modifiers & 4) !== 0,
  shiftKey: (modifiers & 8) !== 0,
});

/** The page's element at a viewport point, under DevTools' own elements. */
function hit(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) if (!el.closest(`[${OWN_ATTRIBUTE}]`)) return el;
  return null;
}

/** Scrolls the nearest scrollable ancestor that can still move in the direction of the delta. */
function scrollBy(target: Element, dx: number, dy: number) {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el === document.documentElement || el === document.body) break;
    const style = getComputedStyle(el);
    const canX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    const canY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    if (canX || canY) el.scrollBy(canX ? dx : 0, canY ? dy : 0);
    if (el.scrollLeft !== left || el.scrollTop !== top) return;
  }
  window.scrollBy(dx, dy);
}

const isEditable = (el: Element | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement &&
    !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

/**
 * Input events from the frontend (the screencast view), replayed as DOM events. They are
 * synthetic (`isTrusted` is false): pages that check it ignore them, and browser defaults
 * that only trusted events trigger are carried out here where possible: focus on press,
 * click and double click on release, scrolling on wheel, text editing on key presses
 * (through `execCommand`, so it is undoable and fires `input`). Mouse events become touch
 * events while touch emulation is on (the screencast's "Use touch" toggle).
 */
export function registerInput({ server }: Context) {
  let emitTouch = false;
  let hovered: Element | null = null;
  let pressed: Element | null = null;
  /** Where the current touch started, to tell a tap from a drag. */
  let touchStart: { x: number; y: number; moved: boolean } | null = null;

  function mouseInit(p: MouseEventRequest, buttons: number): MouseEventInit {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: p.x,
      clientY: p.y,
      screenX: p.x + screenX,
      screenY: p.y + screenY,
      button: BUTTON[p.button ?? 'none'],
      buttons,
      detail: p.clickCount ?? 0,
      ...modifierKeys(p.modifiers),
    };
  }

  /** Fires the pointer event and its compatibility mouse event; false if either was cancelled. */
  function fire(target: Element, type: 'down' | 'up' | 'move' | 'over' | 'out', init: MouseEventInit) {
    const pointer = new PointerEvent(`pointer${type}`, {
      ...init,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });
    const mouse = new MouseEvent(`mouse${type}`, init);
    return target.dispatchEvent(pointer) && target.dispatchEvent(mouse);
  }

  function wheel(target: Element, p: MouseEventRequest) {
    const dx = p.deltaX ?? 0;
    const dy = p.deltaY ?? 0;
    const event = new WheelEvent('wheel', { ...mouseInit(p, 0), deltaX: dx, deltaY: dy, deltaMode: 0 });
    if (target.dispatchEvent(event)) scrollBy(target, dx, dy);
  }

  /** The held buttons, which only Input.dispatchMouseEvent reports. */
  const buttonsOf = (p: MouseEventRequest) => ('buttons' in p ? p.buttons : undefined);

  function mouse(p: MouseEventRequest) {
    const target = hit(p.x, p.y);
    const button = p.button ?? 'none';
    if (!target) {
      // Released off the page (outside the viewport, over DevTools' own elements): the
      // pressed element still gets the release, so the button is not left held down.
      if (p.type === 'mouseReleased' && pressed) fire(pressed, 'up', mouseInit(p, buttonsOf(p) ?? 0));
      if (p.type === 'mouseReleased') pressed = null;
      return;
    }
    switch (p.type) {
      case 'mouseMoved': {
        const init = mouseInit(p, buttonsOf(p) ?? (pressed ? BUTTONS.left : 0));
        if (target !== hovered) {
          if (hovered) fire(hovered, 'out', { ...init, relatedTarget: target });
          fire(target, 'over', { ...init, relatedTarget: hovered });
          hovered = target;
        }
        fire(target, 'move', init);
        break;
      }
      case 'mousePressed': {
        pressed = target;
        if (fire(target, 'down', mouseInit(p, buttonsOf(p) ?? BUTTONS[button]))) focus(target);
        if (button === 'right') target.dispatchEvent(new MouseEvent('contextmenu', mouseInit(p, BUTTONS.right)));
        break;
      }
      case 'mouseReleased': {
        const init = mouseInit(p, buttonsOf(p) ?? 0);
        fire(target, 'up', init);
        const down = pressed;
        pressed = null;
        if (button === 'none' || !down) break;
        // The click goes to the nearest element that contains both the press and the release;
        // other buttons than the left one get an auxclick instead.
        let clicked: Element | null = target;
        while (clicked && !clicked.contains(down)) clicked = clicked.parentElement;
        if (!clicked) break;
        if (button !== 'left') {
          clicked.dispatchEvent(new MouseEvent('auxclick', init));
          break;
        }
        clicked.dispatchEvent(new MouseEvent('click', init));
        if (p.clickCount === 2) clicked.dispatchEvent(new MouseEvent('dblclick', init));
        break;
      }
      case 'mouseWheel':
        wheel(target, p);
        break;
    }
  }

  function touch(p: MouseEventRequest) {
    if (p.type === 'mouseMoved' && !touchStart) return; // hovering does not touch
    // Once touching, the touch stays with the touched element even off the page, so that
    // the release still ends it.
    const target = hit(p.x, p.y) ?? (p.type === 'mousePressed' ? null : pressed);
    if (!target) return;
    if (p.type === 'mouseWheel') return wheel(target, p);
    const type = p.type === 'mousePressed' ? 'touchstart' : p.type === 'mouseReleased' ? 'touchend' : 'touchmove';
    if (type === 'touchstart') {
      touchStart = { x: p.x, y: p.y, moved: false };
      pressed = target;
    } else if (touchStart && Math.hypot(p.x - touchStart.x, p.y - touchStart.y) > 10) {
      touchStart.moved = true;
    }
    const tapped = type === 'touchend' && touchStart && !touchStart.moved;
    const touched = pressed ?? target;
    // Like a real touch: the pointer event first, then the touch event.
    const pointerInit: PointerEventInit = {
      ...mouseInit(p, type === 'touchend' ? 0 : BUTTONS.left),
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
    };
    if (type === 'touchstart') touched.dispatchEvent(new PointerEvent('pointerover', pointerInit));
    const pointerType = type === 'touchstart' ? 'pointerdown' : type === 'touchend' ? 'pointerup' : 'pointermove';
    let proceed = touched.dispatchEvent(new PointerEvent(pointerType, pointerInit));
    // Touch and TouchEvent cannot be constructed in every browser: missing in desktop Safari,
    // present but throwing "Illegal constructor" in iOS Safari and some WebViews. Only the
    // pointer events are sent there.
    const event = touchEvent(type, touched, p);
    if (event) proceed = touched.dispatchEvent(event) && proceed;
    if (type === 'touchend') touched.dispatchEvent(new PointerEvent('pointerout', pointerInit));
    if (type === 'touchmove' && proceed && touchStart?.moved) {
      // Dragging scrolls, unless the page cancelled the touch.
      scrollBy(target, touchStart.x - p.x, touchStart.y - p.y);
      touchStart.x = p.x;
      touchStart.y = p.y;
    }
    if (type === 'touchend') {
      touchStart = null;
      pressed = null;
      // A tap is followed by the compatibility mouse events (without pointer events) and a
      // click, unless cancelled.
      if (tapped && proceed) {
        const init = mouseInit({ ...p, button: 'left', clickCount: 1 }, 0);
        if (target !== hovered) {
          target.dispatchEvent(new MouseEvent('mouseover', { ...init, relatedTarget: hovered }));
          hovered = target;
        }
        if (target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: BUTTONS.left }))) focus(target);
        target.dispatchEvent(new MouseEvent('mouseup', init));
        target.dispatchEvent(new MouseEvent('click', init));
      }
    }
  }

  function touchEvent(type: 'touchstart' | 'touchmove' | 'touchend', touched: Element, p: MouseEventRequest) {
    if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return null;
    try {
      const point = new Touch({
        identifier: 1,
        target: touched,
        clientX: p.x,
        clientY: p.y,
        pageX: p.x + scrollX,
        pageY: p.y + scrollY,
        screenX: p.x + screenX,
        screenY: p.y + screenY,
      });
      const touches = type === 'touchend' ? [] : [point];
      return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        touches,
        targetTouches: touches,
        changedTouches: [point],
        ...modifierKeys(p.modifiers),
      });
    } catch {
      return null;
    }
  }

  function focus(target: Element) {
    const focusable = target.closest<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]'
    );
    if (focusable) focusable.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  /** The default action of an editing key, as the browser would carry it out on keydown. */
  function editingKey(target: Element, key: string) {
    if (!isEditable(target)) return;
    if (key === 'Backspace') document.execCommand('delete');
    else if (key === 'Delete') document.execCommand('forwardDelete');
  }

  function insertText(text: string) {
    const target = document.activeElement;
    if (!text || !isEditable(target)) return;
    // Enter's text: submits a field's form, breaks the line elsewhere.
    if (text === '\r') {
      if (target instanceof HTMLInputElement) target.form?.requestSubmit();
      else document.execCommand('insertLineBreak');
      return;
    }
    document.execCommand('insertText', false, text);
  }

  server.register('Input', {
    dispatchMouseEvent(p: Protocol.Input.DispatchMouseEventRequest) {
      if (emitTouch) touch(p);
      else mouse(p);
    },
    emulateTouchFromMouseEvent: (p: Protocol.Input.EmulateTouchFromMouseEventRequest) => touch(p),

    dispatchKeyEvent(p: Protocol.Input.DispatchKeyEventRequest) {
      const target = document.activeElement ?? document.body;
      const init: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        key: p.key ?? '',
        code: p.code ?? '',
        location: p.location ?? 0,
        repeat: p.autoRepeat ?? false,
        ...modifierKeys(p.modifiers),
      };
      switch (p.type) {
        case 'keyDown':
        case 'rawKeyDown':
          if (target.dispatchEvent(new KeyboardEvent('keydown', init))) {
            editingKey(target, p.key ?? '');
            // keyDown may carry the text of the key itself (rawKeyDown never does): it is
            // typed like a char event, keypress first.
            if (p.type === 'keyDown' && p.text) {
              const charCode = p.text.charCodeAt(0);
              const keypress = new KeyboardEvent('keypress', { ...init, charCode, keyCode: charCode });
              if (target.dispatchEvent(keypress)) insertText(p.text);
            }
          }
          break;
        case 'char':
          if (target.dispatchEvent(new KeyboardEvent('keypress', init))) insertText(p.text ?? '');
          break;
        case 'keyUp':
          target.dispatchEvent(new KeyboardEvent('keyup', init));
          break;
      }
    },

    insertText: (p: Protocol.Input.InsertTextRequest) => insertText(p.text),
    setIgnoreInputEvents: () => {},
  });

  server.register('Emulation', {
    setEmitTouchEventsForMouse(p: Protocol.Emulation.SetEmitTouchEventsForMouseRequest) {
      emitTouch = p.enabled;
    },
    // The page's own touch support (maxTouchPoints, media queries) cannot be changed.
    setTouchEmulationEnabled: () => {},
  });
}
