"""Build configuration.  Widening the range is a change to YEAR_MIN / YEAR_MAX."""

import os

# Overridable from the environment so a container build can narrow the range
# without editing the file; see the Dockerfile's YEAR_MIN / YEAR_MAX build args.
YEAR_MIN = int(os.environ.get("ECLIPSE_YEAR_MIN", "1900"))
YEAR_MAX = int(os.environ.get("ECLIPSE_YEAR_MAX", "2100"))

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "cache")
OUTPUT_DIR = os.path.join(os.path.dirname(HERE), "public", "data")

# Time resolution along the umbral path.  Vertices are thinned afterwards, so
# this only has to be fine enough not to cut corners.
UMBRA_STEPS = 800
# Grid the maximum-eclipse field is sampled on, in degrees.  The penumbral
# outline, the obscuration contours and the shading image are all taken from this
# one sampling.  Vertex positions are solved exactly regardless, so this decides
# contour topology, vertex spacing, and how finely the shading is resolved.
FIELD_GRID_STEP = 1.0

# Douglas-Peucker tolerances (degrees) and stored coordinate precision.
SIMPLIFY_UMBRA = 0.002        # ~220 m
SIMPLIFY_PENUMBRA = 0.02      # ~2.2 km
PRECISION_UMBRA = 4           # ~11 m
PRECISION_PENUMBRA = 3        # ~110 m

# Minutes between time marks along the central line.
TICK_MINUTES = 30

# Obscuration contours drawn inside the partial region: the fraction of the Sun's
# *area* hidden at maximum eclipse.  Not the same as magnitude, which is the
# fraction of its diameter -- 0.9 obscuration is about 0.91 magnitude.
BAND_LEVELS = (0.9, 0.8, 0.6, 0.4, 0.2)
SIMPLIFY_BANDS = 0.04        # ~4.4 km; these are diffuse contours
PRECISION_BANDS = 3

ACKNOWLEDGMENT = "Eclipse Predictions by Fred Espenak, NASA's GSFC"
SOURCE = ('Besselian elements from "Five Millennium Canon of Solar Eclipses: '
          '-1999 to +3000", Fred Espenak and Jean Meeus, NASA/TP-2006-214141')

# Delta T is taken from the canon.  Override individual eclipses here (seconds)
# to match a different source; see README for what this changes.
DELTA_T_OVERRIDES = {}

# Where the site is served from. Only used to write absolute URLs into the
# per-eclipse pages and the sitemap, which is the one place a relative one will
# not do -- canonical links, and the previews social scrapers fetch.
BASE_URL = os.environ.get("ECLIPSE_BASE_URL", "https://eclipse.tsbf.uk").rstrip("/")
