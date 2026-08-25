"""Compare our computed central line against NASA's published path tables.

Usage:  .venv/bin/python verify_central.py [sign]

``sign`` selects the Delta T term in the longitude reduction and exists only to
show what the alternatives cost.  The shipped convention is +1, i.e.
``lambda = theta - mu + 1.002738 dT``; 0 omits the term and -1 reverses it.

The first and last tabulated instants sit where the shadow axis meets the limb.
There a fraction of a second of timing moves the point a long way along the
ground, so they are reported separately rather than quietly dropped.
"""

import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import besselian as B
from nasa_tables import parse_path_table

CASES = [("19010518", "path_19010518.html"),
         ("19050830", "path_19050830.html"),
         ("20170821", "path_20170821.html"),
         ("20240408", "path_20240408.html"),
         ("20260812", "path_20260812.html")]


def gc_sep_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(a))))


def fit_delta_t(el, rows, lo, hi, steps=241):
    """Delta T that best reproduces NASA's tabulated line, by direct search."""
    best = (None, np.inf)
    for dT in np.linspace(lo, hi, steps):
        seps = separations(el, rows, dT)
        rms = float(np.sqrt((seps ** 2).mean()))
        if rms < best[1]:
            best = (float(dT), rms)
    return best


def separations(el, rows, dT, dt_sign=1.0):
    t = np.array([r["ut"] + dT / 3600.0 - el.t0 for r in rows])
    st = el.state(t)
    lat, lon, _ = st.central_line()
    # dt_rotation() uses the canon's value, so swap in the one under test
    shift = B.SIDEREAL_RATE * (dT - el.dt) * 15.0 / 3600.0
    lon = (lon + shift + (dt_sign - 1.0) * st.dt_rotation() + 180.0) % 360.0 - 180.0
    return np.array([gc_sep_deg(r["central"][0], r["central"][1], la, lo)
                     for r, la, lo in zip(rows, lat, lon) if np.isfinite(la)])


def main(dt_sign=1.0):
    cat = {e.key: (e, x) for e, x in B.load_catalog()}
    print(f"Delta T longitude term sign {dt_sign:+.0f}   "
          f"(great-circle separation from NASA's tabulated central line, degrees)\n")
    print(f"{'eclipse':>10} {'dT':>7} {'n':>4} {'median':>9} {'rms':>9} {'max':>9} "
          f"{'max interior':>13}")
    print("-" * 66)
    for key, fname in CASES:
        el, _ = cat[key]
        rows = [r for r in parse_path_table(os.path.join(B.CACHE, "nasa", fname))
                if r["central"]]
        t = np.array([r["ut"] + el.dt / 3600.0 - el.t0 for r in rows])
        st = el.state(t)
        lat, lon, _ = st.central_line()
        lon = (lon + (dt_sign - 1.0) * st.dt_rotation() + 180.0) % 360.0 - 180.0

        seps = np.array([gc_sep_deg(r["central"][0], r["central"][1], la, lo)
                         for r, la, lo in zip(rows, lat, lon) if np.isfinite(la)])
        interior = seps[1:-1] if seps.size > 2 else seps
        print(f"{key:>10} {el.dt:7.1f} {seps.size:4d} {np.median(seps):9.5f} "
              f"{np.sqrt((seps ** 2).mean()):9.5f} {seps.max():9.5f} "
              f"{interior.max():13.5f}")


def fit_report():
    """Show that the modern residual is a Delta T difference, not a geometry one."""
    cat = {e.key: (e, x) for e, x in B.load_catalog()}
    print("\nBest-fit Delta T per eclipse (searched, not assumed)\n")
    print(f"{'eclipse':>10} {'canon dT':>9} {'best dT':>9} {'diff':>7} "
          f"{'rms at canon':>13} {'rms at best':>12}")
    print("-" * 66)
    for key, fname in CASES:
        el, _ = cat[key]
        rows = [r for r in parse_path_table(os.path.join(B.CACHE, "nasa", fname))
                if r["central"]]
        canon = float(np.sqrt((separations(el, rows, el.dt) ** 2).mean()))
        best_dt, best_rms = fit_delta_t(el, rows, el.dt - 12.0, el.dt + 6.0)
        print(f"{key:>10} {el.dt:9.1f} {best_dt:9.2f} {best_dt - el.dt:+7.2f} "
              f"{canon:13.5f} {best_rms:12.5f}")


# Regression thresholds, set well clear of the numbers actually achieved so that
# only a real break trips them.  See the README's verification tables.
UNFITTED_RMS_LIMIT = 0.002      # degrees, for the two eclipses NASA has not revised
FITTED_RMS_LIMIT = 0.01         # degrees, once Delta T is matched


def check():
    """Fail loudly if the reduction has drifted.  Used by CI."""
    cat = {e.key: (e, x) for e, x in B.load_catalog()}
    problems = []
    for key, fname, _ in ((k, f, None) for k, f in
                          ((c[0], c[1]) for c in CASES)):
        el, _ = cat[key]
        rows = [r for r in parse_path_table(os.path.join(B.CACHE, "nasa", fname))
                if r["central"]]
        canon = float(np.sqrt((separations(el, rows, el.dt) ** 2).mean()))
        best_dt, best_rms = fit_delta_t(el, rows, el.dt - 12.0, el.dt + 6.0)
        if abs(best_dt - el.dt) < 0.5 and canon > UNFITTED_RMS_LIMIT:
            problems.append(f"{key}: rms {canon:.5f} deg at the canon's own Delta T "
                            f"(limit {UNFITTED_RMS_LIMIT})")
        if best_rms > FITTED_RMS_LIMIT:
            problems.append(f"{key}: rms {best_rms:.5f} deg even at its best-fit "
                            f"Delta T {best_dt:.2f} (limit {FITTED_RMS_LIMIT})")
    for p in problems:
        print("FAIL", p)
    print("central line: " + ("OK" if not problems else f"{len(problems)} problem(s)"))
    return not problems


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(float(args[0]) if args else 1.0)
    if "--fit" in sys.argv:
        fit_report()
    if "--check" in sys.argv:
        sys.exit(0 if check() else 1)
