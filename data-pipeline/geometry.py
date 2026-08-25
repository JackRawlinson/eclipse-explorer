"""Ground geometry of a solar eclipse: central line, shadow limits, path polygons.

Everything here takes a :class:`besselian.State` -- the elements evaluated on a
time grid -- and returns geographic coordinates on the WGS 84 ellipsoid.

The moving shadow sweeps a region of the Earth's surface.  Its boundary is made
of two kinds of curve:

* the **envelope** of the shadow circle, where the circle's edge is momentarily
  stationary in the direction normal to the shadow's motion.  These are the
  familiar northern and southern limits.
* the **limb crossings**, where the shadow circle cuts the edge of the Earth's
  disc.  These form the sunrise / sunset ends of the path.

At any instant the boundary of the swept region has exactly one point on each
side of the track, so both kinds are handled uniformly: take the envelope point
when it lands on the Earth, otherwise the limb crossing on that side.  At first
and last contact the two sides meet at a single point and the polygon closes on
itself, which is what keeps the ends from spiking.
"""

from __future__ import annotations

import numpy as np
from shapely import affinity
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from besselian import EARTH_RADIUS_KM

POLE_LAT = 89.9  # polar closure latitude; Web Mercator hides everything past 85


# --------------------------------------------------------------------------
# Shadow envelope: northern and southern limits
# --------------------------------------------------------------------------

def limit_curve(state, side: int, penumbral: bool = False, iters: int = 15):
    """North (``side=+1``) or south (``side=-1``) limit of the moving shadow.

    The shadow radius depends on the height of the ground point above the
    fundamental plane, so radius and position are solved together by iteration.
    """
    l0 = state.l1 if penumbral else state.l2
    tanf = state.tanf1 if penumbral else state.tanf2

    xi, eta = state.x.copy(), state.y.copy()
    zeta = np.zeros_like(state.x)
    for _ in range(iters):
        radius = np.abs(l0 - zeta * tanf)
        a, b = state.relative_motion(xi, eta, zeta)
        n = np.hypot(a, b)
        xi = state.x - side * radius * b / n
        eta = state.y + side * radius * a / n
        _, _, zeta_new = state.surface(xi, eta)
        zeta = np.where(np.isfinite(zeta_new), zeta_new, zeta)
    return xi, eta


def north_normal(state):
    """Unit vector normal to the shadow's ground motion, pointing 'north' of it."""
    a, b = state.relative_motion(state.x, state.y, np.zeros_like(state.x))
    n = np.hypot(a, b)
    return -b / n, a / n


# --------------------------------------------------------------------------
# Limb crossings: where the shadow circle cuts the edge of the Earth's disc
# --------------------------------------------------------------------------

def _limb_residual(state, psi, l0, tanf, rows=None):
    """Signed distance^2 from the shadow edge, at limb parameter ``psi``.

    The Earth's outline in the fundamental plane is the ellipse
    ``(xi, eta) = (cos psi, rho1 sin psi)``.  On the limb ``zeta1 = 0``, so the
    point's height above the fundamental plane is ``-rho2 s12 sin psi``.
    """
    if rows is None:
        s, c = np.sin(psi)[None, :], np.cos(psi)[None, :]
        rho1, rho2s12 = state.rho1[:, None], (state.rho2 * state.s12)[:, None]
        x, y, l = state.x[:, None], state.y[:, None], l0[:, None]
    else:
        s, c = np.sin(psi), np.cos(psi)
        rho1, rho2s12 = state.rho1[rows], (state.rho2 * state.s12)[rows]
        x, y, l = state.x[rows], state.y[rows], l0[rows]
    eta = rho1 * s
    zeta = -rho2s12 * s
    radius = np.abs(l - zeta * tanf)
    return (c - x) ** 2 + (eta - y) ** 2 - radius ** 2


def limb_crossings(state, penumbral: bool = False, n_psi: int = 1024, refine: int = 34):
    """Per-instant limb crossings, split into the north and south side of the track.

    Returns ``(n_xi, n_eta, s_xi, s_eta)``, NaN where the shadow does not reach
    the limb on that side.
    """
    l0 = state.l1 if penumbral else state.l2
    tanf = state.tanf1 if penumbral else state.tanf2

    psi = np.linspace(0.0, 2 * np.pi, n_psi, endpoint=False)
    f = _limb_residual(state, psi, l0, tanf)
    f = np.concatenate([f, f[:, :1]], axis=1)
    psi_w = np.concatenate([psi, [2 * np.pi]])

    rows, cols = np.nonzero(f[:, :-1] * f[:, 1:] < 0)
    nt = state.t.size
    out = [np.full(nt, np.nan) for _ in range(4)]
    if rows.size == 0:
        return out

    lo, hi = psi_w[cols], psi_w[cols + 1]
    f_lo = f[rows, cols]
    for _ in range(refine):
        mid = 0.5 * (lo + hi)
        f_mid = _limb_residual(state, mid, l0, tanf, rows=rows)
        same = f_mid * f_lo > 0
        lo = np.where(same, mid, lo)
        f_lo = np.where(same, f_mid, f_lo)
        hi = np.where(same, hi, mid)
    root = 0.5 * (lo + hi)

    xi = np.cos(root)
    eta = state.rho1[rows] * np.sin(root)
    nx, ny = north_normal(state)
    proj = (xi - state.x[rows]) * nx[rows] + (eta - state.y[rows]) * ny[rows]

    # keep the extreme crossing on each side of the track, per instant
    order = np.lexsort((proj, rows))
    rows_s, xi_s, eta_s = rows[order], xi[order], eta[order]
    first = np.ones(rows_s.size, bool)
    first[1:] = rows_s[1:] != rows_s[:-1]
    last = np.ones(rows_s.size, bool)
    last[:-1] = rows_s[:-1] != rows_s[1:]

    out[0][rows_s[last]] = xi_s[last]      # north = largest projection
    out[1][rows_s[last]] = eta_s[last]
    out[2][rows_s[first]] = xi_s[first]    # south = smallest
    out[3][rows_s[first]] = eta_s[first]
    return out


# --------------------------------------------------------------------------
# Swept-region boundary
# --------------------------------------------------------------------------

def boundary_sides(state, penumbral: bool = False):
    """The two boundary points of the swept region at each instant.

    Returns ``(north_lat, north_lon, south_lat, south_lon)``, NaN where the
    shadow misses the Earth entirely.
    """
    res = []
    n_xi, n_eta, s_xi, s_eta = limb_crossings(state, penumbral)
    for side, l_xi, l_eta in ((+1, n_xi, n_eta), (-1, s_xi, s_eta)):
        e_xi, e_eta = limit_curve(state, side, penumbral)
        lat, lon, _ = state.surface(e_xi, e_eta)
        use_limb = ~np.isfinite(lat) & np.isfinite(l_xi)
        if use_limb.any():
            llat, llon, _ = state.surface(np.where(use_limb, l_xi, np.nan),
                                          np.where(use_limb, l_eta, np.nan))
            lat = np.where(use_limb, llat, lat)
            lon = np.where(use_limb, llon, lon)
        res += [lat, lon]
    return res


def limb_fraction(el, window, penumbral: bool = False, steps: int = 300) -> float:
    """Share of the eclipse during which the shadow hangs off the Earth's limb.

    This is what decides whether the swept-region boundary can be read off the
    envelope alone.  While the shadow sits wholly on the near face, its footprint
    contributes exactly one boundary point on each side of the track and the
    sweep is exact.  Once the footprint straddles the limb, the boundary there is
    a long arc of the shadow's own rim that a two-points-per-instant sweep cannot
    represent.  An ordinary eclipse only straddles at its two ends -- a few per
    cent of the time; a grazing one straddles for most of its length.
    """
    t = np.linspace(window[0], window[1], steps)
    state = el.state(t)
    worst = 0.0
    for side in (+1, -1):
        xi, eta = limit_curve(state, side, penumbral)
        lat, _, _ = state.surface(xi, eta)
        worst = max(worst, float(np.mean(~np.isfinite(lat))))
    return worst


def central_line(state):
    """Geographic track of the shadow axis, with the umbral radius at each point.

    ``radius`` is negative where the eclipse is total and positive where annular,
    which is what distinguishes the two legs of a hybrid eclipse.
    """
    lat, lon, zeta = state.central_line()
    radius = state.l2 - zeta * state.tanf2
    return lat, lon, radius


def central_duration_s(state):
    """Duration of totality or annularity on the central line, in seconds."""
    _, _, zeta = state.central_line()
    radius = np.abs(state.l2 - zeta * state.tanf2)
    a, b = state.relative_motion(state.x, state.y, zeta)
    return 7200.0 * radius / np.hypot(a, b)


def path_width_km(state):
    nlat, nlon, slat, slon = boundary_sides(state)
    return great_circle_km(nlat, nlon, slat, slon)


def great_circle_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.clip(np.sqrt(a), 0, 1))


# --------------------------------------------------------------------------
# Wrapping the sphere: antimeridian and poles
# --------------------------------------------------------------------------

def unwrap_lon(lon):
    """Make a longitude sequence continuous, so it may run outside +/-180."""
    lon = np.asarray(lon, float)
    if lon.size == 0:
        return lon
    step = (np.diff(lon) + 180.0) % 360.0 - 180.0
    return np.concatenate([lon[:1], lon[0] + np.cumsum(step)])


def _split_at_antimeridian(lon_u, lat):
    """Cut a polygon drawn in unwrapped longitude into +/-180 tiles."""
    poly = Polygon(np.column_stack([lon_u, lat]))
    if not poly.is_valid:
        poly = poly.buffer(0)
    return _split_geom(poly)


def _split_geom(poly):
    """Fold a polygon spanning many turns of longitude back into +/-180."""
    if poly is None or poly.is_empty:
        return None
    minx, _, maxx, _ = poly.bounds
    k0 = int(np.floor((minx + 180.0) / 360.0))
    k1 = int(np.floor((maxx + 180.0) / 360.0))
    parts = []
    for k in range(k0, k1 + 1):
        piece = poly.intersection(box(-180.0 + 360 * k, -90.0, 180.0 + 360 * k, 90.0))
        if not piece.is_empty:
            parts.append(affinity.translate(piece, xoff=-360.0 * k))
    return unary_union(parts) if parts else None


def ring_to_multipolygon(lat, lon, north_in=False, south_in=False):
    """Turn an open ring of geographic points into a renderable multipolygon.

    Pass the ring's vertices in traversal order, *not* closed -- the closure is
    what tells us whether the ring merely crosses the antimeridian or winds the
    whole way around a pole.  A ring that winds 360 deg splits the sphere into
    two caps and carries no hint of which one is the region, so the caller must
    say which poles the region actually covers (``north_in`` / ``south_in``).
    """
    lat = np.asarray(lat, float)
    lon_u = unwrap_lon(lon)
    if lat.size < 3:
        return None

    if abs(lon_u[-1] - lon_u[0]) > 180.0:      # winds around a pole
        if north_in and not south_in:
            pole = POLE_LAT
        elif south_in and not north_in:
            pole = -POLE_LAT
        else:
            return None                        # annulus: not a single ring
        # The traced ring stops one step short of its own start: the last vertex
        # and the first are neighbours on the globe but a full turn apart here.
        # Close that step explicitly, or the wedge between them is left out.
        turn = -360.0 if lon_u[-1] < lon_u[0] else 360.0
        lat = np.append(lat, lat[0])
        lon_u = np.append(lon_u, lon_u[0] + turn)
        return _polar_fan(lat, lon_u, pole)   # already folded into +/-180
    return _split_at_antimeridian(lon_u, lat)


def _polar_fan(lat, lon_u, pole):
    """Region between a pole-winding boundary and the pole, as a valid geometry.

    Sweeping a strip from the pole down to each boundary segment and closing it
    off would be enough if the boundary ran monotonically round the globe, but
    real boundaries double back, and then the strips overlap and the polygon is
    no longer simple.  Each strip covers everything between its segment and the
    pole, so counting strips counts boundary crossings *below* a point -- and
    since a meridian from pole to pole crosses an odd number of times in total,
    an odd count below means an even count above, which means the point lies on
    the same side as the pole.  So the strips are accumulated by parity: split
    the boundary into runs that *are* monotone in longitude, fan each one to the
    pole, and symmetric-difference the results.

    Each run is folded back into +/-180 *before* the parity is taken.  A boundary
    that doubles back crosses the same real meridian more than once, and those
    crossings have to meet on one vertical line to cancel; folding afterwards
    counts them on separate copies of the world and unions them.

    Runs are also capped in length, because folding a run that covers more than a
    full turn of longitude laps it onto itself -- and the union that does the
    folding cannot tell a lap from an overlap, so the parity inside that one run
    is lost before it is ever counted.
    """
    edges = _monotone_runs(lon_u)

    total = None
    for a, b in zip(edges[:-1], edges[1:]):
        if b - a < 1:
            continue
        lo = np.concatenate([lon_u[a:b + 1], [lon_u[b], lon_u[a]]])
        la = np.concatenate([lat[a:b + 1], [pole, pole]])
        piece = Polygon(np.column_stack([lo, la]))
        if not piece.is_valid:
            piece = piece.buffer(0)
        piece = _split_geom(piece)
        if piece is None or piece.is_empty:
            continue
        total = piece if total is None else total.symmetric_difference(piece)

    return total


def _monotone_runs(lon_u, max_span: float = 180.0):
    """Indices splitting a boundary into runs that are monotone and not too long.

    Monotone so each run's fan to the pole is a simple polygon; short so that
    folding it into +/-180 cannot lap it onto itself.  Splitting a run further is
    free: sub-runs of a monotone run are disjoint in longitude, so combining them
    by parity gives back exactly the whole run.
    """
    step_sign = np.sign(np.diff(lon_u))
    step_sign[step_sign == 0] = 1.0
    turns = set(np.nonzero(np.diff(step_sign) != 0)[0] + 1)

    edges, travelled = [0], 0.0
    for i in range(1, lon_u.size):
        travelled += abs(lon_u[i] - lon_u[i - 1])
        if i in turns or travelled >= max_span:
            edges.append(i)
            travelled = 0.0
    if edges[-1] != lon_u.size - 1:
        edges.append(lon_u.size - 1)
    return np.array(sorted(set(edges)))


def line_to_multilinestring(lat, lon):
    """Split a track at the antimeridian so it never draws around the globe."""
    lat = np.asarray(lat, float)
    lon_u = unwrap_lon(lon)
    segments, cur_lat, cur_lon = [], [], []
    for i in range(lat.size):
        if cur_lat:
            prev = cur_lon[-1]
            crossings = _crossings_between(prev, lon_u[i])
            if crossings:
                for edge in crossings:
                    frac = (edge - prev) / (lon_u[i] - prev)
                    mid_lat = cur_lat[-1] + frac * (lat[i] - cur_lat[-1])
                    cur_lat.append(mid_lat)
                    cur_lon.append(edge)
                    segments.append((cur_lat, cur_lon))
                    cur_lat, cur_lon = [mid_lat], [edge]
                    prev = edge
        cur_lat.append(lat[i])
        cur_lon.append(lon_u[i])
    segments.append((cur_lat, cur_lon))

    out = []
    for slat, slon in segments:
        if len(slat) < 2:
            continue
        slon = np.asarray(slon, float)
        shift = 360.0 * np.round(np.median(slon) / 360.0)
        out.append([[float(a - shift), float(b)] for a, b in zip(slon, slat)])
    return out


def _crossings_between(lon_a, lon_b):
    """Antimeridian lines strictly between two unwrapped longitudes."""
    lo, hi = sorted((lon_a, lon_b))
    k0 = int(np.floor((lo - 180.0) / 360.0)) + 1
    edges = []
    k = k0
    while 180.0 + 360.0 * k < hi:
        if 180.0 + 360.0 * k > lo:
            edges.append(180.0 + 360.0 * k)
        k += 1
    return edges if lon_b >= lon_a else edges[::-1]


# --------------------------------------------------------------------------
# Contact times and the swept path polygon
# --------------------------------------------------------------------------

def _clearance(state, penumbral: bool, n_psi: int = 512):
    """Gap between the shadow circle and the Earth's disc; negative = touching.

    Distance is measured to the *disc*, not to its rim, so a shadow sitting
    wholly inside the Earth's outline still reads as touching.  Getting this
    wrong loses the umbral path of a hybrid eclipse, whose umbra is small enough
    to be entirely interior for its whole crossing.
    """
    l0 = state.l1 if penumbral else state.l2
    tanf = state.tanf1 if penumbral else state.tanf2
    psi = np.linspace(0.0, 2 * np.pi, n_psi, endpoint=False)
    s, c = np.sin(psi)[None, :], np.cos(psi)[None, :]
    eta = state.rho1[:, None] * s
    zeta = -(state.rho2 * state.s12)[:, None] * s
    radius = np.abs(l0[:, None] - zeta * tanf)
    d2 = (c - state.x[:, None]) ** 2 + (eta - state.y[:, None]) ** 2
    nearest = np.argmin(d2, axis=1)
    rows = np.arange(state.t.size)
    gap = np.sqrt(d2[rows, nearest]) - radius[rows, nearest]
    axis_on_disc = state.x ** 2 + (state.y / state.rho1) ** 2 <= 1.0
    return np.where(axis_on_disc, -np.abs(l0), gap)


def contact_times(el, penumbral: bool, span: float = 9.0, step: float = 1 / 240):
    """First and last instant the shadow touches the Earth, in TDT hours from t0.

    Returns ``None`` when the shadow misses the Earth altogether (which is how a
    partial eclipse presents itself when asked for an umbral path).
    """
    t = np.arange(-span, span + step, step)
    g = _clearance(el.state(t), penumbral)
    inside = np.nonzero(g < 0)[0]
    if inside.size == 0:
        return None
    lo_i, hi_i = inside[0], inside[-1]
    t_lo = _bisect_contact(el, penumbral, t[lo_i - 1], t[lo_i]) if lo_i else t[lo_i]
    t_hi = (_bisect_contact(el, penumbral, t[hi_i], t[hi_i + 1])
            if hi_i + 1 < t.size else t[hi_i])
    return float(t_lo), float(t_hi)


def _bisect_contact(el, penumbral, t_out, t_in, iters=30):
    for _ in range(iters):
        mid = 0.5 * (t_out + t_in)
        if _clearance(el.state(np.array([mid])), penumbral)[0] < 0:
            t_in = mid
        else:
            t_out = mid
    return t_in


def swept_ring(el, penumbral: bool, n_steps: int, window=None):
    """Closed ring of geographic points bounding the region the shadow sweeps."""
    window = window or contact_times(el, penumbral)
    if window is None:
        return None
    t0, t1 = window
    eps = min(1e-5, (t1 - t0) / 1e4)
    t = np.linspace(t0 + eps, t1 - eps, n_steps)
    st = el.state(t)
    nlat, nlon, slat, slon = boundary_sides(st, penumbral)
    ok = np.isfinite(nlat) & np.isfinite(nlon) & np.isfinite(slat) & np.isfinite(slon)
    ok = _longest_run(ok)
    if ok.sum() < 3:
        return None
    ring_lat = np.concatenate([nlat[ok], slat[ok][::-1]])
    ring_lon = np.concatenate([nlon[ok], slon[ok][::-1]])
    return ring_lat, ring_lon


def _longest_run(mask):
    """Keep only the longest contiguous block of True."""
    best_len = best_start = run = start = 0
    for i, v in enumerate(mask):
        if v:
            if run == 0:
                start = i
            run += 1
            if run > best_len:
                best_len, best_start = run, start
        else:
            run = 0
    out = np.zeros_like(mask)
    out[best_start:best_start + best_len] = True
    return out
