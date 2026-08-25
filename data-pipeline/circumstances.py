"""Local circumstances of an eclipse: what one place on the ground actually sees.

This is the reference implementation.  The browser carries a port of it (see
``public/circumstances.js``) so a click on the map can answer immediately without
a round trip; ``verify_circumstances.py`` checks the two against each other and
against NASA's tabulated central-line durations.
"""

from __future__ import annotations

import numpy as np

import geometry as G
from besselian import SQRT1ME2


def _reach(el, lat, lon, t):
    """Penumbral radius minus distance from the axis; the magnitude's numerator."""
    st = el.state(np.atleast_1d(t))
    xi, eta, zeta = st.observer(lat, lon)
    sep = np.hypot(xi - st.x, eta - st.y)
    l1p = st.l1 - zeta * st.tanf1
    return np.where(zeta >= 0.0, l1p - sep, -1e6), st, sep, zeta


def _horizon_crossing(el, lat, lon, t_lo, t_hi, steps=4):
    """Sunrise or sunset between two bracketing instants, by Newton on zeta.

    The visibility cut puts a step in the reach curve, and a search cannot find a
    maximum that sits on a step.  Solving for the step instead is what keeps the
    obscuration right for somewhere watching the eclipse come up over the horizon.
    """
    z_lo = _reach(el, lat, lon, t_lo)[3][0]
    z_hi = _reach(el, lat, lon, t_hi)[3][0]
    span = (z_hi - z_lo) or 1.0
    t = float(np.clip(t_lo - z_lo * (t_hi - t_lo) / span, t_lo, t_hi))
    for _ in range(steps):
        st = el.state(np.array([t]))
        xi, eta, zeta = st.observer(lat, lon)
        rate = float((st.dd * eta - st.dmu * xi * st.cosd)[0]) or 1e-9
        t = float(np.clip(t - float(zeta[0]) / rate, t_lo, t_hi))
    return t


def _gap(el, lat, lon, t, umbral):
    """Distance from the axis minus the shadow radius: zero at a contact."""
    st = el.state(np.atleast_1d(t))
    xi, eta, zeta = st.observer(lat, lon)
    sep = np.hypot(xi - st.x, eta - st.y)
    radius = (np.abs(st.l2 - zeta * st.tanf2) if umbral
              else st.l1 - zeta * st.tanf1)
    return float((sep - radius)[0])


def _bisect_contact(el, lat, lon, t_in, t_out, umbral, iters=60):
    for _ in range(iters):
        mid = 0.5 * (t_in + t_out)
        if _gap(el, lat, lon, mid, umbral) < 0:
            t_in = mid
        else:
            t_out = mid
    return 0.5 * (t_in + t_out)


def local_circumstances(el, lat, lon, window=None, scan=400):
    """What is seen from ``lat``/``lon``; ``None`` if the eclipse misses it.

    Times come back as TDT hours from ``t0``; :func:`to_ut` converts them.
    """
    window = window or G.contact_times(el, True)
    if window is None:
        return None

    t_grid = np.linspace(window[0], window[1], scan)
    reach, _, _, _ = _reach(el, lat, lon, t_grid)
    peak = int(np.argmax(reach))
    if reach[peak] <= 0.0:
        return None

    # close on the deepest moment, with the horizon as a hard edge of the bracket
    lo = t_grid[max(peak - 1, 0)]
    hi = t_grid[min(peak + 1, scan - 1)]
    _, _, _, zeta_grid = _reach(el, lat, lon, t_grid)
    dark = zeta_grid < 0.0
    before = np.nonzero(dark[:peak + 1])[0]
    after = np.nonzero(dark[peak:])[0]
    if before.size:
        j = int(before[-1])
        lo = max(lo, _horizon_crossing(el, lat, lon, t_grid[j], t_grid[j + 1]))
    if after.size:
        j = int(after[0]) + peak
        hi = min(hi, _horizon_crossing(el, lat, lon, t_grid[j - 1], t_grid[j]))
    hi = max(hi, lo)

    a, b = lo, hi
    for _ in range(80):
        third = (b - a) / 3.0
        m1, m2 = a + third, b - third
        if _reach(el, lat, lon, m1)[0][0] < _reach(el, lat, lon, m2)[0][0]:
            a = m1
        else:
            b = m2
    # a constrained maximum can sit on either horizon instant instead
    options = [0.5 * (a + b), t_grid[peak], lo, hi]
    t_max = max(options, key=lambda t: _reach(el, lat, lon, t)[0][0])

    _, st, sep, zeta = _reach(el, lat, lon, t_max)
    l1p = float((st.l1 - zeta * st.tanf1)[0])
    l2p = float((st.l2 - zeta * st.tanf2)[0])
    sep = float(sep[0])
    magnitude = (l1p - sep) / (l1p + l2p)
    ratio = (l1p - l2p) / (l1p + l2p)

    from raster import obscuration_from
    obscuration = float(obscuration_from(np.array(magnitude), np.array(ratio)))

    result = {
        "t_max": float(t_max),
        "magnitude": magnitude,
        "obscuration": obscuration,
        "ratio": ratio,
        "sun_alt": float(np.degrees(np.arcsin(np.clip(zeta[0], -1.0, 1.0)))),
        "central": sep < abs(l2p),
        "total": sep < abs(l2p) and l2p < 0,
    }

    # partial contacts, on whichever side of maximum they can be bracketed
    if _gap(el, lat, lon, window[0], False) > 0:
        result["c1"] = _bisect_contact(el, lat, lon, t_max, window[0], False)
    if _gap(el, lat, lon, window[1], False) > 0:
        result["c4"] = _bisect_contact(el, lat, lon, t_max, window[1], False)

    if result["central"]:
        if _gap(el, lat, lon, window[0], True) > 0:
            result["c2"] = _bisect_contact(el, lat, lon, t_max, window[0], True)
        if _gap(el, lat, lon, window[1], True) > 0:
            result["c3"] = _bisect_contact(el, lat, lon, t_max, window[1], True)
        if "c2" in result and "c3" in result:
            result["duration_s"] = (result["c3"] - result["c2"]) * 3600.0

    return result


def to_ut(el, t):
    """TDT hours from t0 to hours UT on the eclipse date (may wrap the day)."""
    return (el.t0 + t - el.dt / 3600.0) % 24.0
