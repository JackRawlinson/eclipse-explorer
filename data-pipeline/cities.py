"""Which cities stand in each eclipse's path, and what they get there.

A city is listed only if it falls inside the path polygon the map itself
draws, and its times come from the same local-circumstances solve the site
uses everywhere else -- so the table on a page can never disagree with a
click on the map. The result is written to public/data/cities.json, read
both by pages.py when it stamps the eclipse pages and by the app at runtime.

The city list is Natural Earth's populated places (public domain), kept to
places of fifty thousand people or more.

Rebuilt only when the output file is missing: delete public/data/cities.json
to force it after a pipeline change.
"""

import json
import os

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

import besselian as B
import circumstances as C

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(os.path.dirname(HERE), "public")
DATA = os.path.join(PUBLIC, "data")
ASSET = os.path.join(HERE, "assets", "cities.json")
OUT = os.path.join(DATA, "cities.json")

PER_ECLIPSE = 8


def _hms(hours):
    s = int(round(((hours % 24) + 24) % 24 * 3600))
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"


def build():
    with open(os.path.join(DATA, "index.json")) as fh:
        index = json.load(fh)
    with open(ASSET) as fh:
        cities = json.load(fh)
    points = [Point(lon, lat) for _, _, lat, lon, _ in cities]
    tree = STRtree(points)
    catalog = {e.key: e for e, _ in B.load_catalog()}

    out = {}
    for entry in index["eclipses"]:
        if not entry.get("hasPath"):
            continue
        with open(os.path.join(DATA, f"{entry['id']}.geojson")) as fh:
            fc = json.load(fh)
        el = catalog[entry["id"]]
        window = fc["properties"]["elements"]["window"]
        path = next((f for f in fc["features"]
                     if f["properties"].get("kind") == "path"), None)
        if path is None:
            continue
        geom = shape(path["geometry"])
        rows = []
        for i in tree.query(geom):          # bbox candidates; contains() decides
            if not geom.contains(points[i]):
                continue
            name, country, lat, lon, pop = cities[i]
            r = C.local_circumstances(el, lat, lon, window=window)
            # In the drawn path yet not central can happen right on the edge,
            # where the polygon's resolution and the solve disagree by less
            # than the linewidth. Listing such a city would promise totality
            # the solve does not back, so it is dropped.
            if not r or not r.get("central") or "duration_s" not in r:
                continue
            rows.append({
                "name": name,
                "country": country,
                "lat": lat,
                "lon": lon,
                "pop": pop,
                "from": _hms(C.to_ut(el, r["c2"])),
                "to": _hms(C.to_ut(el, r["c3"])),
                "durationS": int(round(r["duration_s"])),
                "total": bool(r["total"]),
                "obscuration": round(r["obscuration"], 4),
            })
        rows.sort(key=lambda r: -r["pop"])
        if rows:
            out[entry["id"]] = rows[:PER_ECLIPSE]

    with open(OUT, "w") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    return out


def load_or_build():
    if os.path.exists(OUT):
        with open(OUT) as fh:
            return json.load(fh)
    return build()


if __name__ == "__main__":
    result = build()
    listed = sum(len(v) for v in result.values())
    print(f"{listed} city entries across {len(result)} eclipses")
