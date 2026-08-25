"""Verify computed path limits and central duration against NASA's path tables.

Usage:  .venv/bin/python verify_limits.py [--fitted]

``--fitted`` substitutes the per-eclipse Delta T that verify_central.py --fit
recovers, which separates the geometry from NASA's choice of Delta T.
"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import besselian as B
import geometry as G
from nasa_tables import parse_path_table

CASES = [("19010518", "path_19010518.html"), ("19050830", "path_19050830.html"),
         ("20170821", "path_20170821.html"), ("20240408", "path_20240408.html"),
         ("20260812", "path_20260812.html")]


def run(use_fitted_dt=None):
    cat = {e.key: (e, x) for e, x in B.load_catalog()}
    for key, fname in CASES:
        el, _ = cat[key]
        dT = (use_fitted_dt or {}).get(key, el.dt)
        rows = parse_path_table(os.path.join(B.CACHE, "nasa", fname))
        ut = np.array([r["ut"] for r in rows])
        st = el.state(ut + dT / 3600.0 - el.t0)
        # re-apply the Delta T rotation for the value under test
        shift = B.SIDEREAL_RATE * (dT - el.dt) * 15 / 3600.0
        res = {}
        for name, side in (("north", +1), ("south", -1)):
            e_xi, e_eta = G.limit_curve(st, side)
            la, lo, _ = st.surface(e_xi, e_eta)
            lo = (lo + shift + 180) % 360 - 180
            ref = [r[name] for r in rows]
            d = [G.great_circle_km(r[0], r[1], a, b) / 111.195
                 for r, a, b in zip(ref, la, lo) if r and np.isfinite(a)]
            res[name] = np.array(d)
        w = G.path_width_km(st)
        wref = np.array([r["width_km"] if r["width_km"] else np.nan for r in rows], float)
        dur = G.central_duration_s(st)
        dref = np.array([r["duration_s"] if r["duration_s"] else np.nan for r in rows], float)
        ok = np.isfinite(w) & np.isfinite(wref)
        okd = np.isfinite(dur) & np.isfinite(dref)
        print(f"{key} (dT={dT:g})")
        for name in ("north", "south"):
            d = res[name]
            print(f"   {name} limit : n={len(d):3d}  median={np.median(d):.5f}deg  "
                  f"p95={np.percentile(d,95):.5f}  max={d.max():.4f}")
        print(f"   width      : median |d|={np.nanmedian(np.abs(w[ok]-wref[ok])):.2f} km  "
              f"max={np.nanmax(np.abs(w[ok]-wref[ok])):.2f} km")
        print(f"   duration   : median |d|={np.nanmedian(np.abs(dur[okd]-dref[okd])):.2f} s  "
              f"max={np.nanmax(np.abs(dur[okd]-dref[okd])):.2f} s")


if __name__ == "__main__":
    run({"20170821": 68.35, "20240408": 71.15, "20260812": 72.03}
        if "--fitted" in sys.argv else None)
