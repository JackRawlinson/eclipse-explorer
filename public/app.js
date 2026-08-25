// Eclipse Mapper — draws precomputed eclipse geometry on a MapLibre map.
// All the astronomy happens at build time; this file only fetches and renders.

import * as maplibregl from './vendor/maplibre-gl.mjs';
import { localCircumstances, toUT } from './circumstances.js';

const NASA_ACK = "Eclipse Predictions by Fred Espenak, NASA's GSFC";
// OpenFreeMap's styles, quietest first. `dark` here means the paint palette and
// the panels flip, not that the basemap is literally black.
const BASEMAPS = [
  { id: 'positron', label: 'Light', dark: false },
  { id: 'liberty', label: 'Liberty', dark: false },
  { id: 'bright', label: 'Bright', dark: false },
  { id: 'fiord', label: 'Fiord', dark: true },
  { id: 'dark', label: 'Dark', dark: true },
];
const styleUrl = (id) => `https://tiles.openfreemap.org/styles/${id}`;
const DEFAULT_BASEMAP = 'liberty';

// Painted onto the mask in the browser. A near-neutral slate: the shading has to
// sit under any basemap, and a coloured wash over a coloured sea reads as nothing.
const SHADING_DEFAULTS = { tint: '334155', shade: 0.3, gamma: 0.85 };

function readShadingOptions() {
  const q = new URLSearchParams(location.search);
  const num = (k) => (q.has(k) && Number.isFinite(Number(q.get(k)))
    ? Number(q.get(k)) : SHADING_DEFAULTS[k]);
  const hex = (q.get('tint') || SHADING_DEFAULTS.tint).replace('#', '');
  return {
    rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0),
    shade: Math.min(1, Math.max(0, num('shade'))),
    gamma: Math.max(0.1, num('gamma')),
    key: `${hex}-${num('shade')}-${num('gamma')}`,
  };
}

const PAINT = {
  light: {
    total: '#4c1d95', annular: '#c2410c', penumbra: '#475569',
    central: '#0f172a', centralCasing: '#ffffff',
    greatest: '#dc2626', mark: '#0f172a', markHalo: '#ffffff',
    bandLow: '#93c5fd', bandHigh: '#1e3a8a', bandLine: '#1d4ed8',
  },
  dark: {
    total: '#a78bfa', annular: '#fb923c', penumbra: '#94a3b8',
    central: '#f8fafc', centralCasing: '#0b1120',
    greatest: '#f87171', mark: '#f8fafc', markHalo: '#0b1120',
    bandLow: '#1e3a8a', bandHigh: '#93c5fd', bandLine: '#60a5fa',
  },
};

const TYPES = [
  { key: 'total', label: 'Total' },
  { key: 'annular', label: 'Annular' },
  { key: 'hybrid', label: 'Hybrid' },
  { key: 'partial', label: 'Partial' },
];

const EMPTY = { type: 'FeatureCollection', features: [] };
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const MERCATOR_LIMIT = 85.051129;
const WORLD_CORNERS = [[-180, MERCATOR_LIMIT], [180, MERCATOR_LIMIT],
                       [180, -MERCATOR_LIMIT], [-180, -MERCATOR_LIMIT]];
const $ = (id) => document.getElementById(id);

const state = {
  all: [],
  shown: [],
  current: null,
  query: '',
  types: new Set(),
  basemap: (() => {
    const want = new URLSearchParams(location.search).get('basemap') || DEFAULT_BASEMAP;
    const found = BASEMAPS.findIndex((b) => b.id === want);
    return found >= 0 ? found : 0;
  })(),
  theme: 'light',
  // How the obscuration mask is painted. The mask itself carries no colour, so
  // all three are live: ?tint=334155&shade=0.3&gamma=0.85 tries alternatives
  // without regenerating a single image.
  shading: readShadingOptions(),
  elements: null,       // Besselian elements of the selected eclipse
  version: '',          // build stamp, appended to data URLs to defeat caching
  gradient: true,       // smooth shading, versus stepped contour bands
  globe: false,
};

const geoCache = new Map();
const maskCache = new Map();   // painted masks, keyed by source and appearance
let shadingUrl = null;
let loadToken = 0;
let map;
let popup = null;

// ------------------------------------------------------------------- map

function buildMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: styleUrl(BASEMAPS[state.basemap].id),
    center: [0, 20],
    zoom: 1.3,
    minZoom: 0.6,
    maxZoom: 14,
    attributionControl: false,
    dragRotate: false,
  });

  window.__map = map;   // handy for debugging from the console

  map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: NASA_ACK,
  }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), 'bottom-right');
  map.addControl(buttonGroup(), 'top-right');

  map.on('click', (ev) => showCircumstances(ev.lngLat));
  map.on('mouseout', () => { map.getCanvas().style.cursor = ''; });
  map.getCanvas().style.cursor = 'crosshair';

  map.on('style.load', () => {
    addEclipseLayers();
    if (state.current) {
      setMapData(geoCache.get(state.current.id) || EMPTY);
      setShading(state.current);
    }
  });
}

function buttonGroup() {
  return {
    onAdd() {
      const div = document.createElement('div');
      div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      div.append(
        mapButton('⌖', 'Reset view to this eclipse', () => fitToCurrent()),
        mapButton('◐', 'Change the basemap', cycleBasemap),
        mapButton('◍', 'Switch between flat and globe', toggleGlobe),
        mapButton('▦', 'Switch between smooth shading and stepped bands', toggleGradient),
      );
      return div;
    },
    onRemove() {},
  };
}

function mapButton(glyph, title, onClick) {
  const b = document.createElement('button');
  if (title.startsWith('Change the basemap')) b.dataset.role = 'basemap';
  b.type = 'button';
  b.className = 'map-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.textContent = glyph;
  b.addEventListener('click', onClick);
  return b;
}

function addEclipseLayers() {
  const c = PAINT[state.theme];
  if (!map.getSource('eclipse')) {
    map.addSource('eclipse', { type: 'geojson', data: EMPTY });
  }

  if (!map.getSource('shading')) {
    map.addSource('shading', { type: 'image', url: BLANK_PNG,
                               coordinates: WORLD_CORNERS });
  }

  const is = (kind) => ['==', ['get', 'kind'], kind];
  const byFlavour = ['match', ['get', 'flavour'], 'annular', c.annular, c.total];

  if (map.getLayer('shading')) map.removeLayer('shading');
  map.addLayer({ id: 'shading', type: 'raster', source: 'shading',
                 paint: { 'raster-opacity': state.gradient ? 1 : 0,
                          'raster-fade-duration': 0,
                          'raster-resampling': 'linear' } });

  add({ id: 'band-fill', type: 'fill', filter: is('band'),
        paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'level'],
                                0.2, c.bandLow, 0.9, c.bandHigh],
                 'fill-opacity': state.gradient ? 0 : 0.09 } });
  add({ id: 'band-line', type: 'line', filter: is('band'),
        paint: { 'line-color': c.bandLine, 'line-opacity': 0.55, 'line-width': 0.9 } });
  add({ id: 'band-label', type: 'symbol', filter: is('band'), minzoom: 1.5,
        layout: { 'symbol-placement': 'line', 'text-field': ['concat',
                    ['to-string', ['round', ['*', ['get', 'level'], 100]]], '%'],
                  'text-size': 10, 'text-font': ['Noto Sans Regular'],
                  'symbol-spacing': 320, 'text-allow-overlap': false },
        paint: { 'text-color': c.bandLine, 'text-halo-color': c.markHalo,
                 'text-halo-width': 1.8 } });

  add({ id: 'penumbra-fill', type: 'fill', filter: is('penumbra'),
        paint: { 'fill-color': c.penumbra,
                 'fill-opacity': state.gradient ? 0 : 0.10 } });
  add({ id: 'penumbra-line', type: 'line', filter: is('penumbra'),
        paint: { 'line-color': c.penumbra, 'line-opacity': 0.55,
                 'line-width': 1, 'line-dasharray': [3, 2] } });

  add({ id: 'path-fill', type: 'fill', filter: is('path'),
        paint: { 'fill-color': byFlavour, 'fill-opacity': 0.32 } });
  add({ id: 'path-line', type: 'line', filter: is('path'),
        paint: { 'line-color': byFlavour, 'line-opacity': 0.9,
                 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 8, 1.8] } });

  add({ id: 'central-casing', type: 'line', filter: is('centralLine'),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.centralCasing,
                 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.6, 8, 4.4] } });
  add({ id: 'central-line', type: 'line', filter: is('centralLine'),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': c.central,
                 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.1, 8, 2] } });

  add({ id: 'mark-dot', type: 'circle', filter: is('timeMark'),
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2, 8, 3.5],
                 'circle-color': c.mark, 'circle-stroke-color': c.markHalo,
                 'circle-stroke-width': 1 } });
  add({ id: 'mark-label', type: 'symbol', filter: is('timeMark'),
        minzoom: 3,
        layout: { 'text-field': ['get', 'label'], 'text-size': 11,
                  'text-offset': [0, -1], 'text-anchor': 'bottom',
                  'text-font': ['Noto Sans Regular'], 'text-allow-overlap': false },
        paint: { 'text-color': c.mark, 'text-halo-color': c.markHalo,
                 'text-halo-width': 1.4 } });

  add({ id: 'greatest-dot', type: 'circle', filter: is('greatest'),
        paint: { 'circle-radius': 5, 'circle-opacity': 0,
                 'circle-stroke-color': c.greatest, 'circle-stroke-width': 2.5 } });

  function add(layer) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    map.addLayer({ source: 'eclipse', ...layer });
  }
}

function setMapData(fc) {
  const src = map.getSource('eclipse');
  if (src) src.setData(fc);
}

async function setShading(entry) {
  if (!map.getSource('shading')) return;
  if (!entry.shading) { applyShadingImage(BLANK_PNG); return; }
  try {
    const painted = await paintMask(dataUrl(`${entry.id}.png`));
    if (state.current?.id === entry.id) applyShadingImage(painted);
  } catch (err) {
    applyShadingImage(BLANK_PNG);          // the contours still carry the numbers
    console.warn('could not paint the shading mask', err);
  }
}

function applyShadingImage(url) {
  const src = map.getSource('shading');
  if (src) src.updateImage({ url, coordinates: WORLD_CORNERS });
  if (shadingUrl && shadingUrl !== url) URL.revokeObjectURL(shadingUrl);
  shadingUrl = url.startsWith('blob:') ? url : null;
}

/**
 * Colour the obscuration mask. What ships is a single grey channel holding
 * obscuration itself; the tint, the opacity and the curve are applied here, so
 * changing how the shading looks costs a repaint rather than a rebuild.
 */
async function paintMask(url) {
  const { rgb, shade, gamma, key } = state.shading;
  const cached = maskCache.get(url + key);
  if (cached) return cached;

  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  const [r, g, b] = rgb;
  // A lookup beats calling pow a third of a million times.
  const alphaFor = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    alphaFor[v] = Math.round((v / 255) ** gamma * shade * 255);
  }
  for (let i = 0; i < px.length; i += 4) {
    px[i + 3] = alphaFor[px[i]];            // grey level is the obscuration
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
  ctx.putImageData(image, 0, 0);

  const blobUrl = await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/png');
  });
  if (maskCache.size > 12) {
    const oldest = maskCache.keys().next().value;
    URL.revokeObjectURL(maskCache.get(oldest));
    maskCache.delete(oldest);
  }
  maskCache.set(url + key, blobUrl);
  return blobUrl;
}

function cycleBasemap() {
  state.basemap = (state.basemap + 1) % BASEMAPS.length;
  const chosen = BASEMAPS[state.basemap];
  state.theme = chosen.dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;   // panels follow the map
  map.setStyle(styleUrl(chosen.id));                      // style.load re-adds ours
  const btn = document.querySelector('.map-btn[data-role="basemap"]');
  if (btn) btn.title = `Basemap: ${chosen.label} — click to change`;
}

function toggleGradient() {
  state.gradient = !state.gradient;
  if (map.getLayer('shading')) {
    map.setPaintProperty('shading', 'raster-opacity', state.gradient ? 1 : 0);
  }
  if (map.getLayer('band-fill')) {
    map.setPaintProperty('band-fill', 'fill-opacity', state.gradient ? 0 : 0.09);
  }
  if (map.getLayer('penumbra-fill')) {
    map.setPaintProperty('penumbra-fill', 'fill-opacity', state.gradient ? 0 : 0.10);
  }
}

function toggleGlobe() {
  state.globe = !state.globe;
  if (!state.globe) {
    try { map.setProjection({ type: 'mercator' }); fitToCurrent(); } catch { /* nothing to undo */ }
    return;
  }
  // MapLibre has called the round one both things across versions
  for (const type of ['globe', 'vertical-perspective']) {
    try {
      map.setProjection({ type });
      fitToCurrent();          // the globe can show the poles, so reframe
      return;
    } catch { /* try the other name */ }
  }
  state.globe = false;
}

// ------------------------------------------------- what you would see there

function closePopup() {
  if (popup) { popup.remove(); popup = null; }
}

function showCircumstances(lngLat) {
  if (!state.elements) return;
  closePopup();
  const seen = localCircumstances(state.elements, lngLat.lat, lngLat.lng);
  popup = new maplibregl.Popup({ closeButton: true, maxWidth: '17rem' })
    .setLngLat(lngLat)
    .setHTML(circumstancesHTML(seen, lngLat))
    .addTo(map);
}

function circumstancesHTML(s, lngLat) {
  const where = `<p class="pop__where">${formatLatLon(lngLat.lat, lngLat.lng, 3)}</p>`;
  if (!s) {
    return `<p class="pop__head pop__head--none">No eclipse here</p>
            <p class="pop__note">The Sun is either untouched or below the horizon
            throughout.</p>${where}`;
  }

  const el = state.elements;
  const clock = (t) => hms(toUT(el, t));
  const rows = [];

  const head = s.durationS
    ? `<p class="pop__head pop__head--${s.total ? 'total' : 'annular'}">`
      + `${s.total ? 'Totality' : 'Annularity'} ${formatDuration(s.durationS)}</p>`
    : `<p class="pop__head">${(s.obscuration * 100).toFixed(1)}% of the Sun covered</p>`;

  if (s.durationS) {
    rows.push([s.total ? 'Totality' : 'Annularity', `${clock(s.c2)} – ${clock(s.c3)} UT`]);
    rows.push(['Obscuration', `${(s.obscuration * 100).toFixed(1)}%`]);
  }
  rows.push(['Maximum', `${clock(s.tMax)} UT`]);
  rows.push(['Magnitude', s.magnitude.toFixed(3)]);
  rows.push(['Sun altitude', `${s.sunAlt.toFixed(0)}°`]);
  if (s.c1 !== undefined && s.c4 !== undefined) {
    rows.push(['Partial', `${clock(s.c1)} – ${clock(s.c4)} UT`]);
  }

  const notes = [];
  if (s.c1Alt !== undefined && s.c1Alt < 0) notes.push('already under way at sunrise');
  if (s.c4Alt !== undefined && s.c4Alt < 0) notes.push('still under way at sunset');
  if (s.sunAlt < 5) notes.push('the Sun is very low — the horizon may be in the way');

  return head
    + '<dl class="pop__facts">'
    + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    + '</dl>'
    + (notes.length ? `<p class="pop__note">${notes.join('; ')}.</p>` : '')
    + where;
}

function hms(hours) {
  const total = Math.round(((hours % 24) + 24) % 24 * 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

// ------------------------------------------------------------------ data

/** Data URLs carry the build stamp, so a rebuild is never served from cache. */
const dataUrl = (name) =>
  `data/${name}${state.version ? `?v=${encodeURIComponent(state.version)}` : ''}`;

async function loadGeometry(id) {
  if (geoCache.has(id)) return geoCache.get(id);
  const res = await fetch(dataUrl(`${id}.geojson`));
  if (!res.ok) throw new Error(`no data for ${id}`);
  const fc = await res.json();
  geoCache.set(id, fc);
  if (geoCache.size > 40) geoCache.delete(geoCache.keys().next().value);
  return fc;
}

function prefetchNeighbours(id) {
  const i = state.all.findIndex((e) => e.id === id);
  for (const j of [i - 1, i + 1]) {
    const e = state.all[j];
    if (e && !geoCache.has(e.id)) loadGeometry(e.id).catch(() => {});
  }
}

// ------------------------------------------------------------- selection

async function select(id, { fit = true, push = true, replace = false } = {}) {
  const entry = state.all.find((e) => e.id === id);
  if (!entry) return;

  state.current = entry;
  renderInfo(entry);
  markCurrentInList();
  $('stepper-now').textContent = formatDate(entry.date, true);
  updateStepper();

  if (push) {
    const url = `${location.pathname}?e=${id}`;
    if (replace) history.replaceState({ id }, '', url);
    else if (location.search !== `?e=${id}`) history.pushState({ id }, '', url);
  }

  const token = ++loadToken;
  $('info').classList.add('is-busy');
  try {
    const fc = await loadGeometry(id);
    if (token !== loadToken) return;
    state.elements = fc.properties?.elements || null;
    closePopup();
    setMapData(fc);
    setShading(entry);
    if (fit) fitTo(entry);
    prefetchNeighbours(id);
  } catch (err) {
    if (token === loadToken) setMapData(EMPTY);
    console.error(err);
  } finally {
    if (token === loadToken) $('info').classList.remove('is-busy');
  }
}

function fitTo(entry) {
  if (!entry.bbox) return;
  let [w, s, e, n] = entry.bbox;
  const span = e - w;          // stored unwrapped, so a path across +/-180 reads as one run
  if (span >= 360) {
    [w, e] = [-180, 180];
  } else {
    w = ((w + 180) % 360 + 360) % 360 - 180;
    e = w + span;
    if (e > 180) e -= 360;     // west greater than east is how MapLibre is told to cross
  }
  // Web Mercator stops at 85 deg, so a path that runs over the pole would have us
  // fit to latitudes the projection cannot draw and waste half the view on nothing.
  const limit = state.globe ? 89 : 80;
  s = Math.max(s, -limit);
  n = Math.min(n, limit);
  if (n - s < 2) { s -= 1; n += 1; }
  map.fitBounds([[w, s], [e, n]], { padding: fitPadding(), duration: 700, maxZoom: 7 });
}

function fitToCurrent() {
  if (state.current) fitTo(state.current);
}

function fitPadding() {
  const narrow = window.innerWidth < 736;
  if (narrow) {
    return { top: 24, bottom: Math.min(window.innerHeight * 0.5, 300), left: 24, right: 24 };
  }
  const picker = $('picker');
  return { top: 24, bottom: 40, left: picker.offsetWidth + 32, right: 70 };
}

function step(delta) {
  const list = state.shown.length ? state.shown : state.all;
  const i = indexInList(list);
  const next = list[i === -1 ? (delta > 0 ? 0 : list.length - 1) : i + delta];
  if (next) select(next.id);
}

function indexInList(list) {
  const id = state.current?.id;
  return id ? list.findIndex((e) => e.id === id) : -1;
}

function updateStepper() {
  const list = state.shown.length ? state.shown : state.all;
  const i = indexInList(list);
  $('prev').disabled = i === 0 || !list.length;
  $('next').disabled = i === list.length - 1 || !list.length;
}

// --------------------------------------------------------------- the list

function applyFilters() {
  const q = state.query.trim().toLowerCase();
  state.shown = state.all.filter((e) => {
    if (state.types.size && !state.types.has(e.type)) return false;
    return !q || e.search.includes(q);
  });
  renderList();
  updateStepper();
}

function renderList() {
  const ul = $('list');
  const frag = document.createDocumentFragment();
  for (const e of state.shown) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = e.id;
    b.title = `${formatDate(e.date)} — ${e.type} (${e.typeCode}), saros ${e.saros}`;
    b.innerHTML = `<span class="list__date">${formatDate(e.date, true)}</span>`
      + `<span class="badge badge--${e.type}">${e.type.slice(0, 3)}</span>`;
    li.append(b);
    frag.append(li);
  }
  ul.replaceChildren(frag);
  $('count').textContent = `${state.shown.length} of ${state.all.length} eclipses`;
  markCurrentInList();
}

function markCurrentInList() {
  const ul = $('list');
  for (const b of ul.querySelectorAll('button')) {
    const on = b.dataset.id === state.current?.id;
    if (on) {
      b.setAttribute('aria-current', 'true');
      b.scrollIntoView({ block: 'nearest' });
    } else {
      b.removeAttribute('aria-current');
    }
  }
}

// -------------------------------------------------------------- the facts

function renderInfo(e) {
  $('info-title').textContent = formatDate(e.date);

  const rows = [
    ['Type', `${titleCase(e.type)}<span class="facts__code"> (${e.typeCode})</span>`],
    ['Magnitude', e.magnitude.toFixed(4)],
    ['Gamma', signed(e.gamma, 4)],
    ['Saros', String(e.saros)],
    ['Greatest at', `${e.greatest.ut} UT`],
    ['…located', formatLatLon(e.greatest.lat, e.greatest.lon)],
    ['…Sun altitude', `${e.greatest.sunAlt.toFixed(0)}°`],
  ];
  if (e.centralDurationS) rows.push(['Max duration', formatDuration(e.centralDurationS)]);
  if (e.pathWidthKm) rows.push(['Path width', `${Math.round(e.pathWidthKm)} km`]);
  if (e.pathBegins) rows.push(['Path on ground', `${e.pathBegins}–${e.pathEnds} UT`]);
  if (e.partialBegins) rows.push(['Partial phase', `${e.partialBegins}–${e.partialEnds} UT`]);
  rows.push(['ΔT used', `${e.deltaT.toFixed(1)} s`]);

  const dl = document.createElement('dl');
  dl.className = 'facts';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.innerHTML = v;
    dl.append(dt, dd);
  }
  const note = noteFor(e);
  if (note) {
    const p = document.createElement('p');
    p.className = 'facts__note';
    p.textContent = note;
    dl.append(p);
  }
  $('facts').replaceChildren(dl);

  const show = {
    band: true,
    total: e.type === 'total' || e.type === 'hybrid',
    annular: e.type === 'annular' || e.type === 'hybrid',
    central: e.hasPath,
    marks: e.hasPath,
    penumbra: true,
    greatest: true,
  };
  for (const li of $('legend').children) li.hidden = !show[li.dataset.key];
}

function noteFor(e) {
  if (!e.hasPath) {
    return 'The Moon’s umbra misses the Earth, so there is no path of totality — '
      + 'only the region where a partial eclipse is visible.';
  }
  if (e.type === 'hybrid') {
    return 'Hybrid: the eclipse changes between annular and total along the path, '
      + 'as the Earth’s curvature carries the surface in and out of the umbra. '
      + 'Each leg is drawn in its own colour.';
  }
  return null;
}

// ------------------------------------------------------------- formatting

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso, short = false) {
  const [y, m, d] = iso.split('-');
  return short ? `${y} ${MONTHS[+m - 1]} ${+d}`
               : `${+d} ${MONTHS[+m - 1]} ${y}`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function formatLatLon(lat, lon, dp = 1) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(dp)}°${ns} ${Math.abs(lon).toFixed(dp)}°${ew}`;
}

const signed = (v, dp) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp);
const titleCase = (s) => s[0].toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ chrome

function buildChips() {
  const box = $('chips');
  for (const { key, label } of TYPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<i class="chip__dot" style="background:var(--${key === 'partial' ? 'penumbra' : key === 'hybrid' ? 'greatest' : key})"></i>${label}`;
    b.addEventListener('click', () => {
      if (state.types.has(key)) state.types.delete(key);
      else state.types.add(key);
      b.setAttribute('aria-pressed', String(state.types.has(key)));
      applyFilters();
    });
    box.append(b);
  }
}

function wirePanels() {
  const narrow = () => window.innerWidth < 736 || window.innerHeight < 544;
  for (const btn of document.querySelectorAll('.panel__toggle')) {
    btn.addEventListener('click', () => {
      const panel = $(btn.dataset.panel);
      const collapsed = panel.classList.toggle('is-collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      if (!collapsed && narrow()) {
        // on a phone the sheets would cover the map, so only one opens at a time
        for (const other of document.querySelectorAll('.panel')) {
          if (other === panel) continue;
          other.classList.add('is-collapsed');
          other.querySelector('.panel__toggle').setAttribute('aria-expanded', 'false');
        }
      }
    });
  }
  if (narrow()) {
    // On a phone the sheets would cover most of the map, so both start shut and
    // only one opens at a time.
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.add('is-collapsed');
      panel.querySelector('.panel__toggle').setAttribute('aria-expanded', 'false');
    }
  }
}

function wireKeys() {
  addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
    if (ev.key === '/' && !typing) { ev.preventDefault(); $('search').focus(); return; }
    if (typing && ev.key === 'Escape') { ev.target.blur(); return; }
    if (typing) return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
  });
}

function defaultId() {
  const today = new Date().toISOString().slice(0, 10);
  return (state.all.find((e) => e.date >= today) || state.all.at(-1)).id;
}

function idFromUrl() {
  const want = new URLSearchParams(location.search).get('e');
  return state.all.some((e) => e.id === want) ? want : null;
}

// -------------------------------------------------------------------- boot

async function boot() {
  let index;
  try {
    // revalidate the index every time: it is what tells us the current build
    index = await fetch('data/index.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  } catch (err) {
    $('facts').textContent = 'Could not load eclipse data. '
      + 'If you opened this file directly, serve the folder over HTTP instead.';
    console.error(err);
    return;
  }

  document.documentElement.dataset.theme = 'light';
  state.version = index.version || '';
  state.all = index.eclipses;
  for (const e of state.all) {
    e.search = `${e.date} ${formatDate(e.date, true)} ${e.type} saros ${e.saros}`.toLowerCase();
  }
  state.shown = index.eclipses;
  $('range').textContent = `${index.range[0]}–${index.range[1]}`;

  buildMap();
  buildChips();
  wirePanels();
  wireKeys();
  renderList();

  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (b) select(b.dataset.id);
  });
  $('search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    applyFilters();
  });
  addEventListener('popstate', () => {
    const id = idFromUrl();
    if (id) select(id, { push: false });
  });

  // Select straight away rather than waiting on the map: the details, the list and
  // the URL should all work even if the tile server is unreachable.  Geometry that
  // arrives before the style is ready is picked up again on 'style.load'.
  const start = idFromUrl() || defaultId();
  select(start, { replace: true, fit: false });
  map.once('load', fitToCurrent);
}

boot();
