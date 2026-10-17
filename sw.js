// Offline: the app shell is cached; map tiles are cached as you browse (capped).
const SHELL = 'spots-shell-v10';
const TILES = 'spots-tiles-v2';
const TILE_CAP = 1500;
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css', 'vendor/exifr/lite.umd.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - TILE_CAP; i++) await c.delete(keys[i]);
}

// Background cache writes go through e.waitUntil so the browser keeps them alive properly
// (fire-and-forget writes made WebKit hang the first reload after the worker took over).
const keep = (e, p) => e.waitUntil(p.catch(() => {}));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Network first so updates land; cached copy when offline.
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) { const copy = r.clone(); keep(e, caches.open(SHELL).then(c => c.put(req, copy))); }
        return r;
      } catch {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
        return Response.error();
      }
    })());
    return;
  }
  // Map style + TileJSON change weekly (they point at the newest tiles): network first.
  if (url.hostname === 'tiles.openfreemap.org' && !/\.(pbf|png|jpg|webp)$/.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) { const copy = r.clone(); keep(e, caches.open(TILES).then(c => c.put(req, copy))); }
        return r;
      } catch { return (await caches.match(req)) || Response.error(); }
    })());
    return;
  }
  if (/tiles\.openfreemap\.org|arcgisonline\.com/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); keep(e, c.put(req, copy).then(trimTiles)); }
      return r;
    })());
  }
});
