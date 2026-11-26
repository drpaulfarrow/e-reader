// Offline support: the app shell is cached on install; everything else from
// this origin (fonts and character maps for unusual PDFs) is cached on first use.
const CACHE = 'folio-v3';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css', 'js/app.js', 'js/reflow.js', 'js/store.js', 'js/sync.js', 'js/formats.js',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: answer from the cache at once, refresh it in the
// background so the next launch picks up updates.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Never cache the sync API: PDFs and positions must come from the server.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './' : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || new Response('Offline', { status: 503 });
  })());
});
