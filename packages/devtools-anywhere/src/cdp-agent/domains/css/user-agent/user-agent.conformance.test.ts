import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Protocol } from 'devtools-protocol';
import type { CDPSession, Page } from 'puppeteer-core';
import { launch } from '../../../../../test-support/conformance.ts';
import type { Env } from '../../../../../test-support/conformance.ts';

// The user agent sheet is found next to the bundle's script: here the bundle is loaded from its
// URL, not inline as openPage() does.
let env: Env | undefined;
let page: Page;
let chrome: CDPSession;

type Send = (method: string, params?: object) => Promise<unknown>;
let sendOurs: Send;
let sendChrome: Send;

before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
  await page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<ul><li id="li"><p id="p">x<b id="b">b</b><input id="i"><a id="a" href="#">a</a></p></li></ul>' +
        '<h1 id="h">h</h1><svg><a id="svg-a"><text>t</text></a></svg>'
    )
  );
  chrome = await page.createCDPSession();
  await page.addScriptTag({ url: env.baseUrl + '/packages/devtools-anywhere/dist/devtools-anywhere.iife.js' });
  await page.evaluate(() => {
    window.__session = window.DevtoolsAnywhere.createCdpSession();
    window.__session.onMessage(() => {});
  });
  sendOurs = (method, params = {}) => page.evaluate((m, p) => window.__session.call(m, p), method, params);
  sendChrome = (method, params = {}) => chrome.send(method as never, params as never);
  for (const send of [sendOurs, sendChrome]) {
    await send('DOM.enable');
    await send('CSS.enable');
  }
});
after(() => env?.close());

/** The node of `selector`, on one side. */
async function nodeId(send: Send, selector: string) {
  const { root } = (await send('DOM.getDocument', { depth: -1 })) as Protocol.DOM.GetDocumentResponse;
  const found = (await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  })) as Protocol.DOM.QuerySelectorResponse;
  return found.nodeId;
}

async function matched(send: Send, selector: string) {
  return (await send('CSS.getMatchedStylesForNode', {
    nodeId: await nodeId(send, selector),
  })) as Protocol.CSS.GetMatchedStylesForNodeResponse;
}

const userAgent = (matches: Protocol.CSS.RuleMatch[] = []) => matches.filter(m => m.rule.origin === 'user-agent');

/** A rule as compared: its selectors, the matching ones, and its declarations. */
const summary = (m: Protocol.CSS.RuleMatch) => ({
  selectors: m.rule.selectorList.text,
  matching: m.matchingSelectors,
  properties: m.rule.style.cssProperties.map(p => [p.name, p.value, p.important ?? false]),
});

describe('user agent stylesheet', () => {
  test('the user agent rules of ordinary elements are Chrome’s, in order', async () => {
    for (const selector of ['#p', '#b', '#h', '#a', '#li', '#i']) {
      const [ours, theirs] = await Promise.all([matched(sendOurs, selector), matched(sendChrome, selector)]);
      assert.deepEqual(
        userAgent(ours.matchedCSSRules).map(summary),
        userAgent(theirs.matchedCSSRules).map(summary),
        selector
      );
      // Before the page's own.
      const origins = (ours.matchedCSSRules ?? []).map(m => m.rule.origin);
      assert.deepEqual(
        origins,
        origins.toSorted((x, y) => +(x !== 'user-agent') - +(y !== 'user-agent'))
      );
    }
  });

  test('rules come without a style sheet or source ranges', async () => {
    const [rule] = userAgent((await matched(sendOurs, '#p')).matchedCSSRules);
    assert.ok(rule);
    assert.equal(rule.rule.styleSheetId, undefined);
    assert.equal(rule.rule.style.range, undefined);
    assert.deepEqual(rule.rule.style.shorthandEntries, []);
  });

  test('ancestors’ user agent rules are listed among the inherited, as in Chrome', async () => {
    const [ours, theirs] = await Promise.all([matched(sendOurs, '#b'), matched(sendChrome, '#b')]);
    const selectors = (r: Protocol.CSS.GetMatchedStylesForNodeResponse) =>
      (r.inherited ?? []).map(i => userAgent(i.matchedCSSRules).map(m => m.rule.selectorList.text));
    assert.deepEqual(selectors(ours), selectors(theirs));
  });

  test('an SVG element matches no HTML rule of the same name', async () => {
    const ours = await matched(sendOurs, '#svg-a');
    assert.ok(!userAgent(ours.matchedCSSRules).some(m => /(^|, )a(,|$)/.test(m.rule.selectorList.text)));
  });
});

// The sheet is the only LGPL file of the package, which a site may leave out: dist-test/ has none.
test('without chromium-html.css next to the bundle, styles come without user agent rules, asked for once', async () => {
  assert.ok(env);
  const bare = await env.browser.newPage();
  try {
    const asked: string[] = [];
    bare.on('request', r => {
      if (r.url().endsWith('/chromium-html.css')) asked.push(r.url());
    });
    await bare.goto(env.baseUrl + '/packages/devtools-anywhere/test-support/fixture.html');
    await bare.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<h1 id="h">h</h1>'));
    await bare.addScriptTag({ url: env.baseUrl + '/packages/devtools-anywhere/dist-test/devtools-anywhere.iife.js' });
    await bare.evaluate(() => {
      window.__session = window.DevtoolsAnywhere.createCdpSession();
      window.__session.onMessage(() => {});
    });
    const send: Send = (method, params = {}) => bare.evaluate((m, p) => window.__session.call(m, p), method, params);
    await send('DOM.enable');
    await send('CSS.enable');
    for (let i = 0; i < 3; i++) {
      const styles = (await send('CSS.getMatchedStylesForNode', {
        nodeId: await nodeId(send, '#h'),
      })) as Protocol.CSS.GetMatchedStylesForNodeResponse;
      assert.deepEqual(userAgent(styles.matchedCSSRules), []);
      assert.ok(styles.matchedCSSRules);
    }
    assert.equal(asked.length, 1);
  } finally {
    await bare.close();
  }
});
