"""A continuous shading image for how much of the Sun goes.

The contour bands say exactly where the 80% line runs, which is what you want if
you are deciding where to stand.  They also, unavoidably, look like steps.  This
writes the same quantity as a smooth image instead.

MapLibre cannot colour a greyscale raster through a ramp -- ``raster-color`` is a
Mapbox property, not one of theirs -- so the colour is baked in here and only the
alpha varies.  That costs the ability to re-tint for a dark basemap, but a
translucent blue sits well enough on either, and it makes the file tiny: with the
three colour channels constant, there is almost nothing left for zlib to store.

Rows are spaced evenly in Web Mercator y, not in latitude, so the image drapes
onto MapLibre's image source without any reprojection.
"""

from __future__ import annotations

import os
import struct
import zlib

import numpy as np

import raster as R

MERCATOR_LIMIT = 85.051129          # where Web Mercator gives up
WORLD_CORNERS = [[-180.0, MERCATOR_LIMIT], [180.0, MERCATOR_LIMIT],
                 [180.0, -MERCATOR_LIMIT], [-180.0, -MERCATOR_LIMIT]]

# A near-neutral slate rather than a colour. The shading has to sit under every
# basemap on offer, and a blue wash over Liberty's blue oceans reads as nothing at
# all. Neutral also leaves the colour budget to the paths, which are the subject.
# Override with ECLIPSE_TINT="r,g,b" when trying alternatives.
TINT = tuple(int(v) for v in os.environ.get("ECLIPSE_TINT", "51,65,85").split(","))
MAX_ALPHA = 0.62
GAMMA = 0.85                        # lifts the faint outer reaches into view


def mercator_latitudes(n):
    """``n`` latitudes spaced evenly in Web Mercator, north to south."""
    y = np.linspace(1.0, -1.0, n) * np.pi
    return np.degrees(2.0 * np.arctan(np.exp(y)) - np.pi / 2.0)


def obscuration_image(grid, width=768, height=384):
    """PNG bytes of the obscuration field, or ``None`` if nothing is eclipsed.

    Resampled from the grid the contours were traced on rather than evaluated
    afresh.  The field is smooth over thousands of kilometres, so interpolating
    it costs nothing visible -- and evaluating a second, denser grid was, on its
    own, the single most expensive thing the build did.
    """
    lons = np.linspace(-180.0, 180.0, width)
    lats = mercator_latitudes(height)
    obscuration = R.resample(grid, grid.obscuration, lats, lons)
    if obscuration.max() <= 0.0:
        return None
    alpha = np.clip(obscuration, 0.0, 1.0) ** GAMMA * MAX_ALPHA * 255.0
    return _png_rgba(TINT, alpha.astype(np.uint8))


def _png_rgba(rgb, alpha):
    """Smallest useful PNG writer: constant RGB, varying alpha, 'Up' filtering."""
    height, width = alpha.shape
    img = np.empty((height, width, 4), np.uint8)
    img[..., 0], img[..., 1], img[..., 2] = rgb
    img[..., 3] = alpha

    rows = img.reshape(height, width * 4).astype(np.int16)
    previous = np.zeros(width * 4, np.int16)
    scanlines = []
    for row in rows:
        scanlines.append(b"\x02" + ((row - previous) % 256).astype(np.uint8).tobytes())
        previous = row

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(scanlines), 9))
            + chunk(b"IEND", b""))
