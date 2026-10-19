// Runs synchronously in <head>, right after chobitsu (variant A) or the probe (variant P).
// Everything here happens before any lazy-loaded tool could hook the page.

console.log('[early] primitives', 'str', 42, true, null, undefined);
console.log('[early] object', { a: 1, nested: { b: [1, 2, 3] }, fn() {} });
console.log('[early] array', [1, 'two', { three: 3 }]);
console.log('[early] dom', document.documentElement);
console.info('[early] info');
console.debug('[early] debug');
console.warn('[early] warn');
console.error('[early] error', new Error('early error object'));
console.group('[early] group');
console.log('[early] inside group');
console.groupEnd();
console.table([{ x: 1, y: 2 }, { x: 3, y: 4 }]);

// Network before any tool is ready.
fetch('/api/echo?n=fetch-get&delay=50');
fetch('/api/echo?n=fetch-post', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hello: 'world' }),
});
// Still in flight when the tool takes over in variant P.
fetch('/api/echo?n=fetch-slow&delay=4000');
fetch('/does-not-exist?n=fetch-404');

const xhr = new XMLHttpRequest();
xhr.open('GET', '/api/echo?n=xhr-get&delay=100');
xhr.setRequestHeader('x-test', 'early');
xhr.send();

setTimeout(() => {
  throw new Error('[early] uncaught from setTimeout');
}, 0);
Promise.reject(new Error('[early] unhandled rejection'));
