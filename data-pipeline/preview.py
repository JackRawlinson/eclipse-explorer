"""A share image per eclipse, drawn without a browser.

Capturing the real map would be the obvious way to do this, and it is what the
screenshots in development use. It is the wrong tool for a build: it wants a
headless browser in the image, it costs seconds rather than milliseconds per
eclipse, and it would pull hundreds of map views' worth of tiles from a free
tile service on every rebuild. So the same geometry the site draws is drawn
here instead, over a plain world outline that ships with the pipeline.

Equirectangular rather than the Mercator the site uses: a share image is looked
at once, at a glance, and this way the whole world fits with the poles intact
and there is no seam to fit a view around.
"""

import json
import os
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
LAND = os.path.join(HERE, "assets", "ne_110m_land.geojson")

WIDTH, HEIGHT = 1200, 630
# One scale for both axes, so nothing is stretched. The height then covers a
# little more than pole to pole, which leaves a small margin top and bottom.
SCALE = WIDTH / 360.0
LAT_SPAN = HEIGHT / SCALE / 2.0

OCEAN = (207, 226, 245)
LAND_FILL = (238, 242, 240)
LAND_EDGE = (198, 211, 216)
BAND = (30, 58, 138)            # the obscuration wash, alpha by level
PENUMBRA = (71, 85, 105)
CENTRE_LINE = (255, 255, 255)
GREATEST = (220, 38, 38)
FLAVOUR = {"total": (76, 29, 149), "annular": (194, 65, 12)}

_land_cache = None


def _land():
    global _land_cache
    if _land_cache is None:
        with open(LAND) as fh:
            data = json.load(fh)
        _land_cache = [ring for f in data["features"]
                       for ring in f["geometry"]["coordinates"]]
    return _land_cache


def _project(coords):
    """Lon/lat degrees to pixel coordinates."""
    pts = np.asarray(coords, dtype=float)
    x = (pts[:, 0] + 180.0) * SCALE
    y = (LAT_SPAN - pts[:, 1]) * SCALE
    return list(zip(x.tolist(), y.tolist()))


def _polygons(geometry):
    """Every outer ring in a Polygon or MultiPolygon, holes ignored.

    Holes are dropped deliberately. At this size a hole is a pixel or two, and
    keeping them would mean compositing each polygon separately rather than
    filling them all into one mask.
    """
    kind = geometry["type"]
    if kind == "Polygon":
        return [geometry["coordinates"][0]]
    if kind == "MultiPolygon":
        return [poly[0] for poly in geometry["coordinates"]]
    return []


def _lines(geometry):
    kind = geometry["type"]
    if kind == "LineString":
        return [geometry["coordinates"]]
    if kind == "MultiLineString":
        return geometry["coordinates"]
    return []


def _fill(base, rings, colour, alpha):
    """Fill rings onto `base` at one opacity, without stacking where they meet.

    Drawing them straight onto the image would darken every overlap; painting
    into a mask first means the whole shape gets one wash, which is what the
    site does with its own layers.
    """
    if not rings:
        return
    mask = Image.new("L", (WIDTH, HEIGHT), 0)
    pen = ImageDraw.Draw(mask)
    for ring in rings:
        if len(ring) >= 3:
            pen.polygon(_project(ring), fill=alpha)
    base.paste(Image.new("RGB", (WIDTH, HEIGHT), colour), (0, 0), mask)


def render(collection, entry):
    """One PNG for one eclipse, as bytes."""
    image = Image.new("RGB", (WIDTH, HEIGHT), OCEAN)

    land = _land()
    _fill(image, land, LAND_FILL, 255)
    edge = ImageDraw.Draw(image)
    for ring in land:
        if len(ring) >= 3:
            edge.line(_project(ring) + [_project(ring)[0]], fill=LAND_EDGE, width=1)

    features = collection["features"]
    by_kind = {}
    for f in features:
        by_kind.setdefault(f["properties"].get("kind"), []).append(f)

    for f in by_kind.get("penumbra", []):
        _fill(image, _polygons(f["geometry"]), PENUMBRA, 26)

    # Deepest last, so the strongest wash sits on top of the weaker ones.
    for f in sorted(by_kind.get("band", []), key=lambda f: f["properties"]["level"]):
        level = f["properties"]["level"]
        _fill(image, _polygons(f["geometry"]), BAND, int(22 + 60 * level))

    draw = ImageDraw.Draw(image)
    for f in by_kind.get("path", []):
        colour = FLAVOUR.get(f["properties"].get("flavour"), FLAVOUR["total"])
        _fill(image, _polygons(f["geometry"]), colour, 235)

    for f in by_kind.get("centralLine", []):
        for line in _lines(f["geometry"]):
            if len(line) >= 2:
                draw.line(_project(line), fill=CENTRE_LINE, width=2)

    for f in by_kind.get("greatest", []):
        x, y = _project([f["geometry"]["coordinates"]])[0]
        draw.ellipse([x - 6, y - 6, x + 6, y + 6], outline=GREATEST, width=3)

    out = BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()
