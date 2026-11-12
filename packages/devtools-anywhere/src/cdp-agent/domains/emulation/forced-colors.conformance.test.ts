// Forced colors (Emulation.setEmulatedMedia with forced-colors: active) against Chrome's own. The same
// page is screenshotted under Chrome's forced colors and under ours, and the pixels are compared: over the
// whole page, and element by element for the ones we are meant to paint exactly. Form controls are
// recoloured only (their borders and accents are painted by the theme in Chrome), so they count for the
// whole page alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';
import { agreement, decodePng, mismatches, type Box, type Pixels } from '../../../../test-support/png-pixels.ts';

/** Per channel, how far a pixel may be from Chrome's and still count as the same (antialiasing, dithering). */
const TOLERANCE = 2;
const ELEMENT_TOLERANCE = 2;
/**
 * The share of the page's pixels that must match Chrome's. The page as the test writes it agrees on 99.430%
 * at tolerance 2; what differs is the form controls (Chrome's theme paints them) and the text drawn over a
 * painted border or a translucent background (Chrome's backplate).
 */
const PAGE_AGREEMENT = 0.99;

/** A 1×1 PNG, for the images. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

const FORCED = { features: [{ name: 'forced-colors', value: 'active' }] };
/**
 * What clears the emulated features: `features: []`. Chrome keeps the features of a request that leaves
 * them out (a `{}` request does not clear forced colors there), so the tests clear with this.
 */
const CLEAR = { features: [] };

const BODY = `
<h1 id="h1">Heading one</h1>
<p id="text">Plain paragraph with <em id="em">emphasis</em> and <strong id="strong">strong</strong>.</p>
<p><a id="link" href="#x">A link</a> <a id="link-red" href="#y" style="color: red">Red link</a></p>
<p>
  <button id="btn">Button</button>
  <input id="in-button" type="button" value="Input button">
  <input id="in-submit" type="submit" value="Submit">
  <input id="in-reset" type="reset" value="Reset">
</p>
<p>
  <input id="in-text" type="text" value="Text field">
  <input id="in-search" type="search" value="Search">
  <textarea id="ta">Area</textarea>
  <select id="sel"><option>One</option><option>Two</option></select>
  <input id="in-check" type="checkbox" checked>
  <input id="in-radio" type="radio" checked>
  <input id="in-range" type="range" value="3">
</p>
<p>
  <button id="dis" disabled>Disabled</button>
  <input id="dis-text" disabled value="Disabled field">
</p>
<p><mark id="mk">marked</mark> <span id="sel-span">Selectable text here</span> <span id="pseudo">pseudo</span></p>
<p>
  <svg id="svg" width="80" height="30"><rect id="rect" x="0" y="0" width="50" height="20" fill="#f0f" stroke="#0f0" stroke-width="4"/><text x="0" y="28" fill="red">svg</text></svg>
  <img id="img" alt="img" width="40" height="30" src="${PNG}">
  <canvas id="cv" width="40" height="30"></canvas>
</p>
<div id="grad" style="width: 200px; height: 30px; background: linear-gradient(to right, red, blue)"></div>
<div id="grad-url" style="width: 200px; height: 30px; background: linear-gradient(to right, red, blue), url(${PNG}) 0 0 / 20px 20px"></div>
<div id="url" style="width: 200px; height: 30px; background-image: url(${PNG}); background-size: 20px 20px"></div>
<div id="shadow" style="width: 240px; background: #ccc; box-shadow: 4px 4px 4px #000; text-shadow: 2px 2px #f00">Shadowed text</div>
<div id="fca" style="forced-color-adjust: none; color: #800; background: #fe8; border: 3px solid #080; padding: 4px; width: 240px">
  none parent <span id="fca-child">inherits none</span>
  <div id="pres" style="forced-color-adjust: preserve-parent-color; color: #008; background: #8ef">preserve-parent-color child</div>
</div>
<div id="fca-auto" style="forced-color-adjust: auto; color: #008; background: #8ef; border: 2px solid #800; padding: 4px; width: 240px">auto</div>
<div id="stack" style="position: relative; height: 64px; margin-top: 16px">
  <p id="under-1" style="position: absolute; top: 0; left: 0; margin: 0">Underlying text one</p>
  <div id="over-1" style="position: absolute; top: 2px; left: 0; width: 220px; height: 26px; background: #ccc; color: #111">opaque over</div>
  <p id="under-2" style="position: absolute; top: 34px; left: 0; margin: 0">Underlying text two</p>
  <div id="over-2" style="position: absolute; top: 36px; left: 0; width: 220px; height: 26px; background: rgba(0, 0, 255, 0.5); color: #111">translucent over</div>
</div>
<div id="host"></div>
<iframe id="frame" width="300" height="50" srcdoc="<style>p { color: #800; background: #fe8; border: 2px solid #080 } b { color: #008 }</style><p>frame <b>text</b></p>"></iframe>
`;

const STYLE = `
body { margin: 8px; font: 16px/1.4 sans-serif; background: #eef; color: #223; }
p, h1 { margin: 4px 0; }
h1 { font-size: 22px; }
a { color: #00c; }
button, input, select, textarea { font: 14px sans-serif; }
#btn { color: #600; background: #fc8; border: 3px solid #060; }
#in-text { color: #600; background: #fc8; }
#dis { color: #600; }
#mk { color: #222; background: #fd0; }
#em { font-style: italic; color: #606; }
#pseudo::before { content: ''; display: inline-block; width: 12px; height: 12px; margin-right: 4px; border: 3px solid #0a0; background: transparent; box-shadow: 0 0 4px #000; }
::selection { color: #123; background: #fa4; }
#fca-child { font-weight: bold; }
`;

/** The shadow root of #host: a paragraph styled by the root's own sheet, as a component would be. */
const SHADOW =
  '<style>p { color: #800; background: #fe8; border: 2px solid #080; padding: 2px }</style><p id="sh">shadow text</p>';

/**
 * Elements that must match Chrome's pixels (within ELEMENT_TOLERANCE): the page's text, links, marks,
 * selection, images, gradients, shadows, colour adjustments, an opaque background over text, a
 * pseudo-element, a shadow tree and a same-origin iframe. Not the text under a translucent background, nor
 * text drawn over a painted border: Chrome paints a backplate behind text there (the limitations say so).
 * Nor the text under the opaque overlay (`under-1`): the overlay hides it in both, so it tells nothing.
 */
const EXACT = [
  'h1',
  'text',
  'em',
  'strong',
  'link',
  'link-red',
  'btn',
  'sel-span',
  'mk',
  'pseudo',
  'svg',
  'rect',
  'img',
  'cv',
  'grad',
  'grad-url',
  'url',
  'shadow',
  'fca',
  'fca-child',
  'pres',
  'fca-auto',
  'over-1',
  'frame',
  'shadow:sh',
];

/** Where elements are on the screen, by id. */
type Places = Record<string, Box>;

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, ['DOM.attributeModified', 'DOM.attributeRemoved']);
    // Taller than the page and the elements the tests add below it, so that every element compared lies inside the
    // screenshot: png-pixels.ts throws on a box that does not.
    await t.page.setViewport({ width: 800, height: 1000 });
    await t.page.evaluate(
      ({ body, style, shadow }) => {
        const s = document.createElement('style');
        s.textContent = style;
        document.head.appendChild(s);
        document.body.innerHTML = body;
        const root = document.getElementById('host')?.attachShadow({ mode: 'open' });
        if (root) root.innerHTML = shadow;
        const selected = document.getElementById('sel-span');
        if (selected) window.getSelection()?.selectAllChildren(selected);
      },
      { body: BODY, style: STYLE, shadow: SHADOW }
    );
    // Images decode and the frame loads before the first screenshot.
    await t.page.evaluate(async () => {
      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
      await new Promise<void>(resolve => {
        const frame = document.getElementById('frame') as HTMLIFrameElement | null;
        if (!frame || frame.contentDocument?.readyState === 'complete') resolve();
        else frame.addEventListener('load', () => resolve(), { once: true });
      });
      const canvas = document.getElementById('cv') as HTMLCanvasElement | null;
      canvas?.getContext('2d')?.fillRect(0, 0, 20, 20);
    });
  },
  () => env?.close()
);

/** Waits until the page has painted what the last change made. */
const settle = () =>
  t.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));

/** The page as the screenshot shows it, decoded. */
const shot = async (): Promise<Pixels> => decodePng(new Uint8Array(await t.page.screenshot({ type: 'png' })));

/** Where each element is on the screen, by id ("shadow:sh" is the paragraph in the shadow root). */
const placesOf = (ids: string[]): Promise<Places> =>
  t.page.evaluate((ids: string[]) => {
    const found: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const id of ids) {
      const element = id.startsWith('shadow:')
        ? document.getElementById('host')?.shadowRoot?.getElementById(id.slice('shadow:'.length))
        : document.getElementById(id);
      if (!element) continue;
      const r = element.getBoundingClientRect();
      found[id] = { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    }
    return found;
  }, ids);

/**
 * The screenshot taken while `side` runs forced colors, and where the elements `ids` are then: the
 * emulation ends after both.
 */
async function under(side: Side, ids: string[]): Promise<{ pixels: Pixels; places: Places }> {
  await side.send('Emulation.setEmulatedMedia', FORCED);
  try {
    await settle();
    return { pixels: await shot(), places: await placesOf(ids) };
  } finally {
    await side.send('Emulation.setEmulatedMedia', CLEAR);
    await settle();
  }
}

/** The number of marks of devtools-anywhere's forced colors, in the page, its shadow root and its iframe. */
const marks = () =>
  t.page.evaluate(() => {
    const selector = '[data-devtools-anywhere-forced-colors]';
    const frame = document.getElementById('frame') as HTMLIFrameElement | null;
    const trees = [document, document.getElementById('host')?.shadowRoot, frame?.contentDocument];
    return trees.reduce((n, tree) => n + (tree?.querySelectorAll(selector).length ?? 0), 0);
  });

test('forced colors paint the page as Chrome does, element by element', async ctx => {
  const baseline = await shot();
  const chrome = await under(t.chrome, EXACT);
  const ours = await under(t.ours, EXACT);
  assert.ok(agreement(chrome.pixels, baseline, 0) < 1, 'Chrome paints forced colors');

  const failed = EXACT.filter(id => {
    const box = chrome.places[id];
    assert.ok(box, `#${id} is on the page`);
    return mismatches(ours.pixels, chrome.pixels, box, ELEMENT_TOLERANCE) > 0;
  });
  assert.deepEqual(failed, [], 'elements that differ from Chrome');
  const share = agreement(ours.pixels, chrome.pixels, TOLERANCE);
  ctx.diagnostic(`the page agrees with Chrome on ${(share * 100).toFixed(3)}% of its pixels`);
  assert.ok(share >= PAGE_AGREEMENT, `the page agrees with Chrome on ${(share * 100).toFixed(3)}% of its pixels`);
});

test('the marks are taken away when forced colors end, and the page is painted as before', async () => {
  const baseline = await shot();
  await t.ours.send('Emulation.setEmulatedMedia', FORCED);
  try {
    await settle();
    assert.ok((await marks()) > 0, 'the elements that keep their colors are marked while forced colors run');
  } finally {
    await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
    await settle();
  }
  assert.equal(await marks(), 0);
  assert.equal(agreement(await shot(), baseline, 0), 1);
});

test("the client is told of the page's own attribute changes, and not of the marks", async () => {
  await t.ours.send('DOM.enable');
  const { root } = await t.ours.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await t.ours.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#text' });
  try {
    // The client is told of the page's own change, so that the silence below is not for want of a report.
    await t.ours.clear();
    await t.page.evaluate(() => document.getElementById('text')?.setAttribute('data-probe', 'page'));
    await settle();
    const told = await t.ours.events('DOM.attributeModified');
    assert.ok(
      told.some(event => event.nodeId === nodeId && event.name === 'data-probe'),
      'the page change is told to the client'
    );
    await t.page.evaluate(() => document.getElementById('text')?.removeAttribute('data-probe'));
    await settle();
    await t.ours.clear();
    await t.ours.send('Emulation.setEmulatedMedia', FORCED);
    await settle();
    assert.ok((await marks()) > 0, 'marks are written while forced colors run');
    await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
    await settle();
    assert.deepEqual(await t.ours.events('DOM.attributeModified'), []);
    assert.deepEqual(await t.ours.events('DOM.attributeRemoved'), []);
  } finally {
    await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
    await t.page.evaluate(() => document.getElementById('text')?.removeAttribute('data-probe'));
    await t.ours.send('DOM.disable');
  }
});

test('the client is shown the page as it wrote it, marks left out', async () => {
  await t.chrome.send('DOM.enable');
  await t.ours.send('DOM.enable');
  const { root: chromeRoot } = await t.chrome.send('DOM.getDocument', { depth: -1 });
  const { root: oursRoot } = await t.ours.send('DOM.getDocument', { depth: -1 });
  const outer = async (side: Side, root: { nodeId: number }) => {
    const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fca' });
    return side.send('DOM.getOuterHTML', { nodeId });
  };
  const plain = await outer(t.chrome, chromeRoot);
  await t.chrome.send('Emulation.setEmulatedMedia', FORCED);
  try {
    await t.ours.send('Emulation.setEmulatedMedia', FORCED);
    await settle();
    const oursOuter = await outer(t.ours, oursRoot);
    // Chrome's own DOM agent reads the page as it is, marks included: they are there, and ours leaves them out.
    const chromeOuter = await outer(t.chrome, chromeRoot);
    assert.match(chromeOuter.outerHTML, /data-devtools-anywhere-forced-colors="kept"/);
    assert.equal(oursOuter.outerHTML, plain.outerHTML, 'the element is shown as the page wrote it');
  } finally {
    await t.chrome.send('Emulation.setEmulatedMedia', CLEAR);
    await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
    await settle();
    await t.chrome.send('DOM.disable');
    await t.ours.send('DOM.disable');
  }
});

test('elements added while forced colors run are painted as Chrome paints them', async () => {
  const ADDED = `<div id="added-g" style="width: 200px; height: 30px; background: linear-gradient(to right, red, blue)"></div>
    <p id="added-p" style="forced-color-adjust: none; color: #800; background: #fe8">added, kept</p>
    <p id="added-q" style="color: #008; background: #8ef">added</p>`;
  const withAdded = async (side: Side) => {
    await side.send('Emulation.setEmulatedMedia', FORCED);
    try {
      await t.page.evaluate(html => {
        document.body.insertAdjacentHTML('beforeend', html);
        // A clone of the gradient #grad, as a page makes one: the clone carries the mark of the original.
        const clone = document.getElementById('grad')?.cloneNode(true);
        if (clone instanceof HTMLElement) {
          clone.id = 'added-clone';
          document.body.appendChild(clone);
        }
      }, ADDED);
      await settle();
      const pixels = await shot();
      const places = await placesOf(['added-g', 'added-p', 'added-q', 'added-clone']);
      return { pixels, places };
    } finally {
      await t.page.evaluate(() =>
        document.querySelectorAll('#added-g, #added-p, #added-q, #added-clone').forEach(el => el.remove())
      );
      await side.send('Emulation.setEmulatedMedia', CLEAR);
      await settle();
    }
  };
  const chrome = await withAdded(t.chrome);
  const ours = await withAdded(t.ours);
  for (const id of ['added-g', 'added-p', 'added-q', 'added-clone']) {
    const box = chrome.places[id];
    assert.ok(box, `#${id} is on the page`);
    assert.equal(mismatches(ours.pixels, chrome.pixels, box, ELEMENT_TOLERANCE), 0, `#${id}`);
  }
  assert.equal(await marks(), 0, 'the added elements are unmarked once they are gone');
});

test('the marks of an element the page took out are taken away when forced colors end', async () => {
  await t.ours.send('Emulation.setEmulatedMedia', FORCED);
  const markedOut = () =>
    t.page.evaluate(() => {
      const out = Reflect.get(window, '__out') as { el: Element } | undefined;
      return out ? out.el.hasAttribute('data-devtools-anywhere-forced-colors') : null;
    });
  try {
    await t.page.evaluate(() => {
      const el = document.getElementById('grad');
      const parent = el?.parentNode;
      if (!el || !parent) throw new Error('#grad is on the page');
      Reflect.set(window, '__out', { el, parent, next: el.nextSibling });
      el.remove();
    });
    await settle();
    assert.equal(await markedOut(), true, 'the element the page took out is still marked');
    await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
    await settle();
    assert.equal(await markedOut(), false, 'the element the page took out keeps no mark');
  } finally {
    await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
    await t.page.evaluate(() => {
      const out = Reflect.get(window, '__out') as { el: Node; parent: Node; next: Node | null } | undefined;
      if (out) out.parent.insertBefore(out.el, out.next);
      Reflect.deleteProperty(window, '__out');
    });
    await settle();
  }
});

test('an element slotted into a shadow tree keeps the colors of the element its slot is in', async () => {
  const colors = async (side: Side) => {
    await t.page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div id="slot-host"><span id="slotted" style="forced-color-adjust: preserve-parent-color">slotted</span>' +
          '<span id="slotted-auto">auto</span></div>'
      );
      const root = document.getElementById('slot-host')?.attachShadow({ mode: 'open' });
      if (root) root.innerHTML = '<div style="forced-color-adjust: none; color: #080"><slot></slot></div>';
    });
    await side.send('Emulation.setEmulatedMedia', FORCED);
    try {
      await settle();
      return await t.page.evaluate(() =>
        ['slotted', 'slotted-auto'].map(id => getComputedStyle(document.getElementById(id) ?? document.body).color)
      );
    } finally {
      await t.page.evaluate(() => document.getElementById('slot-host')?.remove());
      await side.send('Emulation.setEmulatedMedia', CLEAR);
      await settle();
    }
  };
  const chrome = await colors(t.chrome);
  assert.deepEqual(await colors(t.ours), chrome);
  assert.equal(chrome[0], 'rgb(0, 136, 0)');
});
