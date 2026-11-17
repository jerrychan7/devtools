// Forced colors (Emulation.setEmulatedMedia with forced-colors: active) against Chrome's own. The same
// page is screenshotted under Chrome's forced colors and under ours, and the pixels are compared: over the
// whole page, and element by element for the ones we are meant to paint exactly. Form controls are
// recoloured only (their borders and accents are painted by the theme in Chrome), so they count for the
// whole page alone.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Frame } from 'puppeteer-core';
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

/** Every test runs under each scheme of the browser, launched with it. */
for (const scheme of ['light', 'dark'] as const)
  describe(`under a ${scheme} scheme`, () => {
    setUpAndTearDown(
      async () => {
        // The browser's scheme is set, whatever the system's: Chrome's palette follows it, so each test runs
        // under the light palette and the dark one.
        env = await launch([`--blink-settings=preferredColorScheme=${scheme === 'dark' ? 0 : 1}`]);
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
          found[id] = {
            x: Math.floor(r.x),
            y: Math.floor(r.y),
            width: Math.ceil(r.width),
            height: Math.ceil(r.height),
          };
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

    test('a page that adds an element for each attribute change it sees does not loop with the marks', async ctx => {
      /** The page's observer adds a gradient to #loop for each attribute record there, up to `LIMIT` of them. */
      const LIMIT = 200;
      const loop = async (side: Side) => {
        await t.page.evaluate(limit => {
          const box = document.createElement('div');
          box.id = 'loop';
          document.body.append(box);
          let added = 0;
          const observer = new MutationObserver(records => {
            for (let i = 0; i < records.length && added < limit; i++) {
              added++;
              box.insertAdjacentHTML('beforeend', '<i style="background: linear-gradient(red, blue)">i</i>');
            }
          });
          observer.observe(box, { attributes: true, subtree: true });
          Reflect.set(window, '__loop', { stop: () => observer.disconnect(), added: () => added });
        }, LIMIT);
        const images = () =>
          t.page.evaluate(() =>
            Array.from(document.querySelectorAll('#loop i'), el => getComputedStyle(el).backgroundImage)
          );
        await side.send('Emulation.setEmulatedMedia', FORCED);
        try {
          await t.page.evaluate(() =>
            document
              .getElementById('loop')
              ?.insertAdjacentHTML('beforeend', '<i style="background: linear-gradient(red, blue)">i</i>')
          );
          await new Promise(resolve => setTimeout(resolve, 2000));
          const added = await t.page.evaluate(() => {
            const state = Reflect.get(window, '__loop') as { stop(): void; added(): number };
            state.stop();
            return state.added();
          });
          // The page adds no more: every gradient there is taken away, the held ones within the longest wait.
          const start = Date.now();
          let left = await images();
          while (left.some(image => image !== 'none') && Date.now() - start < 3000) {
            await new Promise(resolve => setTimeout(resolve, 50));
            left = await images();
          }
          return { added, gradients: left.filter(image => image !== 'none').length };
        } finally {
          await t.page.evaluate(() => document.getElementById('loop')?.remove());
          await side.send('Emulation.setEmulatedMedia', CLEAR);
          await settle();
        }
      };
      const chrome = await loop(t.chrome);
      const ours = await loop(t.ours);
      // Chrome writes nothing the page sees. Our marks are attributes, which this page answers: the scan waits
      // longer each time, so the page adds a few elements in two seconds, not all it would.
      ctx.diagnostic(`answers in the observer's callback: ${ours.added} in two seconds`);
      assert.deepEqual(chrome, { added: 0, gradients: 0 });
      assert.equal(ours.gradients, 0);
      assert.ok(ours.added >= 1 && ours.added <= 12, `the page added ${ours.added} elements`);
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

    /** A gradient, which forced colors take away: ours marks the element for it. */
    const GRADIENT = '<i style="background: linear-gradient(red, blue)">i</i>';

    /**
     * How a page answers a mark: in a microtask, a frame callback, a MessageChannel message, a scheduler.postTask()
     * callback, or a timer of that many ms.
     */
    type Answer = 'microtask' | 'frame' | 'message' | 'postTask' | number;

    /**
     * A page whose observer answers each attribute record of #loop with one more gradient there, `how`, up to 500 of
     * them: how many it has added two seconds after the first one, and how many gradients are left some time after it
     * stopped answering.
     */
    async function answers(side: Side, how: Answer): Promise<{ added: number; gradients: number }> {
      await t.page.evaluate(how => {
        const box = document.createElement('div');
        box.id = 'loop';
        document.body.append(box);
        let added = 0;
        const add = () => {
          if (added++ < 500)
            box.insertAdjacentHTML('beforeend', '<i style="background: linear-gradient(red, blue)">i</i>');
        };
        const channel = new MessageChannel();
        channel.port1.onmessage = add;
        const scheduler = Reflect.get(window, 'scheduler') as { postTask(task: () => void): Promise<void> };
        const observer = new MutationObserver(records => {
          for (let i = 0; i < records.length; i++) {
            if (how === 'microtask') queueMicrotask(add);
            else if (how === 'frame') requestAnimationFrame(add);
            else if (how === 'message') channel.port2.postMessage(null);
            else if (how === 'postTask') void scheduler.postTask(add);
            else setTimeout(add, how);
          }
        });
        observer.observe(box, { attributes: true, subtree: true });
        Reflect.set(window, '__loop', { stop: () => observer.disconnect(), added: () => added });
      }, how);
      await side.send('Emulation.setEmulatedMedia', FORCED);
      try {
        await t.page.evaluate(html => document.getElementById('loop')?.insertAdjacentHTML('beforeend', html), GRADIENT);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const added = await t.page.evaluate(() => {
          const state = Reflect.get(window, '__loop') as { stop(): void; added(): number };
          state.stop();
          return state.added();
        });
        // The page adds no more: every gradient there is taken away, the held ones within the longest wait.
        const images = () =>
          t.page.evaluate(() =>
            Array.from(document.querySelectorAll('#loop i'), el => getComputedStyle(el).backgroundImage)
          );
        const start = Date.now();
        let left = await images();
        while (left.some(image => image !== 'none') && Date.now() - start < 3000) {
          await new Promise(resolve => setTimeout(resolve, 50));
          left = await images();
        }
        return { added, gradients: left.filter(image => image !== 'none').length };
      } finally {
        await t.page.evaluate(() => document.getElementById('loop')?.remove());
        await side.send('Emulation.setEmulatedMedia', CLEAR);
        await settle();
      }
    }

    test('a page that answers the marks in a microtask or a task of no delay is backed off', async ctx => {
      const names = {
        microtask: 'a microtask',
        0: 'a timer of no delay',
        message: 'a message',
        postTask: 'postTask()',
      };
      for (const how of ['microtask', 0, 'message', 'postTask'] as const) {
        // Chrome writes nothing the page sees, so the page adds nothing. Ours marks, which this page answers in the
        // turn of the mark: the scan waits longer each time.
        assert.deepEqual(await answers(t.chrome, how), { added: 0, gradients: 0 });
        const ours = await answers(t.ours, how);
        ctx.diagnostic(`answers from ${names[how]}: ${ours.added} in two seconds`);
        assert.equal(ours.gradients, 0);
        assert.ok(ours.added >= 1 && ours.added <= 12, `the page added ${ours.added} elements`);
      }
    });

    test('a page that answers the marks from a later frame or timer goes on at its own pace', async ctx => {
      // docs/limitations.md says so: an answer from a later task of the page's is not told from an addition of its
      // own, so it is marked at once, which the page answers again, about once a frame or once a timer.
      for (const [how, most] of [
        ['frame', 260],
        [50, 45],
      ] as const) {
        assert.deepEqual(await answers(t.chrome, how), { added: 0, gradients: 0 });
        const ours = await answers(t.ours, how);
        ctx.diagnostic(
          `answers from ${how === 'frame' ? 'a frame callback' : `a ${how} ms timer`}: ${ours.added} in two seconds`
        );
        assert.equal(ours.gradients, 0);
        assert.ok(ours.added > 12 && ours.added <= most, `the page added ${ours.added} elements`);
      }
    });

    /** How a page adds gradients of its own: each step is run in turn, in one document. */
    type Step = 'once' | 'microtasks' | 'timers' | 'frames-100' | 'frames-1';

    /**
     * Runs `steps` in the document of `frame` (the top page's, or the iframe's): 2000 gradients added at once, in 20
     * microtasks or 20 timers of no delay of 100 each, 100 in each of 20 frames, or one in each frame for three
     * seconds. Gives, per step, the most frames an element waited for its mark: 0 where it is marked in the frame it
     * was added in. An element left unmarked two seconds after the last step counts as Infinity.
     */
    const waited = (frame: Frame, steps: Step[]): Promise<number[]> =>
      frame.evaluate(
        async (steps, html) => {
          const MARK = 'data-devtools-anywhere-forced-colors';
          const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
          const box = document.createElement('div');
          box.id = 'bulk';
          document.body.append(box);
          // The frame each element was added in, and the frames it waited: the marks are seen as they are written.
          let now = 0;
          let counting = true;
          const tick = () => {
            now++;
            if (counting) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          const born = new Map<Node, { at: number; step: number }>();
          const longest = steps.map(() => 0);
          const marks = new MutationObserver(records => {
            for (const { target } of records) {
              const was = born.get(target);
              if (!was) continue;
              born.delete(target);
              longest[was.step] = Math.max(longest[was.step] ?? 0, now - was.at);
            }
          });
          marks.observe(box, { attributes: true, attributeFilter: [MARK], subtree: true });
          const add = (step: number, count: number) => {
            const from = box.children.length;
            box.insertAdjacentHTML('beforeend', html.repeat(count));
            for (let i = from; i < box.children.length; i++) born.set(box.children[i] as Node, { at: now, step });
          };
          for (const [step, how] of steps.entries()) {
            if (how === 'once') add(step, 2000);
            else if (how === 'microtasks')
              for (let i = 0; i < 20; i++) {
                await Promise.resolve();
                add(step, 100);
              }
            else if (how === 'timers')
              await Promise.all(
                Array.from(
                  { length: 20 },
                  () => new Promise<void>(resolve => setTimeout(() => resolve(add(step, 100)), 0))
                )
              );
            else {
              const [frames, count] = how === 'frames-100' ? [20, 100] : [180, 1];
              for (let i = 0; i < frames; i++) {
                await nextFrame();
                add(step, count);
              }
            }
            // The next step follows at once, as a page's own work does: after a frame, so that each step's first
            // addition is in a task of its own.
            await nextFrame();
          }
          for (let i = 0; i < 20 && born.size; i++) await pause(100);
          counting = false;
          marks.disconnect();
          for (const { step } of born.values()) longest[step] = Infinity;
          box.remove();
          return longest;
        },
        steps,
        GRADIENT
      );

    /** The document of the fixture's iframe. */
    const inner = (): Frame => {
      const frame = t.page.frames().find(f => f.parentFrame() === t.page.mainFrame());
      if (!frame) throw new Error('the page has no iframe');
      return frame;
    };

    /** The steps a page's own additions are measured in: each alone, then some in a row. */
    const ALONE: Step[] = ['once', 'microtasks', 'timers', 'frames-100', 'frames-1'];
    const IN_A_ROW: Step[] = ['timers', 'frames-100', 'frames-1', 'microtasks', 'frames-1'];
    /** The most frames an element a page adds on its own may wait for its mark. */
    const MOST = 2;

    test('the elements a page adds on its own are marked within two frames, in the page and in an iframe', async ctx => {
      await t.ours.send('Emulation.setEmulatedMedia', FORCED);
      try {
        await settle();
        for (const [where, frame] of [
          ['the page', t.page.mainFrame()],
          ['the iframe', inner()],
        ] as const) {
          const alone: number[] = [];
          for (const step of ALONE) alone.push(...(await waited(frame, [step])));
          const row = await waited(frame, IN_A_ROW);
          ctx.diagnostic(
            `${where}, the most frames an element waited: ${ALONE.map((step, i) => `${step} ${alone[i]}`).join(', ')}; ` +
              `in a row: ${IN_A_ROW.map((step, i) => `${step} ${row[i]}`).join(', ')}`
          );
          for (const [i, step] of ALONE.entries())
            assert.ok((alone[i] ?? Infinity) <= MOST, `${where}: ${step} alone waited ${alone[i]} frames`);
          for (const [i, step] of IN_A_ROW.entries())
            assert.ok((row[i] ?? Infinity) <= MOST, `${where}: ${step} in a row waited ${row[i]} frames`);
        }
      } finally {
        await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
        await settle();
      }
    });

    /**
     * Starts a page in `frame` whose observer answers each mark in #held with one more gradient, in the turn of the
     * mark, up to 500: the scan of that document is held for longer and longer. Gives what stops it and counts.
     */
    const answering = async (frame: Frame): Promise<() => Promise<number>> => {
      await frame.evaluate(html => {
        const box = document.createElement('div');
        box.id = 'held';
        document.body.append(box);
        let added = 0;
        const observer = new MutationObserver(() => {
          if (added++ < 500) box.insertAdjacentHTML('beforeend', html);
        });
        observer.observe(box, { attributes: true, subtree: true });
        Reflect.set(window, '__held', { observer, added: () => added });
        box.insertAdjacentHTML('beforeend', html);
      }, GRADIENT);
      return () =>
        frame.evaluate(() => {
          const state = Reflect.get(window, '__held') as { observer: MutationObserver; added(): number };
          state.observer.disconnect();
          document.getElementById('held')?.remove();
          return state.added();
        });
    };

    test('a document that answers the marks does not hold the scan of another, nor the next forced colors', async ctx => {
      await t.ours.send('Emulation.setEmulatedMedia', FORCED);
      try {
        await settle();
        for (const [answerer, other, name] of [
          [inner(), t.page.mainFrame(), 'the page, while the iframe answers'],
          [t.page.mainFrame(), inner(), 'the iframe, while the page answers'],
        ] as const) {
          const stop = await answering(answerer);
          // The answers have doubled the wait a few times by now.
          await new Promise(resolve => setTimeout(resolve, 500));
          const steps: Step[] = ['microtasks', 'frames-100', 'frames-1'];
          const frames = await waited(other, steps);
          const added = await stop();
          ctx.diagnostic(`${name}: ${steps.map((step, i) => `${step} ${frames[i]}`).join(', ')}; ${added} answers`);
          for (const [i, step] of steps.entries())
            assert.ok((frames[i] ?? Infinity) <= MOST, `${name}: ${step} waited ${frames[i]} frames`);
          assert.ok(added >= 1 && added <= 14, `the answering document added ${added} elements`);
        }
        // A wait still running when forced colors end is not the next run's: the page answers, which holds the scan
        // for frames, and forced colors are set again before those have passed.
        const stop = await answering(t.page.mainFrame());
        await new Promise(resolve => setTimeout(resolve, 1500));
        await t.page.evaluate(() =>
          (Reflect.get(window, '__held') as { observer: MutationObserver }).observer.disconnect()
        );
        await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
        await t.ours.send('Emulation.setEmulatedMedia', FORCED);
        const [again] = await waited(t.page.mainFrame(), ['microtasks']);
        await stop();
        ctx.diagnostic(`after forced colors are set again: microtasks ${again}`);
        assert.ok((again ?? Infinity) <= MOST, `${again} frames once forced colors are set again`);
      } finally {
        await t.page.evaluate(() => document.querySelectorAll('#bulk, #held').forEach(el => el.remove()));
        await inner().evaluate(() => document.querySelectorAll('#bulk, #held').forEach(el => el.remove()));
        await t.ours.send('Emulation.setEmulatedMedia', CLEAR);
        await settle();
      }
    });

    test("an element's computed background is the canvas at the page's opacity, as in Chrome", async () => {
      const backgrounds = async (side: Side) => {
        await t.page.evaluate(() =>
          document.body.insertAdjacentHTML(
            'beforeend',
            '<div id="bgs"><p style="background-color: #123456">opaque</p>' +
              '<p style="background-color: rgba(10, 20, 30, 0.5)">translucent</p>' +
              '<p style="background: linear-gradient(red, blue)">gradient</p><p>none</p></div>'
          )
        );
        await side.send('Emulation.setEmulatedMedia', FORCED);
        try {
          await settle();
          return await t.page.evaluate(() =>
            Array.from(document.querySelectorAll('#bgs p'), el => {
              const style = getComputedStyle(el);
              return `${style.backgroundColor} ${style.backgroundImage}`;
            })
          );
        } finally {
          await t.page.evaluate(() => document.getElementById('bgs')?.remove());
          await side.send('Emulation.setEmulatedMedia', CLEAR);
          await settle();
        }
      };
      const chrome = await backgrounds(t.chrome);
      const ours = await backgrounds(t.ours);
      // The page's colour is not kept: the canvas, with the opacity the page gave its background.
      const canvas = scheme === 'dark' ? '0, 0, 0' : '255, 255, 255';
      assert.deepEqual(chrome, [
        `rgb(${canvas}) none`,
        `rgba(${canvas}, 0.5) none`,
        `rgba(${canvas}, 0) none`,
        `rgba(${canvas}, 0) none`,
      ]);
      // A transparent background is not marked, so it keeps the page's transparent black, which is the dark
      // canvas at no opacity but not the light one (docs/limitations.md#forced-colors).
      assert.deepEqual(ours, [...chrome.slice(0, 2), 'rgba(0, 0, 0, 0) none', 'rgba(0, 0, 0, 0) none']);
    });

    test('the palette follows the prefers-color-scheme emulated with forced colors, and a change of it', async ctx => {
      const other = scheme === 'dark' ? 'light' : 'dark';
      const withScheme = (value: string) => ({
        features: [...FORCED.features, { name: 'prefers-color-scheme', value }],
      });
      const canvasOf = () =>
        t.page.evaluate(() => getComputedStyle(document.getElementById('over-1') ?? document.body).backgroundColor);
      const read = async (side: Side) => {
        const seen: string[] = [];
        const pixels: Pixels[] = [];
        try {
          for (const value of [other, scheme, other]) {
            await side.send('Emulation.setEmulatedMedia', withScheme(value));
            await settle();
            seen.push(await canvasOf());
            pixels.push(await shot());
          }
        } finally {
          await side.send('Emulation.setEmulatedMedia', CLEAR);
          await settle();
        }
        return { seen, pixels };
      };
      const chrome = await read(t.chrome);
      const ours = await read(t.ours);
      assert.deepEqual(ours.seen, chrome.seen);
      assert.notEqual(chrome.seen[0], chrome.seen[1], 'Chrome changes its palette with the scheme');
      for (const [i, pixels] of ours.pixels.entries()) {
        const expected = chrome.pixels[i];
        assert.ok(expected);
        const share = agreement(pixels, expected, TOLERANCE);
        ctx.diagnostic(`step ${i}: the page agrees with Chrome on ${(share * 100).toFixed(3)}% of its pixels`);
        assert.ok(share >= PAGE_AGREEMENT, `step ${i}: ${(share * 100).toFixed(3)}% of the pixels agree`);
      }
    });
  });
