// devtools-anywhere's own style sheets and element scans in every tree of the page (inject.ts), and
// the media rewrites the emulation reports to its stable API. Nothing of these is in CDP, so there
// is no Chrome to compare with: they run against the test bundle (dist-test/), which exposes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launch, setUpAndTearDown, type Env } from '../../../../test-support/conformance.ts';

let env: Env | undefined;

setUpAndTearDown(
  async () => {
    env = await launch();
  },
  () => env?.close()
);

/** A page with the test bundle, a paragraph, a shadow root with a span, and a same-origin iframe. */
async function open(): Promise<Page> {
  assert.ok(env);
  const page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await page.addScriptTag({ url: env.baseUrl + '/packages/devtools-anywhere/dist-test/devtools-anywhere.iife.js' });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p id="p">p</p><div id="host"></div><iframe id="f" srcdoc="<p id=fp>fp</p>"></iframe>'
    );
    const root = document.getElementById('host')?.attachShadow({ mode: 'open' });
    if (root) root.innerHTML = '<span id="s">s</span>';
    window.__session = window.DevtoolsAnywhere.createCdpSession();
    window.__session.onMessage(() => {});
  });
  await loaded(page, 'f');
  return page;
}

/** Waits until the iframe `id` shows its document: its srcdoc, which loads after the iframe is made. */
const loaded = (page: Page, id: string) =>
  page.evaluate(
    id =>
      new Promise<void>(resolve => {
        const frame = document.getElementById(id) as HTMLIFrameElement | null;
        if (frame?.contentDocument?.body?.firstElementChild) resolve();
        else frame?.addEventListener('load', () => resolve(), { once: true });
      }),
    id
  );

/** The colours of the paragraph, the span and the iframe's paragraph, as the page computes them. */
const colours = (page: Page) =>
  page.evaluate(() => {
    const frame = document.getElementById('f') as HTMLIFrameElement | null;
    const framed = frame?.contentDocument?.getElementById('fp');
    return {
      p: getComputedStyle(document.getElementById('p') ?? document.body).color,
      span: getComputedStyle(document.getElementById('host')?.shadowRoot?.getElementById('s') ?? document.body).color,
      framed: framed && frame?.contentWindow ? frame.contentWindow.getComputedStyle(framed).color : null,
    };
  });

test('an injected style applies to every tree, and the page sees no sheet of ours', async () => {
  const page = await open();
  try {
    const adopted = () =>
      page.evaluate(() => [
        document.adoptedStyleSheets.length,
        document.getElementById('host')?.shadowRoot?.adoptedStyleSheets.length ?? -1,
      ]);
    const before = await adopted();
    const plain = await colours(page);
    await page.evaluate(() =>
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle(
        'own',
        'p { color: rgb(1, 2, 3) } span { color: rgb(4, 5, 6) }'
      )
    );
    assert.deepEqual(await adopted(), before);
    const seen = await colours(page);
    assert.equal(seen.p, 'rgb(1, 2, 3)');
    assert.equal(seen.span, 'rgb(4, 5, 6)');
    assert.equal(seen.framed, 'rgb(1, 2, 3)');
    await page.evaluate(() => window.__devtoolsAnywhereTest.emulation.injectOwnStyle('own', null));
    assert.deepEqual(await colours(page), plain);
    assert.deepEqual(await adopted(), before);
  } finally {
    await page.close();
  }
});

test('a page wrapping adoptedStyleSheets after the injection does not see the sheet of ours', async () => {
  const page = await open();
  try {
    const before = await page.evaluate(() => document.adoptedStyleSheets.length);
    await page.evaluate(() =>
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle('own', 'p { color: rgb(1, 2, 3) }')
    );
    // The page wraps the accessors of its documents; the wrapper records the arrays it returns or is given.
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
      const get = descriptor?.get;
      const set = descriptor?.set;
      if (!descriptor || !get || !set) throw new Error('no accessors');
      const seen: number[] = [];
      Reflect.set(window, 'seen', seen);
      Object.defineProperty(Document.prototype, 'adoptedStyleSheets', {
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
        get(this: Document) {
          const value: unknown = get.call(this);
          if (Array.isArray(value)) seen.push(value.length);
          return value;
        },
        set(this: Document, value: CSSStyleSheet[]) {
          set.call(this, value);
        },
      });
    });
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), before);
    await page.evaluate(() =>
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle('own', 'p { color: rgb(4, 5, 6) }')
    );
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), before);
    const seen = await page.evaluate(() => Reflect.get(window, 'seen') as number[]);
    assert.deepEqual(
      seen.filter(n => n !== before),
      [],
      'the wrapper saw the sheet of ours'
    );
  } finally {
    await page.close();
  }
});

test('an injected style is not listed among the CSS domain sheets, and follows the trees that come later', async () => {
  const page = await open();
  try {
    // The sheets the CSS domain reports, counted with and without the injected one.
    const reported = () =>
      page.evaluate(async () => {
        let count = 0;
        const listen = (msg: string) => {
          if (JSON.parse(msg).method === 'CSS.styleSheetAdded') count++;
        };
        const session = window.DevtoolsAnywhere.createCdpSession();
        session.onMessage(listen);
        await session.call('CSS.enable', {});
        await session.call('CSS.disable', {});
        return count;
      });
    const without = await reported();
    assert.ok(without > 0, 'the page has sheets to count');
    await page.evaluate(() =>
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle('own', 'p { color: rgb(1, 2, 3) }')
    );
    assert.equal(await reported(), without);
    // A shadow root and an iframe that come after the injection get it too.
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'late';
      document.body.append(host);
      host.attachShadow({ mode: 'open' }).innerHTML = '<p id="lp">lp</p>';
      document.body.insertAdjacentHTML('beforeend', '<iframe id="g" srcdoc="<p id=gp>gp</p>"></iframe>');
    });
    await loaded(page, 'g');
    const late = await page.evaluate(() => {
      const frame = document.getElementById('g') as HTMLIFrameElement | null;
      const gp = frame?.contentDocument?.getElementById('gp');
      return {
        shadow: getComputedStyle(document.getElementById('late')?.shadowRoot?.getElementById('lp') ?? document.body)
          .color,
        framed: gp && frame?.contentWindow ? frame.contentWindow.getComputedStyle(gp).color : null,
      };
    });
    assert.deepEqual(late, { shadow: 'rgb(1, 2, 3)', framed: 'rgb(1, 2, 3)' });
  } finally {
    await page.close();
  }
});

test('an injected style is taken back out of a shadow root that leaves the page, and put back when it returns', async () => {
  const page = await open();
  try {
    await page.evaluate(() => Reflect.set(window, 'host', document.getElementById('host')));
    // The sheets the host's shadow root adopts, as they are: read below the page's view, which hides ours.
    const adopted = () =>
      page.evaluate(() => {
        const host: unknown = Reflect.get(window, 'host');
        const get = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets')?.get;
        if (!(host instanceof HTMLElement) || !host.shadowRoot || !get) return -1;
        return get.call(host.shadowRoot).length;
      });
    assert.equal(await adopted(), 0);
    await page.evaluate(() =>
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle('own', 'span { color: rgb(1, 2, 3) }')
    );
    assert.equal(await adopted(), 1);
    await page.evaluate(() => {
      const host: unknown = Reflect.get(window, 'host');
      if (host instanceof HTMLElement) host.remove();
      // Any change of the injection brings the trees up to date: the host's shadow root is let go of.
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle('other', 'p { color: rgb(9, 9, 9) }');
      window.__devtoolsAnywhereTest.emulation.injectOwnStyle('other', null);
    });
    assert.equal(await adopted(), 0);
    // Back in the page, while the injection is still there: the shadow root has it once more.
    await page.evaluate(() => {
      const host: unknown = Reflect.get(window, 'host');
      if (host instanceof HTMLElement) document.body.append(host);
    });
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
    assert.equal(await adopted(), 1);
    await page.evaluate(() => window.__devtoolsAnywhereTest.emulation.injectOwnStyle('own', null));
    assert.equal(await adopted(), 0);
  } finally {
    await page.close();
  }
});

test('a scan visits the elements of every tree, then those added, until it is stopped', async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'scanned', []);
      window.__devtoolsAnywhereTest.emulation.scanElements('ids', el => {
        const seen: string[] = Reflect.get(window, 'scanned');
        seen.push(el.id);
      });
    });
    const scanned = () => page.evaluate(() => [...(Reflect.get(window, 'scanned') as string[])]);
    // Each element once: those there when the scan starts, in every tree, the shadow root's and the iframe's too.
    const first = await scanned();
    for (const id of ['p', 'host', 's', 'fp']) assert.equal(first.filter(x => x === id).length, 1, `${id} in ${first}`);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<i id="added">added</i>');
    });
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
    assert.equal((await scanned()).filter(x => x === 'added').length, 1);
    await page.evaluate(() => window.__devtoolsAnywhereTest.emulation.scanElements('ids', null));
    await page.evaluate(() => {
      Reflect.set(window, 'scanned', []);
      document.body.insertAdjacentHTML('beforeend', '<i id="after-stop">after</i>');
    });
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
    assert.deepEqual(await scanned(), []);
  } finally {
    await page.close();
  }
});

test('the emulation reports its media rewrite to the stable API, as it is set and cleared', async () => {
  const page = await open();
  try {
    const state = () =>
      page.evaluate(() => {
        const rewrite = window.__devtoolsAnywhereTest.emulation.currentMediaRewrite();
        return rewrite ? [rewrite('print'), rewrite('screen')] : null;
      });
    let told = 0;
    await page.evaluate(() => {
      Reflect.set(window, 'told', 0);
      window.__devtoolsAnywhereTest.emulation.onMediaRewriteChange(() =>
        Reflect.set(window, 'told', Reflect.get(window, 'told') + 1)
      );
    });
    assert.equal(await state(), null);
    await page.evaluate(() => window.__session?.call('Emulation.setEmulatedMedia', { media: 'print' }));
    told++;
    const [print, screen] = (await state()) ?? [];
    assert.equal(print, 'all');
    assert.notEqual(screen, 'screen');
    await page.evaluate(() => window.__session?.call('Emulation.setEmulatedMedia', { media: '' }));
    told++;
    assert.equal(await state(), null);
    assert.equal(await page.evaluate(() => Reflect.get(window, 'told')), told);
  } finally {
    await page.close();
  }
});
