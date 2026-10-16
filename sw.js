const V = 'pp-v3';
const ASSETS = ['./', 'index.html', 'app.js', 'logic.js', 'history.js', 'debug.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/tesseract.min.js', 'vendor/worker.min.js', 'vendor/tesseract-core-lstm.wasm.js', 'vendor/tesseract-core-simd-lstm.wasm.js', 'lang/eng.traineddata.gz'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== 'pp-shared').map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const files = (await e.request.formData()).getAll('images').filter((f) => f && f.size);
      const c = await caches.open('pp-shared');
      await Promise.all(files.map((f, i) => c.put(`shared/${i}`, new Response(f, { headers: { 'content-type': f.type || 'image/jpeg', 'x-name': encodeURIComponent(f.name || '') } }))));
      return Response.redirect(`./?shared=${files.length}`, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
