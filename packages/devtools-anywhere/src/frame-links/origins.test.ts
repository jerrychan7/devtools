import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOrigin, parseOrigins } from './origins.ts';

/** Whether a list trusts `origin`. */
const trusts = (list: string, origin: string) => matchOrigin(parseOrigins(list), origin);

/** Runs `fn`, returning the warnings it logs. */
const warnings = (fn: () => void) => {
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => logged.push(message);
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return logged;
};

describe('exact origins', () => {
  test('match only themselves', () => {
    assert.ok(trusts('https://a.example', 'https://a.example'));
    assert.ok(trusts('http://localhost:5173 https://a.example', 'http://localhost:5173'));
    assert.ok(!trusts('https://a.example', 'http://a.example'));
    assert.ok(!trusts('https://a.example', 'https://a.example:8443'));
    assert.ok(!trusts('https://a.example', 'https://b.a.example'));
  });

  test('are compared as origins: case, a trailing slash and the default port do not matter', () => {
    assert.ok(trusts('HTTPS://A.Example/', 'https://a.example'));
    assert.ok(trusts('https://a.example:443', 'https://a.example'));
  });

  test('nothing is trusted by default, nor the opaque origin', () => {
    assert.ok(!trusts('', 'https://a.example'));
    assert.ok(!matchOrigin(parseOrigins(null), 'https://a.example'));
    assert.ok(!trusts('https://a.example', 'null'));
  });
});

describe('subdomain wildcards', () => {
  test('match subdomains at any depth, not the host itself', () => {
    assert.ok(trusts('https://*.example.com', 'https://a.example.com'));
    assert.ok(trusts('https://*.example.com', 'https://a.b.example.com'));
    assert.ok(!trusts('https://*.example.com', 'https://example.com'));
    assert.ok(!trusts('https://*.example.com', 'https://badexample.com'));
    assert.ok(!trusts('https://*.example.com', 'https://example.com.evil.test'));
  });

  test('keep the scheme and port exact', () => {
    assert.ok(!trusts('https://*.example.com', 'http://a.example.com'));
    assert.ok(!trusts('https://*.example.com', 'https://a.example.com:8443'));
    assert.ok(trusts('http://*.example.com:8080', 'http://a.example.com:8080'));
    assert.ok(!trusts('http://*.example.com:8080', 'http://a.example.com'));
  });
});

describe('invalid entries', () => {
  test('are ignored with a warning, once each', () => {
    const entries = ['*', 'https://*', 'https://a.*.example.com', '*.example.com', 'https://*example.com', 'not-a-url'];
    for (const entry of entries) {
      const logged = warnings(() => assert.deepEqual(parseOrigins(`${entry} https://ok.example`).length, 1));
      assert.equal(logged.length, 1, entry);
      assert.match(logged[0] ?? '', /is not an origin/);
      assert.deepEqual(
        warnings(() => parseOrigins(entry)),
        [],
        `${entry} again`
      );
    }
  });

  test('a path is not an origin', () => {
    assert.ok(!trusts('https://a.example/app', 'https://a.example'));
  });
});
