// The single-script setup, and the Service Worker that injects the probe in shell mode.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import type { Protocol } from 'devtools-protocol';
import { launch } from '../support/browser.ts';
import type { Env } from '../support/browser.ts';

let env: Env | undefined;
let page: Page;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/tests/e2e/zero-config.html');
});
after(() => env?.close());

/** Messages the fake frontend received, in or outside shell mode. */
const received = () =>
  page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere[shell]') || document.querySelector('devtools-anywhere');
    if (!el) return [];
    const frontend = el.shadowRoot?.querySelector('iframe')?.contentWindow;
    if (!frontend) throw new Error('no frontend frame');
    return frontend.received || [];
  });
/** The first argument of a Runtime.consoleAPICalled message. */
const firstArg = (m: ReceivedMessage) => {
  const arg = (m.params as Protocol.Runtime.ConsoleAPICalledEvent).args[0];
  assert.ok(arg);
  return arg.value;
};
const logged = (messages: ReceivedMessage[], text: string) =>
  messages.some(m => m.method === 'Runtime.consoleAPICalled' && firstArg(m) === text);

async function waitFor(predicate: () => unknown, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) return;
    } catch {
      // Navigation in progress.
    }
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

test('one script tag captures early output and mounts DevTools after load', async () => {
  await waitFor(async () => logged(await received(), 'zero-config early'));
  const open = await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    return devtools.open;
  });
  assert.equal(open, true);
});

/** The undocked panel's size, in px and as a fraction of the viewport. */
const panelSize = () =>
  page.evaluate(() => {
    const panel = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.panel');
    if (!panel) throw new Error('no panel');
    const { width, height } = panel.getBoundingClientRect();
    return { width, height, widthRatio: width / innerWidth, heightRatio: height / innerHeight };
  });

test('an undocked panel ignores a stored size that is not numbers', async () => {
  await page.evaluate(() => {
    localStorage.setItem('devtools-anywhere:float%', 'null');
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    devtools.setAttribute('dock', 'undocked');
  });
  const size = await panelSize();
  assert.ok(Math.abs(size.widthRatio - 0.8) < 0.01, `width ${size.widthRatio}`);
  assert.ok(Math.abs(size.heightRatio - 0.6) < 0.01, `height ${size.heightRatio}`);
});

test('the undocked panel is resized by touch from its corner', async () => {
  const before = await panelSize();
  const corner = await page.evaluate(() => {
    const el = document.querySelector('devtools-anywhere')?.shadowRoot?.querySelector('.corner');
    if (!el) throw new Error('no corner');
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.touchscreen.touchStart(corner.x, corner.y);
  await page.touchscreen.touchMove(corner.x - 100, corner.y - 50);
  await page.touchscreen.touchEnd();
  const after = await panelSize();
  assert.ok(Math.abs(before.width - after.width - 100) < 2, `width ${before.width} -> ${after.width}`);
  assert.ok(Math.abs(before.height - after.height - 50) < 2, `height ${before.height} -> ${after.height}`);
  await page.evaluate(() => {
    localStorage.removeItem('devtools-anywhere:float%');
    localStorage.removeItem('devtools-anywhere:dock');
    document.querySelector('devtools-anywhere')?.setAttribute('dock', 'bottom');
  });
});

test('in shell mode the Service Worker injects the probe into pages without it', async () => {
  await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    devtools.enterShell();
  });
  await waitFor(() => page.evaluate(() => !!document.querySelector('devtools-anywhere[shell]')));
  await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller));
  await page.evaluate(() => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    pageWindow.location.href = '/tests/e2e/no-probe.html';
  });
  await waitFor(async () => logged(await received(), 'no-probe early'));
});

test('the Service Worker adds headers to requests known from Resource Timing', async () => {
  const find = () =>
    page.evaluate(() => {
      const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
      if (!pageWindow) throw new Error('no page frame');
      const probe = pageWindow.__devtoolsAnywhereProbe__;
      return probe?.requests.find(r => r.url.includes('cross.css?n=sw'));
    });
  await waitFor(async () => (await find())?.responseHeaders?.['content-type']);
  const rec = await find();
  assert.ok(rec);
  assert.equal(rec.type, 'Stylesheet');
  assert.equal(rec.status, 200);
  assert.equal(rec.statusText, 'OK');
  const contentType = rec.responseHeaders?.['content-type'];
  assert.ok(contentType);
  assert.match(contentType, /text\/css/);
  assert.ok(Object.keys(rec.requestHeaders).length, 'request headers');
});

/** Navigates the shell's page frame and waits for the new document to finish loading. */
async function navigatePageFrame(url: string) {
  await page.evaluate(url => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    pageWindow.location.href = url;
  }, url);
  await waitFor(() =>
    page.evaluate(url => {
      const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
      return pageWindow?.location.pathname === url && pageWindow.document.readyState === 'complete';
    }, url)
  );
}

/** The `src` of every script element in the shell's page frame. */
const pageScripts = () =>
  page.evaluate(() => {
    const pageDocument = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentDocument;
    if (!pageDocument) throw new Error('no page frame');
    return [...pageDocument.querySelectorAll('script')].map(s => s.src);
  });

test('the Service Worker injects the probe exactly once into a short page without <head>', async () => {
  await navigatePageFrame('/tests/e2e/no-head.html');
  await waitFor(async () => logged(await received(), 'no-head early'));
  // The probe, inserted once when the response ended (it then loads devtools-anywhere.iife.js).
  const scripts = await pageScripts();
  assert.equal(scripts.filter(src => src.endsWith('/probe.iife.js')).length, 1, scripts.join(', '));
  const messages = await received();
  assert.equal(
    messages.filter(m => m.method === 'Runtime.consoleAPICalled' && firstArg(m) === 'no-head early').length,
    1
  );
});

test('the Service Worker injects after <head> when the page ends right after it', async () => {
  await navigatePageFrame('/tests/e2e/head-only.html');
  const { mode, inHead } = await page.evaluate(() => {
    const pageDocument = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentDocument;
    if (!pageDocument) throw new Error('no page frame');
    const probe = [...pageDocument.scripts].find(s => s.src.endsWith('/probe.iife.js'));
    return { mode: pageDocument.compatMode, inHead: probe?.parentElement === pageDocument.head };
  });
  // Before the doctype, the probe would put the page in quirks mode.
  assert.equal(mode, 'CSS1Compat');
  assert.ok(inHead);
});

test('the Service Worker passes non-HTML responses through unchanged', async () => {
  await navigatePageFrame('/tests/e2e/not-html.json');
  const { contentType, text } = await page.evaluate(() => {
    const pageDocument = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentDocument;
    if (!pageDocument) throw new Error('no page frame');
    // Chrome shows a JSON response as text in a <pre>.
    return { contentType: pageDocument.contentType, text: pageDocument.querySelector('pre')?.textContent };
  });
  assert.equal(contentType, 'application/json');
  assert.equal(text?.trimEnd(), '{ "page": "<head> in a non-HTML response" }');
  assert.deepEqual(await pageScripts(), []);
});

test('the Service Worker makes debugger statements log a warning', async () => {
  await navigatePageFrame('/tests/e2e/debugger-page.html');
  const text = 'debugger statement hit (pausing is not supported)';
  const hits = async () =>
    (await received()).filter(
      m =>
        m.method === 'Runtime.consoleAPICalled' &&
        (m.params as Protocol.Runtime.ConsoleAPICalledEvent).type === 'warning' &&
        firstArg(m) === text
    );
  await waitFor(async () => (await hits()).length >= 5);
  const frames = (await hits()).map(
    m => (m.params as Protocol.Runtime.ConsoleAPICalledEvent).stackTrace?.callFrames[0]
  );
  const at = (file: string) => frames.find(f => f?.url.endsWith(file));
  // The position of the `debugger` keyword (0-based), then its caller below it.
  // Columns count characters (`é` is two bytes); a `(` on the next line does not make it a call.
  assert.deepEqual(
    frames.filter(f => f?.url.endsWith('debugger-classic.js')).map(f => [f?.lineNumber, f?.columnNumber]),
    [
      [5, 15],
      [7, 9],
      [8, 9],
      [9, 9],
    ]
  );
  assert.deepEqual([at('debugger-module.js')?.lineNumber, at('debugger-module.js')?.columnNumber], [1, 12]);
  assert.equal((await hits()).length, 5, 'the property named debugger is left alone');
  const result = await page.evaluate(
    () =>
      (
        document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow as {
          __debuggerResult?: unknown;
        }
      )?.__debuggerResult
  );
  assert.deepEqual(result, ['debugger'], 'the script still runs as written');
  // Left alone: a script with an integrity hash, and one a worker imports (no probe there).
  const pageWindowValue = (name: string) =>
    page.evaluate(
      name =>
        Reflect.get(document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow ?? {}, name),
      name
    );
  assert.equal(await pageWindowValue('__sriRan'), true, 'a script with integrity still runs');
  await waitFor(async () => (await pageWindowValue('__workerResult')) !== undefined);
  assert.equal(await pageWindowValue('__workerResult'), true, 'the worker imported its script');
  // The Sources panel fetches the script itself and gets the original.
  const source = await page.evaluate(() => {
    const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
    if (!pageWindow) throw new Error('no page frame');
    return pageWindow.fetch('/tests/e2e/assets/debugger-classic.js').then(r => r.text());
  });
  assert.match(source, /^ {2}const é = x; debugger$/m);
});

test('the Service Worker leaves the same-origin DevTools frontend alone', async () => {
  // The worker controls the shell by now, so it sees the frontend frame's navigation.
  await page.evaluate(() => {
    const frontend = document.querySelector('devtools-anywhere[shell]')?.shadowRoot?.querySelector('iframe');
    if (!frontend?.contentWindow) throw new Error('no frontend frame');
    // Marks the old document, to wait for the new one.
    Reflect.set(frontend.contentWindow, 'stale', true);
    frontend.contentWindow.location.reload();
  });
  await waitFor(() =>
    page.evaluate(() => {
      const doc = document
        .querySelector('devtools-anywhere[shell]')
        ?.shadowRoot?.querySelector('iframe')?.contentDocument;
      const win = doc?.defaultView;
      return !!win && !Reflect.get(win, 'stale') && doc.readyState === 'complete' && !!win.received;
    })
  );
  const scripts = await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere[shell]');
    const frontendDocument = devtools?.shadowRoot?.querySelector('iframe')?.contentDocument;
    if (!frontendDocument) throw new Error('no frontend frame');
    return [...frontendDocument.querySelectorAll('script')].map(s => s.src);
  });
  assert.equal(scripts.filter(src => src.endsWith('/probe.iife.js')).length, 0, scripts.join(', '));
});

// The last one arrives in two chunks, cut between <head> and the marker after it.
for (const path of [
  '/tests/e2e/frontend-dir/',
  '/tests/e2e/frontend-dir/index.html',
  '/tests/e2e/frontend-dir/index.html?split=%3Chead%3E',
]) {
  test(`the Service Worker leaves the frontend alone at ${path}`, async () => {
    // Recognized by its content, whatever URL it is opened at (a directory or its index.html).
    await page.evaluate(href => {
      const frontend = document.querySelector('devtools-anywhere[shell]')?.shadowRoot?.querySelector('iframe');
      if (!frontend?.contentWindow) throw new Error('no frontend frame');
      Reflect.set(frontend.contentWindow, 'stale', true);
      frontend.contentWindow.location.href = href;
    }, path);
    await waitFor(() =>
      page.evaluate(() => {
        const doc = document
          .querySelector('devtools-anywhere[shell]')
          ?.shadowRoot?.querySelector('iframe')?.contentDocument;
        const win = doc?.defaultView;
        return !!win && !Reflect.get(win, 'stale') && doc.readyState === 'complete' && !!win.received;
      })
    );
    const scripts = await page.evaluate(() => {
      const frontendDocument = document
        .querySelector('devtools-anywhere[shell]')
        ?.shadowRoot?.querySelector('iframe')?.contentDocument;
      if (!frontendDocument) throw new Error('no frontend frame');
      return {
        href: frontendDocument.location.href,
        srcs: [...frontendDocument.querySelectorAll('script')].map(s => s.src),
      };
    });
    assert.ok(scripts.href.endsWith(path), scripts.href);
    assert.equal(scripts.srcs.filter(src => src.endsWith('/probe.iife.js')).length, 0, scripts.srcs.join(', '));
  });
}

test('the Service Worker injects right after the shell reloads', async () => {
  // The worker is active already: the reloaded shell must be known to it before the page frame
  // navigates, even though it registers the worker again only after its bundle has loaded.
  // The address bar follows the page frame: reload a page with the probe, so the shell comes back.
  await navigatePageFrame('/tests/e2e/zero-config.html');
  await page.evaluate(() => {
    // Marks the old document, to wait for the new one.
    Reflect.set(window, 'stale', true);
    location.reload();
  });
  await waitFor(
    () =>
      page.evaluate(() => {
        const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
        if (Reflect.get(window, 'stale') || !pageWindow || !document.querySelector('devtools-anywhere[shell]'))
          return false;
        pageWindow.location.href = '/tests/e2e/no-probe.html';
        return true;
      }),
    8000
  );
  await waitFor(() =>
    page.evaluate(() => {
      const pageWindow = document.querySelector<HTMLIFrameElement>('#devtools-anywhere-page')?.contentWindow;
      return (
        pageWindow?.location.pathname === '/tests/e2e/no-probe.html' && pageWindow.document.readyState === 'complete'
      );
    })
  );
  const scripts = await pageScripts();
  assert.equal(scripts.filter(src => src.endsWith('/probe.iife.js')).length, 1, scripts.join(', '));
});

test('leaving shell mode unregisters the Service Worker', async () => {
  await page.evaluate(() => {
    const devtools = document.querySelector<DevtoolsAnywhereElement>('devtools-anywhere[shell]');
    if (!devtools) throw new Error('no <devtools-anywhere shell>');
    return devtools.exitShell();
  });
  await waitFor(() => page.evaluate(() => !document.getElementById('devtools-anywhere-page')));
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  assert.equal(registrations, 0);
});

test('the Service Worker passes requests through once the shell is gone without exitShell', async () => {
  await page.goto(env?.baseUrl + '/tests/e2e/zero-config.html');
  await waitFor(() => page.evaluate(() => !!document.querySelector('devtools-anywhere')?.isConnected));
  await page.evaluate(() => {
    const devtools = document.querySelector('devtools-anywhere');
    if (!devtools) throw new Error('no <devtools-anywhere>');
    devtools.enterShell();
  });
  await waitFor(() => page.evaluate(() => !!document.querySelector('devtools-anywhere[shell]')));
  await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller));
  // Another tab outside shell mode keeps the worker while this shell uses it.
  const other = await page.browser().newPage();
  await other.goto(env?.baseUrl + '/tests/e2e/zero-config.html');
  await waitFor(() => other.evaluate(() => !!document.querySelector('devtools-anywhere')));
  // Longer than the probe's wait for the worker's answer.
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(await other.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1);
  await other.close();
  // Shell mode ends behind the shell's back: the worker stays registered.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(env?.baseUrl + '/tests/e2e/sw-iframe.html');
  await waitFor(() =>
    page.evaluate(() => {
      const framed = document.querySelector<HTMLIFrameElement>('#framed')?.contentDocument;
      return framed?.readyState === 'complete' && framed.location.pathname === '/tests/e2e/no-probe.html';
    })
  );
  const { scripts, controlled, registrations } = await page.evaluate(async () => {
    const framed = document.querySelector<HTMLIFrameElement>('#framed')?.contentDocument;
    if (!framed) throw new Error('no framed page');
    return {
      scripts: [...framed.querySelectorAll('script')].map(s => s.src),
      controlled: !!navigator.serviceWorker.controller,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
    };
  });
  assert.equal(controlled, true, 'the left-over worker still controls the page');
  assert.equal(registrations, 1);
  assert.equal(scripts.filter(src => src.endsWith('/probe.iife.js')).length, 0, scripts.join(', '));
});

// Relies on the worker the previous test left registered.
test('a page outside shell mode unregisters the left-over Service Worker', async () => {
  await page.goto(env?.baseUrl + '/tests/e2e/zero-config.html');
  await waitFor(
    async () => (await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0
  );
});
