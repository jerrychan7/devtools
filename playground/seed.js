// Fills every storage the Application panel shows, so it has something to inspect.
// Values carry the time of the visit, so reloads visibly update them.
(function () {
  var now = new Date().toISOString();

  localStorage.setItem('playground:visited', now);
  localStorage.setItem('playground:object', JSON.stringify({ count: 1, tags: ['a', 'b'] }));
  sessionStorage.setItem('playground:session', now);

  document.cookie = 'playground_visit=' + encodeURIComponent(now) + '; path=/; max-age=86400';
  document.cookie = 'playground_theme=dark; path=/playground/; SameSite=Lax';

  var open = indexedDB.open('playground', 1);
  open.onupgradeneeded = function () {
    var db = open.result;
    var users = db.createObjectStore('users', { keyPath: 'id' });
    users.createIndex('by_name', 'name');
    db.createObjectStore('visits', { autoIncrement: true });
  };
  open.onsuccess = function () {
    var db = open.result;
    var tx = db.transaction(['users', 'visits'], 'readwrite');
    tx.objectStore('users').put({ id: 1, name: 'Ada', roles: ['admin'] });
    tx.objectStore('users').put({ id: 2, name: 'Linus', roles: [] });
    tx.objectStore('visits').add({ at: now });
    tx.oncomplete = function () {
      db.close();
    };
  };

  if ('caches' in window) {
    caches.open('playground-v1').then(function (cache) {
      cache.put(
        '/playground/hello.txt',
        new Response('hello at ' + now, { headers: { 'content-type': 'text/plain' } })
      );
      cache.add('/api/echo?n=cached');
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/playground/sw.js', { scope: '/playground/' }).catch(function (error) {
      console.warn('[seed] service worker', error);
    });
  }
})();
