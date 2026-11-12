// Vision deficiencies (vision.ts): Chrome's filters and ours, drawn on the same page and compared pixel by
// pixel. The mask is ours alone: these tests check that it stays on top of the page's top layer, filters
// <html> under the page's own filter, and is not in the DOM the client sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

const STYLE = `
  #vd { position: fixed; top: 0; left: 0; width: 80px; height: 80px; background: rgb(200, 40, 40) }
  .top {
    position: fixed; inset: 20px auto auto 20px; width: 40px; height: 40px;
    margin: 0; padding: 0; border: 0; background: rgb(30, 160, 220);
  }
  #fs:not(:fullscreen) { display: none }
`;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
    await t.page.evaluate(style => {
      const s = document.createElement('style');
      s.textContent = style;
      document.head.appendChild(s);
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="vd"></div><div id="pop" class="top" popover="manual"></div><dialog id="dlg" class="top"></dialog>' +
          '<div id="auto" class="top" popover="auto"></div><div id="hint" class="top" popover="hint"></div>' +
          '<div id="again" class="top" popover="manual"></div><div id="fs" class="top"></div><div id="host"></div>'
      );
      // A popover in a shadow tree: its toggle events do not reach the document.
      const root = document.getElementById('host')?.attachShadow({ mode: 'closed' });
      if (root) {
        root.innerHTML = `<style>${style.match(/\.top \{[^}]*\}/)?.[0] ?? ''}</style><div class="top" popover="manual"></div>`;
        Reflect.set(window, '__shadowPopover', root.lastElementChild);
      }
    }, STYLE);
  },
  () => env?.close()
);

/**
 * A pixel of the screenshot, inside #vd and away from the viewport's edges, where Chrome's blur
 * fades out and ours does not; on #vd's right edge for the blur, which changes nothing inside.
 * The shot takes the area around it: a backdrop filter in a 1×1 shot sees only that pixel.
 */
const pixel = async (x = 40) => {
  const shot = await t.page.screenshot({ clip: { x: 0, y: 0, width: 120, height: 80 }, encoding: 'base64' });
  return t.page.evaluate(
    async (data, x) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const g = canvas.getContext('2d');
      g?.drawImage(img, 0, 0);
      return Array.from(g?.getImageData(x, 40, 1, 1).data ?? []);
    },
    shot,
    x
  );
};

type Vision = Protocol.Emulation.SetEmulatedVisionDeficiencyRequest['type'];

/**
 * The pixel each side gives under `type` once `before` ran, `after` running before it is cleared.
 * The two sides' filters round apart by a unit or two.
 */
async function filtered(type: Vision, x = 40, before = async () => {}, after = async () => {}) {
  const results: number[][] = [];
  for (const side of [t.chrome, t.ours]) {
    await side.send('Emulation.setEmulatedVisionDeficiency', { type });
    try {
      await before();
      results.push(await pixel(x));
    } finally {
      await after();
      await side.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
    }
  }
  const [chrome = [], ours = []] = results;
  assert.ok(
    ours.length === 4 && ours.every((v, i) => Math.abs(v - (chrome[i] ?? 0)) <= 2),
    `ours ${JSON.stringify(ours)}, Chrome's ${JSON.stringify(chrome)}`
  );
  return chrome;
}

for (const type of [
  'blurredVision',
  'achromatopsia',
  'deuteranopia',
  'protanopia',
  'tritanopia',
  'reducedContrast',
] as const) {
  test(`vision deficiency: ${type}`, async () => {
    const x = type === 'blurredVision' ? 79 : 40;
    const plain = await pixel(x);
    assert.notDeepEqual(await filtered(type, x), plain);
    assert.deepEqual(await pixel(x), plain);
  });
}

test("a vision deficiency keeps the page's own filter on <html>, applied under it", async () => {
  const set = (filter: string) =>
    t.page.evaluate(f => {
      document.documentElement.style.filter = f;
    }, filter);
  const computed = () => t.page.evaluate(() => getComputedStyle(document.documentElement).filter);
  const without = await filtered('protanopia');
  await set('hue-rotate(120deg)');
  try {
    const own = await pixel();
    await set('');
    assert.notDeepEqual(own, await pixel());
    await set('hue-rotate(120deg)');
    const seen = await filtered('protanopia', 40, async () => assert.equal(await computed(), 'hue-rotate(120deg)'));
    assert.notDeepEqual(seen, own);
    assert.notDeepEqual(seen, without);
  } finally {
    await set('');
  }
});

/** Opens or closes the page's top-layer element `what` (see the fixture). */
const toggle = (what: string, open: boolean) =>
  t.page.evaluate(
    async (what, open) => {
      const el =
        what === 'shadow popover'
          ? (Reflect.get(window, '__shadowPopover') as HTMLElement)
          : (document.getElementById(what) as HTMLElement);
      if (what === 'dlg') {
        if (open) (el as HTMLDialogElement).showModal();
        else (el as HTMLDialogElement).close();
      } else if (what === 'fs') {
        // Full screen needs a user gesture: done from a click below.
        if (!open && document.fullscreenElement) await document.exitFullscreen();
      } else el.togglePopover(open);
      await new Promise(requestAnimationFrame);
    },
    what,
    open
  );

const openFullscreen = async () => {
  await t.page.evaluate(() => {
    const fs = document.getElementById('fs');
    if (fs) fs.onclick = () => void fs.requestFullscreen();
    // Shown for the click only: full screen, it is shown by the style.
    fs?.style.setProperty('display', 'block');
  });
  await t.page.click('#fs');
  await t.page.evaluate(() => document.getElementById('fs')?.style.removeProperty('display'));
  await t.page.waitForFunction(() => document.fullscreenElement !== null);
  await t.page.evaluate(() => new Promise(requestAnimationFrame));
};

for (const [what, name] of [
  ['manual popover', 'pop'],
  ['auto popover', 'auto'],
  ['hint popover', 'hint'],
  ['modal dialog', 'dlg'],
  ['popover in a shadow tree', 'shadow popover'],
  ['full-screen element', 'fs'],
] as const) {
  test(`a ${what} opened after a vision deficiency is filtered too`, async () => {
    const open = () => (name === 'fs' ? openFullscreen() : toggle(name, true));
    const close = () => toggle(name, false);
    await open();
    const plain = await pixel();
    await close();
    const seen = await filtered('deuteranopia', 40, open, close);
    assert.notDeepEqual(seen, plain);
  });
}

test('the filter comes back when the page takes the mask out with the rest of <html>', async () => {
  const seen = await filtered('tritanopia');
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'tritanopia' });
  try {
    // Everything in <html> replaced, then the page's content put back in a new <body>.
    await t.page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      document.documentElement.innerHTML = '';
      document.documentElement.innerHTML = html.replace(/<div data-devtools-anywhere="vision"[^>]*><\/div>/, '');
    });
    await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await pixel(), seen);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('a page opening a popover whenever one opens does not loop with the mask', async () => {
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'deuteranopia' });
  try {
    // For half a second, the page shows #again anew each time it opens: a toggle every task.
    const count = await t.page.evaluate(async () => {
      const again = document.getElementById('again') as HTMLElement;
      let toggles = 0;
      let stop = false;
      const onToggle = (e: Event) => {
        if (stop || e.target !== again || (e as ToggleEvent).newState !== 'open') return;
        toggles++;
        again.hidePopover();
        again.showPopover();
      };
      document.addEventListener('toggle', onToggle, true);
      again.showPopover();
      await new Promise(resolve => setTimeout(resolve, 500));
      stop = true;
      document.removeEventListener('toggle', onToggle, true);
      return toggles;
    });
    assert.ok(count > 0);
    // The page still answers, and #again, opened last, is under the mask.
    assert.notDeepEqual(await pixel(), [30, 160, 220, 255]);
  } finally {
    await toggle('again', false);
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('an unknown vision deficiency fails', async () => {
  for (const side of [t.chrome, t.ours]) {
    await assert.rejects(
      side.send('Emulation.setEmulatedVisionDeficiency', { type: 'nope' as 'none' }),
      /Unknown vision deficiency type/
    );
  }
});

test('the mask is not in the DOM tree', async () => {
  const look = async () => {
    const { root } = await t.ours.send('DOM.getDocument', { depth: -1, pierce: true });
    return JSON.stringify(root).replace(/"(nodeId|backendNodeId|parentId)":\d+/g, '');
  };
  const plain = await look();
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' });
  try {
    const seen = await look();
    assert.equal(seen, plain);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});

test('a page removing the mask whenever it sees it does not loop with it', async () => {
  const seen = await filtered('protanopia');
  await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'protanopia' });
  try {
    const removals = await t.page.evaluate(async () => {
      let count = 0;
      const observer = new MutationObserver(() => {
        for (const el of document.documentElement.children)
          if (el.getAttribute('data-devtools-anywhere') === 'vision') {
            el.remove();
            count++;
          }
      });
      observer.observe(document.documentElement, { childList: true });
      document.querySelector('[data-devtools-anywhere="vision"]')?.remove();
      await new Promise(resolve => setTimeout(resolve, 500));
      observer.disconnect();
      return count;
    });
    // Put back once a frame at most: about 30 times in half a second, not thousands.
    assert.ok(removals < 100, `${removals} removals`);
    await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepEqual(await pixel(), seen);
  } finally {
    await t.ours.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  }
});
