// The Animations panel of the DevTools frontend built from the official sources, against the
// in-page CDP agent. Skipped when the frontend has not been built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, JSHandle, Page } from 'puppeteer-core';
import type { Env } from '../support/browser.ts';
import { built, frontendHelpers, openRealFrontend, skip, waitFor, setUpAndTearDown } from '../support/real-frontend.ts';

let env: Env | undefined;
let page: Page;
let frontend: Frame;
/** Uncaught errors in the frontend. */
const errors: string[] = [];
const { showView, count, shownText, clickNth } = frontendHelpers(() => frontend);

setUpAndTearDown(
  async () => {
    if (!built) return;
    ({ env, page, frontend } = await openRealFrontend(errors));
  },
  () => env?.close()
);

test('the Animations panel lists the CSS and Web Animations the page runs', { skip }, async () => {
  await showView('animations');
  const before = await count('.animation-buffer-preview');
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
      '@keyframes rf-spin { to { transform: rotate(1turn) } } .rf-spin { animation: rf-spin 1s infinite }';
    document.head.append(style);
    const css = document.createElement('div');
    css.className = 'rf-spin';
    document.body.append(css);
    const web = document.createElement('div');
    document.body.append(web);
    web.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, iterations: Infinity }).id = 'rf-web';
  });
  try {
    await waitFor(async () => (await count('.animation-buffer-preview')) > before);
    // Each animation's name is shown in its group's timeline: the CSS animation's and the Web
    // Animation's, whether they share a group or not.
    const names = new Set<string>();
    await waitFor(async () => {
      const previews = await count('.animation-buffer-preview');
      for (let i = before; i < previews; i++) {
        await clickNth('.animation-buffer-preview', i);
        for (const line of await shownText()) if (line === 'rf-spin' || line === 'rf-web') names.add(line);
      }
      return names.size === 2;
    });
  } finally {
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.cancel();
      document.querySelector('.rf-spin')?.classList.remove('rf-spin');
    });
  }
});

test('the Animations panel keeps a group for each of two CSS animations started apart', { skip }, async () => {
  await showView('animations');
  const before = await count('.animation-buffer-preview');
  // Without a cssId the panel took the second group for the first and replaced it.
  const add = (name: string) =>
    page.evaluate(n => {
      const style = document.createElement('style');
      style.textContent = `@keyframes ${n} { to { opacity: 0.5 } } .${n} { animation: ${n} 1s infinite }`;
      document.head.append(style);
      document.body.append(Object.assign(document.createElement('div'), { className: n }));
    }, name);
  try {
    await add('rf-one');
    await waitFor(async () => (await count('.animation-buffer-preview')) === before + 1);
    await new Promise(r => setTimeout(r, 300));
    await add('rf-two');
    await waitFor(async () => (await count('.animation-buffer-preview')) === before + 2);
  } finally {
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.cancel();
      for (const el of document.querySelectorAll('.rf-one, .rf-two')) el.remove();
    });
    // The panel keeps only as many groups as its width holds and drops the oldest for a new one, so
    // the groups left here would keep the next test's from adding to the count: clear them.
    await frontend.evaluate(() => {
      const walk = (root: Document | ShadowRoot): Element | undefined =>
        root.querySelector('[title="Clear all"], [aria-label="Clear all"]') ??
        [...root.querySelectorAll('*')].reduce<Element | undefined>(
          (found, el) => found ?? (el.shadowRoot ? walk(el.shadowRoot) : undefined),
          undefined
        );
      const button = walk(document);
      if (button instanceof HTMLElement) button.click();
    });
    await waitFor(async () => (await count('.animation-buffer-preview')) === 0);
  }
});

test('the Animations panel removes its last group without an error', { skip }, async () => {
  await showView('animations');
  // The previous test leaves the panel empty, so the group added here is its only one.
  assert.equal(await count('.animation-buffer-preview'), 0);
  const before = errors.length;
  await page.evaluate(() => {
    const el = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'rf-last' }));
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, iterations: Infinity });
  });
  try {
    await waitFor(async () => (await count('.animation-buffer-preview')) === 1);
    await frontend.evaluate(() => {
      const walk = (root: Document | ShadowRoot): Element | undefined =>
        root.querySelector('.animation-remove-button') ??
        [...root.querySelectorAll('*')].reduce<Element | undefined>(
          (found, el) => found ?? (el.shadowRoot ? walk(el.shadowRoot) : undefined),
          undefined
        );
      const button = walk(document);
      if (button instanceof HTMLElement) button.click();
    });
    await waitFor(async () => (await count('.animation-buffer-preview')) === 0);
    // Upstream focused a toolbar button it never assigned, and threw (patches/animation-remove-last-group.patch).
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(errors.slice(before), []);
  } finally {
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) animation.cancel();
      document.getElementById('rf-last')?.remove();
    });
  }
});

test('the Animations panel plays a shadow tree animation it is shown, and pauses it', { skip }, async () => {
  await showView('animations');
  const before = await count('.animation-buffer-preview');
  await page.evaluate(() => {
    const host = document.body.appendChild(document.createElement('div'));
    host.id = 'rf-shadow-spin';
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<style>@keyframes rf-bounce { 50% { opacity: 0.5 } } p { animation: rf-bounce 0.4s infinite }</style><p>x</p>';
  });
  const click = (selector: string) => clickNth(selector, -1);
  /** The play state and current time of the shadow tree's animation, as the page reads them. */
  const state = () =>
    page.evaluate(() => {
      const animation = document.getElementById('rf-shadow-spin')?.shadowRoot?.getAnimations()[0];
      return {
        playState: animation?.playState,
        pending: animation?.pending,
        currentTime: Number(animation?.currentTime),
      };
    });
  /**
   * The animation's time once it stands still: read twice 300 ms apart, the same both times and
   * paused (the frontend's last seeks of a drag may still be on their way). A running animation
   * never stands still, so this times out.
   */
  const stopped = () =>
    waitFor(async () => {
      const first = await state();
      await new Promise(r => setTimeout(r, 300));
      const second = await state();
      return first.playState === 'paused' && second.pending === false && first.currentTime === second.currentTime
        ? { at: second.currentTime }
        : null;
    }).then(({ at }) => at);
  try {
    await waitFor(async () => (await count('.animation-buffer-preview')) > before);
    await click('.animation-buffer-preview');
    // Selecting a group replays it: the control shows it playing once the page reports the seek.
    await waitFor(() => count('devtools-button[title="Pause timeline"]'));
    await click('devtools-button[title="Pause timeline"]');
    await waitFor(() => count('devtools-button[title="Play timeline"]'));
    // The page's animation is paused, not only the button.
    await waitFor(async () => (await state()).playState === 'paused');
    const pausedAt = await stopped();
    // Dragging the scrubber seeks the page's animation along: to about half the 1.2 s timeline.
    const header = await frontend.evaluate(() => {
      const find = (root: Document | ShadowRoot): Element | null => {
        const hit = root.querySelector('.animation-grid-header');
        if (hit) return hit;
        for (const el of root.querySelectorAll('*')) {
          const found = el.shadowRoot && find(el.shadowRoot);
          if (found) return found;
        }
        return null;
      };
      const rect = find(document)?.getBoundingClientRect();
      return rect && { x: rect.x, y: rect.y + rect.height / 2, width: rect.width };
    });
    assert.ok(header);
    const frame = await (await frontend.frameElement())?.boundingBox();
    assert.ok(frame);
    const y = frame.y + header.y;
    await page.mouse.move(frame.x + header.x + 20, y);
    await page.mouse.down();
    await page.mouse.move(frame.x + header.x + header.width / 2, y, { steps: 5 });
    await page.mouse.up();
    // Seeked, and still paused: the time is the scrubber's, not one the animation ran to.
    await waitFor(async () => (await state()).currentTime !== pausedAt);
    const time = await stopped();
    assert.ok(time > 300 && time < 1200, `seeked to ${time} ms`);
    // Played again, the page's animation runs.
    await click('devtools-button[title="Play timeline"]');
    await waitFor(async () => (await state()).playState === 'running');
  } finally {
    await page.evaluate(() => document.getElementById('rf-shadow-spin')?.remove());
  }
});

/**
 * Selects the scroll-driven group `add` makes, checks the panel shows it in pixels, drags the
 * scrubber to about half the timeline, and gives the scroll position `top` then reads.
 */
async function scrubScrollDriven(add: () => void, top: () => number, remove: () => void) {
  await showView('animations');
  const before = await count('.animation-buffer-preview');
  await page.evaluate(add);
  /** Finds the last match of `selector` in the frontend, shadow DOM included. */
  const find = (selector: string): Promise<JSHandle<Element | null>> =>
    frontend.evaluateHandle(selector => {
      const all: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        all.push(...root.querySelectorAll(selector));
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return all.at(-1) ?? null;
    }, selector);
  try {
    await waitFor(async () => (await count('.animation-buffer-preview')) > before);
    await (await find('.animation-buffer-preview')).evaluate(el => el instanceof HTMLElement && el.click());
    // Shown by scroll position, in pixels, where a time-based one shows milliseconds.
    const current = await waitFor(async () => {
      const value = await (await find('.animation-timeline-current-time')).evaluate(el => el?.textContent ?? '');
      return /^\d+px$/.test(value) ? value : null;
    });
    assert.equal(current, '0px');
    // Dragging the scrubber scrolls the scroller, rather than seeking the animation.
    const header = await (
      await find('.animation-grid-header')
    ).evaluate(el => {
      const rect = el?.getBoundingClientRect();
      return rect && { x: rect.x, y: rect.y + rect.height / 2, width: rect.width };
    });
    assert.ok(header);
    const frame = await (await frontend.frameElement())?.boundingBox();
    assert.ok(frame);
    const y = frame.y + header.y;
    await page.mouse.move(frame.x + header.x + 20, y);
    await page.mouse.down();
    await page.mouse.move(frame.x + header.x + header.width / 2, y, { steps: 5 });
    await page.mouse.up();
    return await waitFor(async () => {
      const value = await page.evaluate(top);
      return value > 100 ? value : null;
    });
  } finally {
    await page.evaluate(remove);
  }
}

test(
  'the Animations panel shows a scroll-driven animation by scroll position, and scrolls with its scrubber',
  { skip },
  async () => {
    const top = await scrubScrollDriven(
      () => {
        const scroller = document.body.appendChild(document.createElement('div'));
        scroller.id = 'rf-scroller';
        scroller.style.cssText = 'height: 100px; overflow: scroll';
        scroller.innerHTML =
          '<style>@keyframes rf-fade { to { opacity: 0.5 } } #rf-scrolled { height: 1000px; animation: rf-fade linear; animation-timeline: scroll(nearest) }</style><div id="rf-scrolled"></div>';
      },
      () => document.getElementById('rf-scroller')?.scrollTop ?? 0,
      () => document.getElementById('rf-scroller')?.remove()
    );
    assert.ok(top < 900, `scrolled to ${top}px`);
  }
);

test('the Animations panel scrolls the page with the scrubber of a scroll(root) animation', { skip }, async () => {
  // The panel is told the document is the scroller (as Chrome tells it), and scrolls it through
  // DOM.resolveNode and Runtime.callFunctionOn on the document node.
  const top = await scrubScrollDriven(
    () => {
      const style = document.head.appendChild(document.createElement('style'));
      style.id = 'rf-root-style';
      style.textContent =
        'html { height: 3000px } @keyframes rf-root { to { opacity: 0.5 } } #rf-root { animation: rf-root linear; animation-timeline: scroll(root) }';
      document.body.appendChild(document.createElement('div')).id = 'rf-root';
    },
    () => document.scrollingElement?.scrollTop ?? 0,
    () => {
      document.getElementById('rf-root-style')?.remove();
      document.getElementById('rf-root')?.remove();
      document.scrollingElement?.scrollTo(0, 0);
    }
  );
  assert.ok(top < 3000, `scrolled to ${top}px`);
});
