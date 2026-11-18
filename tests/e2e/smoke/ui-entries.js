// Triggers for tests/e2e/ui-entries.test.ts: each makes something a DevTools view should show.
console.log('ui-entries-console');
indexedDB.open('ui-entries-db', 1).onupgradeneeded = event => event.target.result.createObjectStore('store');
caches.open('ui-entries-cache');
localStorage.setItem('ui-entries-key', 'value');
document.addEventListener('uientriesevent', () => {});
fetch('/tests/e2e/smoke/ui-entries.html?ui-entries-fetch');
