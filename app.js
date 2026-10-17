'use strict';
/* Spots: a personal map of shoot locations. Everything lives on this device (IndexedDB). */

const $ = s => document.querySelector(s);
const ICON = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  place: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 15l4.5-4 4 3.5 3-2.5 5.5 4.5"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/></svg>',
};
const DEFAULT_VIEW = { c: [27.9659, -82.8001], z: 12 }; // Clearwater, FL
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ---------- IndexedDB ---------- */
let dbPromise;
function db() {
  return dbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('spotmap', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('spots')) d.createObjectStore('spots', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('spotId', 'spotId');
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'id' }); // video pieces
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
const done = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const os = async (name, mode = 'readonly') => (await db()).transaction(name, mode).objectStore(name);
const DB = {
  all: async n => done((await os(n)).getAll()),
  get: async (n, k) => done((await os(n)).get(k)),
  put: async (n, v) => done((await os(n, 'readwrite')).put(v)),
  del: async (n, k) => done((await os(n, 'readwrite')).delete(k)),
  photosOf: async id => done((await os('photos')).index('spotId').getAll(id)),
};

let persistAsked = false;
async function askPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { await navigator.storage.persist(); } catch {}
}

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- Map (MapLibre GL, vector tiles from OpenFreeMap, no key) ---------- */
const spots = new Map();
const markers = new Map();
let map, layerKey, meDot;
let current = null;   // spot id open in the sheet
let placing = null;   // { mode: 'new' | 'move', spotId, pending: [] }
let fileTarget = null;

const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_SAT = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    sat: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    },
    labels: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    },
  },
  layers: [
    { id: 'sat', type: 'raster', source: 'sat' },
    { id: 'labels', type: 'raster', source: 'labels' },
  ],
};
const ll = (lat, lng) => [lng, lat]; // MapLibre wants [lng, lat]

// OpenFreeMap "dark" is near-flat black. Re-color it so water, parks, roads and names read at a glance.
const DARK_PAINT = {
  background: { 'background-color': '#16181c' },
  water: { 'fill-color': '#0d2131' },
  waterway: { 'line-color': '#0d2131' },
  landuse_residential: { 'fill-color': '#1b1e23', 'fill-opacity': 0.7 },
  landcover_wood: { 'fill-pattern': undefined, 'fill-color': '#14251c', 'fill-opacity': 0.8 },
  landuse_park: { 'fill-color': '#14251c' },
  building: { 'fill-color': '#22262d', 'fill-outline-color': '#2c3139' },
  'aeroway-area': { 'fill-color': '#1d2025' },
  'aeroway-runway': { 'line-color': '#2b2f36' },
  'aeroway-taxiway': { 'line-color': '#24282e' },
  road_area_pier: { 'fill-color': '#23272e' },
  road_pier: { 'line-color': '#23272e' },
  highway_path: { 'line-color': '#30353d' },
  highway_minor: { 'line-color': '#2b3037', 'line-opacity': 1 },
  highway_major_casing: { 'line-color': '#1f2329' },
  highway_major_inner: { 'line-color': '#3b414b' },
  highway_major_subtle: { 'line-color': '#343a43' },
  highway_motorway_casing: { 'line-color': '#1f2329' },
  highway_motorway_inner: { 'line-color': '#4d5461' },
  highway_motorway_subtle: { 'line-color': '#3b414b' },
  railway: { 'line-color': '#2b3037' }, railway_minor: { 'line-color': '#2b3037' }, railway_transit: { 'line-color': '#2b3037' },
  railway_dashline: { 'line-color': '#16181c' }, railway_minor_dashline: { 'line-color': '#16181c' }, railway_transit_dashline: { 'line-color': '#16181c' },
  boundary_state: { 'line-color': '#3a3f48' },
  water_name: { 'text-color': '#6f97ba', 'text-halo-color': '#0d2131' },
  highway_name_other: { 'text-color': '#9ea4ae', 'text-halo-color': '#16181c', 'text-halo-width': 1.2 },
  highway_name_motorway: { 'text-color': '#b8bdc6' },
};
const PLACE_TEXT = { 'text-color': '#cfd3da', 'text-halo-color': 'rgba(0,0,0,0.85)' };

function tuneDarkStyle() {
  if (layerKey !== 'map') return;
  for (const l of map.getStyle().layers) {
    const paint = DARK_PAINT[l.id] || (l.id.startsWith('place_') ? PLACE_TEXT : null);
    if (!paint) continue;
    for (const [k, v] of Object.entries(paint)) { try { map.setPaintProperty(l.id, k, v); } catch {} }
  }
}

function onStyleLoad() {
  tuneDarkStyle();
  add3dBuildings();
}

function add3dBuildings() {
  if (layerKey !== 'map' || map.getLayer('buildings-3d') || !map.getSource('openmaptiles')) return;
  const firstLabel = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addLayer({
    id: 'buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14.5,
    paint: {
      'fill-extrusion-color': '#2e333c',
      'fill-extrusion-vertical-gradient': true,
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 0.85],
    },
  }, firstLabel);
}

function initMap() {
  let saved = null;
  try { saved = JSON.parse(store.get('view2') || 'null'); } catch {}
  layerKey = store.get('layer') === 'sat' ? 'sat' : 'map';
  map = new maplibregl.Map({
    container: 'map',
    style: layerKey === 'sat' ? STYLE_SAT : STYLE_DARK,
    center: saved ? [saved.lng, saved.lat] : ll(...DEFAULT_VIEW.c),
    zoom: saved?.z ?? DEFAULT_VIEW.z,
    pitch: saved?.p ?? 0,
    bearing: saved?.b ?? 0,
    maxPitch: 70,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  map.on('style.load', onStyleLoad);
  // The free dark style asks for a sprite image it doesn't ship; give it a blank one.
  map.on('styleimagemissing', e => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  map.on('moveend', () => {
    const c = map.getCenter();
    store.set('view2', JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom(), p: map.getPitch(), b: map.getBearing() }));
    sync3dButton();
  });
  map.on('click', () => { if (!placing && sheetIsOpen()) closeSheet(); });
  map.on('dragstart', () => { userMovedMap = true; });

  // Press and hold on the map = new spot there (right-click on a computer).
  let holdTimer = null, holdStart = null, lastHold = 0;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  const hold = lngLat => {
    if (placing || Date.now() - lastHold < 1000) return;
    lastHold = Date.now();
    navigator.vibrate?.(15);
    newSpotAt(lngLat);
  };
  map.on('touchstart', e => {
    cancelHold();
    if (e.originalEvent.touches.length !== 1) return;
    holdStart = e.point;
    const at = e.lngLat;
    holdTimer = setTimeout(() => hold(at), 550);
  });
  map.on('touchmove', e => { if (holdStart && e.point.dist(holdStart) > 10) cancelHold(); });
  map.on('touchend', cancelHold);
  map.on('touchcancel', cancelHold);
  map.on('dragstart', cancelHold);
  map.on('zoomstart', cancelHold);
  map.on('contextmenu', e => hold(e.lngLat));
  return !saved;
}

function pinHtml(s) {
  const tilt = ((parseInt(s.id.replace(/\D/g, '').slice(-2) || '0', 10) % 7) - 3) + 'deg';
  const sel = s.id === current ? ' selected' : '';
  return s.coverThumb
    ? `<div class="pin${sel}" style="--tilt:${tilt}"><img src="${esc(s.coverThumb)}" alt=""></div>`
    : `<div class="pin pin-empty${sel}"></div>`;
}

function renderMarker(s) {
  let m = markers.get(s.id);
  if (!m) {
    const el = document.createElement('button');
    el.className = 'pin-wrap';
    el.addEventListener('click', e => { e.stopPropagation(); if (!placing) openSpot(s.id); });
    m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(ll(s.lat, s.lng)).addTo(map);
    markers.set(s.id, m);
  }
  const el = m.getElement();
  m.setLngLat(ll(s.lat, s.lng));
  el.innerHTML = pinHtml(s);
  el.setAttribute('aria-label', s.name || 'Untitled spot');
  el.style.zIndex = s.id === current ? 2 : 1;
}

function removeMarker(id) {
  markers.get(id)?.remove();
  markers.delete(id);
}

function refreshSelection(prev) {
  [prev, current].forEach(id => { const s = id && spots.get(id); if (s) renderMarker(s); });
}

function goTo(lat, lng, zoom) {
  map.easeTo({ center: ll(lat, lng), zoom: zoom ?? Math.max(map.getZoom(), 17), duration: 600 });
}

// Put the pin in the middle of the strip of map left visible above the sheet.
function panAbove(lat, lng, minZoom = 15) {
  const top = $('.topbar').getBoundingClientRect().bottom;
  const sheetTop = window.innerHeight - sheet.offsetHeight;
  const pinY = Math.max(top + 70, (top + sheetTop) / 2 + 30); // marker anchor is its bottom tip
  map.easeTo({ center: ll(lat, lng), zoom: Math.max(map.getZoom(), minZoom), offset: [0, pinY - window.innerHeight / 2], duration: 500 });
}

function toggleLayer() {
  layerKey = layerKey === 'map' ? 'sat' : 'map';
  store.set('layer', layerKey);
  map.setStyle(layerKey === 'sat' ? STYLE_SAT : STYLE_DARK);
  const b = $('#btnLayer');
  b.classList.toggle('on', layerKey === 'sat');
  b.setAttribute('aria-pressed', String(layerKey === 'sat'));
  toast(layerKey === 'sat' ? 'Satellite' : 'Dark map', 1200);
}

function sync3dButton() {
  const on = map.getPitch() > 5;
  const b = $('#btn3d');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}
function toggle3d() {
  const on = map.getPitch() > 5;
  map.easeTo(on
    ? { pitch: 0, bearing: 0, duration: 500 }
    : { pitch: 60, zoom: Math.max(map.getZoom(), 16), duration: 700 });
}

function locate(fly = true) {
  return new Promise(res => {
    if (!navigator.geolocation) { toast('This device has no location.'); return res(null); }
    navigator.geolocation.getCurrentPosition(p => {
      const { latitude: lat, longitude: lng } = p.coords;
      placeMe(lat, lng);
      if (fly) goTo(lat, lng);
      myPos = { lat, lng };
      myAcc = p.coords.accuracy || myAcc;
      $('#btnLocate').classList.remove('blocked');
      placeMe(lat, lng);
      updateNearest();
      startWatch();
      res([lat, lng]);
    }, err => {
      if (err.code === 1) locationBlocked();
      else toast('Could not get your location yet. Step outside or wait a few seconds, then tap again.', 5000);
      res(null);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

/* ---------- Places (OpenStreetMap Nominatim, free) ---------- */
async function reverseName(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=en&lat=${lat}&lon=${lng}`);
    if (!r.ok) return '';
    const d = await r.json();
    const a = d.address || {};
    const parts = [d.name, a.road, a.neighbourhood || a.suburb || a.hamlet, a.city || a.town || a.village || a.county].filter(Boolean);
    return [...new Set(parts)].slice(0, 2).join(', ');
  } catch { return ''; }
}
// Photon (komoot, free) ranks places near you first. Nominatim is the backup.
async function searchPlaces(q) {
  const c = map.getCenter();
  try {
    const r = await fetch(`https://photon.komoot.io/api/?limit=8&lang=en&lat=${c.lat}&lon=${c.lng}&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error('photon');
    const seen = new Set();
    return (await r.json()).features.map(f => {
      const p = f.properties;
      const sub = [p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street, p.city || p.county, p.state].filter(Boolean).join(', ');
      return { name: p.name || sub, sub, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    }).filter(x => { const k = `${x.name}|${x.sub}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  } catch {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(q)}&viewbox=${c.lng - 1},${c.lat + 1},${c.lng + 1},${c.lat - 1}`);
    if (!r.ok) throw new Error('search failed');
    return (await r.json()).map(x => ({ name: x.name || x.display_name.split(',')[0], sub: x.display_name, lat: +x.lat, lng: +x.lon }));
  }
}

/* ---------- Photos + videos ---------- */
const isVideoFile = f => /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm|3gp)$/i.test(f.name || '');
const CHUNK = 8 * 1024 * 1024;
const mediaLabel = (total, videos = 0) => {
  const v = videos || 0, ph = Math.max(0, (total || 0) - v);
  return [ph || !v ? plural(ph, 'photo') : '', v ? plural(v, 'video') : ''].filter(Boolean).join(', ');
};
const fmtDur = s => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function loadImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });
}
function draw(img, w, h, sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}
async function processPhoto(file) {
  // One full read. (exifr lite's `pick` option throws, so don't use it.)
  let gps = null, takenAt = null;
  try {
    const m = await exifr.parse(file);
    if (m && isFinite(m.latitude) && isFinite(m.longitude)) gps = { latitude: m.latitude, longitude: m.longitude };
    const d = m?.DateTimeOriginal || m?.CreateDate;
    if (d) takenAt = new Date(d).getTime() || null;
  } catch {}
  const { img, url } = await loadImg(file);
  try {
    const W = img.naturalWidth, H = img.naturalHeight, max = 2048;
    const k = Math.min(1, max / Math.max(W, H));
    const blob = await new Promise(r => draw(img, Math.round(W * k), Math.round(H * k)).toBlob(r, 'image/jpeg', 0.85));
    const side = Math.min(W, H);
    const thumb = draw(img, 240, 240, (W - side) / 2, (H - side) / 2, side, side).toDataURL('image/jpeg', 0.8);
    return { kind: 'photo', blob, thumb, takenAt, gps };
  } finally { URL.revokeObjectURL(url); }
}
// Grab one frame for the tile + the length. Never blocks: no frame after 12 s = icon tile.
// Safari hands back a black canvas if you draw right on 'seeked', so wait for a painted frame
// (requestVideoFrameCallback) and, if it is still black, try a bit further into the clip.
function videoPoster(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    let finished = false, tries = 0;
    const finish = thumb => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const out = { thumb, duration: Number.isFinite(v.duration) ? v.duration : 0 };
      v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
      res(out);
    };
    const timer = setTimeout(() => finish(null), 12000);
    const seekTo = t => { v.currentTime = Math.min(t, Math.max(0, (v.duration || 1) - 0.1)); };
    const grab = () => {
      try {
        const W = v.videoWidth, H = v.videoHeight;
        if (!W || !H) return finish(null);
        const side = Math.min(W, H);
        const c = document.createElement('canvas');
        c.width = c.height = 240;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(v, (W - side) / 2, (H - side) / 2, side, side, 0, 0, 240, 240);
        const px = g.getImageData(0, 0, 240, 240).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
        const dark = sum / (px.length / 64) / 3 < 6;
        if (dark && tries++ < 3) return seekTo((v.duration || 4) * [0.25, 0.5, 0.75][tries - 1]);
        finish(c.toDataURL('image/jpeg', 0.8));
      } catch { finish(null); }
    };
    v.addEventListener('loadeddata', () => { v.pause(); seekTo(Math.min(0.5, (v.duration || 1) * 0.1)); }, { once: true });
    v.addEventListener('seeked', () => {
      if (v.requestVideoFrameCallback) {
        let done = false;
        v.requestVideoFrameCallback(() => { if (!done) { done = true; grab(); } });
        setTimeout(() => { if (!done) { done = true; grab(); } }, 400); // paused video may never call back
      } else setTimeout(grab, 150);
    });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = url;
    v.play?.()?.catch?.(() => {});
  });
}
async function processVideo(file) {
  const { thumb, duration } = await videoPoster(file);
  return { kind: 'video', file, thumb, duration, takenAt: null, gps: null };
}
const processFile = f => (isVideoFile(f) ? processVideo(f) : processPhoto(f));

async function processFiles(files) {
  const out = [];
  let failed = 0;
  for (const [i, f] of [...files].entries()) {
    toast(`Adding ${i + 1} of ${files.length}...`, 60000);
    try { out.push(await processFile(f)); } catch { failed++; }
  }
  $('#toast').hidden = true;
  if (failed) toast(`${plural(failed, 'file')} could not be read.`);
  return out;
}

// Videos: try to keep the file as a Blob (Safari streams it from disk). Where WebKit refuses
// Blobs ("Error preparing Blob/File data"), store raw bytes in 8 MB pieces, one write each.
// Restore passes copyBytes: WebKit saves a *slice* of a File (a video cut out of the backup file)
// without its start offset, so after a reload it plays the backup's header bytes. Copy instead.
let blobStoreOk = null;
async function putVideo(rec, file, copyBytes = false) {
  if (!copyBytes && blobStoreOk !== false) {
    try { await DB.put('photos', { ...rec, blob: file }); blobStoreOk = true; return; }
    catch { blobStoreOk = false; }
  }
  const n = Math.max(1, Math.ceil(file.size / CHUNK));
  for (let i = 0; i < n; i++) {
    await DB.put('chunks', { id: `${rec.id}:${i}`, data: await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer() });
  }
  await DB.put('photos', { ...rec, chunks: n });
}
async function mediaBlob(p) {
  if (p.blob instanceof Blob) return p.blob;
  if (p.chunks) {
    const parts = [];
    for (let i = 0; i < p.chunks; i++) parts.push((await DB.get('chunks', `${p.id}:${i}`)).data);
    return new Blob(parts, { type: p.type || 'video/mp4' });
  }
  return new Blob([p.data], { type: p.type || 'image/jpeg' });
}
async function deleteMedia(p) {
  for (let i = 0; i < (p.chunks || 0); i++) await DB.del('chunks', `${p.id}:${i}`);
  await DB.del('photos', p.id);
}
async function recount(s) {
  const all = await DB.photosOf(s.id);
  s.photoCount = all.length;
  s.videoCount = all.filter(p => p.kind === 'video').length;
}

async function attachPhotos(s, processed) {
  const now = Date.now();
  const videoBytes = processed.filter(p => p.kind === 'video').reduce((n, p) => n + p.file.size, 0);
  if (videoBytes) {
    try {
      const e = await navigator.storage?.estimate?.();
      if (e?.quota && e.quota - e.usage < videoBytes * 1.1) {
        toast(`Not enough space on this phone for ${(videoBytes / 1048576).toFixed(0)} MB of video.`, 6000);
        processed = processed.filter(p => p.kind !== 'video');
      }
    } catch {}
  }
  for (const [i, p] of processed.entries()) {
    const rec = { id: uid(), spotId: s.id, kind: p.kind, thumb: p.thumb || '', takenAt: p.takenAt, addedAt: now + i };
    if (p.kind === 'video') {
      if (processed.length > 1 || p.file.size > 40 * 1048576) toast(`Saving video ${(p.file.size / 1048576).toFixed(0)} MB...`, 60000);
      await putVideo({ ...rec, type: p.file.type || 'video/mp4', duration: p.duration, size: p.file.size }, p.file);
    } else {
      // Photos as raw bytes, not a Blob: Safari/WebKit can fail with "Error preparing Blob/File data".
      await DB.put('photos', { ...rec, type: 'image/jpeg', data: await p.blob.arrayBuffer() });
    }
    if (!s.coverId && rec.thumb) { s.coverId = rec.id; s.coverThumb = rec.thumb; }
  }
  $('#toast').hidden = true;
  await recount(s);
  await saveSpot(s);
  return processed.length;
}

/* ---------- Spots ---------- */
async function saveSpot(s) {
  readyBackup = null;
  s.updatedAt = Date.now();
  spots.set(s.id, s);
  await DB.put('spots', s);
  renderMarker(s);
  askPersist();
  updateNearest();
}

async function newSpotAt(latlng, pending = [], name = '') {
  const s = {
    id: uid(), name, notes: '', lat: latlng.lat, lng: latlng.lng,
    createdAt: Date.now(), updatedAt: Date.now(), coverId: null, coverThumb: null, photoCount: 0, videoCount: 0,
  };
  await saveSpot(s);
  if (pending.length) await attachPhotos(s, pending);
  await openSpot(s.id);
  if (name) return;
  const found = await reverseName(s.lat, s.lng);
  const cur = spots.get(s.id);
  if (found && cur && !cur.name) {
    cur.name = found;
    await saveSpot(cur);
    const el = $('#spotName');
    if (current === cur.id && el && !el.value) { el.value = found; el.dispatchEvent(new Event('input')); }
  }
}

async function deleteSpot(s) {
  if (!confirm(`Delete "${s.name || 'Untitled spot'}" and its ${mediaLabel(s.photoCount, s.videoCount)}? This can't be undone.`)) return;
  readyBackup = null;
  for (const p of await DB.photosOf(s.id)) await deleteMedia(p);
  await DB.del('spots', s.id);
  spots.delete(s.id);
  removeMarker(s.id);
  current = null;
  closeSheet();
  updateNearest();
  toast('Spot deleted.');
}

const appleUrl = s => `https://maps.apple.com/?ll=${s.lat},${s.lng}&q=${encodeURIComponent(s.name || 'Spot')}`;
const googleUrl = s => `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
const dirUrl = s => `https://maps.apple.com/?daddr=${s.lat},${s.lng}`;

/* ---------- Sheet ---------- */
const sheet = $('#sheet');
const body = $('#sheetBody');
let sheetKind = null;
const sheetIsOpen = () => sheet.classList.contains('open');

function openSheet(kind) {
  sheetKind = kind;
  document.body.classList.add('sheet-open');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  body.scrollTop = 0;
}
function closeSheet() {
  sheet.classList.remove('open');
  document.body.classList.remove('sheet-open');
  sheet.setAttribute('aria-hidden', 'true');
  sheetKind = null;
  if (document.activeElement && sheet.contains(document.activeElement)) document.activeElement.blur();
  const prev = current;
  current = null;
  refreshSelection(prev);
}

// Drag the grab bar down to close.
(() => {
  let y0 = null;
  const grab = $('#grab');
  grab.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; sheet.classList.add('dragging'); }, { passive: true });
  grab.addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  grab.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    if (dy > 70) closeSheet();
  });
  grab.addEventListener('click', closeSheet);
})();

async function openSpot(id) {
  const s = spots.get(id);
  if (!s) return;
  const prev = current;
  current = id;
  refreshSelection(prev);
  const photos = (await DB.photosOf(id)).sort((a, b) => (a.takenAt || a.addedAt) - (b.takenAt || b.addedAt));
  const meta = [mediaLabel(photos.length, photos.filter(p => p.kind === 'video').length), `added ${fmtDate(s.createdAt)}`].join(' · ');
  body.innerHTML = `
    <div class="sheet-head">
      <textarea id="spotName" class="title" rows="1" placeholder="Name this spot" maxlength="80" aria-label="Spot name" enterkeyhint="done">${esc(s.name)}</textarea>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button>
    </div>
    <p class="meta">${meta}</p>
    <div class="strip">
      ${photos.map((p, i) => {
        const video = p.kind === 'video';
        const pic = p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : `<span class="tile-icon">${video ? ICON.play : ICON.photo}</span>`;
        return `<button class="tile${p.id === s.coverId ? ' is-cover' : ''}${video ? ' tile-video' : ''}" data-photo="${i}" aria-label="Open ${video ? 'video' : 'photo'} ${i + 1}">${pic}${video ? `<span class="dur">${ICON.play}${fmtDur(p.duration)}</span>` : ''}</button>`;
      }).join('')}
      <button class="tile tile-add" data-act="addPhotos">${ICON.plus}<span>Photo or video</span></button>
    </div>
    <label class="label" for="spotNotes">Notes</label>
    <textarea id="spotNotes" placeholder="Best time for light, parking, crowds, permits, outfit ideas">${esc(s.notes)}</textarea>
    <div class="rows">
      <a class="row" href="${appleUrl(s)}" target="_blank" rel="noopener">Open in Apple Maps <span>Look Around</span></a>
      <a class="row" href="${googleUrl(s)}" target="_blank" rel="noopener">Open in Google Maps <span>Street View, place photos</span></a>
      <a class="row" href="${dirUrl(s)}" target="_blank" rel="noopener">Directions</a>
      <button class="row" data-act="move">Move pin</button>
      <button class="row" data-act="copy">Copy coordinates <span>${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</span></button>
      <button class="row row-danger" data-act="delete">Delete spot</button>
    </div>`;

  const saveName = debounce(async v => { const cur = spots.get(id); if (!cur) return; cur.name = v.trim(); await saveSpot(cur); }, 400);
  const saveNotes = debounce(async v => { const cur = spots.get(id); if (!cur) return; cur.notes = v; await saveSpot(cur); }, 500);
  const nameEl = $('#spotName');
  const growName = () => { nameEl.style.height = 'auto'; nameEl.style.height = nameEl.scrollHeight + 'px'; };
  nameEl.addEventListener('input', e => { growName(); saveName(e.target.value.replace(/\n/g, ' ')); });
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
  growName();
  const ta = $('#spotNotes');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 260) + 'px'; };
  ta.addEventListener('input', e => { grow(); saveNotes(e.target.value); });
  grow();

  body.querySelectorAll('[data-photo]').forEach(b => b.addEventListener('click', () => openViewer(s, photos, +b.dataset.photo)));
  body.querySelector('[data-act="close"]').addEventListener('click', closeSheet);
  body.querySelector('[data-act="addPhotos"]').addEventListener('click', () => pickPhotos({ type: 'spot', id }));
  body.querySelector('[data-act="move"]').addEventListener('click', () => startPlacing('move', id));
  body.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSpot(spots.get(id)));
  body.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    const txt = `${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}`;
    try { await navigator.clipboard.writeText(txt); toast('Coordinates copied.'); } catch { toast(txt, 6000); }
  });

  const wasOpen = sheetIsOpen() && sheetKind === 'spot';
  openSheet('spot');
  if (!wasOpen) panAbove(s.lat, s.lng);
}

function listItem(s) {
  const img = s.coverThumb ? `<img src="${esc(s.coverThumb)}" alt="">` : `<span class="noimg">${ICON.photo}</span>`;
  const sub = [mediaLabel(+s.photoCount || 0, +s.videoCount || 0), s.notes ? s.notes.replace(/\s+/g, ' ').slice(0, 60) : ''].filter(Boolean).join(' · ');
  return `<button class="item" data-spot="${esc(s.id)}">${img}<span><b>${esc(s.name || 'Untitled spot')}</b><small>${esc(sub)}</small></span></button>`;
}

function openList(q = '') {
  const needle = q.trim().toLowerCase();
  const all = [...spots.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const hits = needle ? all.filter(s => `${s.name} ${s.notes}`.toLowerCase().includes(needle)) : all;
  body.innerHTML = `
    <div class="sheet-head">
      <h2>${needle ? 'Results' : 'Your spots'}</h2>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button>
    </div>
    <p class="meta">${needle ? `${plural(hits.length, 'spot')} ${hits.length === 1 ? 'matches' : 'match'} "${esc(q.trim())}"` : plural(all.length, 'spot')}</p>
    <div class="list">${hits.map(listItem).join('') || `<p class="empty">${needle ? 'None of your spots match.' : 'No spots yet. Tap Add spot, or press and hold anywhere on the map.'}</p>`}</div>
    ${needle ? `<p class="section">Places</p><div id="places"><button class="text-btn" data-act="places">Search places for "${esc(q.trim())}"</button></div>` : ''}`;
  body.querySelector('[data-act="close"]').addEventListener('click', closeSheet);
  body.querySelectorAll('[data-spot]').forEach(b => b.addEventListener('click', () => { $('#q').blur(); openSpot(b.dataset.spot); }));
  body.querySelector('[data-act="places"]')?.addEventListener('click', () => runPlaceSearch(q.trim()));
  openSheet('list');
  if (needle && placeQuery === q.trim()) runPlaceSearch(q.trim());
}

const placeCache = new Map();
let placeQuery = '';
async function runPlaceSearch(q) {
  placeQuery = q;
  const box = $('#places');
  if (!box) return;
  if (!placeCache.has(q)) box.innerHTML = '<p class="note">Searching...</p>';
  try {
    const res = placeCache.get(q) || await searchPlaces(q);
    placeCache.set(q, res);
    if (placeQuery !== q || !$('#places')) return;
    if (!res.length) { box.innerHTML = '<p class="note">No places found. Try adding the city name.</p>'; return; }
    box.innerHTML = res.map((r, i) => `<button class="item" data-place="${i}"><span class="noimg">${ICON.place}</span><span><b>${esc(r.name)}</b><small>${esc(r.sub)}</small></span></button>`).join('');
    box.querySelectorAll('[data-place]').forEach(b => b.addEventListener('click', () => {
      const r = res[+b.dataset.place];
      $('#q').blur();
      startPlacing('new', null, [r.lat, r.lng]);
      placing.name = r.name;
      $('#placeHint').textContent = 'Set here to save this place as a spot, or move the map first.';
    }));
  } catch {
    box.innerHTML = '<p class="note">Place search needs internet. Your own spots still work offline.</p>';
  }
}

async function openMenu() {
  const total = [...spots.values()].reduce((n, s) => n + (+s.photoCount || 0), 0);
  const videos = [...spots.values()].reduce((n, s) => n + (+s.videoCount || 0), 0);
  let used = '';
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.usage != null) used = `${(e.usage / 1048576).toFixed(0)} MB used, map tiles included`;
  } catch {}
  let kept = null;
  try { kept = await navigator.storage?.persisted?.(); } catch {}
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  body.innerHTML = `
    <div class="sheet-head">
      <h2>Backup &amp; storage</h2>
      <button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button>
    </div>
    <p class="meta">${esc([plural(spots.size, 'spot'), mediaLabel(total, videos), used].filter(Boolean).join(' · '))}</p>
    <p class="note">Everything is saved on this phone only. Nothing is uploaded. Make a backup now and then so you never lose your spots. Videos make the backup file big.</p>
    <div class="rows">
      <button class="row" data-act="export">Save a backup <span>to Files or iCloud Drive</span></button>
      <button class="row" data-act="import">Restore from a backup</button>
      <div class="row">Keep data on this phone <span>${kept === true ? 'On' : kept === false ? 'Not confirmed yet' : 'Unknown'}</span></div>
    </div>
    ${standalone ? '' : '<p class="note" style="margin-top:16px">To use it like an app: in Safari tap Share, then Add to Home Screen, then open Spots from your home screen. Your spots stay inside the home screen app.</p>'}
    <p class="note" style="margin-top:16px">Map &copy; OpenStreetMap contributors, OpenFreeMap, OpenMapTiles. Satellite &copy; Esri. Place search by Photon (komoot) and Nominatim.</p>`;
  body.querySelector('[data-act="close"]').addEventListener('click', closeSheet);
  body.querySelector('[data-act="export"]').addEventListener('click', exportBackup);
  body.querySelector('[data-act="import"]').addEventListener('click', () => $('#fileImport').click());
  openSheet('menu');
}

/* ---------- Viewer (photos + videos) ---------- */
let vState = null;
function openViewer(s, photos, i) {
  vState = { s, photos, i, url: null, blob: null };
  $('#viewer').hidden = false;
  showPhoto();
}
async function showPhoto() {
  const st = vState;
  if (!st) return;
  const p = st.photos[st.i];
  const img = $('#vImg'), vid = $('#vVid');
  vid.pause();
  $('#vCount').textContent = `${st.i + 1} / ${st.photos.length}`;
  $('#vDate').textContent = p.takenAt ? `Taken ${fmtDate(p.takenAt)}` : `Added ${fmtDate(p.addedAt)}`;
  $('#vCover').hidden = !p.thumb;
  $('#vCover').textContent = p.id === st.s.coverId ? 'Cover' : 'Make cover';
  const blob = await mediaBlob(p);
  if (vState !== st || st.photos[st.i] !== p) return; // moved on while loading
  if (st.url) URL.revokeObjectURL(st.url);
  st.blob = blob; // kept ready so Share can open the sheet right on the tap
  st.url = URL.createObjectURL(blob);
  if (p.kind === 'video') {
    img.hidden = true; img.removeAttribute('src');
    vid.hidden = false; vid.src = st.url;
  } else {
    vid.hidden = true; vid.removeAttribute('src'); vid.load();
    img.hidden = false; img.src = st.url;
  }
}
function closeViewer() {
  const vid = $('#vVid');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  if (vState?.url) URL.revokeObjectURL(vState.url);
  vState = null;
  $('#viewer').hidden = true;
  $('#vImg').removeAttribute('src');
}
function step(d) {
  if (!vState) return;
  const n = vState.photos.length;
  vState.i = (vState.i + d + n) % n;
  showPhoto();
}
(() => {
  let x0 = null, y0 = null;
  const img = $('#vImg'), vid = $('#vVid');
  for (const el of [img, vid]) {
    el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });
  }
  img.addEventListener('click', e => { step(e.clientX > window.innerWidth / 2 ? 1 : -1); });
  $('#vClose').addEventListener('click', closeViewer);
  document.addEventListener('keydown', e => {
    if (!vState) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
  $('#vShare').addEventListener('click', async () => {
    const st = vState;
    if (!st?.blob) return;
    const p = st.photos[st.i];
    const ext = p.kind === 'video' ? (/quicktime/.test(st.blob.type) ? 'mov' : /webm/.test(st.blob.type) ? 'webm' : 'mp4') : 'jpg';
    const file = new File([st.blob], `${(st.s.name || 'spot').replace(/[^\w-]+/g, '-')}-${st.i + 1}.${ext}`, { type: st.blob.type || (p.kind === 'video' ? 'video/mp4' : 'image/jpeg') });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch {}
    } else {
      const a = document.createElement('a');
      a.href = st.url; a.download = file.name; a.click();
    }
  });
  $('#vCover').addEventListener('click', async () => {
    const p = vState.photos[vState.i];
    if (!p.thumb) return;
    const s = spots.get(vState.s.id);
    s.coverId = p.id; s.coverThumb = p.thumb;
    vState.s = s;
    await saveSpot(s);
    $('#vCover').textContent = 'Cover';
    toast('Cover set.', 1500);
  });
  $('#vDel').addEventListener('click', async () => {
    const { photos, i } = vState;
    const p = photos[i];
    if (!confirm(`Delete this ${p.kind === 'video' ? 'video' : 'photo'}?`)) return;
    const s = spots.get(vState.s.id);
    await deleteMedia(p);
    photos.splice(i, 1);
    if (s.coverId === p.id) {
      const next = photos.find(x => x.thumb);
      s.coverId = next?.id || null; s.coverThumb = next?.thumb || null;
    }
    await recount(s);
    await saveSpot(s);
    if (!photos.length) { closeViewer(); }
    else { vState.s = s; vState.i = Math.min(i, photos.length - 1); showPhoto(); }
    openSpot(s.id);
  });
})();

/* ---------- Placing a pin ---------- */
function startPlacing(mode, spotId = null, at = null) {
  closeSheet();
  placing = { mode, spotId, pending: [] };
  document.body.classList.add('placing');
  $('#crosshair').hidden = false;
  $('#placeBar').hidden = false;
  $('#pPhoto').hidden = mode === 'move';
  $('#placeHint').textContent = mode === 'move'
    ? 'Move the map so the cross sits on the new spot, then tap Set here.'
    : 'Move the map so the cross sits on the spot. Or pick a photo or video to add (photos with a location jump the map there).';
  const target = at || (spotId && spots.get(spotId) && [spots.get(spotId).lat, spots.get(spotId).lng]);
  if (target) goTo(target[0], target[1]);
}
function stopPlacing() {
  placing = null;
  document.body.classList.remove('placing');
  $('#crosshair').hidden = true;
  $('#placeBar').hidden = true;
}

$('#pCancel').addEventListener('click', stopPlacing);
$('#pMe').addEventListener('click', () => locate(true));
$('#pPhoto').addEventListener('click', () => pickPhotos({ type: 'placing' }));
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast('Something went wrong saving that. Try again. If it keeps happening, make a backup from the ... menu.', 6000);
});

// Photos/videos still being read when Set here is tapped must not get lost: wait for them.
let filesBusy = null;
$('#pSet').addEventListener('click', async () => {
  if (!placing) return;
  const c = map.getCenter();
  const pl = placing;
  const { mode, spotId, name } = pl;
  stopPlacing();
  if (filesBusy) { toast('Finishing your photos and videos...', 60000); await filesBusy; $('#toast').hidden = true; }
  const pending = pl.pending;
  if (mode === 'move') {
    const s = spots.get(spotId);
    s.lat = c.lat; s.lng = c.lng;
    await saveSpot(s);
    await openSpot(spotId);
    toast('Pin moved.', 1500);
  } else {
    await newSpotAt(c, pending, name || '');
  }
});

/* ---------- Files ---------- */
function pickPhotos(target) {
  fileTarget = target;
  const input = $('#filePhotos');
  input.value = '';
  input.click();
}
$('#filePhotos').addEventListener('change', async e => {
  const files = [...e.target.files];
  const target = fileTarget;
  fileTarget = null;
  if (!files.length || !target) return;
  const pl = target.type === 'placing' ? placing : null;
  const job = processFiles(files);
  filesBusy = job;
  const processed = await job;
  if (filesBusy === job) filesBusy = null;
  if (!processed.length) return;
  if (pl) {
    pl.pending.push(...processed);
    if (placing !== pl) return; // Set here was already tapped; it picks these up
    const ready = mediaLabel(pl.pending.length, pl.pending.filter(p => p.kind === 'video').length);
    const g = processed.find(p => p.gps)?.gps;
    if (g) {
      goTo(g.latitude, g.longitude, 18);
      $('#placeHint').textContent = `${ready} ready. Jumped to where the photo was taken. Fine-tune, then Set here.`;
    } else if (processed.every(p => p.kind === 'video')) {
      $('#placeHint').textContent = `${ready} ready. iPhone doesn't share a video's location with web apps, so tap My location or move the map, then Set here.`;
    } else {
      $('#placeHint').textContent = `${ready} ready, but no location inside. Next time tap Options > Location when picking. Tap My location or move the map, then Set here.`;
    }
  } else if (target.type === 'spot') {
    const s = spots.get(target.id);
    if (!s) return;
    const n = await attachPhotos(s, processed);
    await openSpot(s.id);
    if (n) toast(`${mediaLabel(n, processed.filter(p => p.kind === 'video').length)} added.`, 1800);
  }
});

const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();

/* Backup file (.spots): "SPOTS2\n" + 12-digit header length + "\n" + JSON header + raw media bytes.
   Built from Blob parts, so big videos are never copied into memory or turned into text. */
const MAGIC = 'SPOTS2\n';
// Two taps on purpose: iPhone only opens the share sheet right after a tap,
// and packing takes longer than that. Tap 1 packs, tap 2 shares.
let readyBackup = null;
async function exportBackup() {
  const row = body.querySelector('[data-act="export"]');
  if (readyBackup) return saveBackupFile(readyBackup);
  if (row) row.innerHTML = 'Packing backup... <span>photos and videos included</span>';
  try {
    const parts = [], media = [];
    let offset = 0;
    for (const rec of await DB.all('photos')) {
      const b = await mediaBlob(rec);
      const { data, blob, chunks, ...meta } = rec;
      media.push({ ...meta, kind: meta.kind || 'photo', type: b.type || meta.type, offset, size: b.size });
      parts.push(b);
      offset += b.size;
    }
    const header = new TextEncoder().encode(JSON.stringify({ app: 'spot-map', version: 2, exportedAt: new Date().toISOString(), spots: [...spots.values()], media }));
    const name = `spots-backup-${new Date().toISOString().slice(0, 10)}.spots`;
    readyBackup = new File([MAGIC, String(header.length).padStart(12, '0'), '\n', header, ...parts], name, { type: 'application/octet-stream' });
    if (row && row.isConnected) row.innerHTML = `Backup ready, tap to save <span>${(readyBackup.size / 1048576).toFixed(1)} MB</span>`;
  } catch {
    readyBackup = null;
    if (row) row.innerHTML = 'Save a backup <span>to Files or iCloud Drive</span>';
    toast('Backup failed. Try again with fewer apps open.');
  }
}
async function saveBackupFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Spots backup' }); readyBackup = null; if (sheetKind === 'menu') openMenu(); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  readyBackup = null;
  toast('Backup saved.');
  if (sheetKind === 'menu') openMenu();
}

// Restore. A backup file is untrusted input: every record is rebuilt from typed, allowed fields.
$('#fileImport').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const str = (v, max) => String(v ?? '').slice(0, max);
  const num = v => (Number.isFinite(+v) ? +v : 0);
  const isId = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
  const isImg = v => typeof v === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
  const PHOTO_TYPE = /^image\/(jpeg|png|webp|gif|heic|heif)$/, VIDEO_TYPE = /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/;
  try {
    let data, items; // items: [{ meta, getBlob }]
    const head = new TextDecoder().decode(await f.slice(0, 20).arrayBuffer());
    if (head.startsWith(MAGIC)) {
      const len = parseInt(head.slice(7, 19), 10);
      if (!(len > 0 && 20 + len <= f.size)) throw new Error('bad header');
      data = JSON.parse(await f.slice(20, 20 + len).text());
      const start = 20 + len;
      items = (data.media || []).map(m => ({
        meta: m,
        getBlob: () => {
          const o = num(m.offset), n = num(m.size);
          if (o < 0 || n <= 0 || start + o + n > f.size) throw new Error('bad media range');
          return f.slice(start + o, start + o + n, PHOTO_TYPE.test(m.type) || VIDEO_TYPE.test(m.type) ? m.type : '');
        },
      }));
    } else {
      data = JSON.parse(await f.text()); // version 1 backups (photos as text)
      items = (data.photos || []).map(p => ({ meta: { ...p, kind: 'photo' }, getBlob: () => { if (!isImg(p.blob)) throw new Error('bad photo'); return dataURLToBlob(p.blob); } }));
    }
    if (data.app !== 'spot-map' || !Array.isArray(data.spots)) throw new Error('not a backup');
    toast('Restoring...', 60000);
    let ns = 0, np = 0, nv = 0;
    const touched = new Set();
    for (const raw of data.spots) {
      if (!isId(raw.id) || spots.has(raw.id)) continue;
      const lat = +raw.lat, lng = +raw.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const s = {
        id: raw.id, name: str(raw.name, 80), notes: str(raw.notes, 5000), lat, lng,
        createdAt: num(raw.createdAt) || Date.now(), updatedAt: num(raw.updatedAt) || Date.now(),
        coverId: isId(raw.coverId) ? raw.coverId : null,
        coverThumb: isImg(raw.coverThumb) ? raw.coverThumb : null,
        photoCount: 0, videoCount: 0,
      };
      await DB.put('spots', s); spots.set(s.id, s); touched.add(s.id); ns++;
    }
    for (const { meta: m, getBlob } of items) {
      if (!isId(m.id) || !isId(m.spotId) || !spots.has(m.spotId)) continue;
      if (await DB.get('photos', m.id)) continue;
      let b;
      try { b = await getBlob(); } catch { continue; }
      const video = m.kind === 'video';
      if (!(video ? VIDEO_TYPE.test(b.type) : PHOTO_TYPE.test(b.type))) continue;
      const rec = { id: m.id, spotId: m.spotId, kind: video ? 'video' : 'photo', thumb: isImg(m.thumb) ? m.thumb : '', takenAt: num(m.takenAt) || null, addedAt: num(m.addedAt) || Date.now() };
      if (video) await putVideo({ ...rec, type: b.type, duration: num(m.duration), size: b.size }, b, true);
      else await DB.put('photos', { ...rec, type: b.type, data: await b.arrayBuffer() });
      touched.add(m.spotId); np++; if (video) nv++;
    }
    for (const id of touched) { const s = spots.get(id); await recount(s); await DB.put('spots', s); renderMarker(s); }
    readyBackup = null;
    updateNearest();
    toast(`Restored ${plural(ns, 'spot')} and ${mediaLabel(np, nv)}.`);
    if (sheetKind === 'menu') openMenu();
  } catch {
    toast('That file is not a Spots backup.');
  }
});

/* ---------- You + the nearest spot ---------- */
let myPos = null, watchId = null, nearestKey = '';
// You: blue dot + a ring showing how accurate the fix is (real size on the map).
let myAcc = 0, flewToMe = false, userMovedMap = false;
function sizeAccuracy() {
  if (!meDot || !myPos) return;
  const mPerPx = 40075016.686 * Math.cos(myPos.lat * Math.PI / 180) / (512 * 2 ** map.getZoom());
  const d = Math.min(600, Math.max(0, (2 * myAcc) / mPerPx));
  const ring = meDot.getElement().querySelector('.me-acc');
  ring.style.width = ring.style.height = `${d}px`;
  ring.style.opacity = d > 30 ? '1' : '0';
}
function placeMe(lat, lng) {
  if (!meDot) {
    const el = document.createElement('div');
    el.className = 'me';
    el.innerHTML = '<span class="me-acc"></span><span class="me-pulse"></span><span class="me-dot"></span>';
    el.setAttribute('aria-label', 'You are here');
    meDot = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(ll(lat, lng)).addTo(map);
    el.style.zIndex = 5;
    map.on('zoom', sizeAccuracy);
  } else meDot.setLngLat(ll(lat, lng));
  sizeAccuracy();
}
function locationBlocked() {
  $('#btnLocate').classList.add('blocked');
  toast('Location is off for Spots. On your iPhone: Settings > Privacy & Security > Location Services (on) > Safari Websites > While Using the App. Then close and reopen Spots.', 10000);
}
function startWatch() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(p => {
    myPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    myAcc = p.coords.accuracy || 0;
    $('#btnLocate').classList.remove('blocked');
    placeMe(myPos.lat, myPos.lng);
    // First fix after opening: go to you, unless you already moved the map yourself.
    if (!flewToMe && !userMovedMap && !placing && !sheetIsOpen()) {
      flewToMe = true;
      map.flyTo({ center: ll(myPos.lat, myPos.lng), zoom: Math.max(map.getZoom(), 15), duration: 900 });
    }
    updateNearest();
  }, err => {
    if (err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; locationBlocked(); }
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function metersBetween(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = m => (m < 160 ? `${Math.round(m * 3.281 / 10) * 10 || 10} ft away` : `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi away`);
async function updateNearest() {
  const card = $('#nearest');
  if (!myPos || !spots.size) { card.hidden = true; document.body.classList.remove('has-nearest'); return; }
  let best = null, bestD = Infinity;
  for (const s of spots.values()) { const d = metersBetween(myPos, s); if (d < bestD) { bestD = d; best = s; } }
  card.hidden = false;
  document.body.classList.add('has-nearest');
  card.dataset.spot = best.id;
  $('#nDist').textContent = `Nearest spot · ${fmtDist(bestD)}`;
  $('#nName').textContent = best.name || 'Untitled spot';
  const key = `${best.id}:${best.updatedAt}`;
  if (key === nearestKey) return;
  nearestKey = key;
  const media = (await DB.photosOf(best.id)).sort((a, b) => (a.takenAt || a.addedAt) - (b.takenAt || b.addedAt));
  if (nearestKey !== key) return;
  const shown = media.filter(p => p.thumb).slice(0, 2);
  $('#nThumbs').innerHTML = shown.map(p => `<span class="n-thumb${p.kind === 'video' ? ' is-video' : ''}"><img src="${esc(p.thumb)}" alt="">${p.kind === 'video' ? ICON.play : ''}</span>`).join('')
    + (media.length > shown.length ? `<span class="n-more">+${media.length - shown.length}</span>` : '');
  $('#nName').title = mediaLabel(media.length, media.filter(p => p.kind === 'video').length);
}
$('#nearest').addEventListener('click', () => { const id = $('#nearest').dataset.spot; if (id && !placing) openSpot(id); });

/* ---------- Wiring ---------- */
$('#btnAdd').addEventListener('click', () => startPlacing('new'));
$('#btnLocate').addEventListener('click', () => locate(true));
$('#btnLayer').addEventListener('click', toggleLayer);
$('#btn3d').addEventListener('click', toggle3d);
$('#btnList').addEventListener('click', () => (sheetKind === 'list' ? closeSheet() : openList($('#q').value)));
$('#btnMenu').addEventListener('click', () => (sheetKind === 'menu' ? closeSheet() : openMenu()));
const q = $('#q');
q.addEventListener('input', debounce(() => { if (q.value.trim()) openList(q.value); else if (sheetKind === 'list') closeSheet(); }, 150));
q.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (!q.value.trim()) return;
  placeQuery = q.value.trim();
  openList(q.value);
  q.blur();
});

async function boot() {
  const fresh = initMap();
  $('#btnLayer').classList.toggle('on', layerKey === 'sat');
  try {
    for (const s of await DB.all('spots')) { spots.set(s.id, s); renderMarker(s); }
  } catch {
    toast('Could not open saved spots on this browser.', 6000);
  }
  if (fresh && spots.size) {
    const b = new maplibregl.LngLatBounds();
    spots.forEach(s => b.extend(ll(s.lat, s.lng)));
    map.fitBounds(b, { padding: 90, maxZoom: 15, duration: 0 });
  }
  startWatch(); // live blue dot; iPhone asks for location the first time
  if (spots.size) askPersist();
  else toast('Tap Add spot, or press and hold anywhere on the map, to save your first spot.', 6000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
