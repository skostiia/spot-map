// Offline: the app shell is cached; map tiles are cached as you browse (capped).
const SHELL = 'spots-shell-v6';
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

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // Network first so updates land, cache when offline.
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  // Map style + TileJSON change weekly (they point at the newest tiles): network first.
  if (url.hostname === 'tiles.openfreemap.org' && !/\.(pbf|png|jpg|webp)$/.test(url.pathname)) {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(TILES).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  if (/tiles\.openfreemap\.org|arcgisonline\.com/.test(url.hostname)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trimTiles(); }
      return r;
    }));
  }
});
