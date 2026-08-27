import * as maplibregl from './vendor/maplibre-gl.mjs';
import { localCircumstances, localInstant, obscurationFrom, toUT, shadowOutline,
         instantField, penumbraEdge, nightPolygon, terminator } from './circumstances.js';
import * as lunar from './lunar.js';

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
  Math.max(0, BASEMAPS.findIndex(
    (b) => b.id === (state.basemapOverride || state.settings.basemap)));

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
  kind: 'solar',        // which catalogue the app is showing: 'solar' | 'lunar'
  lunarAll: null,       // the lunar catalogue, fetched on first use
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
  playRate: (() => {
    try {
      const v = Number(localStorage.getItem('eclipse-mapper.speed'));
      return [0.5, 1, 2, 4].includes(v) ? v : 1;
    } catch { return 1; }
  })(),
  live: false,          // the timeline is showing one instant, not the whole eclipse
  liveT: null,          // that instant, for the view-from-the-pin disc
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

  // The constructor above already has the style; this settles everything else
  // that follows from the choice -- the panel theme, the dark-basemap note.
  applyBasemap({ restyle: false });

  // Both credits belong here rather than in a panel: a panel scrolls, and on a
  // phone it can be shut altogether, so anything kept only in there is
  // effectively unattributed. The wording is the acknowledgment the eclipse
  // predictions are published under, verbatim.
  map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: 'Eclipse Predictions by Fred Espenak, NASA\u2019s GSFC',
  }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), 'bottom-right');
  map.addControl(buttonGroup(), 'top-right');

  // MapLibre routes style and layer failures here rather than throwing, so
  // without this a bad layer definition just silently draws nothing.
  map.on('error', (ev) => console.error('map error:', ev?.error?.message || ev));

  // One click does everything: the pin drops, the card fills in, and if the
  // shadow is running the corner disc follows the new place on the next frame.
  map.on('click', (ev) => setPin(ev.lngLat));
  map.on('mouseout', () => { map.getCanvas().style.cursor = ''; });
  map.getCanvas().style.cursor = 'crosshair';

  map.on('style.load', () => {
    addEclipseLayers();
    applyPathColours();
    if (state.kind === 'lunar') {
      if (state.current) lunarShadowAt(Number($('tl-scrub').value) / 1000, state.live);
    } else if (state.current) {
      setMapData(geoCache.get(state.current.id) || EMPTY);
      setShading(state.current);
    }
  });
}

// Stroke icons rather than text glyphs: the glyphs rendered thin and pale, and
// half of them were not obviously buttons at all.
const ICONS = {
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.2 2.4'
      + 'c-.6.2-.9.7-.9 1.4v.5"/><path d="M12 17.2v.2"/>',
  refit: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3.6M12 17.9v3.6'
       + 'M2.5 12h3.6M17.9 12h3.6"/><circle cx="12" cy="12" r="7.6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'
       + '<path d="M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z"/>',
  flat: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M9 5v14"/>',
  cog: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H2.8a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3.7v-.2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  moon: '<path d="M20.2 14.2A8.7 8.7 0 0 1 9.8 3.8a8.7 8.7 0 1 0 10.4 10.4z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6'
     + 'M18.8 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/>',
  share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/>'
       + '<circle cx="17.5" cy="18.5" r="2.5"/><path d="M8.8 10.9l6.4-4.2M8.8 13.1l6.4 4.2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/>'
          + '<path d="M3.5 9.5h17M8 2.8v4M16 2.8v4M7.5 13.5h3M13.5 13.5h3M7.5 17h3"/>',
};

function buttonGroup() {
  return {
    onAdd() {
      const div = document.createElement('div');
      div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      div.append(
        mapButton('refit', 'Refit the map to this eclipse', () => fitToCurrent()),
        mapButton('globe', 'Switch between the flat map and a globe', toggleGlobe, 'globe'),
        mapButton('moon', 'Switch between solar and lunar eclipses', () => {
          setKind(state.kind === 'lunar' ? 'solar' : 'lunar');
        }, 'kind'),
        mapButton('share', 'Copy a link to this view', shareView),
        mapButton('calendar', 'Save this eclipse to your calendar, for the picked place',
                  downloadCalendar),
        mapButton('cog', 'Display settings', toggleSettings, 'settings'),
        mapButton('help', 'What this is, and what you can do with it', showIntro),
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
  for (const id of ['night-fill', 'terminator', 'live-edge',
                    'shadow-fill', 'shadow-line', 'shadow-centre']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  map.addLayer({ id: 'night-fill', type: 'fill', source: 'shadow',
                 filter: ['==', ['get', 'kind'], 'night'],
                 paint: { 'fill-color': LIVE_TINT, 'fill-opacity': LIVE_NIGHT } });
  map.addLayer({ id: 'terminator', type: 'line', source: 'shadow',
                 filter: ['==', ['get', 'kind'], 'terminator'],
                 paint: { 'line-color': c.penumbra, 'line-width': 1,
                          'line-opacity': 0.5 } });
  map.addLayer({ id: 'live-edge', type: 'line', source: 'shadow',
                 filter: ['==', ['get', 'kind'], 'rim'],
                 paint: { 'line-color': c.penumbra, 'line-width': 1.2,
                          'line-opacity': 0.7 } });
  map.addLayer({ id: 'shadow-fill', type: 'fill', source: 'shadow',
                 filter: ['==', ['get', 'kind'], 'umbra'],
                 paint: { 'fill-color': c.central, 'fill-opacity': 0.45 } });
  map.addLayer({ id: 'shadow-line', type: 'line', source: 'shadow',
                 filter: ['==', ['get', 'kind'], 'umbra'],
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
  // The shadow is drawn as darkness, which a dark basemap simply absorbs.
  if ($('dark-note')) $('dark-note').hidden = !chosen.dark;
  state.theme = chosen.dark ? 'dark' : 'light';
  // The overlays above follow the basemap, but the panels follow the system:
  // a dark basemap forces them dark to match it, a light one leaves the
  // stylesheet's prefers-color-scheme rules to decide.
  if (chosen.dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
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
  set('shading', 'raster-opacity', state.live || mode !== 'gradient' ? 0 : 1);
  set('band-fill', 'fill-opacity', !state.live && mode === 'bands' ? 0.09 : 0);
  set('penumbra-fill', 'fill-opacity', !state.live && mode === 'bands' ? 0.10 : 0);
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

// -------------------------------------------------------- solar or lunar

async function lunarCatalogue() {
  if (!state.lunarAll) {
    const data = await fetch(dataUrl('lunar.json')).then((r) => {
      if (!r.ok) throw new Error(`lunar.json: ${r.status}`);
      return r.json();
    });
    for (const e of data.eclipses) {
      e.typeCode = e.type === 'total' ? 'T' : 'P';
      e.search = `${e.date} ${formatDate(e.date, true)} ${e.type} lunar `
        + `saros ${e.saros}`.toLowerCase();
    }
    state.lunarAll = data.eclipses;
  }
  return state.lunarAll;
}

/** Swap the whole app between the two catalogues. */
async function setKind(kind, { push = true } = {}) {
  if (state.kind === kind) return;
  if (kind === 'lunar') {
    try { await lunarCatalogue(); }
    catch (err) { console.error(err); toast('Could not load the lunar catalogue'); return; }
  }
  const wasAt = state.current?.date;
  stopPlaying();
  setLive(false);
  setShadow(null);
  if (state.visible) clearVisible();     // the visibility filter is solar-only
  state.kind = kind;
  document.body.classList.toggle('is-lunar', kind === 'lunar');
  // Lunar mode borrows the dark basemap -- it is a night event, and the red
  // and pale washes are drawn for a dark ground. The person's own choice is
  // untouched and comes back with the Sun; picking a basemap by hand while
  // in lunar mode wins over the borrowing.
  if (kind === 'lunar') {
    if (!BASEMAPS[basemapIndex()].dark) {
      state.basemapOverride = 'dark';
      applyBasemap();
    }
  } else if (state.basemapOverride) {
    state.basemapOverride = null;
    applyBasemap();
  }
  const btn = document.querySelector('.map-btn[data-role="kind"]');
  if (btn) {
    btn.setAttribute('aria-pressed', String(kind === 'lunar'));
    setButtonIcon('kind', kind === 'lunar' ? 'sun' : 'moon');
  }
  state.all = kind === 'lunar' ? state.lunarAll : state.solarAll;
  applyFilters();
  // land on the same stretch of time in the other catalogue
  const anchor = wasAt || new Date().toISOString().slice(0, 10);
  const near = state.all.find((e) => e.date >= anchor) || state.all.at(-1);
  await select(near.id, { push, replace: true });
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
  setLive(false);
  const el = state.elements;
  const win = entry.hasPath ? umbralWindow(el) : null;
  // A little room either side of the strict crossing: totality at a place near
  // the path's end otherwise lands in the last sliver of the bar, and the
  // shadow gets to arrive and leave instead of starting mid-map.
  state.shadowWindow = win
    ? [win[0] - (win[1] - win[0]) * 0.05, win[1] + (win[1] - win[0]) * 0.05]
    : null;
  $('timeline').hidden = !state.shadowWindow;
  // The sheet needs to know to leave room for it; see the mobile rule.
  document.body.classList.toggle('has-timeline', !!state.shadowWindow);
  updateScrubMarks();
  syncUrl({ replace: true });   // a moment shown on the last eclipse is not this one's
  if (!state.shadowWindow) {
    setShadow(null);
    return;
  }
  $('tl-scrub').value = '0';
  setShadowAt(0, false);
}

/**
 * Paint the pinned place's share of the crossing onto the scrub track: its
 * partial phase as a wash, totality or annularity at full strength. The local
 * partial phase usually starts before the umbra touches the Earth at all, so
 * the ends clamp to the bar rather than hang off it.
 */
function updateScrubMarks() {
  const input = $('tl-scrub');
  if (!input) return;
  if (state.kind === 'lunar') {
    const win = state.shadowWindow;
    const entry = state.current;
    if (!win || !entry) { input.style.removeProperty('--tl-marks'); return; }
    const { contacts } = lunar.geometryOf(entry);
    const f = (t) => Math.min(100, Math.max(0, ((t - win[0]) / (win[1] - win[0])) * 100));
    const wash = 'color-mix(in srgb, var(--accent) 35%, var(--line))';
    const faint = 'color-mix(in srgb, var(--accent) 16%, var(--line))';
    const stops = [`var(--line) 0% ${f(contacts.p1)}%`,
                   `${faint} ${f(contacts.p1)}% ${f(contacts.u1)}%`];
    if (contacts.u2 !== undefined) {
      stops.push(`${wash} ${f(contacts.u1)}% ${f(contacts.u2)}%`,
                 `var(--accent) ${f(contacts.u2)}% ${f(contacts.u3)}%`,
                 `${wash} ${f(contacts.u3)}% ${f(contacts.u4)}%`);
    } else {
      stops.push(`${wash} ${f(contacts.u1)}% ${f(contacts.u4)}%`);
    }
    stops.push(`${faint} ${f(contacts.u4)}% ${f(contacts.p4)}%`,
               `var(--line) ${f(contacts.p4)}% 100%`);
    input.style.setProperty('--tl-marks', `linear-gradient(to right, ${stops.join(', ')})`);
    return;
  }
  const win = state.shadowWindow;
  let r = null;
  if (win && state.pin && state.elements) {
    r = localCircumstances(state.elements, state.pin.lat, state.pin.lon);
  }
  if (!r) {
    input.style.removeProperty('--tl-marks');
    return;
  }
  const f = (t) => Math.min(100, Math.max(0, ((t - win[0]) / (win[1] - win[0])) * 100));
  // A missing contact means that edge of the eclipse falls outside the window:
  // it is already under way when the crossing starts, or still going at the end.
  const p0 = f(r.c1 ?? win[0]);
  const p1 = f(r.c4 ?? win[1]);
  if (p1 - p0 < 0.5) {
    input.style.removeProperty('--tl-marks');
    return;
  }
  const wash = 'color-mix(in srgb, var(--accent) 35%, var(--line))';
  const stops = [`var(--line) 0% ${p0}%`];
  if (r.c2 !== undefined && r.c3 !== undefined) {
    let q0 = f(r.c2);
    let q1 = f(r.c3);
    // totality is minutes inside a crossing of hours; keep its mark visible
    if (q1 - q0 < 1.4) {
      const mid = (q0 + q1) / 2;
      q0 = Math.max(p0, mid - 0.7);
      q1 = Math.min(p1, mid + 0.7);
    }
    stops.push(`${wash} ${p0}% ${q0}%`,
               `var(--accent) ${q0}% ${q1}%`,
               `${wash} ${q1}% ${p1}%`);
  } else {
    stops.push(`${wash} ${p0}% ${p1}%`);
  }
  stops.push(`var(--line) ${p1}% 100%`);
  input.style.setProperty('--tl-marks', `linear-gradient(to right, ${stops.join(', ')})`);
}

/**
 * Draw the shadow where it stands at `fraction` through the umbra's crossing.
 * The equal-obscuration rings come only once the timeline is being driven --
 * simply picking an eclipse leaves the map showing the whole-eclipse view.
 */
function setShadowAt(fraction, showing = true) {
  if (state.kind === 'lunar') return lunarShadowAt(fraction, showing);
  const win = state.shadowWindow;
  if (!win) return;
  const t = win[0] + (win[1] - win[0]) * fraction;
  const el = state.elements;
  const { centre, ring } = shadowOutline(el, t);

  const features = [];
  if (showing) {
    const dark = nightPolygon(el, t);
    drawLiveField(el, t, dark);
    if (dark) {
      features.push({ type: 'Feature', properties: { kind: 'night' },
                      geometry: { type: 'Polygon', coordinates: dark } });
    }
    const line = terminator(el, t);
    if (line) {
      features.push({ type: 'Feature', properties: { kind: 'terminator' },
                      geometry: { type: 'MultiLineString', coordinates: line } });
    }
    const rim = penumbraEdge(el, t);
    if (rim) {
      features.push({ type: 'Feature', properties: { kind: 'rim' },
                      geometry: { type: 'MultiLineString', coordinates: rim } });
    }
  }
  if (ring) {
    features.push({ type: 'Feature', properties: { kind: 'umbra' },
                    geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  if (centre) {
    features.push({ type: 'Feature', properties: { kind: 'centre' },
                    geometry: { type: 'Point', coordinates: [centre.lon, centre.lat] } });
  }
  setShadow({ type: 'FeatureCollection', features });
  state.liveT = showing ? t : null;
  updateEye();
  setLive(showing);

  const date = state.current?.date;
  const readout = date
    ? `${clock(date, toUT(el, t), { seconds: true, reference: toUT(el, (win[0] + win[1]) / 2) })} ${timeLabel()}`
    : '';
  $('tl-time').textContent = readout;
  // The corner disc carries the same clock, so watching it means watching it all.
  const eyeTime = $('eye-time');
  if (eyeTime) eyeTime.textContent = $('eye')?.hidden ? '' : readout;
}

/** The lunar timeline: the whole event, umbral phases plus shoulders. */
function showLunarTimeline(entry) {
  stopPlaying();
  setLive(false);
  const { contacts } = lunar.geometryOf(entry);
  const pad = (contacts.u4 - contacts.u1) * 0.25;
  state.shadowWindow = [contacts.u1 - pad, contacts.u4 + pad];
  $('timeline').hidden = false;
  document.body.classList.add('has-timeline');
  updateScrubMarks();
  syncUrl({ replace: true });
  $('tl-scrub').value = '0';
  lunarShadowAt(0, false);
}

/**
 * Draw the lunar view at `fraction` through the window: the hemisphere that
 * can see the Moon, tinted by the phase -- or, when nothing is being shown,
 * the whole-eclipse picture of how much each place gets to see.
 */
function lunarShadowAt(fraction, showing = true) {
  const win = state.shadowWindow;
  const entry = state.current;
  if (!win || !entry) return;
  const t = win[0] + (win[1] - win[0]) * fraction;
  const target = liveTarget();
  const lines = [];
  if (showing) {
    lunar.paintInstant(entry, t, target);
    lines.push({ kind: 'terminator', at: t });
  } else {
    lunar.paintSummary(entry, target);
    const { contacts } = lunar.geometryOf(entry);
    lines.push({ kind: 'rim', at: contacts.u1 }, { kind: 'rim', at: contacts.u4 });
  }
  setShadow({ type: 'FeatureCollection',
              features: lines.map(({ kind, at }) => ({
                type: 'Feature', properties: { kind },
                geometry: { type: 'MultiLineString',
                            coordinates: lunar.horizonLine(entry, at) } })) });
  ensureLiveLayer();
  if (map.getLayer('live')) map.setLayoutProperty('live', 'visibility', 'visible');
  const source = map.getSource('live');
  if (source) { source.play.call(source); setTimeout(() => source.pause.call(source), 120); }
  state.live = showing;
  state.liveT = showing ? t : null;
  $('tl-stop').hidden = !showing;
  updateEye();

  const ut = ((t % 24) + 24) % 24;
  const readout = showing
    ? `${clock(entry.date, ut, { seconds: true, reference: ((lunar.geometryOf(entry).g % 24) + 24) % 24 })} ${timeLabel()}`
    : '\u2014';
  $('tl-time').textContent = readout;
  const eyeTime = $('eye-time');
  if (eyeTime) eyeTime.textContent = $('eye')?.hidden || !showing ? '' : readout;
}

function setShadow(fc) {
  const src = map.getSource('shadow');
  if (src) src.setData(fc || EMPTY_SHADOW);
}

/**
 * The static shading and the live field are the same picture of different
 * moments: one is the deepest a place ever gets, the other is how much is
 * covered right now. Two readings of the same colours would be one too many, so
 * driving the timeline swaps them over rather than stacking them.
 */
function setLive(on) {
  if (state.live === on) return;
  state.live = on;
  if (!on) { state.liveT = null; updateEye(); }
  const mode = state.settings.mode;
  const set = (layer, prop, value) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  set('shading', 'raster-opacity', on || mode !== 'gradient' ? 0 : 1);
  set('band-fill', 'fill-opacity', !on && mode === 'bands' ? 0.09 : 0);
  set('penumbra-fill', 'fill-opacity', !on && mode === 'bands' ? 0.10 : 0);
  set('band-line', 'line-opacity', on ? 0 : 0.55);
  if (map.getLayer('band-label')) {
    map.setLayoutProperty('band-label', 'visibility', on ? 'none' : 'visible');
  }
  if (map.getLayer('live')) {
    map.setLayoutProperty('live', 'visibility', on ? 'visible' : 'none');
  }
  const source = map.getSource('live');
  if (source) (on ? source.play : source.pause).call(source);
  $('tl-stop').hidden = !on;
}

// ------------------------------------------------ the view from the pin
//
// While the shadow is running and a place is pinned, a small disc of sky in the
// corner shows the Sun and Moon as they stand from that place at that moment,
// the way the person standing there sees it: zenith up, horizon level.
const EYE_DAY = [0x63, 0x9e, 0xd2];
const EYE_DUSK = [0x0d, 0x14, 0x26];

function updateEye() {
  const host = $('eye');
  if (!host) return;
  if (state.kind === 'lunar') {
    const t = state.liveT;
    const entry = state.current;
    if (t === null || !entry || !state.pin) { host.hidden = true; return; }
    const canvas = $('eye-canvas');
    const { label } = lunar.drawEye(canvas.getContext('2d'), canvas.width,
                                    entry, t, state.pin);
    const caption = $('eye-label');
    if (caption.textContent !== label) caption.textContent = label;
    host.setAttribute('aria-label',
      `The Moon from the pinned place: ${label || 'full and unshadowed'}`);
    host.hidden = false;
    return;
  }
  const t = state.liveT;
  const el = state.elements;
  if (t === null || !el || !state.pin) { host.hidden = true; return; }
  const v = localInstant(el, state.pin.lat, state.pin.lon, t);

  const canvas = $('eye-canvas');
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cx = size / 2, cy = size / 2, edge = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, edge, 0, 2 * Math.PI);
  ctx.clip();

  const c = Math.max(v.ratio, 1e-3);
  const o = obscurationFrom(v.magnitude, c);
  const total = v.separation <= c - 1;
  const annular = c < 1 && v.separation <= 1 - c;
  const alt = v.altitude;

  // Daylight holds until nearly the end, then goes all at once -- the fourth
  // power is the same judgement the map's live shading makes. Twilight pulls
  // the same lever: whichever has taken more of the light wins.
  const twilight = Math.min(1, Math.max(0, (2 - alt) / 10));
  const k = total ? 1 : Math.max(Math.min(1, o ** 4), twilight);
  const mix = (i) => Math.round(EYE_DAY[i] + (EYE_DUSK[i] - EYE_DAY[i]) * k);
  ctx.fillStyle = `rgb(${mix(0)},${mix(1)},${mix(2)})`;
  ctx.fillRect(0, 0, size, size);

  // The Sun fills a third of the disc, so first and last contact fall just
  // inside the rim and the Moon slides in through it rather than popping up.
  const R = edge * 0.34;
  if (!total && v.up) {
    const glare = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 2.4);
    glare.addColorStop(0, 'rgba(255,244,214,.5)');
    glare.addColorStop(1, 'rgba(255,244,214,0)');
    ctx.fillStyle = glare;
    ctx.fillRect(0, 0, size, size);
  }
  const sun = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.2, cx, cy, R);
  sun.addColorStop(0, '#fff8dc');
  sun.addColorStop(1, '#fbbf24');
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fill();

  // The view stands the way the viewer does: zenith up, horizon level. The
  // Moon's offset comes out of the geometry with celestial north up, so it is
  // rotated by the angle between north and the local vertical.
  const zl = Math.hypot(v.zenithEast, v.zenithNorth);
  const zx = zl > 1e-6 ? -v.zenithEast / zl : 0;    // zenith, canvas axes
  const zy = zl > 1e-6 ? -v.zenithNorth / zl : -1;
  const phi = Math.atan2(zx, -zy);
  const d = Math.hypot(v.east, v.north) || 1;
  const ox = -(v.east / d) * v.separation * R;      // north-up offset...
  const oy = -(v.north / d) * v.separation * R;
  const mx = cx + ox * Math.cos(phi) + oy * Math.sin(phi);   // ...stood upright
  const my = cy + oy * Math.cos(phi) - ox * Math.sin(phi);
  if (total) {
    // the corona: the one sight the map itself cannot show
    const halo = ctx.createRadialGradient(mx, my, R * c * 0.95, mx, my, R * c * 2);
    halo.addColorStop(0, 'rgba(228,238,255,.95)');
    halo.addColorStop(0.4, 'rgba(196,212,240,.35)');
    halo.addColorStop(1, 'rgba(196,212,240,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.fillStyle = '#0d1117';
  ctx.beginPath();
  ctx.arc(mx, my, R * c, 0, 2 * Math.PI);
  ctx.fill();

  // The ground, level across the bottom as a person standing there has it.
  // The view is glued to the Sun, so it is the horizon that moves: as the Sun
  // drops the ground climbs the disc and finally rides over it. The altitude
  // scale is deliberately compressed -- to true scale the horizon would only
  // enter this narrow a view for the last fraction of a degree.
  if (alt < 10) {
    // clamped: far below the horizon the ground is everything, not a band
    // that slides out through the top of the disc
    const yH = cy + (Math.max(alt, -12) / 10) * edge;
    const ground = ctx.createLinearGradient(0, yH, 0, cy + edge * 1.2);
    ground.addColorStop(0, '#232d28');
    ground.addColorStop(1, '#0c110e');
    ctx.fillStyle = ground;
    ctx.fillRect(0, yH, size, size * 2);
    // the last light along the horizon, when the Sun is near it
    const glow = Math.max(0, 1 - Math.abs(alt) / 6) * (1 - o * 0.85);
    if (glow > 0.02) {
      ctx.strokeStyle = `rgba(255,196,130,${(0.65 * glow).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, yH);
      ctx.lineTo(size, yH);
      ctx.stroke();
    }
  }

  // 100% belongs to totality alone; the seconds either side of it are a 99.9%
  // that must not round up to a claim the geometry is not making.
  const label = !v.up ? 'Sun below the horizon'
    : total ? 'Totality'
    : annular ? 'Annular'
    : o >= 0.005 ? `${Math.min(99, Math.round(o * 100))}% covered`
    : '';
  ctx.restore();

  const caption = $('eye-label');
  if (caption.textContent !== label) caption.textContent = label;
  host.setAttribute('aria-label',
    `The Sun from the pinned place: ${label || 'not yet eclipsed'}`);
  host.hidden = false;
}

// A real eclipse shadow is neutral, and faithfully drawn it is also nearly
// invisible: brightness goes as the *uncovered* part of the Sun, so half of it
// gone is only about a quarter of a dimming, and the last few percent are the
// whole show. Drawn that way the penumbra reads as nothing at all. The curve
// below is deliberately past physical -- a shadow you can actually watch cross
// the map rather than one that only exists at the centre line.
const LIVE_TINT = '#0b1220';
const LIVE_DEPTH = 0.82;   // how dark it gets under totality
const LIVE_NIGHT = 0.20;   // the night side, a flat wash
const LIVE_CURVE = 0.9;    // near 1 spreads the darkening out into the penumbra
// How far past the horizon the field is carried before the night side is cut
// back off it, in Earth radii along the shadow axis.
const LIVE_MARGIN = 0.05;

// The shading is drawn per pixel into a canvas the map samples directly. Bands
// of filled outline were the obvious alternative and were abandoned: rings that
// run round a pole or across the antimeridian cannot be described as a closed
// shape without a good deal of machinery, and every high-latitude eclipse does
// both. A field has no such topology. Its edges come out soft, so the two that
// need to be crisp -- the rim of the shadow and the day/night line -- are drawn
// over it as lines.
const LIVE_W = 640;
const LIVE_H = 320;
let live = null;

function liveTarget() {
  if (live) return live;
  const top = Math.log(Math.tan(Math.PI / 4 + (MERCATOR_LIMIT * Math.PI) / 360));
  const lats = new Float64Array(LIVE_H);
  for (let j = 0; j < LIVE_H; j++) {           // rows are spaced up the Mercator
    const y = top * (1 - (2 * (j + 0.5)) / LIVE_H);
    lats[j] = (Math.atan(Math.sinh(y)) * 180) / Math.PI;
  }
  const lons = new Float64Array(LIVE_W);
  for (let i = 0; i < LIVE_W; i++) lons[i] = -180 + (360 * (i + 0.5)) / LIVE_W;
  const toX = (lon) => ((lon + 180) / 360) * LIVE_W;
  const toY = (lat) => {
    const m = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    return ((1 - m / top) / 2) * LIVE_H;
  };

  // The map reads this canvas straight out of the document. Off-document it
  // uploads nothing at all, silently -- so it is parked out of sight instead of
  // being left detached.
  const canvas = document.createElement('canvas');
  canvas.width = LIVE_W;
  canvas.height = LIVE_H;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;left:-9999px;top:0;pointer-events:none';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  live = { lats, lons, canvas, ctx, toX, toY,
           field: new Float32Array(LIVE_W * LIVE_H),
           image: ctx.createImageData(LIVE_W, LIVE_H) };
  return live;
}

/** Paint the obscuration as it stands at `t` into the map's live raster. */
function drawLiveField(el, t, dark) {
  const { lats, lons, canvas, ctx, toX, toY, field, image } = liveTarget();
  instantField(el, t, lats, lons, field, dark ? LIVE_MARGIN : 0);

  const hex = LIVE_TINT.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  const px = image.data;
  for (let k = 0, p = 0; k < field.length; k++, p += 4) {
    const v = field[k];
    px[p] = r; px[p + 1] = g; px[p + 2] = b;
    px[p + 3] = v > 0
      ? Math.round(LIVE_DEPTH * (1 - (1 - v) ** LIVE_CURVE) * 255)
      : 0;
  }
  ctx.putImageData(image, 0, 0);

  // Trim the night side away along a path rather than along the pixel grid.
  // Canvas antialiases a filled path, so the day/night edge lands between
  // pixels instead of stepping down them.
  if (dark) {
    const path = new Path2D();
    for (const ring of dark) {
      ring.forEach(([lon, lat], i) => (i ? path.lineTo(toX(lon), toY(lat))
                                         : path.moveTo(toX(lon), toY(lat))));
      path.closePath();
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(path);
    ctx.globalCompositeOperation = 'source-over';
  }

  ensureLiveLayer();
}

function ensureLiveLayer() {
  const { canvas } = liveTarget();
  if (!map.getSource('live')) {
    try {
      map.addSource('live', { type: 'canvas', canvas, animate: true,
                              coordinates: WORLD_CORNERS });
    } catch { return; }              // style not ready yet; the next draw will be
  }
  if (!map.getLayer('live')) {
    const below = ['band-fill', 'penumbra-fill', 'path-fill']
      .find((id) => map.getLayer(id));
    try {
      map.addLayer({ id: 'live', type: 'raster', source: 'live',
                     paint: { 'raster-fade-duration': 0,
                              'raster-resampling': 'linear' } }, below);
    } catch { /* same */ }
  }
}

/** Leave the moment-by-moment view and put the whole-eclipse picture back. */
function stopLive() {
  stopPlaying();
  setLive(false);
  setShadow(null);
  $('tl-scrub').value = '0';
  $('tl-time').textContent = '\u2014';
  syncUrl({ replace: true });     // no moment showing, so none in the address
}

function startPlaying() {
  if (!state.shadowWindow) return;
  state.playing = true;
  $('tl-play').innerHTML = PAUSE_ICON;
  $('tl-play').setAttribute('aria-label', 'Pause the shadow');
  // The position lives here as a float, not in the scrub bar: the bar holds
  // integers, and at the slower speeds a frame's progress is a fraction of one
  // unit -- read back and rounded each frame, it would never move at all.
  let v = Number($('tl-scrub').value) / 1000;
  let last = null;
  const tick = (now) => {
    if (!state.playing) return;
    if (last !== null) {
      // the whole crossing takes about twenty-four seconds at 1x, whatever its
      // real length -- the twelve it used to take turned out to be a sprint
      v += ((now - last) / 24000) * state.playRate;
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

/**
 * The picked place. Setting it drops the marker, fills the card and feeds the
 * corner disc; it does NOT filter the list -- that is opted into with the
 * card's button, though once opted in the filter follows the pin around.
 */
function setPin(lngLat, { push = true } = {}) {
  state.pin = lngLat ? { lat: lngLat.lat, lon: lngLat.lng ?? lngLat.lon } : null;
  drawPin();
  updateEye();
  renderPlace();
  updateScrubMarks();
  if (push) syncUrl();
  if (!state.pin) {
    if (state.visible) clearVisible();
    return;
  }
  if (state.visible) showVisibleFromPin();
}

function clearVisible() {
  state.visible = null;
  $('pinbar').hidden = true;
  $('place-threshold').hidden = true;
  applyFilters();
}

function showVisibleFromPin() {
  if (!state.pin) return;
  $('pinbar-at').textContent = `From ${formatLatLon(state.pin.lat, state.pin.lon, 2)}`;
  $('pinbar').hidden = false;
  $('place-threshold').hidden = false;
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

// One scan of all 454 eclipses from one place, cached by place: the filter,
// the card's "next from here" line, and any repeat visit share the same work.
let placeScan = { key: null, promise: null };

function visibleFrom(pin) {
  const key = `${pin.lat.toFixed(4)},${pin.lon.toFixed(4)}`;
  if (placeScan.key === key) return placeScan.promise;
  placeScan = {
    key,
    promise: elementsForAll().then((elements) => {
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
      return seen;
    }),
  };
  return placeScan.promise;
}

async function computeVisible() {
  const pin = state.pin;
  $('count').textContent = 'working out what is visible…';
  let seen;
  try {
    seen = await visibleFrom(pin);
  } catch (err) {
    $('count').textContent = 'Could not load the eclipse elements.';
    console.error(err);
    return;
  }
  if (state.pin !== pin) return;                 // moved on already
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

/** The card for the picked place: re-rendered whenever the place, the eclipse
    or the time format changes, so it can never show a stale reading. */
function renderPlace() {
  const card = $('place');
  if (!card) return;
  const visBtn = $('place-visible');
  if (visBtn) visBtn.hidden = state.kind === 'lunar';   // that filter is solar-only
  if (!state.pin) { card.hidden = true; return; }
  if (state.kind === 'lunar') { renderLunarPlace(card); return; }
  const pin = state.pin;
  const lngLat = { lat: pin.lat, lng: pin.lon };
  $('place-body').innerHTML = state.elements
    ? circumstancesHTML(localCircumstances(state.elements, lngLat.lat, lngLat.lng), lngLat)
    : `<p class="pop__where">${formatLatLon(lngLat.lat, lngLat.lng, 3)}</p>`;
  card.hidden = false;

  // The next eclipse this place will see, filled in once the scan is done.
  // The scan is shared with (and cached for) the visible-from-here filter.
  visibleFrom(pin).then((seen) => {
    if (state.pin !== pin || card.hidden) return;
    const today = new Date().toISOString().slice(0, 10);
    // Only an eclipse worth standing outside for: half the Sun gone, or the
    // real thing. A two-per-cent graze is technically next and worth nothing.
    const worth = (e) => e.date >= today && seen.has(e.id)
      && (seen.get(e.id).central || seen.get(e.id).obscuration >= 0.5);
    const next = state.all.find(worth);
    if (!next) return;
    const what = seen.get(next.id);
    const how = what.durationS
      ? `${what.total ? 'totality' : 'annularity'} ${formatDuration(what.durationS)}`
      : `${formatObscuration(what.obscuration)} covered`;
    const row = document.createElement('p');
    row.className = 'pop__note pop__next';
    row.innerHTML = `Next from here: <button type="button" class="pop__link" `
      + `data-next="${next.id}">${formatDate(next.date)}</button> — ${how}`;
    $('place-body').append(row);
  }).catch(() => { /* the card stands without it */ });
}

function renderLunarPlace(card) {
  const pin = state.pin;
  const entry = state.current;
  if (!entry) { card.hidden = true; return; }
  const { head, rows } = lunar.placeSummary(entry, pin);
  const listed = rows.map(([name, when, seen]) =>
    `<dt>${name}</dt><dd>${when} — ${seen}</dd>`).join('');
  // the next lunar eclipse this place gets a proper look at
  const today = new Date().toISOString().slice(0, 10);
  const next = (state.lunarAll || []).find((e) => e.date >= today
    && (e.type === 'total' || e.umbralMag >= 0.5)
    && lunar.moonAlt(e, pin.lat, pin.lon, lunar.geometryOf(e).g) > 0);
  const nextRow = next
    ? `<p class="pop__note pop__next">Next from here: <button type="button"
         class="pop__link" data-next="${next.id}">${formatDate(next.date)}</button>
         — ${next.type === 'total' ? 'total' : 'partial'} lunar</p>`
    : '';
  $('place-body').innerHTML =
    `<p class="pop__head${head.includes('below') ? ' pop__head--none' : ''}">${head}</p>`
    + `<dl class="pop__facts">${listed}</dl>`
    + `<p class="pop__where">${formatLatLon(pin.lat, pin.lon, 3)}</p>`
    + nextRow;
  card.hidden = false;
}

function circumstancesHTML(s, lngLat) {
  const where = `<p class="pop__where">${formatLatLon(lngLat.lat, lngLat.lng, 3)}</p>`;
  if (!s) {
    return `<p class="pop__head pop__head--none">No eclipse here</p>
            <p class="pop__note">The Sun is either untouched or below the horizon
            throughout.</p>${where}`;
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
    // To the second: the whole event can be shorter than the minute the times
    // would otherwise round to.
    rows.push([s.total ? 'Totality' : 'Annularity',
               `${when(s.c2, { seconds: true })} – ${when(s.c3, { seconds: true })} ${timeLabel()}`]);
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
    + where;
}

// ------------------------------------------------------ sharing the view

let toastTimer = null;
function toast(message) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
}

async function shareView() {
  syncUrl({ replace: true });     // catch the moment playback is sitting on
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title: document.title, url }); return; }
    catch { return; }             // the person closed the sheet; that is an answer
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { toast(url); }           // clipboard refused: show it to copy by hand
}

/** An .ics for the picked place: the eclipse there, first to last contact. */
function downloadCalendar() {
  if (!state.pin) { toast('Click the map to pick a place first'); return; }
  if (state.kind === 'lunar') return downloadLunarCalendar();
  if (!state.elements || !state.current) return;
  const r = localCircumstances(state.elements, state.pin.lat, state.pin.lon);
  if (!r) { toast('No eclipse visible from the picked place'); return; }
  const el = state.elements;
  const date = state.current.date;
  const ref = toUT(el, r.tMax);
  const when = (t) => instantFor(date, toUT(el, t), ref);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (s) => s.replace(/[\\;,]/g, ' ');
  const summary = r.durationS
    ? `Solar eclipse — ${r.total ? 'totality' : 'annularity'} ${formatDuration(r.durationS)}`
    : `Solar eclipse — ${formatObscuration(r.obscuration)} of the Sun covered`;
  const detail = [
    `Maximum ${hms(toUT(el, r.tMax), true)} UT`,
    r.durationS
      ? `${r.total ? 'totality' : 'annularity'} ${hms(toUT(el, r.c2), true)}–${hms(toUT(el, r.c3), true)} UT`
      : null,
    location.href,
  ].filter(Boolean).join(' — ');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eclipse Mapper//EN',
    'BEGIN:VEVENT',
    `UID:${state.current.id}-${state.pin.lat.toFixed(2)}-${state.pin.lon.toFixed(2)}@eclipse-mapper`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(when(r.c1 ?? r.tMax))}`,
    `DTEND:${stamp(when(r.c4 ?? r.tMax))}`,
    `SUMMARY:${clean(summary)}`,
    `DESCRIPTION:${clean(detail)}`,
    `GEO:${state.pin.lat.toFixed(4)};${state.pin.lon.toFixed(4)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `eclipse-${date}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Calendar event saved');
}

function downloadLunarCalendar() {
  const entry = state.current;
  if (!entry) return;
  const { contacts, g } = lunar.geometryOf(entry);
  const summary = lunar.placeSummary(entry, state.pin);
  if (summary.head.startsWith('Moon below')) {
    toast('The Moon is below the horizon there for this one');
    return;
  }
  const ref = ((g % 24) + 24) % 24;
  const when = (t) => instantFor(entry.date, ((t % 24) + 24) % 24, ref);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (x) => x.replace(/[\\;,]/g, ' ');
  const title = `${titleCase(entry.type)} lunar eclipse`
    + (entry.totM ? ` — totality ${formatDuration(entry.totM * 60)}` : '');
  const detail = [
    summary.head,
    contacts.u2 !== undefined
      ? `totality ${lunar.utClock(contacts.u2)}–${lunar.utClock(contacts.u3)} UT`
      : null,
    `partial phase ${lunar.utClock(contacts.u1)}–${lunar.utClock(contacts.u4)} UT`,
    location.href,
  ].filter(Boolean).join(' — ');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eclipse Mapper//EN',
    'BEGIN:VEVENT',
    `UID:lunar-${entry.id}-${state.pin.lat.toFixed(2)}-${state.pin.lon.toFixed(2)}@eclipse-mapper`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(when(contacts.u1))}`,
    `DTEND:${stamp(when(contacts.u4))}`,
    `SUMMARY:${clean(title)}`,
    `DESCRIPTION:${clean(detail)}`,
    `GEO:${state.pin.lat.toFixed(4)};${state.pin.lon.toFixed(4)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `lunar-eclipse-${entry.date}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Calendar event saved');
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

const htmlEscape = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

// ------------------------------------------------------------------ data

/** Data URLs carry the build stamp, so a rebuild is never served from cache. */
// Rooted, not relative: selecting an eclipse rewrites the address to
// /eclipse/<date>/, which would move what a relative URL resolves against.
const dataUrl = (name) =>
  `/data/${name}${state.version ? `?v=${encodeURIComponent(state.version)}` : ''}`;

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

async function select(id, opts = {}) {
  if (state.kind === 'lunar') return selectLunar(id, opts);
  return selectSolar(id, opts);
}

/** Lunar selection: no geometry to fetch -- the catalogue row is everything. */
async function selectLunar(id, { fit = true, push = true, replace = false } = {}) {
  const entry = state.all.find((e) => e.id === id);
  if (!entry) return;
  loadToken++;                       // cancel any solar load still in flight
  state.current = entry;
  state.elements = null;
  renderInfo(entry);
  markCurrentInList();
  $('stepper-now').textContent = formatDate(entry.date, true);
  updateStepper();
  if (push) syncUrl({ replace });
  renderPlace();
  setMapData(EMPTY);
  showLunarTimeline(entry);
  if (fit) {
    map.easeTo({ center: [entry.zenith.lon, entry.zenith.lat],
                 zoom: Math.min(map.getZoom(), 2.2), duration: 700 });
  }
}

async function selectSolar(id, { fit = true, push = true, replace = false } = {}) {
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
    renderPlace();
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
  if (state.pin) q.set('at', `${state.pin.lat.toFixed(4)},${state.pin.lon.toFixed(4)}`);
  // A shown moment goes into the address as its UT clock time, so a shared
  // link opens mid-eclipse. Only written when the timeline is showing one --
  // and only on a pause or a scrub, never per frame of playback.
  if (state.live && state.liveT !== null
      && (state.kind === 'lunar' || state.elements)) {
    const ut = state.kind === 'lunar'
      ? state.liveT                       // lunar time is already UT hours
      : toUT(state.elements, state.liveT);
    const s = Math.round(ut * 3600);
    q.set('t', [3600, 60, 1].map((d, i) =>
      String(Math.floor(s / d) % (i ? 60 : 24)).padStart(2, '0')).join(''));
  }
  const query = q.toString();
  const base = state.kind === 'lunar' ? 'lunar' : 'eclipse';
  const path = state.current ? `/${base}/${state.current.date}/` : '/';
  const url = query ? `${path}?${query}` : path;
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

/** Put the timeline where a shared link's ?t=HHMMSS (UT) said it was. The raw
    value is captured before boot's select() rewrites the address. */
function applyMoment(raw) {
  const win = state.shadowWindow;
  const el = state.elements;
  if (!raw || !win || !/^\d{6}$/.test(raw)) return;
  if (state.kind !== 'lunar' && !el) return;
  const ut = Number(raw.slice(0, 2)) + Number(raw.slice(2, 4)) / 60 + Number(raw.slice(4)) / 3600;
  // toUT is t plus a constant, mod 24 -- so invert it and pick the day's copy
  // that lands nearest the crossing. Lunar windows are UT already.
  let t = state.kind === 'lunar' ? ut : ut - el.t0 + el.deltaT / 3600;
  const mid = (win[0] + win[1]) / 2;
  t += 24 * Math.round((mid - t) / 24);
  const fraction = (t - win[0]) / (win[1] - win[0]);
  if (fraction < 0 || fraction > 1) return;
  $('tl-scrub').value = String(Math.round(fraction * 1000));
  setShadowAt(fraction);
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
  setLive(false);
  setShadow(null);
  stopPlaying();
  if ($('tl-scrub')) $('tl-scrub').value = '0';
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
  if (state.kind === 'lunar') return renderLunarInfo(e);
  const ref = e.greatest.ut ? hoursOf(e.greatest.ut) : 12;
  const at = (hhmm, opts) => clock(e.date, hoursOf(hhmm), { reference: ref, ...opts });
  const span = (from, to) => `${at(from)}–${at(to)} ${timeLabel()}`;

  // Short values pair up two to a row; anything carrying a time range needs the width.
  const pairs = [
    ['Type', `${titleCase(e.type)}<span class="facts__code"> ${e.typeCode}</span>`],
    // Nothing here explains what a saros is, on purpose: to anyone who does not
    // already care it stays a number. Anyone who wonders whether this eclipse
    // happens again gets the answer by pressing it.
    ['Saros', `<button type="button" class="facts__series" data-saros="${e.saros}"
                       title="Show the rest of this series">${e.saros}</button>`],
    ['Magnitude', e.magnitude.toFixed(3)],
  ];
  if (e.pathWidthKm) pairs.push(['Width', `${Math.round(e.pathWidthKm)} km`]);

  const wide = [];
  if (e.centralDurationS) {
    // A hybrid is both along its length, so it does not get a noun.
    const longest = e.type === 'total' ? 'Longest totality'
      : e.type === 'annular' ? 'Longest annularity' : 'Longest';
    wide.push([longest, formatDuration(e.centralDurationS)]);
  }
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
    + `<details class="facts__more"><summary>More</summary>${dl(more)}</details>`
    + '<div id="facts-cities"></div>';
  renderCities(e);
}

function renderLunarInfo(e) {
  const { contacts, g } = lunar.geometryOf(e);
  const ref = ((g % 24) + 24) % 24;
  const at = (t, opts) => clock(e.date, ((t % 24) + 24) % 24, { reference: ref, ...opts });
  const span = (a, b) => `${at(a)}–${at(b)} ${timeLabel()}`;
  const pairs = [
    ['Type', `${titleCase(e.type)} lunar<span class="facts__code"> ${e.typeCode}</span>`],
    ['Saros', `<button type="button" class="facts__series" data-saros="${e.saros}"
                       title="Show the rest of this series">${e.saros}</button>`],
    ['Umbral mag.', e.umbralMag.toFixed(3)],
    ['Penumbral', e.penMag.toFixed(3)],
  ];
  const wide = [];
  if (contacts.u2 !== undefined) {
    wide.push(['Totality', `${span(contacts.u2, contacts.u3)} · ${formatDuration(e.totM * 60)}`]);
  }
  wide.push(['Greatest', `${at(g, { seconds: true })} ${timeLabel()}`]);
  wide.push(['Partial phase', span(contacts.u1, contacts.u4)]);
  wide.push(['Penumbral', span(contacts.p1, contacts.p4)]);
  const more = [
    ['Gamma', signed(e.gamma, 4)],
    ['Moon overhead', formatLatLon(e.zenith.lat, e.zenith.lon)],
  ];
  const dl = (rows, cls) =>
    `<dl class="facts ${cls || ''}">`
    + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
    + '</dl>';
  const note = e.type === 'total'
    ? 'Visible from the entire night side of the Earth at once — anywhere the '
      + 'Moon is up sees the same eclipse at the same moment.'
    : 'The Moon only clips the umbra, so part of it stays bright throughout. '
      + 'Visible from the whole night side at once.';
  $('facts').innerHTML =
    dl(pairs, 'facts--pairs')
    + dl(wide)
    + `<p class="facts__note">${note}</p>`
    + '<div id="facts-cities"></div>';
}

// The cities standing in the path, precomputed by the pipeline into one file
// for all eclipses. Clicking one pins it, so the card, the corner disc and the
// timeline marks all snap to that city.
let cityTimes = null;

async function renderCities(e) {
  const host = $('facts-cities');
  if (!host || !e.hasPath) return;
  if (!cityTimes) {
    try {
      cityTimes = await fetch(dataUrl('cities.json')).then((r) => {
        if (!r.ok) throw new Error(`cities.json: ${r.status}`);
        return r.json();
      });
    } catch { return; }                        // the panel stands without it
  }
  if (state.current?.id !== e.id || !host.isConnected) return;
  const rows = cityTimes[e.id];
  if (!rows?.length) return;
  const noun = e.type === 'total' ? 'Totality'
    : e.type === 'annular' ? 'Annularity' : 'Central phase';
  const ref = hoursOf(rows[0].from);
  const line = (r) =>
    `<li><button type="button" class="pop__link" data-city="${r.lat},${r.lon}"
       title="Pin ${htmlEscape(r.name)} on the map">${htmlEscape(r.name)},
       ${htmlEscape(r.country)}</button>
     <span class="facts__citytime">${clock(e.date, hoursOf(r.from), { seconds: true, reference: ref })}
       ${timeLabel()} · ${formatDuration(r.durationS)}</span></li>`;
  host.innerHTML = `<h3 class="facts__cities-title">${noun}, city by city</h3>`
    + `<ul class="facts__cities">${rows.map(line).join('')}</ul>`;

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
    marks.lastChild.textContent = 'Shadow centre, every 30 min';
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
        () => s.basemap, (id) => {
          s.basemap = id; state.basemapOverride = null;
          saveSettings(); applyBasemap();
        });

  chips($('set-times'), [['ut', 'UT'], ['local', `Yours (${LOCAL_ZONE})`]],
        () => s.times, (v) => {
          s.times = v;
          saveSettings();
          if (state.current) {
            renderInfo(state.current);
            const fc = geoCache.get(state.current.id);
            if (fc) setMapData(fc);
          }
          renderPlace();
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
    b.dataset.type = key;
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

const INTRO_KEY = 'eclipse-mapper.intro';

/** The tour, shown once and thereafter only when the ? is pressed. */
function showIntro() {
  const dialog = $('intro');
  if (!dialog?.showModal) return;          // no <dialog> support: silently skip
  if (!dialog.open) dialog.showModal();
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* private mode */ }
}

function wireIntro() {
  const dialog = $('intro');
  if (!dialog) return;
  // Any click at all dismisses it, inside or out. It is a greeting, not a form,
  // and it should never be something you have to aim at to get rid of.
  dialog.addEventListener('click', () => dialog.close());
}

function maybeShowIntro() {
  let seen = '1';
  try { seen = localStorage.getItem(INTRO_KEY); } catch { /* blocked: treat as seen */ }
  if (!seen) showIntro();
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
    if (ev.key === ' ' && !$('timeline').hidden) {
      ev.preventDefault();          // the page must not scroll under the map
      if (state.playing) {
        stopPlaying();
        syncUrl({ replace: true }); // pausing pins the moment into the address
      } else {
        startPlaying();
      }
    }
  });
}

function defaultId() {
  const today = new Date().toISOString().slice(0, 10);
  return (state.all.find((e) => e.date >= today) || state.all.at(-1)).id;
}

/**
 * Which eclipse the address asks for. Every eclipse has a page of its own, so
 * arriving on one is an ordinary page load; from then on the path is rewritten
 * in place and stepping stays the instant swap it always was. The old ?e= form
 * is still read, so links made before the pages existed keep working.
 */
function idFromUrl() {
  const onPath = location.pathname.match(/^\/eclipse\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (onPath) {
    const dated = state.all.find((e) => e.date === onPath[1]);
    if (dated) return dated.id;
  }
  const want = new URLSearchParams(location.search).get('e');
  return state.all.some((e) => e.id === want) ? want : null;
}

// -------------------------------------------------------------------- boot

async function boot() {
  let index;
  try {
    // revalidate the index every time: it is what tells us the current build
    index = await fetch('/data/index.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  } catch (err) {
    $('facts').textContent = 'Could not load eclipse data. '
      + 'If you opened this file directly, serve the folder over HTTP instead.';
    console.error(err);
    return;
  }

  state.version = index.version || '';
  state.solarAll = index.eclipses;
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
  wireIntro();
  maybeShowIntro();

  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('list').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (b) select(b.dataset.id);
  });
  $('place-clear').addEventListener('click', () => setPin(null));
  // Optional chaining on the newer controls: a cached page can be one deploy
  // older than this script, and a missing button must cost that button alone,
  // not every listener wired after the line that would have thrown.
  $('place-close')?.addEventListener('click', () => setPin(null));
  $('place-visible')?.addEventListener('click', showVisibleFromPin);
  const speedLabel = () => `${state.playRate === 0.5 ? '½' : state.playRate}×`;
  const speedBtn = $('tl-speed');
  if (speedBtn) {
    speedBtn.textContent = speedLabel();
    speedBtn.addEventListener('click', () => {
      const speeds = [0.5, 1, 2, 4];
      state.playRate = speeds[(speeds.indexOf(state.playRate) + 1) % speeds.length];
      speedBtn.textContent = speedLabel();
      try { localStorage.setItem('eclipse-mapper.speed', String(state.playRate)); }
      catch { /* private mode; the choice just will not stick */ }
    });
  }
  $('tl-scrub').addEventListener('input', (ev) => {
    stopPlaying();
    setShadowAt(Number(ev.target.value) / 1000);
    syncUrl({ replace: true });   // a scrubbed-to moment is a linkable one
  });
  $('tl-stop').addEventListener('click', stopLive);
  $('tl-play').addEventListener('click', () => {
    if (state.playing) {
      stopPlaying();
      syncUrl({ replace: true }); // pausing pins the moment into the address
    } else {
      startPlaying();
    }
  });
  $('place-body')?.addEventListener('click', (ev) => {
    const id = ev.target?.dataset?.next;
    if (id) select(id);
  });
  $('facts')?.addEventListener('click', (ev) => {
    const city = ev.target.closest?.('[data-city]')?.dataset.city;
    if (!city) return;
    const [lat, lon] = city.split(',').map(Number);
    setPin({ lat, lng: lon });
  });
  $('search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    applyFilters();
  });
  // The facts panel is rewritten on every selection, so the saros button is
  // caught on the way up rather than bound each time.
  $('facts').addEventListener('click', (ev) => {
    const button = ev.target.closest('.facts__series');
    if (!button) return;
    state.query = `saros ${button.dataset.saros}`;
    $('search').value = state.query;
    applyFilters();
    // The list sits above the facts in the same sheet, so bring it back into
    // view -- the filter it just applied is off the top of the scroll.
    const panel = $('picker');
    panel.classList.remove('is-collapsed');
    panel.querySelector('.panel__toggle')?.setAttribute('aria-expanded', 'true');
    $('list').scrollTop = 0;
    $('list').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  const startMoment = new URLSearchParams(location.search).get('t');
  // /lunar/<date>/ is the page form; ?l=YYYYMMDD is the fallback the 404
  // bounce uses, exactly as ?e= is for the solar pages.
  const onLunar = location.pathname.match(/^\/lunar\/(\d{4}-\d{2}-\d{2})\/?$/)
    || (/^\d{8}$/.test(new URLSearchParams(location.search).get('l') || '')
        ? [null, new URLSearchParams(location.search).get('l')
            .replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')]
        : null);
  let selected;
  if (onLunar) {
    selected = (async () => {
      await setKind('lunar', { push: false });
      const wanted = state.all.find((e) => e.date === onLunar[1]);
      if (wanted) await select(wanted.id, { replace: true, fit: false });
    })();
  } else {
    selected = select(idFromUrl() || defaultId(), { replace: true, fit: false });
  }
  map.once('load', () => {
    fitToCurrent();
    if (startPin) setPin(startPin, { push: false });
    // Only once both the eclipse and the map are in: the moment draws layers.
    selected.then(() => applyMoment(startMoment));
  });
}

boot();
