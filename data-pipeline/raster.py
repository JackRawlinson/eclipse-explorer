"""Region of partial visibility, traced as a contour of the shadow-reach field.

The umbral path is a narrow band and its boundary follows analytically from the
shadow envelope (see :mod:`geometry`).  The penumbral region is not so tame: at
any instant its boundary mixes envelope points with limb crossings, and the two
families swap places along the region's edge.  Rather than try to order those
analytically, this module evaluates how far the shadow reaches at each point of
a lat/lon grid and traces the zero contour.

Grid resolution only decides the *topology*; every contour vertex is then
refined by bisection against the same continuous field, so vertices sit on the
true boundary to within a few metres.  The tracer treats longitude as periodic,
so a region that wraps the globe or covers a pole comes out as one closed ring
in unwrapped coordinates, which :func:`geometry.ring_to_multipolygon` then cuts
into renderable pieces.
"""

from __future__ import annotations

import numpy as np

import geometry as G

NEVER_VISIBLE = -1.0e6
INV_PHI = (5.0 ** 0.5 - 1.0) / 2.0


def _horizon_crossing(el, lat, lon, t_lo, t_hi, z_lo, z_hi, steps=3):
    """When the Sun crosses the horizon, between two bracketing instants.

    ``zeta`` is the observer's height above the fundamental plane, so its zero is
    sunrise or sunset.  It is smooth, and its rate follows from quantities the
    observer transform already produces -- ``d' eta - mu' xi cos d`` -- so a
    linear guess plus a couple of Newton steps lands on it.
    """
    span = np.where(z_hi != z_lo, z_hi - z_lo, 1.0)
    t = np.clip(t_lo - z_lo * (t_hi - t_lo) / span, t_lo, t_hi)
    for _ in range(steps):
        st = el.state(t)
        xi, eta, zeta = st.observer(lat, lon)
        rate = st.dd * eta - st.dmu * xi * st.cosd
        rate = np.where(np.abs(rate) < 1e-9, 1e-9, rate)
        t = np.clip(t - zeta / rate, t_lo, t_hi)
    return t


def _reach_at(el, lat, lon, t, penumbral):
    """Shadow reach at one instant per point (all arrays share a shape)."""
    st = el.state(t)
    l0 = st.l1 if penumbral else st.l2
    tanf = st.tanf1 if penumbral else st.tanf2
    xi, eta, zeta = st.observer(lat, lon)
    radius = np.abs(l0 - zeta * tanf)
    reach = radius - np.hypot(xi - st.x, eta - st.y)
    return np.where(zeta >= 0.0, reach, NEVER_VISIBLE)


def peak_time(el, lat, lon, penumbral=True, n_scan=64, window=None,
              chunk=200_000, refine=22):
    """When each point sees its deepest eclipse, in TDT hours from ``t0``.

    "Deepest" means the largest ``radius - distance`` -- the numerator of the
    eclipse magnitude -- which is what puts the region's edge exactly where the
    magnitude reaches zero.  It is within a breath of the moment of least
    separation, the shadow radii changing far more slowly than the separation.

    The maximum is searched for rather than sampled.  A fixed time step would
    leave the region's edge short by however far the shadow travels in half a
    step -- tens of kilometres at any step affordable over a whole grid --
    precisely because the edge is where the eclipse lasts no time at all.  So a
    coarse scan brackets the peak and a ternary search closes on it; reach is
    unimodal in time, the shadow axis passing by only once.
    """
    t_scan = np.linspace(window[0], window[1], n_scan)
    st_scan = el.state(t_scan)
    l0 = st_scan.l1 if penumbral else st_scan.l2
    tanf = st_scan.tanf1 if penumbral else st_scan.tanf2

    flat_lat, flat_lon = np.ravel(lat), np.ravel(lon)
    out = np.empty(flat_lat.size)
    for i in range(0, flat_lat.size, chunk):
        sl = slice(i, i + chunk)
        p_lat, p_lon = flat_lat[sl], flat_lon[sl]
        xi, eta, zeta = st_scan.observer(p_lat[:, None], p_lon[:, None])
        radius = np.abs(l0 - zeta * tanf)
        coarse = np.where(zeta >= 0.0,
                          radius - np.hypot(xi - st_scan.x, eta - st_scan.y),
                          NEVER_VISIBLE)
        peak = np.argmax(coarse, axis=1)
        # Golden-section rather than ternary search: it keeps one of the two
        # interior points each round, so each step costs a single evaluation
        # instead of two for the same rate of convergence.  That halving matters
        # -- this loop is most of the build.
        a = t_scan[np.maximum(peak - 1, 0)]
        b = t_scan[np.minimum(peak + 1, n_scan - 1)]

        # The Sun coming up or going down puts a step in `reach`, and no search
        # finds a maximum sitting exactly on a step.  Where a point's deepest
        # moment is the moment it sees the Sun at all, solve for that instant and
        # make it an endpoint of the bracket rather than a cliff inside it.  Left
        # alone this misplaces obscuration near the terminator by up to ten points.
        dark = zeta < 0.0
        order = np.arange(n_scan)
        rows = np.arange(peak.size)
        before = np.max(np.where(dark & (order <= peak[:, None]), order, -1), axis=1)
        after = np.min(np.where(dark & (order >= peak[:, None]), order, n_scan), axis=1)

        rising = before >= 0
        if rising.any():
            j = np.clip(before, 0, n_scan - 2)
            a = np.where(rising,
                         np.maximum(a, _horizon_crossing(
                             el, p_lat, p_lon, t_scan[j], t_scan[j + 1],
                             zeta[rows, j], zeta[rows, j + 1])), a)
        setting = after < n_scan
        if setting.any():
            j = np.clip(after, 1, n_scan - 1)
            b = np.where(setting,
                         np.minimum(b, _horizon_crossing(
                             el, p_lat, p_lon, t_scan[j - 1], t_scan[j],
                             zeta[rows, j - 1], zeta[rows, j])), b)
        b = np.maximum(b, a)

        c = b - INV_PHI * (b - a)
        d = a + INV_PHI * (b - a)
        fc = _reach_at(el, p_lat, p_lon, c, penumbral)
        fd = _reach_at(el, p_lat, p_lon, d, penumbral)
        for _ in range(refine):
            left = fc >= fd                     # the peak lies in [a, d]
            a2 = np.where(left, a, c)
            b2 = np.where(left, d, b)
            probe = np.where(left, b2 - INV_PHI * (b2 - a2),
                             a2 + INV_PHI * (b2 - a2))
            f_probe = _reach_at(el, p_lat, p_lon, probe, penumbral)
            a, b = a2, b2
            c, fc, d, fd = (np.where(left, probe, d), np.where(left, f_probe, fd),
                            np.where(left, c, probe), np.where(left, fc, f_probe))
        # The best of: the interior optimum, the best coarse sample, and the two
        # horizon instants -- a constrained maximum can sit on any of them.
        candidates = np.stack([0.5 * (a + b), t_scan[peak], a, b])
        values = np.stack([_reach_at(el, p_lat, p_lon, t, penumbral)
                           for t in candidates])
        out[sl] = candidates[np.argmax(values, axis=0), np.arange(p_lat.size)]
    return out.reshape(np.shape(lat))


def reach_field(el, lat, lon, penumbral=True, n_scan=64, window=None,
                chunk=200_000, refine=22):
    """How close the shadow ever comes: ``max_t (radius - distance)``.

    Positive inside the region, negative outside.  Points where the Sun is below
    the horizon for the whole eclipse are pushed far negative, which is what puts
    the sunrise and sunset edges of the region in the right place.
    """
    window = window or G.contact_times(el, penumbral)
    if window is None:
        return np.full(np.shape(lat), NEVER_VISIBLE)
    t = peak_time(el, lat, lon, penumbral, n_scan, window, chunk, refine)
    return _reach_at(el, np.asarray(lat), np.asarray(lon), t, penumbral)


# --------------------------------------------------------------------------
# Marching squares with a periodic longitude axis
# --------------------------------------------------------------------------

# edge keys: ("h", i, j) spans lon j -> j+1 at lat i;  ("v", i, j) spans lat i -> i+1
_CASES = {
    1: [("v0", "h0")], 2: [("h0", "v1")], 3: [("v0", "v1")],
    4: [("v1", "h1")], 6: [("h0", "h1")], 7: [("v0", "h1")],
    8: [("h1", "v0")], 9: [("h1", "h0")], 11: [("h1", "v1")],
    12: [("v1", "v0")], 13: [("h0", "v1")], 14: [("v0", "h0")],
}

# Cells with two opposite corners inside are ambiguous: the contour can either
# isolate the two inside corners or the two outside ones.  The cell centre says
# which -- and it has to be asked, because picking wrong joins the boundary up
# the wrong way and the ring that comes out is a closed curve that is not the
# boundary.
_SADDLE = {
    (5, False): [("v0", "h0"), ("v1", "h1")],    # isolate the two inside corners
    (5, True): [("h0", "v1"), ("v0", "h1")],     # centre inside: isolate the outside pair
    (10, False): [("h0", "v1"), ("v0", "h1")],
    (10, True): [("v0", "h0"), ("v1", "h1")],
}


def contour_rings(field, lats, lons, refine=None):
    """Trace the zero contour of ``field`` as closed rings of (lat, lon).

    ``field`` is (nlat, nlon); longitude wraps.  Returns a list of rings with
    *unwrapped* longitudes, so a ring that circles the globe reads as such.
    """
    nlat, nlon = field.shape
    a = field[:-1, :]
    b = np.roll(field[:-1, :], -1, axis=1)
    c = np.roll(field[1:, :], -1, axis=1)
    d = field[1:, :]
    idx = ((a > 0).astype(np.uint8) | ((b > 0).astype(np.uint8) << 1)
           | ((c > 0).astype(np.uint8) << 2) | ((d > 0).astype(np.uint8) << 3))
    centre_in = (a + b + c + d) > 0

    rows, cols = np.nonzero((idx != 0) & (idx != 15))
    segments = []
    adjacency = {}
    for i, j in zip(rows.tolist(), cols.tolist()):
        case = int(idx[i, j])
        pairs = (_SADDLE[(case, bool(centre_in[i, j]))]
                 if case in (5, 10) else _CASES[case])
        for e1, e2 in pairs:
            k1, k2 = _edge_key(i, j, e1, nlon), _edge_key(i, j, e2, nlon)
            n = len(segments)
            segments.append((k1, k2))
            adjacency.setdefault(k1, []).append(n)
            adjacency.setdefault(k2, []).append(n)

    if not segments:
        return []

    used = [False] * len(segments)
    rings_keys = []
    for start in range(len(segments)):
        if used[start]:
            continue
        chain = []
        seg, entry = start, segments[start][0]
        while True:
            used[seg] = True
            k1, k2 = segments[seg]
            nxt_key = k2 if entry == k1 else k1
            chain.append(nxt_key)
            options = [s for s in adjacency.get(nxt_key, []) if not used[s]]
            if not options:
                break
            seg, entry = options[0], nxt_key
        if len(chain) >= 3:
            rings_keys.append(chain)

    positions = _edge_positions({k for r in rings_keys for k in r},
                                field, lats, lons, refine)
    rings = []
    for chain in rings_keys:
        pts = np.array([positions[k] for k in chain])          # (n, 2) lat, lon
        rings.append((pts[:, 0], pts[:, 1]))
    return rings


def _edge_key(i, j, code, nlon):
    if code == "h0":
        return ("h", i, j)
    if code == "h1":
        return ("h", i + 1, j)
    if code == "v0":
        return ("v", i, j)
    return ("v", i, (j + 1) % nlon)


def _edge_positions(keys, field, lats, lons, refine):
    """Locate each crossed edge, then pull the point onto the true boundary."""
    keys = sorted(keys)
    nlon = lons.size
    step_lon = lons[1] - lons[0]
    lat_a = np.empty(len(keys)); lon_a = np.empty(len(keys))
    lat_b = np.empty(len(keys)); lon_b = np.empty(len(keys))
    f_a = np.empty(len(keys)); f_b = np.empty(len(keys))
    for n, (kind, i, j) in enumerate(keys):
        if kind == "h":
            lat_a[n] = lat_b[n] = lats[i]
            lon_a[n] = lons[j]
            lon_b[n] = lons[j] + step_lon
            f_a[n], f_b[n] = field[i, j], field[i, (j + 1) % nlon]
        else:
            lon_a[n] = lon_b[n] = lons[j]
            lat_a[n], lat_b[n] = lats[i], lats[i + 1]
            f_a[n], f_b[n] = field[i, j], field[i + 1, j]

    frac = f_a / (f_a - f_b)
    lat_p = lat_a + frac * (lat_b - lat_a)
    lon_p = lon_a + frac * (lon_b - lon_a)

    if refine is not None:
        lat_p, lon_p = _bisect(refine, lat_a, lon_a, f_a, lat_b, lon_b, f_b)

    return {k: (lat_p[n], lon_p[n]) for n, k in enumerate(keys)}


def _bisect(field_fn, lat_a, lon_a, f_a, lat_b, lon_b, f_b, iters=18):
    """Squeeze each crossing onto the true zero of the continuous field."""
    inside_a = f_a > 0
    lat_in = np.where(inside_a, lat_a, lat_b); lon_in = np.where(inside_a, lon_a, lon_b)
    lat_out = np.where(inside_a, lat_b, lat_a); lon_out = np.where(inside_a, lon_b, lon_a)
    for _ in range(iters):
        lat_m, lon_m = 0.5 * (lat_in + lat_out), 0.5 * (lon_in + lon_out)
        hit = field_fn(lat_m, lon_m) > 0
        lat_in = np.where(hit, lat_m, lat_in); lon_in = np.where(hit, lon_m, lon_in)
        lat_out = np.where(hit, lat_out, lat_m); lon_out = np.where(hit, lon_out, lon_m)
    return 0.5 * (lat_in + lat_out), 0.5 * (lon_in + lon_out)


def region_rings(el, penumbral=True, step=1.0, window=None, grid=None):
    """Contour rings bounding the region the shadow reaches.

    Pass ``grid`` to reuse a field already sampled; it is only valid for the
    penumbra, the umbral path being far too narrow for any affordable grid.
    """
    window = window or G.contact_times(el, penumbral)
    if window is None:
        return []

    def refine_fn(la, lo):
        return reach_field(el, la, lo, penumbral, window=window)

    if grid is not None and penumbral:
        return contour_rings(grid.reach, grid.lats, grid.lons, refine=refine_fn)

    lats = np.arange(-90.0, 90.0 + step / 2, step)
    lons = np.arange(-180.0, 180.0, step)
    LON, LAT = np.meshgrid(lons, lats)
    return contour_rings(reach_field(el, LAT, LON, penumbral, window=window),
                         lats, lons, refine=refine_fn)


def poles_inside(el, penumbral=True, window=None):
    """Whether the north / south pole lies in the region the shadow reaches."""
    lat = np.array([[90.0], [-90.0]])
    lon = np.array([[0.0], [0.0]])
    reach = reach_field(el, lat, lon, penumbral, window=window)
    return bool(reach[0, 0] > 0), bool(reach[1, 0] > 0)


# --------------------------------------------------------------------------
# How much of the Sun goes: magnitude and obscuration
# --------------------------------------------------------------------------

def obscuration_from(magnitude, ratio):
    """Fraction of the Sun's *area* hidden, from the fraction of its diameter.

    Magnitude is the covered fraction of the solar diameter; obscuration is the
    covered fraction of the disc.  They are not interchangeable -- two equal
    discs half overlapping in diameter hide only 39% of the area -- and it is
    obscuration that people mean by "a 90% eclipse".

    ``ratio`` is the Moon's apparent diameter over the Sun's.  Below 1 the Moon
    never covers the whole disc, so even a central eclipse leaves a ring and the
    obscuration tops out at ratio squared.
    """
    mag = np.clip(magnitude, 0.0, None)
    c = np.clip(ratio, 1e-6, None)
    sep = 1.0 + c - 2.0 * mag          # centre separation, in solar radii

    with np.errstate(invalid="ignore", divide="ignore"):
        cos_sun = np.clip((sep ** 2 + 1.0 - c ** 2) / (2.0 * sep), -1.0, 1.0)
        cos_moon = np.clip((sep ** 2 + c ** 2 - 1.0) / (2.0 * sep * c), -1.0, 1.0)
        lens = (np.arccos(cos_sun) + c ** 2 * np.arccos(cos_moon)
                - 0.5 * np.sqrt(np.clip((-sep + 1 + c) * (sep + 1 - c)
                                        * (sep - 1 + c) * (sep + 1 + c), 0.0, None)))
        partial = lens / np.pi

    covered = np.minimum(1.0, c ** 2)   # Moon wholly inside or wholly covering
    return np.where(mag <= 0.0, 0.0,
                    np.where(sep <= np.abs(c - 1.0), covered,
                             np.where(sep >= 1.0 + c, 0.0, partial)))


def eclipse_field(el, lat, lon, window=None, **kwargs):
    """Magnitude, obscuration and diameter ratio at maximum eclipse, per point."""
    window = window or G.contact_times(el, True)
    if window is None:
        zeros = np.zeros(np.shape(lat))
        return zeros, zeros.copy(), zeros.copy()

    t = peak_time(el, lat, lon, True, window=window, **kwargs)
    st = el.state(t)
    xi, eta, zeta = st.observer(np.asarray(lat), np.asarray(lon))
    sep = np.hypot(xi - st.x, eta - st.y)
    l1p = st.l1 - zeta * st.tanf1
    l2p = st.l2 - zeta * st.tanf2

    magnitude = np.where(zeta >= 0.0, (l1p - sep) / (l1p + l2p), 0.0)
    ratio = (l1p - l2p) / (l1p + l2p)
    return magnitude, obscuration_from(magnitude, ratio), ratio


class EclipseGrid:
    """Maximum-eclipse quantities sampled once over the globe.

    Finding the deepest moment at a point is the expensive step, and everything
    the build draws -- where the eclipse reaches at all, the obscuration
    contours, the shading image -- falls out of that one search.  Doing it once
    and keeping the answers is the difference between a nine-minute build and a
    thirty-five-minute one.
    """

    __slots__ = ("lats", "lons", "reach", "obscuration")

    def __init__(self, lats, lons, reach, obscuration):
        self.lats = lats
        self.lons = lons
        self.reach = reach
        self.obscuration = obscuration


def sample_grid(el, window, step):
    """Evaluate the maximum-eclipse field once, on a lat/lon grid."""
    lats = np.arange(-90.0, 90.0 + step / 2, step)
    lons = np.arange(-180.0, 180.0, step)
    LON, LAT = np.meshgrid(lons, lats)

    t = peak_time(el, LAT, LON, True, window=window)
    st = el.state(t)
    xi, eta, zeta = st.observer(LAT, LON)
    sep = np.hypot(xi - st.x, eta - st.y)
    l1p = st.l1 - zeta * st.tanf1
    l2p = st.l2 - zeta * st.tanf2

    visible = zeta >= 0.0
    reach = np.where(visible, l1p - sep, NEVER_VISIBLE)
    magnitude = np.where(visible, (l1p - sep) / (l1p + l2p), 0.0)
    obscuration = obscuration_from(magnitude, (l1p - l2p) / (l1p + l2p))
    return EclipseGrid(lats, lons, reach, obscuration)


def resample(grid, values, out_lats, out_lons):
    """Bilinear resample of a grid field, wrapping in longitude."""
    step_lon = grid.lons[1] - grid.lons[0]
    x = (np.asarray(out_lons) - grid.lons[0]) / step_lon
    x0 = np.floor(x).astype(int)
    fx = x - x0
    x0 %= grid.lons.size
    x1 = (x0 + 1) % grid.lons.size

    y = np.interp(np.asarray(out_lats), grid.lats, np.arange(grid.lats.size))
    y0 = np.clip(np.floor(y).astype(int), 0, grid.lats.size - 2)
    fy = (y - y0)[:, None]

    lower = values[y0][:, x0] * (1 - fx) + values[y0][:, x1] * fx
    upper = values[y0 + 1][:, x0] * (1 - fx) + values[y0 + 1][:, x1] * fx
    return lower * (1 - fy) + upper * fy


def obscuration_rings(el, level, lats, lons, field, window):
    """Contour rings where obscuration equals ``level``."""
    def refine(la, lo):
        return eclipse_field(el, la, lo, window)[1] - level

    return contour_rings(field - level, lats, lons, refine=refine)
