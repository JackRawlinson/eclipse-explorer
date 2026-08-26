// Eclipse Mapper — draws precomputed eclipse geometry on a MapLibre map.
// All the astronomy happens at build time; this file only fetches and renders.

import * as maplibregl from './vendor/maplibre-gl.mjs';
import { localCircumstances, toUT, shadowOutline } from './circumstances.js';

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

// Overlay colours, one set per theme. The basemap decides which is in force.
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

// Everything about how the map is painted, in one place. Defaults chosen to keep
// the basemap legible: the shading is a backdrop, the contours carry the numbers.
const DEFAULTS = {
  basemap: 'liberty',
  mode: 'gradient',        // gradient | bands | off
  tint: '#334155',         // near-neutral: a coloured wash over a coloured sea reads as nothing
  shade: 0.3,
  gamma: 0.85,
  total: '#4c1d95',
  annular: '#c2410c',
  // UT by default: most eclipses you look at are somewhere else, and there is no
  // honest way to show that place's civil time without a timezone-boundary set.
  // Your own clock is right only when the eclipse is where you are.
  times: 'ut',
};
const SETTINGS_KEY = 'eclipse-mapper.display';

const SWATCHES = {
  tint: [['#334155', 'Slate'], ['#1d4ed8', 'Blue'], ['#5b21b6', 'Violet'],
         ['#7c2d12', 'Umber'], ['#0f766e', 'Teal']],
  total: [['#4c1d95', 'Violet'], ['#1e3a8a', 'Navy'], ['#9d174d', 'Magenta'],
          ['#065f46', 'Green'], ['#0f172a', 'Ink']],
  annular: [['#c2410c', 'Orange'], ['#b45309', 'Amber'], ['#be123c', 'Rose'],
            ['#a16207', 'Ochre'], ['#7c2d12', 'Umber']],
};

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch { /* a corrupt or blocked store just means defaults */ }

  // URL wins over the stored preference, so a link can carry a specific look.
  const q = new URLSearchParams(location.search);
  const fromUrl = {};
  if (q.has('basemap')) fromUrl.basemap = q.get('basemap');
  if (q.has('tint')) fromUrl.tint = `#${q.get('tint').replace('#', '')}`;
  for (const k of ['shade', 'gamma']) {
    if (q.has(k) && Number.isFinite(Number(q.get(k)))) fromUrl[k] = Number(q.get(k));
  }
  return { ...DEFAULTS, ...stored, ...fromUrl };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch { /* private mode; the session still works, it just will not persist */ }
}

const basemapIndex = () =>
  Math.max(0, BASEMAPS.findIndex((b) => b.id === state.settings.basemap));

const maskKey = () => {
  const { tint, shade, gamma } = state.settings;
  return `${tint}-${shade}-${gamma}`;
};

const TYPES = [
  { key: 'total', label: 'Total' },
  { key: 'annular', label: 'Annular' },
  { key: 'hybrid', label: 'Hybrid' },
  { key: 'partial', label: 'Partial' },
];

const EMPTY = { type: 'FeatureCollection', features: [] };
// A transparent placeholder for the image source before a mask is painted.
// Built at runtime rather than inlined: a one-pixel image stretched across the
// whole world is something MapLibre declines to decode.
// No placeholder image: the source is created when there is a real mask to put
// in it. Handing MapLibre a stand-in only to replace it a moment later left it
// reporting a decode failure on the request it had already abandoned.
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
  settings: loadSettings(),
  theme: 'light',
  elements: null,       // Besselian elements of the selected eclipse
  shadowWindow: null,   // when the umbra is on the Earth, for the timeline
  playing: false,
  playTimer: null,
  pin: null,            // a place to ask "what is visible from here?"
  visible: null,        // that answer, for every eclipse
  threshold: (() => {
    try { return localStorage.getItem('eclipse-mapper.threshold') || 'p90'; }
    catch { return 'p90'; }
  })(),
  version: '',          // build stamp, appended to data URLs to defeat caching
  span: '',             // the years covered, for the list count
  globe: false,
};

const geoCache = new Map();
let pinMarker = null;
const maskCache = new Map();   // painted masks, keyed by source and appearance
let shadingUrl = null;
let layersReady = false;   // our layers exist and can be added to
let loadToken = 0;
let map;
let popup = null;

// ------------------------------------------------------------------- map

function buildMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: styleUrl(BASEMAPS[basemapIndex()].id),
    center: [0, 20],
    zoom: 1.3,
    minZoom: 0.6,
    maxZoom: 14,
    attributionControl: false,
    dragRotate: false,
  });

  window.__map = map;   // handy for debugging from the console

  // NASA's acknowledgment is carried in the info panel; the map bar keeps the
  // tile attribution it is obliged to show.
  map.addControl(new maplibregl.AttributionControl({ compact: false }),
                 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), 'bottom-right');
  map.addControl(buttonGroup(), 'top-right');

  // MapLibre routes style and layer failures here rather than throwing, so
  // without this a bad layer definition just silently draws nothing.
  map.on('error', (ev) => console.error('map error:', ev?.error?.message || ev));

  map.on('click', (ev) => showCircumstances(ev.lngLat));
  map.on('mouseout', () => { map.getCanvas().style.cursor = ''; });
  map.getCanvas().style.cursor = 'crosshair';

  map.on('style.load', () => {
    addEclipseLayers();
    applyPathColours();
    if (state.current) {
      setMapData(geoCache.get(state.current.id) || EMPTY);
      setShading(state.current);
    }
  });
}

// Stroke icons rather than text glyphs: the glyphs rendered thin and pale, and
// half of them were not obviously buttons at all.
const ICONS = {
  refit: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3.6M12 17.9v3.6'
       + 'M2.5 12h3.6M17.9 12h3.6"/><circle cx="12" cy="12" r="7.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'
       + '<path d="M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z"/>',
  flat: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M9 5v14"/>',
  cog: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H2.8a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.7v-.2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};

function buttonGroup() {
  return {
    onAdd() {
      const div = document.createElement('div');
      div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      div.append(
        mapButton('refit', 'Refit the map to this eclipse', () => fitToCurrent()),
        mapButton('globe', 'Switch between the flat map and a globe', toggleGlobe, 'globe'),
        mapButton('cog', 'Display settings', toggleSettings, 'settings'),
      );
      return div;
    },
    onRemove() {},
  };
}

function mapButton(icon, title, onClick, role) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'map-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  if (role) b.dataset.role = role;
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${ICONS[icon]}</svg>`;
  b.addEventListener('click', onClick);
  return b;
}

function setButtonIcon(role, icon) {
  const b = document.querySelector(`.map-btn[data-role="${role}"]`);
  if (b) b.querySelector('svg').innerHTML = ICONS[icon];
}

function addEclipseLayers() {
  layersReady = false;
  const c = PAINT[state.theme];
  if (!map.getSource('eclipse')) {
    map.addSource('eclipse', { type: 'geojson', data: EMPTY });
  }

  const is = (kind) => ['==', ['get', 'kind'], kind];
  const byFlavour = ['match', ['get', 'flavour'], 'annular',
                     state.settings.annular, state.settings.total];

  add({ id: 'band-fill', type: 'fill', filter: is('band'),
        paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'level'],
                                0.2, c.bandLow, 0.9, c.bandHigh],
                 'fill-opacity': state.settings.mode === 'bands' ? 0.09 : 0 } });
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
                 'fill-opacity': state.settings.mode === 'bands' ? 0.10 : 0 } });
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

  if (!map.getSource('shadow')) {
    map.addSource('shadow', { type: 'geojson', data: EMPTY_SHADOW });
  }
  for (const id of ['shadow-fill', 'shadow-line', 'shadow-centre']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  map.addLayer({ id: 'shadow-fill', type: 'fill', source: 'shadow',
                 filter: ['==', ['geometry-type'], 'Polygon'],
                 paint: { 'fill-color': c.central, 'fill-opacity': 0.35 } });
  map.addLayer({ id: 'shadow-line', type: 'line', source: 'shadow',
                 filter: ['==', ['geometry-type'], 'Polygon'],
                 paint: { 'line-color': c.centralCasing, 'line-width': 1.2,
                          'line-opacity': 0.9 } });
  // The umbra is a couple of hundred kilometres across: a few pixels at world
  // zoom. The centre marker carries the animation until the footprint is big
  // enough to read on its own.
  map.addLayer({ id: 'shadow-centre', type: 'circle', source: 'shadow',
                 filter: ['==', ['get', 'kind'], 'centre'],
                 paint: {
                   'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 6, 6, 3],
                   'circle-color': c.central,
                   'circle-stroke-color': c.centralCasing,
                   'circle-stroke-width': 2,
                   'circle-opacity': ['interpolate', ['linear'], ['zoom'], 4, 1, 7, 0],
                   'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 4, 1, 7, 0],
                 } });

  add({ id: 'greatest-dot', type: 'circle', filter: is('greatest'),
        paint: { 'circle-radius': 5, 'circle-opacity': 0,
                 'circle-stroke-color': c.greatest, 'circle-stroke-width': 2.5 } });

  layersReady = true;

  function add(layer) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    map.addLayer({ source: 'eclipse', ...layer });
  }
}

function setMapData(fc) {
  const src = map.getSource('eclipse');
  if (src) src.setData(localiseMarks(fc));
}

/**
 * The shadow-centre ticks ship as UT strings. If the panel is showing local time
 * the map has to agree, so relabel them rather than have the two contradict.
 */
function localiseMarks(fc) {
  if (state.settings.times === 'ut') return fc;
  const date = fc.properties?.id
    ? `${fc.properties.id.slice(0, 4)}-${fc.properties.id.slice(4, 6)}-${fc.properties.id.slice(6, 8)}`
    : null;
  if (!date) return fc;
  const marks = fc.features.filter((f) => f.properties.kind === 'timeMark');
  if (!marks.length) return fc;
  const ref = hoursOf(marks[Math.floor(marks.length / 2)].properties.label);
  return {
    ...fc,
    features: fc.features.map((f) => (f.properties.kind === 'timeMark'
      ? { ...f, properties: { ...f.properties,
          label: clock(date, hoursOf(f.properties.label), { reference: ref }) } }
      : f)),
  };
}

async function setShading(entry) {
  if (!layersReady) return;   // style.load calls us again once the layers exist
  if (!entry.shading) { applyShadingImage(null); return; }
  try {
    const painted = await paintMask(dataUrl(`${entry.id}.png`));
    if (state.current?.id === entry.id) applyShadingImage(painted);
  } catch (err) {
    applyShadingImage(null);               // the contours still carry the numbers
    console.warn('could not paint the shading mask', err);
  }
}

function applyShadingImage(url) {
  if (!url) {                                  // nothing to show for this eclipse
    if (map.getLayer('shading')) map.setLayoutProperty('shading', 'visibility', 'none');
    return;
  }
  const existing = map.getSource('shading');
  if (existing) {
    existing.updateImage({ url, coordinates: WORLD_CORNERS });
  } else {
    map.addSource('shading', { type: 'image', url, coordinates: WORLD_CORNERS });
  }
  if (!map.getLayer('shading')) {
    // beneath everything we draw, above the basemap
    const below = ['band-fill', 'penumbra-fill', 'path-fill']
      .find((id) => map.getLayer(id));
    map.addLayer({
      id: 'shading', type: 'raster', source: 'shading',
      paint: { 'raster-opacity': state.settings.mode === 'gradient' ? 1 : 0,
               'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    }, below);
  }
  map.setLayoutProperty('shading', 'visibility', 'visible');
  shadingUrl = url;   // the cache owns these; revoking here would kill a live entry
}

/**
 * Colour the obscuration mask. What ships is a single grey channel holding
 * obscuration itself; the tint, the opacity and the curve are applied here, so
 * changing how the shading looks costs a repaint rather than a rebuild.
 */
async function paintMask(url) {
  const { tint, shade, gamma } = state.settings;
  const key = maskKey();
  const hex = tint.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
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
  // Evict the oldest, but never the one currently on the map: revoking a blob
  // URL still in use leaves MapLibre unable to decode it.
  if (maskCache.size > 12) {
    for (const [k, v] of maskCache) {
      if (v === shadingUrl) continue;
      URL.revokeObjectURL(v);
      maskCache.delete(k);
      break;
    }
  }
  maskCache.set(url + key, blobUrl);
  return blobUrl;
}

function applyBasemap({ restyle = true } = {}) {
  const chosen = BASEMAPS[basemapIndex()];
  state.theme = chosen.dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;   // panels follow the map
  if (restyle) map.setStyle(styleUrl(chosen.id));         // style.load re-adds ours
}

/** Path colours reach both the map layers and the legend swatches. */
function applyPathColours() {
  const { total, annular } = state.settings;
  const root = document.documentElement.style;
  root.setProperty('--total', total);
  root.setProperty('--annular', annular);
  const byFlavour = ['match', ['get', 'flavour'], 'annular', annular, total];
  for (const layer of ['path-fill', 'path-line']) {
    if (map.getLayer(layer)) {
      map.setPaintProperty(layer, layer.endsWith('fill') ? 'fill-color' : 'line-color',
                           byFlavour);
    }
  }
}

/** Push the shading settings at the layers already on the map. */
function applyShading() {
  const mode = state.settings.mode;
  const set = (layer, prop, value) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  set('shading', 'raster-opacity', mode === 'gradient' ? 1 : 0);
  set('band-fill', 'fill-opacity', mode === 'bands' ? 0.09 : 0);
  set('penumbra-fill', 'fill-opacity', mode === 'bands' ? 0.10 : 0);
  if (state.current) setShading(state.current);           // repaint the mask
}

function toggleGlobe() {
  state.globe = !state.globe;
  const btn = document.querySelector('.map-btn[data-role="globe"]');
  if (btn) btn.setAttribute('aria-pressed', String(state.globe));
  setButtonIcon('globe', state.globe ? 'flat' : 'globe');
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

// --------------------------------------------------- running the shadow

const EMPTY_SHADOW = { type: 'FeatureCollection', features: [] };

/** The stretch of time the umbra is actually touching the Earth. */
function umbralWindow(el) {
  if (!el?.window) return null;
  const [w0, w1] = el.window;
  const steps = 240;
  const on = [];
  for (let i = 0; i <= steps; i++) {
    const t = w0 + ((w1 - w0) * i) / steps;
    if (shadowOutline(el, t, 4).centre) on.push(t);
  }
  if (on.length < 2) return null;
  // nudge outward to the true contacts, which fall between samples
  const step = (w1 - w0) / steps;
  const edge = (from, dir) => {
    let inside = from;
    let outside = from + dir * step;
    for (let i = 0; i < 24; i++) {
      const mid = (inside + outside) / 2;
      if (shadowOutline(el, mid, 4).centre) inside = mid;
      else outside = mid;
    }
    return inside;
  };
  return [edge(on[0], -1), edge(on.at(-1), 1)];
}

function showTimeline(entry) {
  stopPlaying();
  const el = state.elements;
  state.shadowWindow = entry.hasPath ? umbralWindow(el) : null;
  $('timeline').hidden = !state.shadowWindow;
  if (!state.shadowWindow) {
    setShadow(null);
    return;
  }
  $('tl-scrub').value = '0';
  setShadowAt(0);
}

/** Draw the umbra where it stands at `fraction` through its crossing. */
function setShadowAt(fraction) {
  const win = state.shadowWindow;
  if (!win) return;
  const t = win[0] + (win[1] - win[0]) * fraction;
  const el = state.elements;
  const { centre, ring } = shadowOutline(el, t);

  const features = [];
  if (ring) {
    features.push({ type: 'Feature', properties: {},
                    geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  if (centre) {
    features.push({ type: 'Feature', properties: { kind: 'centre' },
                    geometry: { type: 'Point', coordinates: [centre.lon, centre.lat] } });
  }
  setShadow({ type: 'FeatureCollection', features });

  const date = state.current?.date;
  $('tl-time').textContent = date
    ? `${clock(date, toUT(el, t), { seconds: true, reference: toUT(el, (win[0] + win[1]) / 2) })} ${timeLabel()}`
    : '';
}

function setShadow(fc) {
  const src = map.getSource('shadow');
  if (src) src.setData(fc || EMPTY_SHADOW);
}

function startPlaying() {
  if (!state.shadowWindow) return;
  state.playing = true;
  $('tl-play').innerHTML = PAUSE_ICON;
  $('tl-play').setAttribute('aria-label', 'Pause the shadow');
  let last = null;
  const tick = (now) => {
    if (!state.playing) return;
    if (last !== null) {
      // the whole crossing takes about twelve seconds, whatever its real length
      const step = (now - last) / 12000;
      let v = Number($('tl-scrub').value) / 1000 + step;
      if (v > 1) v = 0;
      $('tl-scrub').value = String(Math.round(v * 1000));
      setShadowAt(v);
    }
    last = now;
    state.playTimer = requestAnimationFrame(tick);
  };
  state.playTimer = requestAnimationFrame(tick);
}

function stopPlaying() {
  state.playing = false;
  if (state.playTimer) cancelAnimationFrame(state.playTimer);
  state.playTimer = null;
  const btn = $('tl-play');
  if (btn) {
    btn.innerHTML = PLAY_ICON;
    btn.setAttribute('aria-label', 'Play the shadow');
  }
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

// ------------------------------------------------ what is visible from here

// How much of the Sun has to go before an eclipse is worth listing. Anything is
// technically visible over half the planet; a three per cent bite is not an event.
const THRESHOLDS = [
  { id: 'central', label: 'Total or annular', test: (r) => r.central },
  { id: 'p90', label: '90%+', test: (r) => r.obscuration >= 0.9 },
  { id: 'p50', label: '50%+', test: (r) => r.obscuration >= 0.5 },
  { id: 'any', label: 'Any', test: () => true },
];

let allElements = null;      // every eclipse's elements, fetched on first use

async function elementsForAll() {
  if (!allElements) {
    allElements = await fetch(dataUrl('elements.json')).then((r) => {
      if (!r.ok) throw new Error(`elements.json: ${r.status}`);
      return r.json();
    });
  }
  return allElements;
}

function setPin(lngLat, { push = true } = {}) {
  state.pin = lngLat ? { lat: lngLat.lat, lon: lngLat.lng ?? lngLat.lon } : null;
  drawPin();
  if (push) syncUrl();
  const bar = $('pinbar');
  const chips = $('place-threshold');
  if (!state.pin) {
    state.visible = null;
    bar.hidden = true;
    chips.hidden = true;
    applyFilters();
    return;
  }
  $('pinbar-at').textContent = `From ${formatLatLon(state.pin.lat, state.pin.lon, 2)}`;
  bar.hidden = false;
  chips.hidden = false;
  computeVisible();
}

function drawPin() {
  if (pinMarker) { pinMarker.remove(); pinMarker = null; }
  if (!state.pin) return;
  const el = document.createElement('div');
  el.className = 'pin-marker';
  pinMarker = new maplibregl.Marker({ element: el })
    .setLngLat([state.pin.lon, state.pin.lat])
    .addTo(map);
}

async function computeVisible() {
  const pin = state.pin;
  $('count').textContent = 'working out what is visible…';

  let elements;
  try {
    elements = await elementsForAll();
  } catch (err) {
    $('count').textContent = 'Could not load the eclipse elements.';
    console.error(err);
    return;
  }
  if (state.pin !== pin) return;                 // moved on already

  const seen = new Map();
  for (const entry of state.all) {
    const el = elements[entry.id];
    if (!el) continue;
    const r = localCircumstances(el, pin.lat, pin.lon);
    if (!r || r.obscuration <= 0) continue;
    seen.set(entry.id, {
      obscuration: r.obscuration,
      central: r.central,
      total: r.total,
      durationS: r.durationS ?? null,
    });
  }
  state.visible = seen;
  applyFilters();
}

function buildThresholds() {
  const host = $('place-threshold');
  host.replaceChildren();
  for (const t of THRESHOLDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = t.label;
    b.setAttribute('aria-pressed', String(state.threshold === t.id));
    b.addEventListener('click', () => {
      state.threshold = t.id;
      try { localStorage.setItem('eclipse-mapper.threshold', t.id); } catch { /* fine */ }
      for (const other of host.children) {
        other.setAttribute('aria-pressed', String(other === b));
      }
      applyFilters();
    });
    host.append(b);
  }
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
  popup.getElement().querySelector('[data-act="pin"]')
    ?.addEventListener('click', () => { setPin(lngLat); closePopup(); });
}

function circumstancesHTML(s, lngLat) {
  const where = `<p class="pop__where">${formatLatLon(lngLat.lat, lngLat.lng, 3)}</p>`;
  if (!s) {
    return `<p class="pop__head pop__head--none">No eclipse here</p>
            <p class="pop__note">The Sun is either untouched or below the horizon
            throughout.</p>${where}
            <p class="pop__actions"><button type="button" class="pop__action"
            data-act="pin">See every eclipse here</button></p>`;
  }

  const el = state.elements;
  const date = state.current?.date || new Date().toISOString().slice(0, 10);
  const ref = toUT(el, s.tMax);
  const when = (t, opts) => clock(date, toUT(el, t), { reference: ref, ...opts });
  const rows = [];

  const head = s.durationS
    ? `<p class="pop__head pop__head--${s.total ? 'total' : 'annular'}">`
      + `${s.total ? 'Totality' : 'Annularity'} ${formatDuration(s.durationS)}</p>`
    : `<p class="pop__head">${formatObscuration(s.obscuration)} of the Sun covered</p>`;

  if (s.durationS) {
    rows.push([s.total ? 'Totality' : 'Annularity',
               `${when(s.c2)} – ${when(s.c3)} ${timeLabel()}`]);
    rows.push(['Obscuration', formatObscuration(s.obscuration)]);
  }
  rows.push(['Maximum', `${when(s.tMax, { seconds: true })} ${timeLabel()}`]);
  rows.push(['Magnitude', s.magnitude.toFixed(3)]);
  rows.push(['Sun altitude', `${s.sunAlt.toFixed(0)}°`]);
  if (s.c1 !== undefined && s.c4 !== undefined) {
    rows.push(['Partial', `${when(s.c1)} – ${when(s.c4)} ${timeLabel()}`]);
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
    + where
    + '<p class="pop__actions"><button type="button" class="pop__action" '
    + 'data-act="pin">See every eclipse here</button></p>';
}

const LOCAL_ZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; }
  catch { return 'local time'; }
})();

/**
 * Turn an hour-of-day in UT into a real instant. Eclipse times run a few hours
 * either side of greatest eclipse, so one that reads as far away from it has
 * wrapped past midnight and belongs to the neighbouring day.
 */
function instantFor(dateISO, hours, referenceHours) {
  const [y, m, d] = dateISO.split('-').map(Number);
  let shift = 0;
  if (Number.isFinite(referenceHours)) {
    const gap = hours - referenceHours;
    if (gap > 12) shift = -1;
    else if (gap < -12) shift = 1;
  }
  const whole = Math.floor(hours);
  const minutes = Math.floor((hours - whole) * 60);
  const seconds = Math.round((((hours - whole) * 60) - minutes) * 60);
  return new Date(Date.UTC(y, m - 1, d + shift, whole, minutes, seconds));
}

/** A clock time, in UT or the viewer's zone depending on the setting. */
function clock(dateISO, hours, { seconds = false, reference } = {}) {
  if (state.settings.times === 'ut') return hms(hours, seconds);
  const when = instantFor(dateISO, hours, reference);
  return when.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
}

const timeLabel = () => (state.settings.times === 'ut' ? 'UT' : 'local');

function hms(hours, seconds = true) {
  const total = Math.round(((hours % 24) + 24) % 24 * 3600);
  const pad = (n) => String(n).padStart(2, '0');
  const hh = pad(Math.floor(total / 3600) % 24);
  const mm = pad(Math.floor(total / 60) % 60);
  return seconds ? `${hh}:${mm}:${pad(total % 60)}` : `${hh}:${mm}`;
}

/** Parse "HH:MM" or "HH:MM:SS" from the index back into hours. */
const hoursOf = (text) => {
  const [h = 0, m = 0, sec = 0] = text.split(':').map(Number);
  return h + m / 60 + sec / 3600;
};

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

  if (push) syncUrl({ replace });

  const token = ++loadToken;
  $('info').classList.add('is-busy');
  try {
    const fc = await loadGeometry(id);
    if (token !== loadToken) return;
    state.elements = fc.properties?.elements || null;
    closePopup();
    setMapData(fc);
    setShading(entry);
    showTimeline(entry);
    if (fit) fitTo(entry);
    prefetchNeighbours(id);
  } catch (err) {
    if (token === loadToken) setMapData(EMPTY);
    console.error(err);
  } finally {
    if (token === loadToken) $('info').classList.remove('is-busy');
  }
}

/** The URL carries the selection and any pinned place, so a view is shareable. */
function syncUrl({ replace = false } = {}) {
  const q = new URLSearchParams();
  if (state.current) q.set('e', state.current.id);
  if (state.pin) q.set('at', `${state.pin.lat.toFixed(4)},${state.pin.lon.toFixed(4)}`);
  const url = `${location.pathname}?${q}`;
  if (replace || url === location.pathname + location.search) {
    history.replaceState({}, '', url);
  } else {
    history.pushState({}, '', url);
  }
}

function pinFromUrl() {
  const at = new URLSearchParams(location.search).get('at');
  if (!at) return null;
  const [lat, lon] = at.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lng: lon } : null;
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
  const rule = THRESHOLDS.find((t) => t.id === state.threshold) || THRESHOLDS[0];
  state.shown = state.all.filter((e) => {
    if (state.types.size && !state.types.has(e.type)) return false;
    if (state.visible) {
      const here = state.visible.get(e.id);
      if (!here || !rule.test(here)) return false;
    }
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
    const here = state.visible?.get(e.id);
    const much = here
      ? (here.durationS
          ? `<span class="list__much list__much--central">${formatDuration(here.durationS)}</span>`
          : `<span class="list__much">${formatObscuration(here.obscuration)}</span>`)
      : '';
    b.innerHTML = `<span class="list__date">${formatDate(e.date, true)}</span>${much}`
      + `<span class="badge badge--${e.type}">${e.type.slice(0, 3)}</span>`;
    li.append(b);
    frag.append(li);
  }
  ul.replaceChildren(frag);
  $('count').textContent = state.visible
    ? `${state.shown.length} visible from here, ${state.span}`
    : `${state.shown.length} of ${state.all.length} eclipses, ${state.span}`;
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
  const ref = e.greatest.ut ? hoursOf(e.greatest.ut) : 12;
  const at = (hhmm, opts) => clock(e.date, hoursOf(hhmm), { reference: ref, ...opts });
  const span = (from, to) => `${at(from)}–${at(to)} ${timeLabel()}`;

  // Short values pair up two to a row; anything carrying a time range needs the width.
  const pairs = [
    ['Type', `${titleCase(e.type)}<span class="facts__code"> ${e.typeCode}</span>`],
    ['Saros', String(e.saros)],
    ['Magnitude', e.magnitude.toFixed(3)],
  ];
  if (e.pathWidthKm) pairs.push(['Width', `${Math.round(e.pathWidthKm)} km`]);

  const wide = [];
  if (e.centralDurationS) wide.push(['Longest', formatDuration(e.centralDurationS)]);
  wide.push(['Greatest', `${at(e.greatest.ut, { seconds: true })} ${timeLabel()}`]);
  if (e.pathBegins) wide.push(['Path', span(e.pathBegins, e.pathEnds)]);
  if (e.partialBegins) wide.push(['Partial', span(e.partialBegins, e.partialEnds)]);

  const more = [
    ['Gamma', signed(e.gamma, 4)],
    ['Greatest at', formatLatLon(e.greatest.lat, e.greatest.lon)],
    ['Sun altitude', `${e.greatest.sunAlt.toFixed(0)}\u00b0`],
    ['\u0394T used', `${e.deltaT.toFixed(1)} s`],
  ];

  const dl = (rows, cls) =>
    `<dl class="facts ${cls || ''}">`
    + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    + '</dl>';

  const note = noteFor(e);
  $('facts').innerHTML =
    dl(pairs, 'facts--pairs')
    + dl(wide)
    + (note ? `<p class="facts__note">${note}</p>` : '')
    + `<details class="facts__more"><summary>More</summary>${dl(more)}</details>`;

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
  const marks = $('legend').querySelector('[data-key="marks"]');
  if (marks) {
    marks.lastChild.textContent = `Shadow centre, 30 min ${timeLabel()}`;
  }
}

function noteFor(e) {
  if (!e.hasPath) {
    return 'The Moon\u2019s umbra misses the Earth, so there is no path of totality \u2014 '
      + 'only the region where a partial eclipse is visible.';
  }
  if (e.type === 'hybrid') {
    return 'Hybrid: the eclipse changes between annular and total along the path. '
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

/** Never round a near-miss up to 100%: that is the one number that means totality. */
function formatObscuration(v) {
  const pct = v * 100;
  if (pct >= 99.5 && v < 1) return '>99%';
  return `${Math.round(pct)}%`;
}

const signed = (v, dp) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp);
const titleCase = (s) => s[0].toUpperCase() + s.slice(1);

// --------------------------------------------------------------- settings ui

function toggleSettings(force) {
  const panel = $('settings');
  const open = typeof force === 'boolean' ? force : panel.hidden;
  panel.hidden = !open;
  const btn = document.querySelector('.map-btn[data-role="settings"]');
  if (btn) btn.setAttribute('aria-pressed', String(open));
}

function buildSettings() {
  const s = state.settings;

  const chips = (host, options, current, onPick) => {
    host.replaceChildren();
    for (const [value, label] of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(current() === value));
      b.addEventListener('click', () => {
        onPick(value);
        for (const other of host.children) {
          other.setAttribute('aria-pressed', String(other === b));
        }
      });
      host.append(b);
    }
  };

  chips($('set-basemap'), BASEMAPS.map((b) => [b.id, b.label]),
        () => s.basemap, (id) => { s.basemap = id; saveSettings(); applyBasemap(); });

  chips($('set-times'), [['ut', 'UT'], ['local', `Yours (${LOCAL_ZONE})`]],
        () => s.times, (v) => {
          s.times = v;
          saveSettings();
          if (state.current) {
            renderInfo(state.current);
            const fc = geoCache.get(state.current.id);
            if (fc) setMapData(fc);
          }
          closePopup();
        });

  chips($('set-mode'), [['gradient', 'Gradient'], ['bands', 'Bands'], ['off', 'None']],
        () => s.mode, (mode) => { s.mode = mode; saveSettings(); applyShading(); shadingOnly(); });

  const slider = (id, key, format) => {
    const input = $(id);
    const out = $(`${id}-out`);
    input.value = s[key];
    out.textContent = format(s[key]);
    input.addEventListener('input', () => {
      s[key] = Number(input.value);
      out.textContent = format(s[key]);
      applyShading();
    });
    input.addEventListener('change', saveSettings);
  };
  slider('set-shade', 'shade', (v) => `${Math.round(v * 100)}%`);
  slider('set-gamma', 'gamma', (v) => v.toFixed(2));

  const colourRow = (key, apply) => {
    const input = $(`set-${key}`);
    input.value = s[key];
    input.addEventListener('input', () => { s[key] = input.value; apply(); });
    input.addEventListener('change', saveSettings);

    const host = $(`set-${key}-swatches`);
    host.replaceChildren();
    for (const [hex, name] of SWATCHES[key]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = hex;
      b.title = name;
      b.setAttribute('aria-label', `${name}`);
      b.addEventListener('click', () => {
        s[key] = hex;
        input.value = hex;
        saveSettings();
        apply();
      });
      host.append(b);
    }
  };
  colourRow('tint', applyShading);
  colourRow('total', applyPathColours);
  colourRow('annular', applyPathColours);

  $('settings-close').addEventListener('click', () => toggleSettings(false));
  $('settings-reset').addEventListener('click', () => {
    state.settings = { ...DEFAULTS };
    saveSettings();
    buildSettings();
    applyBasemap();
    applyShading();
    applyPathColours();
    shadingOnly();
  });
  shadingOnly();
}

/** The strength, contrast and colour rows mean nothing with shading turned off. */
function shadingOnly() {
  const on = state.settings.mode !== 'off';
  for (const el of document.querySelectorAll('[data-shading-only]')) {
    el.style.opacity = on ? '' : '.4';
    for (const input of el.querySelectorAll('input, button')) input.disabled = !on;
  }
}

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
    });
  }
  // On a phone the sheet would cover most of the map, so it starts shut. The
  // header keeps the stepper, so eclipses can still be stepped through.
  if (narrow()) {
    const panel = $('picker');
    panel.classList.add('is-collapsed');
    panel.querySelector('.panel__toggle').setAttribute('aria-expanded', 'false');
  }
}

function wireKeys() {
  addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
    if (ev.key === '/' && !typing) { ev.preventDefault(); $('search').focus(); return; }
    if (ev.key === 'Escape' && !$('settings').hidden) { toggleSettings(false); return; }
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
  state.span = `${index.range[0]}–${index.range[1]}`;

  buildMap();
  buildSettings();
  buildChips();
  buildThresholds();
  wirePanels();
  wireKeys();
  renderList();

  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (b) select(b.dataset.id);
  });
  $('place-clear').addEventListener('click', () => setPin(null));
  $('tl-scrub').addEventListener('input', (ev) => {
    stopPlaying();
    setShadowAt(Number(ev.target.value) / 1000);
  });
  $('tl-play').addEventListener('click', () => {
    if (state.playing) stopPlaying(); else startPlaying();
  });
  $('search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    applyFilters();
  });
  addEventListener('popstate', () => {
    const id = idFromUrl();
    if (id) select(id, { push: false });
    setPin(pinFromUrl(), { push: false });
  });

  // Select straight away rather than waiting on the map: the details, the list and
  // the URL should all work even if the tile server is unreachable.  Geometry that
  // arrives before the style is ready is picked up again on 'style.load'.
  // Read the pin before selecting: select() rewrites the URL from state, and
  // would drop `at=` before we ever looked at it.
  const startPin = pinFromUrl();
  const start = idFromUrl() || defaultId();
  select(start, { replace: true, fit: false });
  map.once('load', () => {
    fitToCurrent();
    if (startPin) setPin(startPin, { push: false });
  });
}

boot();
