// A minimal service worker for the Application panel: it precaches the page and answers
// nothing itself, so requests behave as if it were not there.
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open('playground-sw-v1').then(function (cache) {
      return cache.addAll(['/playground/', '/playground/manifest.json']);
    })
  );
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
