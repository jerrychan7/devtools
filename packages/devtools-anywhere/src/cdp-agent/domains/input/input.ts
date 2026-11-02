import type { Protocol } from 'devtools-protocol';
import type { Context } from '../../core/context';
import { closestOwn } from '../../core/nodes';
import { askChild, type ChildLink, type ChildTargets, childTargets } from '../../core/child-targets';
import { frameDocumentOf, hitPath, parentFrameDocument, pointInFrame, pointInOwnerContent } from '../../core/geometry';
import { documentOf, isElement, isHtml, isHtmlElement, realmOf } from '../../core/realm';

/** How long a cross-origin iframe's agent has to carry out forwarded input, in ms. */
const FORWARD_TIMEOUT = 5000;

type MouseEventRequest = Protocol.Input.DispatchMouseEventRequest | Protocol.Input.EmulateTouchFromMouseEventRequest;

/** What receives a mouse event: an element, or a document where no element is hit. */
type Target = Element | Document;

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

/**
 * A param of a wheel forwarded to a cross-origin iframe's agent, and the field of its answer, for
 * scroll chaining: set in the answer when nothing in the iframe's page could scroll, for the
 * parent's page to scroll on from the iframe, as Chrome chains a scroll across processes.
 */
const SCROLL_CHAIN = 'devtoolsAnywhereScrollChain';

/**
 * Scrolls the nearest scrollable ancestor that can still move in the direction of the delta;
 * false when none could.
 */
function scrollBy(target: Target, dx: number, dy: number): boolean {
  // From the target's document out through the iframes holding it, each viewport last.
  for (let doc: Document | null = documentOf(target), from = isElement(target) ? target : null; doc;) {
    for (let el = from; el; el = el.parentElement) {
      if (el === doc.documentElement || el === doc.body) break;
      const style = realmOf(el).getComputedStyle(el);
      const canX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
      const canY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
      const left = el.scrollLeft;
      const top = el.scrollTop;
      if (canX || canY) el.scrollBy(canX ? dx : 0, canY ? dy : 0);
      if (el.scrollLeft !== left || el.scrollTop !== top) return true;
    }
    const win = realmOf(doc);
    const parent = parentFrameDocument(doc);
    const [x, y] = [win.scrollX, win.scrollY];
    win.scrollBy(dx, dy);
    if (win.scrollX !== x || win.scrollY !== y) return true;
    if (!parent) return false;
    // Like Chrome, a frame that cannot scroll further passes the scroll on to its parent.
    from = win.frameElement;
    doc = parent;
  }
  return false;
}

const isEditable = (el: Element | null) =>
  isHtml(el, 'textarea') ||
  (isHtml(el, 'input') && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(el.type)) ||
  (isHtmlElement(el) && el.isContentEditable);

/**
 * Input events from the frontend (the screencast view), replayed as DOM events. They are
 * synthetic (`isTrusted` is false): pages that check it ignore them, and browser defaults
 * that only trusted events trigger are carried out here where possible: focus on press,
 * click and double click on release, scrolling on wheel, text editing on key presses
 * (through `execCommand`, so it is undoable and fires `input`). Mouse events become touch
 * events while touch emulation is on (the screencast's "Use touch" toggle).
 *
 * Like Chrome, input over a same-origin iframe goes to the element under it in the iframe's
 * document, at the point in that document's viewport, as events of that document's window; and
 * keys and text go to the element focused in the focused frame.
 *
 * Input over a linked cross-origin iframe (core/child-targets.ts) goes to the iframe's agent, as
 * Chrome routes it to the iframe's process: the same command, at the point in the iframe's
 * viewport, and keys and text while the iframe has the focus. The command goes over the link as
 * this agent's own, which the client does not see, and is answered once the iframe's agent has
 * carried it out.
 */
export function registerInput({ session, frames }: Context, links: ChildTargets = childTargets) {
  const top = frames.top;
  let emitTouch = false;
  /** What the mouse is over: the element in each document from the top one in (see `hitAt`). */
  let hovered: Target[] = [];
  let pressed: Target | null = null;
  /** Where the current touch started, to tell a tap from a drag. */
  let touchStart: { x: number; y: number; moved: boolean; cancelled: boolean } | null = null;
  /** The current touch started off the page: Chrome then only sends its tap a mouseover. */
  let touchOffPage = false;

  /** The page's elements at a top viewport point, under DevTools' own, into iframes' documents. */
  const elementsAt = (x: number, y: number): Element[] =>
    hitPath(top.document, x, y, el => !closestOwn(el)).map(hit => hit.el);

  /**
   * What is under a top viewport point, from the top document in: like Chrome, the top document
   * where no page element is hit (outside the viewport).
   */
  const hitAt = (x: number, y: number): Target[] => {
    const path = elementsAt(x, y);
    return path.length ? path : [top.document];
  };

  const innermost = (path: Target[]): Target => path[path.length - 1] ?? top.document;

  /** The link of the cross-origin iframe `target` is, if it is one. */
  const linkOf = (target: Target | null): ChildLink | undefined =>
    target && isElement(target) ? links.childOf(target) : undefined;

  /** The touch going on in a cross-origin iframe: the iframe's agent has it till it ends. */
  let touchIn: { link: ChildLink; owner: Element } | null = null;

  /**
   * Sends a mouse (or touch) command on to a cross-origin iframe's agent, at the top viewport
   * point mapped into the iframe's viewport, and waits for it to be carried out.
   */
  async function forward(link: ChildLink, owner: Element, method: string, p: MouseEventRequest) {
    const at = pointInFrame(owner.ownerDocument, p.x, p.y);
    const inner = pointInOwnerContent(owner, at.x, at.y);
    const wheeled = p.type === 'mouseWheel';
    const result = await askChild(
      link,
      method,
      { ...p, x: inner.x, y: inner.y, ...(wheeled ? { [SCROLL_CHAIN]: true } : {}) },
      FORWARD_TIMEOUT
    );
    // Nothing in the iframe could scroll: like Chrome, the scroll goes on from the iframe out.
    if (wheeled && typeof result === 'object' && result !== null && Reflect.get(result, SCROLL_CHAIN) === true)
      return scrolled(owner, p);
    return undefined;
  }

  /**
   * Scrolls from `target` out for a wheel; when nothing could scroll and the wheel was forwarded
   * from a parent's agent, answers so, for that page to scroll on.
   */
  function scrolled(target: Target, p: MouseEventRequest) {
    if (scrollBy(target, p.deltaX ?? 0, p.deltaY ?? 0) || Reflect.get(p, SCROLL_CHAIN) !== true) return undefined;
    return { [SCROLL_CHAIN]: true };
  }

  /**
   * Mouse input over a cross-origin iframe, measured in Chrome: this page's documents get none of
   * it, not even an over or out (their hovered elements stay what they were), nor the iframe's
   * document an out once the mouse leaves it. Each page keeps its own press, as each process
   * does: a press here released over the iframe gets no click there (the iframe's page has no
   * press), and stays this page's, so a release over this page later clicks what holds both; a
   * press in the iframe released over this page clicks nothing here unless this page has a press
   * of its own. The focus moves into the iframe as its page focuses what was pressed.
   */
  function mouseInto(link: ChildLink, owner: Element, p: MouseEventRequest) {
    return forward(link, owner, 'Input.dispatchMouseEvent', p);
  }

  function mouseInit(p: MouseEventRequest, buttons: number, target: Target): MouseEventInit {
    const at = pointInFrame(documentOf(target), p.x, p.y);
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: realmOf(target),
      clientX: at.x,
      clientY: at.y,
      screenX: p.x + top.window.screenX,
      screenY: p.y + top.window.screenY,
      button: BUTTON[p.button ?? 'none'],
      buttons,
      detail: p.clickCount ?? 0,
      ...modifierKeys(p.modifiers),
    };
  }

  /** A mouse event of the target's own realm. */
  const mouseEvent = (target: Target, type: string, init: MouseEventInit) =>
    new (realmOf(target).MouseEvent)(type, init);
  const pointerEvent = (target: Target, type: string, init: PointerEventInit) =>
    new (realmOf(target).PointerEvent)(type, init);

  const mousePointer = (init: MouseEventInit): PointerEventInit => ({
    ...init,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  });

  /** Fires the pointer event and its compatibility mouse event; false if either was cancelled. */
  function fire(target: Target, type: 'down' | 'up' | 'move', init: MouseEventInit) {
    return (
      target.dispatchEvent(pointerEvent(target, `pointer${type}`, mousePointer(init))) &&
      target.dispatchEvent(mouseEvent(target, `mouse${type}`, init))
    );
  }

  /**
   * Moves the hover to what is under the point, document by document like Chrome: the documents
   * the mouse left get an out (the innermost first), then from the top document in, each
   * document whose hovered element changed gets the pointer's out and over, then the mouse's.
   * A tap's compatibility mouse events come without pointer events (`pointer` false).
   */
  function hover(next: Target[], p: MouseEventRequest, buttons: number, pointer = true) {
    const sameDocument = (a: Target | undefined, b: Target | undefined) =>
      !!a && !!b && documentOf(a) === documentOf(b);
    for (let d = hovered.length - 1; d >= 0; d--) {
      const left = hovered[d];
      if (!left || sameDocument(left, next[d])) break;
      const init = { ...mouseInit(p, buttons, left), relatedTarget: null };
      if (pointer) left.dispatchEvent(pointerEvent(left, 'pointerout', mousePointer(init)));
      left.dispatchEvent(mouseEvent(left, 'mouseout', init));
    }
    next.forEach((now, d) => {
      const before = sameDocument(hovered[d], now) ? hovered[d] : undefined;
      if (before === now) return;
      const init = mouseInit(p, buttons, now);
      if (pointer) {
        if (before)
          before.dispatchEvent(pointerEvent(before, 'pointerout', mousePointer({ ...init, relatedTarget: now })));
        now.dispatchEvent(pointerEvent(now, 'pointerover', mousePointer({ ...init, relatedTarget: before ?? null })));
      }
      if (before) before.dispatchEvent(mouseEvent(before, 'mouseout', { ...init, relatedTarget: now }));
      now.dispatchEvent(mouseEvent(now, 'mouseover', { ...init, relatedTarget: before ?? null }));
    });
    hovered = next;
  }

  /** A wheel event, and the scroll unless cancelled; see {@link scrolled} for the answer. */
  function wheel(target: Target, p: MouseEventRequest) {
    const init = { ...mouseInit(p, 0, target), deltaX: p.deltaX ?? 0, deltaY: p.deltaY ?? 0, deltaMode: 0 };
    if (target.dispatchEvent(new (realmOf(target).WheelEvent)('wheel', init))) return scrolled(target, p);
    return undefined;
  }

  /** The held buttons, which only Input.dispatchMouseEvent reports. */
  const buttonsOf = (p: MouseEventRequest) => ('buttons' in p ? p.buttons : undefined);

  async function mouse(p: MouseEventRequest) {
    const path = hitAt(p.x, p.y);
    const target = innermost(path);
    const link = linkOf(target);
    if (link && isElement(target)) return await mouseInto(link, target, p);
    const button = p.button ?? 'none';
    switch (p.type) {
      case 'mouseMoved': {
        const buttons = buttonsOf(p) ?? (pressed ? BUTTONS.left : 0);
        hover(path, p, buttons);
        fire(target, 'move', mouseInit(p, buttons, target));
        break;
      }
      case 'mousePressed': {
        // Like Chrome, a press elsewhere than the last move moves the hover there first.
        hover(path, p, buttonsOf(p) ?? BUTTONS[button]);
        pressed = target;
        if (fire(target, 'down', mouseInit(p, buttonsOf(p) ?? BUTTONS[button], target))) focus(target);
        if (button === 'right')
          target.dispatchEvent(mouseEvent(target, 'contextmenu', mouseInit(p, BUTTONS.right, target)));
        break;
      }
      case 'mouseReleased': {
        hover(path, p, buttonsOf(p) ?? 0);
        const init = mouseInit(p, buttonsOf(p) ?? 0, target);
        fire(target, 'up', init);
        const down = pressed;
        pressed = null;
        if (button === 'none' || !down) break;
        // The click goes to the nearest element that contains both the press and the release
        // (none when they are in different documents); other buttons than the left one get an
        // auxclick instead.
        let clicked: Node | null = target;
        while (clicked && !clicked.contains(down)) clicked = clicked.parentNode;
        if (!clicked) break;
        if (button !== 'left') {
          clicked.dispatchEvent(mouseEvent(target, 'auxclick', init));
          break;
        }
        clicked.dispatchEvent(mouseEvent(target, 'click', init));
        if (p.clickCount === 2) clicked.dispatchEvent(mouseEvent(target, 'dblclick', init));
        break;
      }
      case 'mouseWheel':
        return wheel(target, p);
    }
    return undefined;
  }

  async function touch(p: MouseEventRequest) {
    // A touch that started in a cross-origin iframe is the iframe's agent's till it ends, as a
    // touch stays with what it touched; a wheel over one is too.
    if (touchIn) {
      const { link, owner } = touchIn;
      if (p.type === 'mouseReleased') touchIn = null;
      return await forward(link, owner, 'Input.emulateTouchFromMouseEvent', p);
    }
    if (p.type === 'mousePressed' || p.type === 'mouseWheel') {
      const owner = elementsAt(p.x, p.y).pop() ?? null;
      const link = linkOf(owner);
      if (link && owner) {
        if (p.type === 'mousePressed') touchIn = { link, owner };
        return await forward(link, owner, 'Input.emulateTouchFromMouseEvent', p);
      }
    }
    // Hovering does not touch, and Chrome ignores a release without a touch to end.
    if ((p.type === 'mouseMoved' || p.type === 'mouseReleased') && !touchStart) return undefined;
    // Once touching, the touch stays with the touched element even off the page, so that
    // the release still ends it. Like Chrome, a touch starting off the page (or on nothing)
    // goes to the root element.
    const held = pressed && isElement(pressed) ? pressed : null;
    const found = elementsAt(p.x, p.y).pop() ?? null;
    const target = found ?? (p.type === 'mousePressed' ? null : held) ?? top.document.documentElement;
    if (p.type === 'mouseWheel') return wheel(target, p);
    const type = p.type === 'mousePressed' ? 'touchstart' : p.type === 'mouseReleased' ? 'touchend' : 'touchmove';
    if (type === 'touchstart') {
      touchStart = { x: p.x, y: p.y, moved: false, cancelled: false };
      touchOffPage = !found;
      pressed = target;
    } else if (touchStart && Math.hypot(p.x - touchStart.x, p.y - touchStart.y) > 10) {
      touchStart.moved = true;
    }
    const tapped = type === 'touchend' && touchStart && !touchStart.moved;
    const touched = (pressed && isElement(pressed) ? pressed : null) ?? target;
    // Like a real touch: the pointer event first, then the touch event.
    const pointerInit: PointerEventInit = {
      ...mouseInit(p, type === 'touchend' ? 0 : BUTTONS.left, touched),
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
    };
    if (type === 'touchstart') touched.dispatchEvent(pointerEvent(touched, 'pointerover', pointerInit));
    const pointerType = type === 'touchstart' ? 'pointerdown' : type === 'touchend' ? 'pointerup' : 'pointermove';
    // Once scrolling has taken the touch over, the pointer is gone: only touch events follow.
    const cancelled = touchStart?.cancelled ?? false;
    let proceed = cancelled || touched.dispatchEvent(pointerEvent(touched, pointerType, pointerInit));
    // Like Chrome, the lifted pointer leaves before the touchend.
    if (type === 'touchend' && !cancelled) touched.dispatchEvent(pointerEvent(touched, 'pointerout', pointerInit));
    // Touch and TouchEvent cannot be constructed in every browser: missing in desktop Safari,
    // present but throwing "Illegal constructor" in iOS Safari and some WebViews. Only the
    // pointer events are sent there.
    const event = touchEvent(type, touched, p);
    if (event) proceed = touched.dispatchEvent(event) && proceed;
    if (type === 'touchmove' && proceed && touchStart?.moved) {
      // Like Chrome, the touchmove that starts the scroll is followed by the pointer's cancel.
      if (!touchStart.cancelled) {
        touchStart.cancelled = true;
        touched.dispatchEvent(pointerEvent(touched, 'pointercancel', pointerInit));
        touched.dispatchEvent(pointerEvent(touched, 'pointerout', pointerInit));
      }
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
        const init = mouseInit({ ...p, button: 'left', clickCount: 1 }, 0, target);
        hover(found ? hitAt(p.x, p.y) : [target], p, 0, false);
        if (touchOffPage) return undefined;
        if (target.dispatchEvent(mouseEvent(target, 'mousedown', { ...init, buttons: BUTTONS.left }))) focus(target);
        target.dispatchEvent(mouseEvent(target, 'mouseup', init));
        target.dispatchEvent(mouseEvent(target, 'click', init));
      }
    }
    return undefined;
  }

  function touchEvent(type: 'touchstart' | 'touchmove' | 'touchend', touched: Element, p: MouseEventRequest) {
    const win = realmOf(touched);
    if (typeof win.Touch !== 'function' || typeof win.TouchEvent !== 'function') return null;
    const at = pointInFrame(touched.ownerDocument, p.x, p.y);
    try {
      const point = new win.Touch({
        identifier: 1,
        target: touched,
        clientX: at.x,
        clientY: at.y,
        pageX: at.x + win.scrollX,
        pageY: at.y + win.scrollY,
        screenX: p.x + top.window.screenX,
        screenY: p.y + top.window.screenY,
      });
      const touches = type === 'touchend' ? [] : [point];
      return new win.TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        touches,
        targetTouches: touches,
        changedTouches: [point],
        ...modifierKeys(p.modifiers),
      });
    } catch {
      return null;
    }
  }

  function focus(target: Target) {
    const focusable =
      isElement(target) &&
      target.closest<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]'
      );
    if (focusable) focusable.focus();
    else {
      const active = documentOf(target).activeElement;
      if (isHtmlElement(active)) active.blur();
    }
  }

  /**
   * The element keys and text go to: the focused element of the top document, or, when that is
   * an iframe, the one focused in its document, and so on; the body where nothing is focused.
   */
  function focused(): Element | null {
    for (let doc = top.document; ;) {
      const active = doc.activeElement ?? doc.body;
      const inner = active && frameDocumentOf(active);
      if (!inner) return active;
      doc = inner;
    }
  }

  /** The default action of an editing key, as the browser would carry it out on keydown. */
  function editingKey(target: Element, key: string) {
    if (!isEditable(target)) return;
    if (key === 'Backspace') target.ownerDocument.execCommand('delete');
    else if (key === 'Delete') target.ownerDocument.execCommand('forwardDelete');
  }

  function insertText(text: string) {
    const target = focused();
    if (!text || !target || !isEditable(target)) return;
    const doc = target.ownerDocument;
    // Enter's text: submits a field's form, breaks the line elsewhere.
    if (text === '\r') {
      if (isHtml(target, 'input')) target.form?.requestSubmit();
      else doc.execCommand('insertLineBreak');
      return;
    }
    doc.execCommand('insertText', false, text);
  }

  session.register('Input', {
    dispatchMouseEvent: (p: Protocol.Input.DispatchMouseEventRequest) => (emitTouch ? touch(p) : mouse(p)),
    emulateTouchFromMouseEvent: (p: Protocol.Input.EmulateTouchFromMouseEventRequest) => touch(p),

    async dispatchKeyEvent(p: Protocol.Input.DispatchKeyEventRequest) {
      const target = focused();
      if (!target) return;
      // Like Chrome, keys go to the focused frame's process: to the iframe's agent when a
      // cross-origin iframe has the focus.
      const link = linkOf(target);
      if (link) {
        await askChild(link, 'Input.dispatchKeyEvent', p, FORWARD_TIMEOUT);
        return;
      }
      const win = realmOf(target);
      const init: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        key: p.key ?? '',
        code: p.code ?? '',
        location: p.location ?? 0,
        repeat: p.autoRepeat ?? false,
        ...modifierKeys(p.modifiers),
      };
      switch (p.type) {
        case 'keyDown':
        case 'rawKeyDown':
          if (target.dispatchEvent(new win.KeyboardEvent('keydown', init))) {
            editingKey(target, p.key ?? '');
            // keyDown may carry the text of the key itself (rawKeyDown never does): it is
            // typed like a char event, keypress first.
            if (p.type === 'keyDown' && p.text) {
              const charCode = p.text.charCodeAt(0);
              const keypress = new win.KeyboardEvent('keypress', { ...init, charCode, keyCode: charCode });
              if (target.dispatchEvent(keypress)) insertText(p.text);
            }
          }
          break;
        case 'char':
          if (target.dispatchEvent(new win.KeyboardEvent('keypress', init))) insertText(p.text ?? '');
          break;
        case 'keyUp':
          target.dispatchEvent(new win.KeyboardEvent('keyup', init));
          break;
      }
    },

    async insertText(p: Protocol.Input.InsertTextRequest) {
      const link = linkOf(focused());
      if (link) await askChild(link, 'Input.insertText', p, FORWARD_TIMEOUT);
      else insertText(p.text);
    },
    setIgnoreInputEvents: () => {},
  });

  session.register('Emulation', {
    setEmitTouchEventsForMouse(p: Protocol.Emulation.SetEmitTouchEventsForMouseRequest) {
      emitTouch = p.enabled;
    },
    // The page's own touch support (maxTouchPoints, media queries) cannot be changed.
    setTouchEmulationEnabled: () => {},
  });
}
