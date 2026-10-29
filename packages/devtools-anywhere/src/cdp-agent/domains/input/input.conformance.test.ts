import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

/** Events the page sees, as `type:targetId`. */
const RECORDED = [
  'pointerover',
  'pointerdown',
  'pointerup',
  'pointercancel',
  'pointerout',
  'pointerleave',
  'mouseover',
  'mousedown',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
  'wheel',
  'keydown',
  'keypress',
  'keyup',
  'input',
  'touchstart',
  'touchmove',
  'touchend',
  'submit',
];

before(async () => {
  env = await launch();
  t = await openPage(env, []);
  await t.page.setViewport({ width: 800, height: 600 });
  await t.page.evaluate(RECORDED => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div id="input-test" style="position: fixed; inset: 0; background: #fff; z-index: 1">
        <button id="btn" style="position: absolute; left: 10px; top: 10px; width: 100px; height: 40px">button</button>
        <form id="form" onsubmit="event.preventDefault()">
          <input id="field" style="position: absolute; left: 10px; top: 70px; width: 200px; height: 30px" />
        </form>
        <div id="scroller" style="position: absolute; left: 10px; top: 120px; width: 200px; height: 100px; overflow: auto">
          <div style="height: 1000px">tall</div>
        </div>
      </div>`
    );
    const events: string[] = [];
    for (const type of RECORDED)
      addEventListener(type, e => events.push(`${type}:${e.target instanceof Element ? e.target.id : ''}`), true);
    window.__inputEvents = events;
  }, RECORDED);
});
after(() => env?.close());

/** Resets the page, runs the steps through one side and returns what the page saw. */
async function run(side: Side, steps: (side: Side) => Promise<unknown>) {
  await t.page.evaluate(() => {
    const field = document.getElementById('field');
    if (field instanceof HTMLInputElement) field.value = '';
    document.getElementById('scroller')?.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (window.__inputEvents) window.__inputEvents.length = 0;
  });
  await steps(side);
  // Chrome dispatches some input asynchronously (wheel scrolling): wait until what the page
  // saw has not changed for 300 ms, for at most two seconds.
  const read = () =>
    t.page.evaluate(() => ({
      events: window.__inputEvents?.slice() ?? [],
      value: (document.getElementById('field') as HTMLInputElement).value,
      scrollTop: Math.round(document.getElementById('scroller')?.scrollTop ?? 0),
      focused: document.activeElement?.id ?? '',
    }));
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

async function same(steps: (side: Side) => Promise<unknown>, oursSteps = steps) {
  const chrome = await run(t.chrome, steps);
  const ours = await run(t.ours, oursSteps);
  assert.deepEqual(ours, chrome);
  return ours;
}

const click = async (side: Side, x: number, y: number, clickCount = 1) => {
  await side.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await side.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await side.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
};

const KEY_CODES: Record<string, number> = { Backspace: 8, Enter: 13 };

/** A key press as the screencast view sends it: keyDown, then char with the text, then keyUp. */
const press = async (side: Side, key: string, code: string, text?: string) => {
  await side.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0),
  });
  if (text) await side.send('Input.dispatchKeyEvent', { type: 'char', key, code, text });
  await side.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
};

test('a click', async () => {
  const result = await same(side => click(side, 50, 30));
  assert.ok(result.events.includes('click:btn'));
});

test('a double click', async () => {
  await same(async side => {
    await click(side, 50, 30, 1);
    await click(side, 50, 30, 2);
  });
});

test('a right click opens the context menu event', async () => {
  await same(async side => {
    await side.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 30, button: 'right', clickCount: 1 });
    await side.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 50,
      y: 30,
      button: 'right',
      clickCount: 1,
    });
  });
});

test('typing into a field', async () => {
  const result = await same(async side => {
    await click(side, 100, 85);
    await press(side, 'h', 'KeyH', 'h');
    await press(side, 'i', 'KeyI', 'i');
    await press(side, 'Backspace', 'Backspace');
  });
  assert.equal(result.value, 'h');
  assert.equal(result.focused, 'field');
});

test('a keyDown with text (Puppeteer style) fires keypress and types', async () => {
  const result = await same(async side => {
    await click(side, 100, 85);
    await side.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'h',
      code: 'KeyH',
      text: 'h',
      windowsVirtualKeyCode: 72,
    });
    await side.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72 });
  });
  assert.ok(result.events.includes('keypress:field'));
  assert.equal(result.value, 'h');
});

test('a middle click fires auxclick', async () => {
  const result = await same(async side => {
    await side.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 30 });
    await side.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 50,
      y: 30,
      button: 'middle',
      buttons: 4,
      clickCount: 1,
    });
    await side.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 50,
      y: 30,
      button: 'middle',
      buttons: 0,
      clickCount: 1,
    });
  });
  assert.ok(result.events.includes('auxclick:btn'));
});

// Off the page, Chrome sends the events to the document, the release included, and clicks it
// (the nearest common ancestor of the press and the release).
test('a release outside the page goes to the document and still ends the press', async () => {
  const result = await same(async side => {
    await side.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 30 });
    await side.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 30, button: 'left', clickCount: 1 });
    await side.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -10, y: -10, button: 'left', buttons: 1 });
    await side.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: -10,
      y: -10,
      button: 'left',
      clickCount: 1,
    });
    // The press has ended: a later click is an ordinary one.
    await click(side, 50, 30);
  });
  assert.ok(result.events.includes('pointerup:'));
  assert.ok(result.events.includes('click:'));
});

test('a press and release outside the page go to the document', async () => {
  await same(async side => {
    await side.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -10, y: -10 });
    await side.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: -10,
      y: -10,
      button: 'left',
      clickCount: 1,
    });
    await side.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: -10,
      y: -10,
      button: 'left',
      clickCount: 1,
    });
  });
});

test('Enter submits the form', async () => {
  const result = await same(async side => {
    await click(side, 100, 85);
    await press(side, 'Enter', 'Enter', '\r');
  });
  assert.ok(result.events.includes('submit:form'));
});

test('the wheel scrolls', async () => {
  const result = await same(side =>
    side.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 170, deltaX: 0, deltaY: 120 })
  );
  assert.equal(result.scrollTop, 120);
});

// With touch emulation on, Chrome's Input.dispatchMouseEvent waits for a gesture that never
// completes in headless mode; a real tap (Input.dispatchTouchEvent) is the reference.
test('a tap while touch is emulated (the screencast\'s "Use touch")', async () => {
  const result = await same(
    async chrome => {
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 50, y: 30 }] });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    },
    async ours => {
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      await click(ours, 50, 30);
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    }
  );
  assert.ok(result.events.includes('touchstart:btn'));
});

// Chrome sends a touch that starts off the page to the root element, and a touch dragged off
// the page stays with the element it started on.
test('a touch off the page goes to the root element', async () => {
  const result = await same(
    async chrome => {
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 900, y: 700 }] });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    },
    async ours => {
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      await click(ours, 900, 700);
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    }
  );
  assert.deepEqual(
    result.events.filter(e => e.startsWith('touch')),
    ['touchstart:', 'touchend:']
  );
});

test('a touch dragged off the page stays with its element', async () => {
  const result = await same(
    async chrome => {
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 50, y: 30 }] });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 900, y: 700 }] });
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    },
    async ours => {
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      await ours.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: 50,
        y: 30,
        button: 'left',
        clickCount: 1,
      });
      await ours.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 700, button: 'left', buttons: 1 });
      await ours.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 900,
        y: 700,
        button: 'left',
        clickCount: 1,
      });
      await ours.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    }
  );
  assert.deepEqual(
    result.events.filter(e => e.startsWith('touch')),
    ['touchstart:btn', 'touchmove:btn', 'touchend:btn']
  );
});

// With touch emulated for the mouse and no touch in progress, Chrome answers a release or a move with {} and sends nothing,
// through either command.
test('a release or a move without a touch sends nothing', async () => {
  const responses: Record<string, unknown[]> = { chrome: [], ours: [] };
  const steps = (name: string) => async (side: Side) => {
    const send = (p: Promise<unknown>) =>
      p
        .then(
          r => r,
          (e: unknown) => String(e)
        )
        .then(r => responses[name]?.push(r));
    await side.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    for (const type of ['mouseReleased', 'mouseMoved'] as const) {
      const params = { type, x: 50, y: 30, button: 'left' as const, clickCount: 1 };
      await send(side.send('Input.emulateTouchFromMouseEvent', params));
      await send(side.send('Input.dispatchMouseEvent', params));
    }
    await side.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  };
  // Chrome's hover from earlier tests sometimes gets a pointerover and a mouseover through:
  // only what a touch would send is compared.
  const touchy = (events: string[]) => events.filter(e => !/^(pointer|mouse)over:/.test(e));
  assert.deepEqual(touchy((await run(t.chrome, steps('chrome'))).events), []);
  assert.deepEqual(touchy((await run(t.ours, steps('ours'))).events), []);
  assert.deepEqual(responses['ours'], responses['chrome']);
  assert.deepEqual(responses['chrome'], [{}, {}, {}, {}]);
});
