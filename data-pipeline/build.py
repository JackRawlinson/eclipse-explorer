"""Generate the static data the site loads: one GeoJSON per eclipse, plus an index.

Run:  .venv/bin/python build.py            (whole range)
      .venv/bin/python build.py 20240408   (one eclipse, for a quick look)
"""

from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
from shapely.geometry import MultiPolygon, Polygon

import besselian as B
import config
import geometry as G
import raster as R
import shading

# Above this share of limb-straddling time the envelope sweep stops being valid;
# measured cleanly between well-behaved eclipses (<=0.08) and grazing ones (>=0.20).
LIMB_FRACTION_LIMIT = 0.15


# --------------------------------------------------------------------------
# Facts
# --------------------------------------------------------------------------

def saros_number(lunation: int) -> int:
    """Saros series from the canon's lunation number.

    The two run in lockstep -- 38 saros steps per lunation, modulo the 223
    lunations of a series.  Checked against NASA's SEcat5 catalogue.
    """
    return (38 * lunation + 111) % 223 + 1


def _hhmm(hours: float) -> str:
    hours %= 24.0
    total = int(round(hours * 3600))
    return f"{total // 3600 % 24:02d}:{total % 3600 // 60:02d}"


def index_entry(el, extra, umbral_window, penumbral_window, bbox, kind):
    ut_of = lambda t: (el.t0 + t - el.dt / 3600.0) % 24.0
    entry = {
        "id": el.key,
        "date": f"{el.year:04d}-{el.month:02d}-{el.day:02d}",
        "type": kind,
        "typeCode": extra["eclipse_type"],
        "saros": saros_number(int(extra["lunationnum"])),
        "gamma": extra["gamma"],
        "magnitude": extra["magnitude"],
        "deltaT": el.dt,
        "greatest": {
            "lat": extra["greatestlatitude"],
            "lon": extra["greatestlongitude"],
            "ut": extra["instantOfGreatestEclipseUT"].replace(" UT", ""),
            "sunAlt": extra["greatestalt"],
        },
        "hasPath": umbral_window is not None,
    }
    if extra.get("greatestpathwidth"):
        entry["pathWidthKm"] = extra["greatestpathwidth"]
    if extra.get("greatestduration"):
        entry["centralDurationS"] = extra["greatestduration"]
    if penumbral_window:
        entry["partialBegins"] = _hhmm(ut_of(penumbral_window[0]))
        entry["partialEnds"] = _hhmm(ut_of(penumbral_window[1]))
    if umbral_window:
        entry["pathBegins"] = _hhmm(ut_of(umbral_window[0]))
        entry["pathEnds"] = _hhmm(ut_of(umbral_window[1]))
    if bbox:
        entry["bbox"] = bbox
    return entry


# --------------------------------------------------------------------------
# Geometry -> GeoJSON
# --------------------------------------------------------------------------

def _round_coords(obj, ndigits):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(v), ndigits) for v in obj]
        return [_round_coords(v, ndigits) for v in obj]
    return obj


def polygon_geojson(geom, tolerance, ndigits):
    if geom is None or geom.is_empty:
        return None
    geom = geom.simplify(tolerance, preserve_topology=True)
    if geom.is_empty:
        return None
    parts = [g for g in getattr(geom, "geoms", [geom])
             if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty]
    rings = []
    for part in parts:
        for poly in getattr(part, "geoms", [part]):
            shell = [list(c) for c in poly.exterior.coords]
            holes = [[list(c) for c in r.coords] for r in poly.interiors]
            rings.append(_round_coords([shell] + holes, ndigits))
    if not rings:
        return None
    return {"type": "MultiPolygon", "coordinates": rings}


def swept_band(el, extra, window, north_in, south_in, grazing):
    """Umbral path polygon: envelope sweep where that holds, traced contour where it does not.

    The sweep is the accurate method -- its limits agree with NASA's published path
    tables to about a thousandth of a degree -- but it assumes the shadow crosses
    the ground transversally.  A grazing eclipse breaks that assumption, so those
    are traced as a contour of the shadow-reach field instead, the same way the
    penumbral region always is.

    Tracing is not a general-purpose fallback: an ordinary path is far too narrow to
    resolve on any grid affordable over the whole globe, and a grid fine enough
    would take longer than the rest of the build put together.  Outside the grazing
    regime a sweep that yields nothing means a degenerate slice -- the vanishing
    annular tail of a hybrid, say -- and contributes nothing worth drawing.

    ``grazing`` is judged once for the eclipse as a whole, never per slice.  The
    first and last seconds of *any* path straddle the limb completely, so a hybrid's
    sliver ends would each order up a global fine grid on their own account.
    """
    if not grazing:
        ring = G.swept_ring(el, False, config.UMBRA_STEPS, window=window)
        band = G.ring_to_multipolygon(ring[0], ring[1], north_in, south_in) if ring else None
        return (band if band is not None and not band.is_empty else None), "sweep"

    traced = None
    for lat, lon in R.region_rings(el, False, _raster_step(extra), window=window):
        piece = G.ring_to_multipolygon(lat, lon, north_in, south_in)
        if piece is not None and not piece.is_empty:
            traced = piece if traced is None else traced.union(piece)
    return traced, "raster"


def _raster_step(extra):
    """Grid step giving several cells across the path, in degrees.

    Grazing paths -- the only ones traced -- are hundreds of kilometres wide, so the
    lower clamp is a guard against a pathological input rather than a real limit.
    """
    width_km = extra.get("greatestpathwidth") or 200.0
    return float(np.clip(width_km / 111.195 / 6.0, 0.2, 0.5))


def hybrid_segments(el, extra, window, kind):
    """Split a hybrid eclipse's path where it changes between total and annular."""
    if kind != "hybrid" or window is None:
        return [(window, kind)]
    t = np.linspace(window[0], window[1], 1200)
    _, _, radius = G.central_line(el.state(t))
    ok = np.isfinite(radius)
    if not ok.any():
        return [(window, kind)]
    sign = np.where(radius[ok] < 0, -1, 1)
    times = t[ok]
    cuts = [window[0]]
    for i in np.nonzero(np.diff(sign) != 0)[0]:
        cuts.append(0.5 * (times[i] + times[i + 1]))
    cuts.append(window[1])
    out = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        if b - a < 1e-4:
            continue
        mid = el.state(np.array([0.5 * (a + b)]))
        _, _, rad = G.central_line(mid)
        flavour = "total" if (np.isfinite(rad[0]) and rad[0] < 0) else "annular"
        out.append(((a, b), flavour))
    return out or [(window, kind)]


def obscuration_bands(el, grid, window):
    """Nested contours of how much of the Sun goes, as (level, geometry) pairs.

    Every level is traced from the one sampled field; only the vertex refinement
    costs anything per level, so five contours are barely dearer than one.
    """
    field = grid.obscuration
    poles = (field[-1, 0], field[0, 0])    # the grid's rows end on the poles

    out = []
    for level in config.BAND_LEVELS:
        if field.max() <= level:
            continue                       # eclipse never gets that deep anywhere
        band = None
        for lat, lon in R.obscuration_rings(el, level, grid.lats, grid.lons,
                                            field, window):
            piece = G.ring_to_multipolygon(lat, lon,
                                           bool(poles[0] > level), bool(poles[1] > level))
            if piece is not None and not piece.is_empty:
                band = piece if band is None else band.union(piece)
        if band is not None and not band.is_empty:
            out.append((level, band))
    return out


def elements_payload(el, window):
    """The Besselian elements, so the browser can work out local circumstances.

    The penumbral contact window rides along: finding it means solving for the
    shadow's tangency with the Earth, and there is no reason to make the browser
    redo that when the answer is already known.
    """
    return {
        "t0": el.t0,
        "deltaT": el.dt,
        "window": [round(window[0], 6), round(window[1], 6)] if window else None,
        "x": [round(v, 9) for v in el.x],
        "y": [round(v, 9) for v in el.y],
        "d": [round(v, 9) for v in el.d],
        "mu": [round(v, 9) for v in el.mu],
        "l1": [round(v, 9) for v in el.l1],
        "l2": [round(v, 9) for v in el.l2],
        "tanf1": el.tanf1,
        "tanf2": el.tanf2,
    }


def build_eclipse(el, extra):
    kind = B.eclipse_kind(extra)
    penumbral_window = G.contact_times(el, True)
    umbral_window = G.contact_times(el, False)
    features = []
    track_lat, track_lon = np.array([]), np.array([])

    # One sampling of the maximum-eclipse field feeds the outline, the contours
    # and the shading; see raster.EclipseGrid.
    grid = (R.sample_grid(el, penumbral_window, config.FIELD_GRID_STEP)
            if penumbral_window else None)

    north_in, south_in = R.poles_inside(el, True, penumbral_window)
    penumbra = None
    for lat, lon in R.region_rings(el, True, window=penumbral_window, grid=grid):
        piece = G.ring_to_multipolygon(lat, lon, north_in, south_in)
        if piece is not None and not piece.is_empty:
            penumbra = piece if penumbra is None else penumbra.union(piece)
    geom = polygon_geojson(penumbra, config.SIMPLIFY_PENUMBRA, config.PRECISION_PENUMBRA)
    if geom:
        features.append({"type": "Feature", "properties": {"kind": "penumbra"},
                         "geometry": geom})

    for level, band in (obscuration_bands(el, grid, penumbral_window)
                        if grid is not None else []):
        geom = polygon_geojson(band, config.SIMPLIFY_BANDS, config.PRECISION_BANDS)
        if geom:
            features.append({"type": "Feature",
                             "properties": {"kind": "band", "level": level},
                             "geometry": geom})

    # umbral path and central line, one piece per flavour
    methods = set()
    if umbral_window is not None:
        n_in, s_in = R.poles_inside(el, False, umbral_window)
        grazing = G.limb_fraction(el, umbral_window) > LIMB_FRACTION_LIMIT
        for window, flavour in hybrid_segments(el, extra, umbral_window, kind):
            band, method = swept_band(el, extra, window, n_in, s_in, grazing)
            methods.add(method)
            geom = polygon_geojson(band, config.SIMPLIFY_UMBRA, config.PRECISION_UMBRA)
            if geom:
                features.append({
                    "type": "Feature",
                    "properties": {"kind": "path", "flavour": flavour},
                    "geometry": geom})

            t = np.linspace(window[0], window[1], config.UMBRA_STEPS)
            lat, lon, _ = G.central_line(el.state(t))
            ok = np.isfinite(lat)
            if ok.sum() >= 2:
                lat, lon = lat[ok], lon[ok]
                track_lat = np.concatenate([track_lat, lat])
                track_lon = np.concatenate([track_lon, lon])
                lines = G.line_to_multilinestring(lat, lon)
                lines = [_round_coords(_thin(ls), config.PRECISION_UMBRA)
                         for ls in lines if len(ls) >= 2]
                if lines:
                    features.append({
                        "type": "Feature",
                        "properties": {"kind": "centralLine", "flavour": flavour},
                        "geometry": {"type": "MultiLineString", "coordinates": lines}})

        for la, lo, label in _time_marks(el, umbral_window):
            features.append({
                "type": "Feature",
                "properties": {"kind": "timeMark", "label": label},
                "geometry": {"type": "Point",
                             "coordinates": [round(lo, 3), round(la, 3)]}})

    features.append({
        "type": "Feature",
        "properties": {"kind": "greatest"},
        "geometry": {"type": "Point",
                     "coordinates": [extra["greatestlongitude"],
                                     extra["greatestlatitude"]]}})

    bbox = _bbox(track_lat, track_lon) if track_lat.size else _bbox_of(penumbra)
    shade = shading.obscuration_image(grid) if grid is not None else None

    entry = index_entry(el, extra, umbral_window, penumbral_window, bbox, kind)
    if "raster" in methods:
        entry["pathMethod"] = "raster"
    collection = {
        "type": "FeatureCollection",
        "properties": {
            "id": el.key,
            "acknowledgment": config.ACKNOWLEDGMENT,
            "elements": elements_payload(el, penumbral_window),
        },
        "features": features,
    }
    return entry, collection, shade


def _thin(coords, tolerance=config.SIMPLIFY_UMBRA):
    from shapely.geometry import LineString
    line = LineString(coords).simplify(tolerance, preserve_topology=False)
    return [list(c) for c in line.coords]


def _time_marks(el, window):
    """Positions of the shadow centre at whole clock intervals, in UT."""
    step = config.TICK_MINUTES / 60.0
    ut0 = el.t0 + window[0] - el.dt / 3600.0
    ut1 = el.t0 + window[1] - el.dt / 3600.0
    first = np.ceil(ut0 / step) * step
    uts = np.arange(first, ut1, step)
    if uts.size == 0:
        return []
    t = uts + el.dt / 3600.0 - el.t0
    lat, lon, _ = G.central_line(el.state(t))
    return [(la, lo, _hhmm(u)) for la, lo, u in zip(lat, lon, uts) if np.isfinite(la)]


def _bbox(lat, lon):
    lon_u = G.unwrap_lon(lon)
    west, east = float(lon_u.min()), float(lon_u.max())
    if east - west >= 360.0:
        west, east = -180.0, 180.0
    else:
        shift = 360.0 * np.floor((west + 180.0) / 360.0)
        west, east = west - shift, east - shift
    pad_lat = max(1.0, 0.08 * (float(lat.max()) - float(lat.min())))
    pad_lon = max(1.0, 0.08 * (east - west))
    return [round(west - pad_lon, 3), round(max(-89.0, float(lat.min()) - pad_lat), 3),
            round(east + pad_lon, 3), round(min(89.0, float(lat.max()) + pad_lat), 3)]


def _bbox_of(geom):
    if geom is None or geom.is_empty:
        return None
    minx, miny, maxx, maxy = geom.bounds
    return [round(minx, 3), round(miny, 3), round(maxx, 3), round(maxy, 3)]


# --------------------------------------------------------------------------

def main(only=None):
    os.makedirs(config.OUTPUT_DIR, exist_ok=True)
    catalog = [(e, x) for e, x in B.load_catalog()
               if config.YEAR_MIN <= e.year <= config.YEAR_MAX]
    if only:
        catalog = [(e, x) for e, x in catalog if e.key == only]
    for el, _ in catalog:
        if el.key in config.DELTA_T_OVERRIDES:
            el.dt = config.DELTA_T_OVERRIDES[el.key]

    index, started, total_bytes = [], time.time(), 0
    # Stamped into every data URL the page requests, so a rebuild is picked up
    # rather than served from a browser cache that has no way to know better.
    version = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    for n, (el, extra) in enumerate(catalog, 1):
        entry, collection, shade = build_eclipse(el, extra)
        path = os.path.join(config.OUTPUT_DIR, f"{el.key}.geojson")
        blob = json.dumps(collection, separators=(",", ":"))
        with open(path, "w") as fh:
            fh.write(blob)
        total_bytes += len(blob)
        if shade:
            with open(os.path.join(config.OUTPUT_DIR, f"{el.key}.png"), "wb") as fh:
                fh.write(shade)
            total_bytes += len(shade)
            entry["shading"] = True
        index.append(entry)
        if n % 25 == 0 or n == len(catalog):
            rate = n / max(1e-9, time.time() - started)
            print(f"  {n:4d}/{len(catalog)}  {el.key}  "
                  f"{rate:.1f}/s  avg {total_bytes / n / 1024:.0f} KB", flush=True)

    if not only:
        index.sort(key=lambda e: e["id"])
        with open(os.path.join(config.OUTPUT_DIR, "index.json"), "w") as fh:
            json.dump({
                "version": version,
                "range": [config.YEAR_MIN, config.YEAR_MAX],
                "acknowledgment": config.ACKNOWLEDGMENT,
                "source": config.SOURCE,
                "count": len(index),
                "eclipses": index,
            }, fh, separators=(",", ":"))
    print(f"done: {len(index)} eclipses, {total_bytes / 1024 / 1024:.1f} MB total, "
          f"{time.time() - started:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
