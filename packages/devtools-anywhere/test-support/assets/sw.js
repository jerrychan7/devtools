// A service worker for the ServiceWorker domain's tests: it only installs and activates.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
