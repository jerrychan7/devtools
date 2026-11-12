// The page's wrappers of the element's attribute methods, and the page guards that put back what the emulation
// rewrote. Only the copy test runs its scenario on both Chrome and us, as emulation.conformance does; the others
// check our side against what the page should see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openPage, setUpAndTearDown } from '../../../../test-support/conformance.ts';
import type { Env, Side, TestPage } from '../../../../test-support/conformance.ts';

let env: Env | undefined;
let t: TestPage;

setUpAndTearDown(
  async () => {
    env = await launch();
    t = await openPage(env, []);
  },
  () => env?.close()
);

/** What each side gives for `run`, run on each in turn: the two must give the same. */
async function sameOnBoth<T>(run: (side: Side) => Promise<T>): Promise<T> {
  const results: T[] = [];
  for (const side of [t.chrome, t.ours]) results.push(await run(side));
  const [chrome, ours] = results;
  assert.deepEqual(ours, chrome);
  return chrome as T;
}

const settle = () => t.page.evaluate(() => new Promise(r => setTimeout(r)));

/**
 * Polls `read` until it gives `expected`, or gives up after a few seconds with what it last read: the
 * browser applies a change of the emulation a little after the page's task.
 */
async function until<T>(read: () => Promise<T>, expected: T, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value === expected || Date.now() - start > timeout) return value;
    await new Promise(r => setTimeout(r, 20));
  }
}

test("a page wrapping the element's getAttribute and setAttribute does not see the emulation's writes", async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="wrp" style="padding-top: env(safe-area-inset-top, 7px)">wrp</div>'
    )
  );
  // The page wraps both methods after the agent has taken its own: the calls made on #wrp are recorded.
  await t.page.evaluate(() => {
    const seen: string[] = [];
    const names = ['getAttribute', 'setAttribute'] as const;
    const originals = names.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    Reflect.set(window, 'wrapped', { seen, originals });
    names.forEach((name, i) => {
      const native: unknown = originals[i]?.value;
      if (typeof native !== 'function') throw new Error(`no ${name}`);
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value(this: Element, ...args: unknown[]) {
          if (this.id === 'wrp') seen.push(`${name} ${args.join(' ')}`);
          return Reflect.apply(native, this, args);
        },
      });
    });
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    const padding = await t.page.evaluate(
      () => getComputedStyle(document.getElementById('wrp') ?? document.body).paddingTop
    );
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    const seen = await t.page.evaluate(() => (Reflect.get(window, 'wrapped') as { seen: string[] }).seen);
    assert.equal(padding, '5px');
    assert.deepEqual(seen, []);
  } finally {
    await t.page.evaluate(() => {
      const { originals } = Reflect.get(window, 'wrapped') as { originals: (PropertyDescriptor | undefined)[] };
      ['getAttribute', 'setAttribute'].forEach((name, i) => {
        const descriptor = originals[i];
        if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      });
      document.getElementById('wrp')?.remove();
    });
  }
});

test("a page wrapping the element's getAttribute and setAttribute does not see the copy of a rewritten element", async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="cpy" style="padding-top: env(safe-area-inset-top, 7px)">cpy</div>'
    )
  );
  // Wrapped after the agent has taken its natives: the calls made on the copy of #cpy are recorded.
  await t.page.evaluate(() => {
    const seen: string[] = [];
    const names = ['getAttribute', 'setAttribute'] as const;
    const originals = names.map(name => Object.getOwnPropertyDescriptor(Element.prototype, name));
    Reflect.set(window, 'copied', { seen, originals });
    names.forEach((name, i) => {
      const native: unknown = originals[i]?.value;
      if (typeof native !== 'function') throw new Error(`no ${name}`);
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value(this: Element, ...args: unknown[]) {
          if (this.id === 'cpy') seen.push(`${name} ${args.join(' ')}`);
          return Reflect.apply(native, this, args);
        },
      });
    });
  });
  try {
    // DOM.getOuterHTML of a rewritten element copies it, with the attributes the page gave (shownCopy). The page
    // reads 5px first, so that the element is rewritten: without that, the copy would have nothing to show.
    const r = await sameOnBoth(async side => {
      await side.send('DOM.enable');
      const { root } = await side.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await side.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#cpy' });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
      await settle();
      const padding = await t.page.evaluate(
        () => getComputedStyle(document.getElementById('cpy') ?? document.body).paddingTop
      );
      const { outerHTML } = await side.send('DOM.getOuterHTML', { nodeId });
      await side.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
      await side.send('DOM.disable');
      return { padding, outerHTML };
    });
    assert.equal(r.padding, '5px');
    assert.match(r.outerHTML, /style="padding-top: env\(safe-area-inset-top, 7px\)"/);
    const seen = await t.page.evaluate(() => (Reflect.get(window, 'copied') as { seen: string[] }).seen);
    assert.deepEqual(seen, []);
  } finally {
    await t.page.evaluate(() => {
      const { originals } = Reflect.get(window, 'copied') as { originals: (PropertyDescriptor | undefined)[] };
      ['getAttribute', 'setAttribute'].forEach((name, i) => {
        const descriptor = originals[i];
        if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      });
      document.getElementById('cpy')?.remove();
    });
  }
});

test('a page guard that puts back the style it had does not loop with the emulation', async () => {
  await t.page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="grd" style="padding-top: env(safe-area-inset-top, 7px)">grd</div>'
    )
  );
  // The guard: a mutation observer that puts the original style back whenever the page changes it. Chrome
  // never changes the attribute, so the guard never answers there.
  await t.page.evaluate(() => {
    const el = document.getElementById('grd');
    if (!el) throw new Error('no guard element');
    const original = el.getAttribute('style') ?? '';
    const state = { fires: 0 };
    const observer = new MutationObserver(() => {
      if (el.getAttribute('style') === original) return;
      state.fires++;
      // Stops answering at 200: a loop then ends, and the count fails the test instead of hanging the page.
      if (state.fires <= 200) el.setAttribute('style', original);
    });
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'guard', { observer, state });
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    // Frames keep coming while the guard runs (the page is not held in a loop), and the guard is answered
    // a few times, not once for each frame or more.
    const { fires, frames } = await t.page.evaluate(
      () =>
        new Promise<{ fires: number; frames: number }>(resolve => {
          const guard = Reflect.get(window, 'guard') as { state: { fires: number } };
          const start = performance.now();
          let frames = 0;
          const frame = () => {
            frames++;
            if (performance.now() - start < 500) requestAnimationFrame(frame);
            else resolve({ fires: guard.state.fires, frames });
          };
          requestAnimationFrame(frame);
        })
    );
    assert.ok(frames > 3, `${frames} frames in half a second`);
    assert.ok(fires <= 10, `${fires} answers to the guard`);
    // Once the guard lets go, the emulation rewrites the element again (the last wait may be 64 frames).
    await t.page.evaluate(() => (Reflect.get(window, 'guard') as { observer: MutationObserver }).observer.disconnect());
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('grd') ?? document.body).paddingTop),
      '5px',
      8000
    );
    assert.equal(padding, '5px');
  } finally {
    // The page first, and the emulation reset whatever happens there: the guard and its element must not outlive the test.
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'guard') as { observer: MutationObserver }).observer.disconnect();
        document.getElementById('grd')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page guard that puts back the style of a <style> element does not loop with the emulation', async () => {
  // A <style> with a style attribute of its own: a sheet owner, whose style changes are no sheet changes.
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'gst';
    style.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)');
    style.textContent = '#em { color: rgb(1, 0, 0) }';
    document.head.append(style);
    const original = style.getAttribute('style') ?? '';
    const state = { fires: 0 };
    const observer = new MutationObserver(() => {
      if (style.getAttribute('style') === original) return;
      state.fires++;
      // Stops answering at 200, as the guard above does.
      if (state.fires <= 200) style.setAttribute('style', original);
    });
    observer.observe(style, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'styleGuard', { observer, state });
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await t.page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    const fires = await t.page.evaluate(
      () => (Reflect.get(window, 'styleGuard') as { state: { fires: number } }).state.fires
    );
    assert.ok(fires <= 10, `${fires} answers to the guard`);
    await t.page.evaluate(() =>
      (Reflect.get(window, 'styleGuard') as { observer: MutationObserver }).observer.disconnect()
    );
    // The page's style attribute reads the var() form now, so the padding is what the inset gives.
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('gst') ?? document.body).paddingTop),
      '5px',
      8000
    );
    assert.equal(padding, '5px');
    const style = await t.page.evaluate(() => document.getElementById('gst')?.getAttribute('style') ?? null);
    assert.notEqual(style, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'styleGuard') as { observer: MutationObserver }).observer.disconnect();
        document.getElementById('gst')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a guard that also answers each rewrite with a sheet attribute does not loop with the emulation', async () => {
  // The guard above, on a <style> with a media of its own: each answer changes the sheet too, so it reaches
  // the emulation as a change of the sheet, not only of the style.
  await t.page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'gsm';
    style.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)');
    style.setAttribute('media', 'all');
    style.textContent = '#em { color: rgb(1, 0, 0) }';
    document.head.append(style);
    const original = style.getAttribute('style') ?? '';
    const state = { fires: 0 };
    const observer = new MutationObserver(() => {
      if (style.getAttribute('style') === original && style.getAttribute('media') === 'all') return;
      state.fires++;
      // Stops answering at 200, as the guard above does.
      if (state.fires <= 200) {
        style.setAttribute('style', original);
        style.setAttribute('media', 'all');
      }
    });
    observer.observe(style, { attributes: true, attributeFilter: ['style', 'media'] });
    Reflect.set(window, 'sheetGuard', { observer, state });
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await t.page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    const fires = await t.page.evaluate(
      () => (Reflect.get(window, 'sheetGuard') as { state: { fires: number } }).state.fires
    );
    assert.ok(fires <= 10, `${fires} answers to the guard`);
    await t.page.evaluate(() =>
      (Reflect.get(window, 'sheetGuard') as { observer: MutationObserver }).observer.disconnect()
    );
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('gsm') ?? document.body).paddingTop),
      '5px',
      8000
    );
    assert.equal(padding, '5px');
    const style = await t.page.evaluate(() => document.getElementById('gsm')?.getAttribute('style') ?? null);
    assert.notEqual(style, 'padding-top: env(safe-area-inset-top, 7px)');
  } finally {
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'sheetGuard') as { observer: MutationObserver }).observer.disconnect();
        document.getElementById('gsm')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page that clears its style and puts back a value with env() in each new task is backed off', async () => {
  // The guard answers each rewrite in a task of its own, as the test below does, but in two steps: it clears the
  // style, which drops our record of the rewrite, and then puts the value with env() back. Each put-back is a
  // revert all the same, although the emulation has no record of the rewrite to compare it with.
  const FIXED = 'padding-top: env(safe-area-inset-top, 9px)';
  await t.page.evaluate(fixed => {
    const el = document.createElement('div');
    el.id = 'clr';
    el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)');
    el.textContent = 'clr';
    document.body.append(el);
    const state = { reverts: 0, rewrites: 0 };
    const step = () => {
      // When the emulation has rewritten the value, clears it; when the style is clear, puts the value back. The
      // value the guard put back stands on its own, so the guard does nothing once it is there.
      const style = el.getAttribute('style');
      if (style === fixed) return;
      if (style) el.setAttribute('style', '');
      else {
        state.reverts++;
        el.setAttribute('style', fixed);
      }
    };
    // Each step is a timer set from a timer, so that it runs after the emulation's turn: an answer in the turn is
    // the case of the guard tests above, which this one is not.
    const guard = new MutationObserver(() => setTimeout(() => setTimeout(step, 0), 0));
    guard.observe(el, { attributes: true, attributeFilter: ['style'] });
    // The emulation's writes replace the value the guard put back, and are the changes from it to a value: its
    // clears are changes to nothing, which are not counted.
    const counter = new MutationObserver(records => {
      for (const record of records) if (record.oldValue === fixed && el.getAttribute('style')) state.rewrites++;
    });
    counter.observe(el, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    Reflect.set(window, 'clearGuard', { guard, counter, state });
  }, FIXED);
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    // Frames keep coming while the guard answers, and the emulation's rewrites stay few in a second.
    const frames = await t.page.evaluate(
      () =>
        new Promise<number>(resolve => {
          const start = performance.now();
          let frames = 0;
          const frame = () => {
            frames++;
            if (performance.now() - start < 1000) requestAnimationFrame(frame);
            else resolve(frames);
          };
          requestAnimationFrame(frame);
        })
    );
    const { reverts, rewrites } = await t.page.evaluate(
      () => (Reflect.get(window, 'clearGuard') as { state: { reverts: number; rewrites: number } }).state
    );
    assert.ok(frames > 3, `${frames} frames in a second`);
    assert.ok(rewrites <= 15, `${rewrites} rewrites of the emulation, answered ${reverts} times, in a second`);
    // Once the guard lets go, the page puts the value back once more, and the emulation rewrites it.
    await t.page.evaluate(fixed => {
      const { guard, counter } = Reflect.get(window, 'clearGuard') as {
        guard: MutationObserver;
        counter: MutationObserver;
      };
      guard.disconnect();
      counter.disconnect();
      document.getElementById('clr')?.setAttribute('style', fixed);
    }, FIXED);
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('clr') ?? document.body).paddingTop),
      '5px',
      8000
    );
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => {
        const { guard, counter } = Reflect.get(window, 'clearGuard') as {
          guard: MutationObserver;
          counter: MutationObserver;
        };
        guard.disconnect();
        counter.disconnect();
        document.getElementById('clr')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page guard that puts back a value with env() in each new task is backed off', async () => {
  // The guard answers each rewrite in a task of its own: a timer its observer sets. What it puts back is not the
  // text the page started with, and still has env(), so the emulation rewrites it again each time: unpaced, the
  // answers would never end.
  const FIXED = 'padding-top: env(safe-area-inset-top, 9px)';
  await t.page.evaluate(fixed => {
    const el = document.createElement('div');
    el.id = 'tsk';
    el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)');
    el.textContent = 'tsk';
    document.body.append(el);
    const state = { reverts: 0, rewrites: 0 };
    const guard = new MutationObserver(() =>
      setTimeout(() => {
        if (el.getAttribute('style') === fixed) return;
        state.reverts++;
        el.setAttribute('style', fixed);
      }, 0)
    );
    guard.observe(el, { attributes: true, attributeFilter: ['style'] });
    // The emulation's writes are the changes that replace the guard's text: they report it as their old value.
    const counter = new MutationObserver(records => {
      for (const record of records) if (record.oldValue === fixed) state.rewrites++;
    });
    counter.observe(el, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    Reflect.set(window, 'taskGuard', { guard, counter, state });
  }, FIXED);
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    // Frames keep coming while the guard answers, and the emulation's rewrites stay few in a second: the window
    // is long enough for the frame rate to matter little (at 30 Hz, a rewrite per frame would already be 30).
    const frames = await t.page.evaluate(
      () =>
        new Promise<number>(resolve => {
          const start = performance.now();
          let frames = 0;
          const frame = () => {
            frames++;
            if (performance.now() - start < 1000) requestAnimationFrame(frame);
            else resolve(frames);
          };
          requestAnimationFrame(frame);
        })
    );
    const { reverts, rewrites } = await t.page.evaluate(
      () => (Reflect.get(window, 'taskGuard') as { state: { reverts: number; rewrites: number } }).state
    );
    assert.ok(frames > 3, `${frames} frames in a second`);
    assert.ok(rewrites <= 15, `${rewrites} rewrites of the emulation, answered ${reverts} times, in a second`);
    // Once the guard lets go, the emulation rewrites the element again (the last wait may be 64 frames).
    await t.page.evaluate(() => {
      const { guard, counter } = Reflect.get(window, 'taskGuard') as {
        guard: MutationObserver;
        counter: MutationObserver;
      };
      guard.disconnect();
      counter.disconnect();
    });
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('tsk') ?? document.body).paddingTop),
      '5px',
      8000
    );
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => {
        const { guard, counter } = Reflect.get(window, 'taskGuard') as {
          guard: MutationObserver;
          counter: MutationObserver;
        };
        guard.disconnect();
        counter.disconnect();
        document.getElementById('tsk')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page guard that puts back the original value in each new task is backed off', async () => {
  // The guard above, but it puts back the text the page started with, which the emulation takes for its original.
  // The rewrites stay few, as for the other guards, and the element follows once the guard lets go.
  const ORIGINAL = 'padding-top: env(safe-area-inset-top, 7px)';
  await t.page.evaluate(original => {
    const el = document.createElement('div');
    el.id = 'tso';
    el.setAttribute('style', original);
    el.textContent = 'tso';
    document.body.append(el);
    const state = { reverts: 0, rewrites: 0 };
    const guard = new MutationObserver(() =>
      setTimeout(() => {
        if (el.getAttribute('style') === original) return;
        state.reverts++;
        el.setAttribute('style', original);
      }, 0)
    );
    guard.observe(el, { attributes: true, attributeFilter: ['style'] });
    // The emulation's writes are the changes that replace the guard's text: they report it as their old value.
    const counter = new MutationObserver(records => {
      for (const record of records) if (record.oldValue === original) state.rewrites++;
    });
    counter.observe(el, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    Reflect.set(window, 'originalGuard', { guard, counter, state });
  }, ORIGINAL);
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    // Frames keep coming while the guard answers, and the emulation's rewrites stay few in a second.
    const frames = await t.page.evaluate(
      () =>
        new Promise<number>(resolve => {
          const start = performance.now();
          let frames = 0;
          const frame = () => {
            frames++;
            if (performance.now() - start < 1000) requestAnimationFrame(frame);
            else resolve(frames);
          };
          requestAnimationFrame(frame);
        })
    );
    const { reverts, rewrites } = await t.page.evaluate(
      () => (Reflect.get(window, 'originalGuard') as { state: { reverts: number; rewrites: number } }).state
    );
    assert.ok(frames > 3, `${frames} frames in a second`);
    assert.ok(rewrites <= 15, `${rewrites} rewrites of the emulation, answered ${reverts} times, in a second`);
    assert.ok(reverts > 3, `${reverts} put-backs of the guard in a second: it did not answer`);
    // Once the guard lets go, the emulation rewrites the element again (the last wait may be 64 frames).
    await t.page.evaluate(() => {
      const { guard, counter } = Reflect.get(window, 'originalGuard') as {
        guard: MutationObserver;
        counter: MutationObserver;
      };
      guard.disconnect();
      counter.disconnect();
    });
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('tso') ?? document.body).paddingTop),
      '5px',
      8000
    );
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => {
        const { guard, counter } = Reflect.get(window, 'originalGuard') as {
          guard: MutationObserver;
          counter: MutationObserver;
        };
        guard.disconnect();
        counter.disconnect();
        document.getElementById('tso')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

/**
 * The restores a timer guard makes in the first frame after the page changes its element, for one order of the two
 * observers: the guard made before the emulation (its observer is older than the rewrite's), or after it. The guard
 * answers the rewrite in a timer of its own, queued by its observer. A rewrite answered in the turn is held for
 * frames, so one restore falls in that frame; a revert is written at once, so the restores run on in it.
 */
async function restoreBurst(guardFirst: boolean, n: number): Promise<number> {
  const id = `order-${n}`;
  const ORIGINAL = 'padding-top: env(safe-area-inset-top, 7px)';
  const FIXED = 'padding-top: env(safe-area-inset-top, 9px)';
  const guard = (id: string, fixed: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error('no element');
    const state = { armed: false, frames: [] as number[] };
    const observer = new MutationObserver(() =>
      setTimeout(() => {
        if (!state.armed || el.getAttribute('style') === fixed) return;
        state.frames.push(Reflect.get(window, 'pacingFrames') as number);
        el.setAttribute('style', fixed);
      }, 0)
    );
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'orderGuard', { observer, state });
  };
  try {
    // Counts the frames the page runs, until the test stops this loop: a loop of an earlier call of the test then ends
    // at its next frame, whatever the calls in between (each loop has a number of its own).
    await t.page.evaluate(() => {
      const loop = ((Reflect.get(window, 'pacingLoops') as number | undefined) ?? 0) + 1;
      Reflect.set(window, 'pacingLoops', loop);
      Reflect.set(window, 'pacingLoop', loop);
      Reflect.set(window, 'pacingFrames', 0);
      const frame = () => {
        if (Reflect.get(window, 'pacingLoop') !== loop) return;
        Reflect.set(window, 'pacingFrames', (Reflect.get(window, 'pacingFrames') as number) + 1);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await t.page.evaluate(
      (id: string, original: string) => {
        const el = document.createElement('div');
        el.id = id;
        el.setAttribute('style', original);
        el.textContent = id;
        document.body.append(el);
      },
      id,
      ORIGINAL
    );
    if (guardFirst) await t.page.evaluate(guard, id, FIXED);
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    if (!guardFirst) await t.page.evaluate(guard, id, FIXED);
    // The rewrite of the emulation's own write settles before the page's change: the guard is armed for that one.
    await new Promise(resolve => setTimeout(resolve, 100));
    const framesBefore = await t.page.evaluate(() => Reflect.get(window, 'pacingFrames') as number);
    await t.page.evaluate(
      (id: string, original: string) => {
        const { state } = Reflect.get(window, 'orderGuard') as { state: { armed: boolean } };
        state.armed = true;
        document.getElementById(id)?.setAttribute('style', original);
      },
      id,
      ORIGINAL
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    const { frames, framesAfter } = await t.page.evaluate(() => ({
      frames: (Reflect.get(window, 'orderGuard') as { state: { frames: number[] } }).state.frames.slice(),
      framesAfter: Reflect.get(window, 'pacingFrames') as number,
    }));
    // Held answers wait for frames: a page that runs none would show nothing of them.
    assert.ok(framesAfter - framesBefore >= 3, `${framesAfter - framesBefore} frames in 300 ms`);
    assert.ok(frames.length >= 2, `${frames.length} restores of the guard`);
    let burst = 1;
    while (burst < frames.length && frames[burst] === frames[0]) burst++;
    return burst;
  } finally {
    await t.page.evaluate(id => {
      (Reflect.get(window, 'orderGuard') as { observer?: MutationObserver } | undefined)?.observer?.disconnect();
      document.getElementById(id)?.remove();
      Reflect.set(window, 'pacingLoop', 0);
    }, id);
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  }
}

test("a timer guard's restores are answers in the turn of the rewrite, whichever observer was made first", async () => {
  // Answers are held (the next write comes a frame or more later), so one restore falls in the first frame; a revert
  // is written at once, and the restores run on in it. Both orders must give the answer.
  const older = await restoreBurst(true, 1);
  const newer = await restoreBurst(false, 2);
  assert.equal(older, 1, 'the restores in the first frame with the guard made first');
  assert.equal(newer, 1, 'the restores in the first frame with the emulation made first');
});

test('a timer guard that puts back another spelling of a value the emulation rewrites is backed off', async () => {
  // The guard's text has no light and dark in it, so the rewrite leaves it alone; the rewrite then writes the value
  // back in its own spelling, and the guard puts its spelling back, in a timer of its own, again and again.
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'spelling';
    el.setAttribute('style', 'color-scheme: light dark');
    el.textContent = 'spelling';
    document.body.append(el);
    const state = { restores: 0 };
    const guard = new MutationObserver(() =>
      setTimeout(() => {
        if (el.getAttribute('style') === 'color-scheme:dark') return;
        state.restores++;
        el.setAttribute('style', 'color-scheme:dark');
      }, 0)
    );
    guard.observe(el, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'spellingGuard', { guard, state });
  });
  try {
    await t.ours.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const restores = await t.page.evaluate(
      () => (Reflect.get(window, 'spellingGuard') as { state: { restores: number } }).state.restores
    );
    // One restore is the page's answer to the emulation's write, and the rewrite does not write the spelling again.
    assert.equal(restores, 1, `${restores} restores in a second`);
    await t.page.evaluate(() =>
      (Reflect.get(window, 'spellingGuard') as { guard: MutationObserver }).guard.disconnect()
    );
    const scheme = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('spelling') ?? document.body).colorScheme),
      'dark',
      8000
    );
    assert.equal(scheme, 'dark');
  } finally {
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'spellingGuard') as { guard: MutationObserver }).guard.disconnect();
        document.getElementById('spelling')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setEmulatedMedia', {});
    }
  }
});

test('a page edit of other declarations in a rewritten style attribute is not written again', async () => {
  // A CSSOM edit makes the browser write the attribute back in its own serialization: the same declarations as the
  // rewrite would write, in another text. Nothing changes in the values, so the rewrite writes nothing, and the
  // edit is no revert that backs the rewrites off.
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'edits';
    el.setAttribute('style', 'padding-top: env(safe-area-inset-top, 7px)');
    el.textContent = 'edits';
    document.body.append(el);
    const state = { records: 0 };
    const counter = new MutationObserver(records => {
      state.records += records.length;
    });
    counter.observe(el, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'editCounter', { counter, state });
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await new Promise(resolve => setTimeout(resolve, 100));
    await t.page.evaluate(() => {
      (Reflect.get(window, 'editCounter') as { state: { records: number } }).state.records = 0;
    });
    const EDITS = 8;
    for (let i = 1; i <= EDITS; i++) {
      // Each edit is a task of its own, as a page's animation frame is.
      await t.page.evaluate(i => {
        document.getElementById('edits')?.style.setProperty('transform', `translate(${i}px)`);
      }, i);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    const records = await t.page.evaluate(
      () => (Reflect.get(window, 'editCounter') as { state: { records: number } }).state.records
    );
    // Each edit is one record of the page's; a write of the emulation's would add one more.
    assert.equal(records, EDITS, `${records} records of the attribute for ${EDITS} edits`);
    // And the rewrite still applies: the inset is 5px, not the 7px the env() falls back to.
    const padding = await t.page.evaluate(
      () => getComputedStyle(document.getElementById('edits') ?? document.body).paddingTop
    );
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'editCounter') as { counter: MutationObserver }).counter.disconnect();
        document.getElementById('edits')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page that sets back the rewritten text of a pending shorthand with another declaration writes nothing', async () => {
  // A shorthand with an env() followed by a longhand reads as empty in the browser, as its sides have no one value. The
  // page's text with the rewrite in it, and another declaration added (its own spelling, with a semicolon at the end),
  // says what the rewrite says: the values alone do not show it, so the rewrite wrote its text again, a revert each time
  // that backs the rewrites off.
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'pending-edits';
    el.setAttribute('style', 'padding: env(safe-area-inset-top, 7px) 0 0 0; padding-left: 3px');
    el.textContent = 'pending';
    document.body.append(el);
    const state = { records: 0 };
    const counter = new MutationObserver(records => {
      state.records += records.length;
    });
    counter.observe(el, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'pendingCounter', { counter, state });
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await new Promise(resolve => setTimeout(resolve, 100));
    await t.page.evaluate(() => {
      (Reflect.get(window, 'pendingCounter') as { state: { records: number } }).state.records = 0;
    });
    const EDITS = 8;
    for (let i = 1; i <= EDITS; i++) {
      // Each edit is a task of its own, as a page's animation frame is.
      await t.page.evaluate(i => {
        const el = document.getElementById('pending-edits');
        el?.setAttribute('style', `${el.getAttribute('style') ?? ''}; --edit: ${i};`);
      }, i);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    const records = await t.page.evaluate(
      () => (Reflect.get(window, 'pendingCounter') as { state: { records: number } }).state.records
    );
    // Each edit is one record of the page's; a write of the emulation's would add one more.
    assert.equal(records, EDITS, `${records} records of the attribute for ${EDITS} edits`);
    const padding = await t.page.evaluate(
      () => getComputedStyle(document.getElementById('pending-edits') ?? document.body).paddingTop
    );
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'pendingCounter') as { counter: MutationObserver }).counter.disconnect();
        document.getElementById('pending-edits')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page edit through the CSSOM of a rewritten pending shorthand shows the emulated value at the next frame', async () => {
  // The browser writes such a block back with its longhands empty (the shorthand's value is not in it any more), so each
  // edit of another declaration makes the rewrite write the shorthand again. That write answers no put-back of the
  // page's: it must not count as one, or after a few edits the rewrites are held for frames and the padding is the
  // browser's own, without the inset.
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'pending-cssom';
    el.setAttribute('style', 'padding: env(safe-area-inset-top, 7px) 0 0 0; padding-left: 3px');
    el.textContent = 'pending';
    document.body.append(el);
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const EDITS = 8;
    for (let i = 1; i < EDITS; i++) {
      // Each edit is a task of its own, as a page's animation frame is.
      await t.page.evaluate(i => {
        document.getElementById('pending-cssom')?.style.setProperty('transform', `translate(${i}px)`);
      }, i);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    // The last edit, with the frame that follows it read before the edit is made: a rewrite held for frames shows then.
    const padding = await t.page.evaluate(i => {
      const el = document.getElementById('pending-cssom');
      const frame = new Promise<string>(resolve =>
        requestAnimationFrame(() => resolve(getComputedStyle(el ?? document.body).paddingTop))
      );
      el?.style.setProperty('transform', `translate(${i}px)`);
      return frame;
    }, EDITS);
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => document.getElementById('pending-cssom')?.remove());
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a page that clears every timer id does not hold the rewrites of its later changes', async () => {
  // The emulation closes the turn of its writes with a timer. A page that clears every timer id, as a guard may do
  // from a microtask after the emulation's write (here, the guard's observer comes after the emulation's), clears
  // that timer too. The turn must end all the same, or the page's later changes are taken for answers in the turn and
  // held for frames, the fallback of env() showing meanwhile.
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'cleared';
    el.setAttribute('style', 'padding-top: 1px');
    el.textContent = 'cleared';
    document.body.append(el);
    const guard = new MutationObserver(() => {
      queueMicrotask(() =>
        queueMicrotask(() => {
          const last = window.setTimeout(() => {}, 0);
          for (let id = 0; id <= last; id++) clearTimeout(id);
        })
      );
    });
    guard.observe(el, { attributes: true, attributeFilter: ['style'] });
    Reflect.set(window, 'clearedGuard', guard);
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    await t.page.evaluate(() => {
      const el = document.getElementById('cleared');
      if (el) el.style.paddingTop = 'env(safe-area-inset-top, 7px)';
    });
    // Longer than a turn can last: the page's next change is not one of the turn's answers.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const padding = await t.page.evaluate(() => {
      const el = document.getElementById('cleared');
      const frame = new Promise<string>(resolve =>
        requestAnimationFrame(() => resolve(getComputedStyle(el ?? document.body).paddingTop))
      );
      if (el) el.style.paddingTop = 'env(safe-area-inset-top, 9px)';
      return frame;
    });
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => {
        (Reflect.get(window, 'clearedGuard') as MutationObserver).disconnect();
        document.getElementById('cleared')?.remove();
      });
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});

test('a shorthand the rewrite changes keeps its rewrite when a longhand after it is set', async () => {
  // The page's text has a shorthand with an env(), and a longhand after it that sets one of its sides. Chrome then reads
  // the shorthand's value as empty, as its longhands no longer share one value, so the values alone do not tell the
  // rewrite that its target differs from the page's text: the declarations as the browser serializes them do.
  await t.page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'shorthand';
    el.setAttribute('style', 'padding: env(safe-area-inset-top, 7px) 0; padding-left: 3px');
    el.textContent = 'shorthand';
    document.body.append(el);
  });
  try {
    await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 5 } });
    const padding = await until(
      () => t.page.evaluate(() => getComputedStyle(document.getElementById('shorthand') ?? document.body).paddingTop),
      '5px',
      3000
    );
    assert.equal(padding, '5px');
  } finally {
    try {
      await t.page.evaluate(() => document.getElementById('shorthand')?.remove());
    } finally {
      await t.ours.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    }
  }
});
