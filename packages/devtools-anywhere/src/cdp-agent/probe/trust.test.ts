import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cdnFrontendUrl, isTrusted, trustOf } from './trust.ts';

const JSDELIVR = 'https://cdn.jsdelivr.net/npm/';
const PROBE = `${JSDELIVR}devtools-anywhere@0.2.0/dist/probe.iife.js`;
const FRONTEND = `${JSDELIVR}@devtools-anywhere/devtools-frontend@0.2.0/dist/anywhere_app.html`;

/** Whether a script at `script` trusts `url`. */
const trusts = (script: string, url: string) => {
  const trust = trustOf(script);
  assert.ok(trust);
  return isTrusted(url, trust);
};

describe('the frontend by default', () => {
  test('on jsDelivr and unpkg, the frontend package of the same version', () => {
    assert.equal(cdnFrontendUrl(PROBE), FRONTEND);
    assert.equal(
      cdnFrontendUrl('https://unpkg.com/devtools-anywhere@0.2.0/dist/probe.iife.js'),
      'https://unpkg.com/@devtools-anywhere/devtools-frontend@0.2.0/dist/anywhere_app.html'
    );
    // A dist-tag is kept as it is.
    assert.equal(
      cdnFrontendUrl(`${JSDELIVR}devtools-anywhere@latest/dist/probe.iife.js`),
      `${JSDELIVR}@devtools-anywhere/devtools-frontend@latest/dist/anywhere_app.html`
    );
  });

  for (const [what, script] of Object.entries({
    'self-hosted': 'https://example.com/devtools-anywhere/dist/probe.iife.js',
    'without a version': `${JSDELIVR}devtools-anywhere/dist/probe.iife.js`,
    'another package': `${JSDELIVR}devtools-anywhere-fork@0.2.0/dist/probe.iife.js`,
    'an escaped version': `${JSDELIVR}devtools-anywhere@0.2.0%2F..%2Fx/dist/probe.iife.js`,
    'no URL': 'probe.iife.js',
  })) {
    test(`none ${what}`, () => assert.equal(cdnFrontendUrl(script), null));
  }
});

describe('what a shell config may point to', () => {
  test('on an npm CDN, this package and the frontend package at the same version', () => {
    assert.equal(trusts(PROBE, FRONTEND), true);
    assert.equal(trusts(PROBE, `${JSDELIVR}devtools-anywhere@0.2.0/dist/devtools-anywhere.iife.js`), true);
  });

  for (const [what, url] of Object.entries({
    'another version of the frontend': `${JSDELIVR}@devtools-anywhere/devtools-frontend@0.1.0/dist/anywhere_app.html`,
    'another version of this package': `${JSDELIVR}devtools-anywhere@0.1.0/dist/devtools-anywhere.iife.js`,
    'another package': `${JSDELIVR}evil@1.0.0/anywhere_app.html`,
    'a package that starts the same': `${JSDELIVR}devtools-anywhere@0.2.0-evil/dist/devtools-anywhere.iife.js`,
    'a scope that starts the same': `${JSDELIVR}@devtools-anywhere/devtools-frontend@0.2.0x/dist/anywhere_app.html`,
    'dot segments': `${JSDELIVR}devtools-anywhere@0.2.0/../evil@1.0.0/x.html`,
    'escaped dot segments': `${JSDELIVR}devtools-anywhere@0.2.0/%2e%2e/evil@1.0.0/x.html`,
    'escaped slashes': `${JSDELIVR}devtools-anywhere@0.2.0/..%2F..%2Fevil@1.0.0/x.html`,
    'escaped backslashes': `${JSDELIVR}devtools-anywhere@0.2.0/..%5C..%5Cevil@1.0.0/x.html`,
    backslashes: `${JSDELIVR}devtools-anywhere@0.2.0\\..\\..\\evil@1.0.0/x.html`,
    'another CDN': 'https://unpkg.com/@devtools-anywhere/devtools-frontend@0.2.0/dist/anywhere_app.html',
    'plain http': FRONTEND.replace('https:', 'http:'),
    credentials: FRONTEND.replace('https://', 'https://user@'),
    'not http': `javascript:alert(1)//${FRONTEND}`,
  })) {
    test(`not ${what}`, () => assert.equal(trusts(PROBE, url), false));
  }

  test('on an npm CDN but not this package, nothing', () => {
    const other = `${JSDELIVR}evil@1.0.0/probe.iife.js`;
    assert.equal(trusts(other, `${JSDELIVR}evil@1.0.0/anywhere_app.html`), false);
    assert.equal(trusts(other, FRONTEND), false);
  });

  test('elsewhere, the whole origin of the script', () => {
    const probe = 'https://example.com/static/probe.iife.js';
    assert.equal(trusts(probe, 'https://example.com/other/anywhere_app.html'), true);
    assert.equal(trusts(probe, 'https://example.org/anywhere_app.html'), false);
    assert.equal(trusts(probe, 'https://example.com:8443/anywhere_app.html'), false);
  });

  test('no URL, no trust', () => assert.equal(trustOf('probe.iife.js'), null));
});
