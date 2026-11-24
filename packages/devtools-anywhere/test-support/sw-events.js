// A service worker for the ServiceWorker domain's tests that need one controlling the fixture
// page (its scope is this directory). A new version waits; it skips waiting when the page posts
// {type: 'SKIP_WAITING'} (Workbox's convention), unless loaded with ?listen=0. Each `sync` event
// is posted to the pages as {sync: tag, lastChance}.
const params = new URL(self.location.href).searchParams;
const listens = params.get('listen') !== '0';
// ?hold=<ms> keeps the worker installing that long: its registration has no active worker yet.
const hold = Number(params.get('hold') ?? 0);
if (hold) self.addEventListener('install', e => e.waitUntil(new Promise(r => setTimeout(r, hold))));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => {
  if (listens && e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('sync', e => {
  e.waitUntil(
    self.clients
      .matchAll({ includeUncontrolled: true })
      .then(all => all.forEach(c => c.postMessage({ sync: e.tag, lastChance: e.lastChance })))
  );
});
