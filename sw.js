// Notizen – Service Worker: app shell offline. Notes live in IndexedDB (not here); api.php and admin.html are never cached.
// Release: bump CACHE_NAME. test/js/sw.test.mjs checks that SHELL lists every app file.

const CACHE_NAME = 'notizen-v17';
const PREFIX = 'notizen-';

const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'css/base.css',
  'css/login.css',
  'css/library.css',
  'css/editor.css',
  'css/pages.css',
  'css/share.css',
  'css/account.css',
  'css/export.css',
  'css/present.css',
  'js/app.js',
  'js/api.js',
  'js/config.js',
  'js/db.js',
  'js/model.js',
  'js/sync.js',
  'js/ink/codec.js',
  'js/ink/paper.js',
  'js/ink/render.js',
  'js/ink/stroke.js',
  'js/ink/surface.js',
  'js/ink/shapes.js',
  'js/ink/leitner.js',
  'js/ui/dom.js',
  'js/ui/login.js',
  'js/ui/status.js',
  'js/ui/account.js',
  'js/ui/library.js',
  'js/ui/thumbs.js',
  'js/ui/trash.js',
  'js/ui/editor.js',
  'js/ui/pages.js',
  'js/ui/toolbar.js',
  'js/ui/color-slots.js',
  'js/ui/fullscreen.js',
  'js/ui/ruler.js',
  'js/ui/ruler-geom.js',
  'js/ui/geodreieck.js',
  'js/ui/geodreieck-geom.js',
  'js/ui/compass.js',
  'js/ui/compass-geom.js',
  'js/ui/present.js',
  'js/ui/export-dialog.js',
  'js/ui/share.js',
  'js/ui/shared.js',
  'js/export/pdf.js',
  'js/export/backup.js',
  'js/export/save.js',
  'js/export/cover.js',
  'js/import/importer.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only our own caches: other apps on this origin keep theirs.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (path.includes('/api.php') || path.endsWith('/admin.html') || path.includes('/js/admin/') || path.endsWith('/labor.html')) return;

  // Navigations: network first (fresh app after deploys), offline → cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((c) => c.put('index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('index.html')),
    );
    return;
  }

  // Assets: cache first, refresh in the background (stale-while-revalidate).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || net;
    }),
  );
});
