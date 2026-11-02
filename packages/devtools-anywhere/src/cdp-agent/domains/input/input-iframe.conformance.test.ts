// Input over a same-origin iframe against Chrome's: mouse, wheel and touch input on it goes to
// the iframe's document at the point in its viewport, keys and text to the element focused in it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

const FIXTURE = '/packages/devtools-anywhere/test-support/frame-geometry.html';

let env: Env | undefined;
let t: TestPage;

/** Events the documents see, as `doc:type:targetId`, with the point of mouse events. */
const RECORDED = [
  'pointerover',
  'pointerout',
  'pointerdown',
  'pointerup',
  'mouseover',
  'mouseout',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'keydown',
  'keypress',
  'keyup',
  'input',
  'touchstart',
  'touchend',
  'focus',
  'blur',
];

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.setViewport({ width: 800, height: 600 });
  await t.page.evaluate(
    (src, RECORDED) =>
      new Promise<void>(resolve => {
        document.body.insertAdjacentHTML(
          'afterbegin',
          `<div id="ii-test" style="position: fixed; inset: 0; background: #fff; z-index: 1">
            <button id="top-btn" style="position: absolute; left: 10px; top: 10px; width: 100px; height: 40px">top</button>
            <iframe id="ii-frame" style="position: absolute; left: 200px; top: 50px; width: 400px; height: 300px; border: 4px solid; padding: 6px"></iframe>
          </div>`
        );
        const frame = document.getElementById('ii-frame') as HTMLIFrameElement;
        frame.onload = () => {
          const events: string[] = [];
          const record = (win: Window & typeof globalThis, name: string) => {
            for (const type of RECORDED)
              win.addEventListener(
                type,
                e => {
                  const target = e.target;
                  const id = target && 'id' in target ? String(target.id) : target === win ? 'window' : '';
                  // The point, view and realm of the event as the page sees it.
                  const where =
                    e instanceof win.MouseEvent
                      ? `@${Math.round(e.clientX)},${Math.round(e.clientY)}${e.view === win ? '' : '!view'}`
                      : e instanceof win.Event
                        ? ''
                        : '!realm';
                  events.push(`${name}:${type}:${id}${where}`);
                },
                true
              );
          };
          record(window, 'top');
          const inner = frame.contentWindow as (Window & typeof globalThis) | null;
          if (inner) record(inner, 'in');
          window.__inputEvents = events;
          resolve();
        };
        frame.src = src;
      }),
    FIXTURE,
    RECORDED
  );
  await locate();
});
after(() => env?.close());

/** The iframe's document. */
declare global {
  interface Window {
    __inputEvents?: string[];
  }
}

/** Resets the page, runs the steps through one side and returns what the page saw. */
async function run(side: Side, steps: (side: Side) => Promise<unknown>) {
  await t.page.evaluate(() => {
    const doc = (document.getElementById('ii-frame') as HTMLIFrameElement).contentDocument;
    const field = doc?.getElementById('fg-field');
    if (field && 'value' in field) field.value = '';
    doc?.getElementById('fg-scroller')?.scrollTo(0, 0);
    doc?.defaultView?.scrollTo(0, 0);
    if (doc?.activeElement && 'blur' in doc.activeElement && typeof doc.activeElement.blur === 'function')
      doc.activeElement.blur();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (window.__inputEvents) window.__inputEvents.length = 0;
  });
  await steps(side);
  // Chrome dispatches some input asynchronously (wheel scrolling): wait until what the page
  // saw has not changed for 300 ms, for at most two seconds.
  const read = () =>
    t.page.evaluate(() => {
      const doc = (document.getElementById('ii-frame') as HTMLIFrameElement).contentDocument;
      const field = doc?.getElementById('fg-field');
      return {
        events: window.__inputEvents?.slice() ?? [],
        value: field && 'value' in field ? field.value : null,
        scrollTop: Math.round(doc?.getElementById('fg-scroller')?.scrollTop ?? 0),
        frameScroll: Math.round(doc?.defaultView?.scrollY ?? 0),
        focused: `${document.activeElement?.id ?? ''}/${doc?.activeElement?.id ?? ''}`,
      };
    });
  const start = Date.now();
  let result = await read();
  for (let stable = 0; stable < 6 && Date.now() - start < 2000;) {
    await new Promise(r => setTimeout(r, 50));
    const next = await read();
    stable = JSON.stringify(next) === JSON.stringify(result) ? stable + 1 : 0;
    result = next;
  }
  return result;
}

async function same(
  steps: (side: Side) => Promise<unknown>,
  oursSteps = steps,
  only: (event: string) => boolean = () => true
) {
  const chrome = await run(t.chrome, steps);
  const ours = await run(t.ours, oursSteps);
  for (const result of [chrome, ours]) result.events = result.events.filter(only);
  assert.deepEqual(ours, chrome);
  return ours;
}

/** The iframe's content box in the top viewport. */
const IN = { x: 210, y: 60 };
type Point = { x: number; y: number };
/** Top viewport points on elements of the iframe's document, with the document not scrolled. */
let BTN: Point;
let FIELD: Point;
let SCROLLER: Point;
/** Finds the points, once the page is set up. */
async function locate() {
  const centers = await t.page.evaluate(
    (ids, IN) =>
      ids.map(id => {
        const frame = document.getElementById('ii-frame') as HTMLIFrameElement;
        const r = frame.contentDocument?.getElementById(id)?.getBoundingClientRect();
        return r ? { x: Math.round(IN.x + r.left + r.width / 2), y: Math.round(IN.y + r.top + r.height / 2) } : IN;
      }),
    ['fg-btn', 'fg-field', 'fg-scroller'],
    IN
  );
  [BTN = IN, FIELD = IN, SCROLLER = IN] = centers;
}

const move = (side: Side, { x, y }: Point) => side.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const click = async (side: Side, { x, y }: Point) => {
  await move(side, { x, y });
  await side.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await side.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const KEY_CODES: Record<string, number> = { Backspace: 8 };
const press = async (side: Side, key: string, code: string, text?: string) => {
  const windowsVirtualKeyCode = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  await side.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
  if (text) await side.send('Input.dispatchKeyEvent', { type: 'char', key, code, text });
  await side.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
};

test('moving from the top page into an iframe and clicking there', async () => {
  const result = await same(async side => {
    await move(side, { x: 50, y: 30 });
    await click(side, BTN);
    await move(side, { x: 50, y: 30 });
  });
  assert.ok(result.events.includes(`in:click:fg-btn@${BTN.x - IN.x},${BTN.y - IN.y}`));
});

test('typing into a field of an iframe', async () => {
  const result = await same(async side => {
    await click(side, FIELD);
    await press(side, 'h', 'KeyH', 'h');
    await press(side, 'i', 'KeyI', 'i');
    await press(side, 'Backspace', 'Backspace');
    await side.send('Input.insertText', { text: 'ey' });
  });
  assert.equal(result.value, 'hey');
});

// With touch emulation on, Chrome's Input.dispatchMouseEvent waits for a gesture that never
// completes in headless mode; a real tap (Input.dispatchTouchEvent) is the reference.
test('a tap in an iframe while touch is emulated', async () => {
  const result = await same(
    async chrome => {
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [BTN] });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    },
    async ours => {
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      await click(ours, BTN);
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    },
    // Where each side's hover was after the tests before differs: the mouse's over and out are
    // not compared.
    e => !/:mouse(over|out):/.test(e)
  );
  assert.ok(result.events.includes('in:touchstart:fg-btn'));
});

// Chrome also moves the hover after scrolling (asynchronously, so this test goes last), which
// is not compared: only the wheel events.
test('the wheel scrolls a scroller of an iframe, then the iframe', async () => {
  const result = await same(
    async side => {
      await side.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...SCROLLER, deltaX: 0, deltaY: 100 });
      await side.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: IN.x + 300,
        y: IN.y + 50,
        deltaX: 0,
        deltaY: 120,
      });
    },
    undefined,
    e => e.includes(':wheel:')
  );
  assert.equal(result.scrollTop, 100);
  assert.equal(result.frameScroll, 120);
});
