"""A continuous shading image for how much of the Sun goes.

The contour bands say exactly where the 80% line runs, which is what you want if
you are deciding where to stand.  They also, unavoidably, look like steps.  This
writes the same quantity as a smooth image instead.

MapLibre has no way to colour a raster through a ramp -- ``raster-color`` is a
Mapbox property, not one of theirs -- so what ships is a bare mask and the browser
paints it onto a canvas before handing it over.  Colour, opacity and curve are all
decided there, which means they can be changed without regenerating anything.

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


def mercator_latitudes(n):
    """``n`` latitudes spaced evenly in Web Mercator, north to south."""
    y = np.linspace(1.0, -1.0, n) * np.pi
    return np.degrees(2.0 * np.arctan(np.exp(y)) - np.pi / 2.0)


def obscuration_image(grid, width=768, height=384):
    """PNG bytes of the obscuration mask, or ``None`` if nothing is eclipsed.

    A single grey channel holding obscuration itself, 0 to 255 -- no colour, no
    opacity, no curve.  All three are decided in the browser, which recolours the
    mask onto a canvas before handing it to the map, so the look can be changed
    without regenerating four hundred images.

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
    return _png_grey((np.clip(obscuration, 0.0, 1.0) * 255.0).astype(np.uint8))


def _png_grey(values):
    """Smallest useful PNG writer: one 8-bit channel, 'Up' filtering.

    Greyscale rather than RGBA because the browser supplies the colour: one
    channel is a quarter of the pixels and compresses better besides.
    """
    height, width = values.shape
    rows = values.reshape(height, width).astype(np.int16)
    previous = np.zeros(width, np.int16)
    scanlines = []
    for row in rows:
        scanlines.append(b"\x02" + ((row - previous) % 256).astype(np.uint8).tobytes())
        previous = row

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(scanlines), 9))
            + chunk(b"IEND", b""))
