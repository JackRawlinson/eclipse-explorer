"""Check the files actually shipped in public/data.

Everything else in this directory validates geometry in memory.  This one reads
what the browser will read, so it also catches anything lost in simplification,
rounding or serialisation -- above all a ring that wraps the globe because an
antimeridian crossing was mishandled.
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union

import besselian as B
import config
import geometry as G
import raster as R

# A part may legitimately stretch across most of the world -- an ordinary path
# spans 200 degrees of longitude without going anywhere near the antimeridian.
# What cannot happen is a *jump* between neighbouring vertices: that is the line
# drawn the wrong way round the globe.  The one exception is the edge closing a
# polar cap, which runs along the top or bottom of the map by construction.
MAX_VERTEX_JUMP = 180.0
POLAR_EDGE_LAT = 89.8


def iter_parts(geom):
    """Yield each coordinate ring / line of a GeoJSON geometry."""
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        yield [c]
    elif t == "MultiPoint":
        yield from ([p] for p in c)
    elif t == "MultiLineString":
        yield from c
    elif t == "MultiPolygon":
        for poly in c:
            yield from poly
    else:
        raise ValueError(f"unexpected geometry {t}")


def structural_check(path):
    """Coordinate sanity, and no edge drawn the wrong way round the world."""
    problems = []
    fc = json.load(open(path))
    kinds = set()
    for feat in fc["features"]:
        kind = feat["properties"]["kind"]
        kinds.add(kind)
        for part in iter_parts(feat["geometry"]):
            xs = [p[0] for p in part]
            ys = [p[1] for p in part]
            if min(xs) < -180.001 or max(xs) > 180.001:
                problems.append(f"{kind}: longitude out of range "
                                f"[{min(xs):.3f}, {max(xs):.3f}]")
            if min(ys) < -90.001 or max(ys) > 90.001:
                problems.append(f"{kind}: latitude out of range "
                                f"[{min(ys):.3f}, {max(ys):.3f}]")
            for i in range(1, len(part)):
                jump = abs(xs[i] - xs[i - 1])
                polar = abs(ys[i]) >= POLAR_EDGE_LAT and abs(ys[i - 1]) >= POLAR_EDGE_LAT
                if jump > MAX_VERTEX_JUMP and not polar:
                    problems.append(
                        f"{kind}: {jump:.1f} deg jump at "
                        f"({xs[i-1]:.2f},{ys[i-1]:.2f})->({xs[i]:.2f},{ys[i]:.2f})")
    return kinds, problems


_CATALOG = None


def elements_for(key):
    """The canon is 12 MB of JSON; parse it once, not once per eclipse."""
    global _CATALOG
    if _CATALOG is None:
        _CATALOG = {e.key: e for e, _ in B.load_catalog()}
    return _CATALOG[key]


def physical_check(key, path, step=1.0):
    """Do the shipped polygons agree with where the shadow actually goes?"""
    el = elements_for(key)
    fc = json.load(open(path))
    lats = np.arange(-90 + step / 2, 90, step)
    lons = np.arange(-180 + step / 2, 180, step)
    LON, LAT = np.meshgrid(lons, lats)

    out = {}
    # Obscuration contours: inside the 80% ring the Sun really should be at least
    # 80% gone.  Checked against the field rather than against itself.
    bands = [f for f in fc["features"] if f["properties"]["kind"] == "band"]
    if bands:
        window = G.contact_times(el, True)
        obscuration = R.eclipse_field(el, LAT, LON, window)[1]
        bad = 0
        for feature in bands:
            level = feature["properties"]["level"]
            inside = shapely.contains_xy(shape(feature["geometry"]),
                                         LON.ravel(), LAT.ravel()).reshape(LAT.shape)
            bad += int((inside != (obscuration >= level)).sum())
        out["bands"] = (len(bands), bad)

    for kind, penumbral in (("penumbra", True), ("path", False)):
        geoms = [shape(f["geometry"]) for f in fc["features"]
                 if f["properties"]["kind"] == kind]
        window = G.contact_times(el, penumbral)
        if not geoms:
            out[kind] = (0, 0) if window is None else (-1, -1)
            continue
        poly = unary_union(geoms)
        reach = R.reach_field(el, LAT, LON, penumbral, window=window) > 0
        inside = shapely.contains_xy(poly, LON.ravel(), LAT.ravel()).reshape(LAT.shape)
        out[kind] = (int(reach.sum()), int((inside != reach).sum()))
    return out


REQUIRED = ("id", "date", "type", "typeCode", "saros", "gamma", "magnitude",
            "deltaT", "greatest", "hasPath", "bbox")


def index_check(entries):
    """Every entry complete, every file present, every bbox usable."""
    problems = []
    for e in entries:
        for field in REQUIRED:
            if field not in e:
                problems.append(f"{e.get('id', '?')}: missing {field}")
        path = os.path.join(config.OUTPUT_DIR, f"{e['id']}.geojson")
        if not os.path.exists(path):
            problems.append(f"{e['id']}: no geojson file")
        if e.get("shading") and not os.path.exists(
                os.path.join(config.OUTPUT_DIR, f"{e['id']}.png")):
            problems.append(f"{e['id']}: shading claimed but no png")
        bbox = e.get("bbox")
        if not bbox:
            continue
        w, s_, e_, n = bbox
        if not (-90 <= s_ < n <= 90):
            problems.append(f"{e['id']}: bad latitude range in bbox {bbox}")
        if e_ - w <= 0 or e_ - w > 360.001:
            problems.append(f"{e['id']}: bbox spans {e_ - w:.1f} deg of longitude")
        if e["hasPath"] != any(
                f["properties"]["kind"] == "path"
                for f in json.load(open(path))["features"]):
            problems.append(f"{e['id']}: hasPath disagrees with the geometry")
    return problems


def main(sample=60, seed=5):
    import random
    index = json.load(open(os.path.join(config.OUTPUT_DIR, "index.json")))
    entries = index["eclipses"]

    print(f"index check over {len(entries)} entries")
    for p in index_check(entries):
        print(f"  {p}")
    print("  ok\n" if not index_check(entries) else "")

    print(f"structural check over all {len(entries)} files")
    all_kinds, bad = set(), 0
    for e in entries:
        path = os.path.join(config.OUTPUT_DIR, f"{e['id']}.geojson")
        kinds, problems = structural_check(path)
        all_kinds |= kinds
        for p in problems:
            print(f"  {e['id']}: {p}")
            bad += 1
    print(f"  feature kinds present: {sorted(all_kinds)}")
    print(f"  problems: {bad}\n")

    picked = random.Random(seed).sample(entries, min(sample, len(entries)))
    picked.sort(key=lambda e: e["id"])
    print(f"physical check over {len(picked)} eclipses "
          f"(cells the shadow reaches / cells mis-classified, 1 deg grid)")
    worst = []
    for n, e in enumerate(picked, 1):
        path = os.path.join(config.OUTPUT_DIR, f"{e['id']}.geojson")
        res = physical_check(e["id"], path)
        pen, umb = res["penumbra"], res["path"]
        worst.append((umb[1] + pen[1] + (res.get("bands", (0, 0))[1]),
                      e["id"], e["type"], pen, umb))
        print(f"\r  {n}/{len(picked)}", end="", flush=True)
    print("\r" + " " * 20 + "\r", end="")
    worst.sort(reverse=True)
    print(f"  {'eclipse':>10} {'type':<8} {'penumbra':>16} {'path':>16}")
    for total, key, kind, pen, umb in worst[:12]:
        print(f"  {key:>10} {kind:<8} {pen[0]:>7} /{pen[1]:>5} bad "
              f"{umb[0]:>7} /{umb[1]:>5} bad")
    tot_bad = sum(w[0] for w in worst)
    reached = sum(w[3][0] + w[4][0] for w in worst)
    print(f"  mis-classified cells across the sample: {tot_bad} of {reached} "
          f"({100 * tot_bad / max(1, reached):.3f}%), "
          f"worst single eclipse {worst[0][0]}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
